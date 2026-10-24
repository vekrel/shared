// @effect-diagnostics globalFetch:off globalDate:off - Promise API for app auth providers (React, Electron, Expo), outside an Effect runtime.
/**
 * Vekrel account sign-in against the relay's OAuth endpoints (`src/accounts/oauth.rs` in
 * Vekrel-Relay): authorization code + PKCE S256, rotating refresh tokens, RFC 7009 revoke.
 *
 * The relay rotates the refresh token on every use and revokes the whole family when a rotated
 * token is presented again, so a refresh must never run twice at once: one in-flight request
 * per session, and across tabs or windows of one origin a Web Lock.
 *
 * The web client never sees its refresh token: the relay keeps it in an HttpOnly cookie, sent
 * with `credentials: "include"`. Desktop, mobile and CLI get it in the body and keep it in a
 * `RefreshTokenStore`.
 */
import {
  buildRelayAuthorizeUrl,
  createOAuthState,
  createPkcePair,
} from "@vekrel/shared/connectAuth";
import * as Data from "effect/Data";

export const AccountClientId = {
  web: "vekrel-web",
  desktop: "vekrel-desktop",
  mobile: "vekrel-mobile",
  cli: "vekrel-cli",
} as const;
export type AccountClientId = (typeof AccountClientId)[keyof typeof AccountClientId];

/** Refresh the access token this long before it expires. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 30_000;

export class AccountAuthError extends Data.TaggedError("AccountAuthError")<{
  readonly reason:
    | "state-mismatch"
    | "authorization-denied"
    | "missing-code"
    | "token-rejected"
    | "token-request-failed"
    | "invalid-token-response";
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/** Kept by the client between opening the authorize URL and receiving the callback. */
export interface PendingSignIn {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export function beginSignIn(input: {
  readonly relayUrl: string;
  readonly clientId: AccountClientId;
  readonly redirectUri: string;
}): { readonly url: string; readonly pending: PendingSignIn } {
  const { verifier, challenge } = createPkcePair();
  const state = createOAuthState();
  return {
    url: buildRelayAuthorizeUrl({ ...input, state, challenge }),
    pending: { state, verifier, redirectUri: input.redirectUri },
  };
}

/** The authorization code from a callback URL; throws unless `state` is the one we sent. */
export function readSignInCallback(callbackUrl: string | URL, pending: PendingSignIn): string {
  const params = new URL(callbackUrl).searchParams;
  // State first: an error or code under a foreign state is not ours to act on.
  if (params.get("state") !== pending.state) {
    throw new AccountAuthError({
      reason: "state-mismatch",
      message: "The sign-in response does not belong to this sign-in.",
    });
  }
  const error = params.get("error");
  if (error) {
    throw new AccountAuthError({
      reason: "authorization-denied",
      message: params.get("error_description") || error,
    });
  }
  const code = params.get("code");
  if (!code) {
    throw new AccountAuthError({
      reason: "missing-code",
      message: "The sign-in response has no authorization code.",
    });
  }
  return code;
}

export interface RefreshTokenStore {
  readonly read: () => Promise<string | null>;
  readonly write: (refreshToken: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface LockManagerLike {
  readonly request: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
}

export interface AccountSessionOptions {
  readonly relayUrl: string;
  readonly clientId: AccountClientId;
  /** Required for every client except `vekrel-web`, whose refresh token is a relay cookie. */
  readonly store?: RefreshTokenStore;
  readonly fetch?: Fetch;
  /** Called when the relay refuses the refresh token (revoked, reused, disabled account). */
  readonly onSignedOut?: () => void;
}

export interface AccountSession {
  readonly completeSignIn: (callbackUrl: string | URL, pending: PendingSignIn) => Promise<void>;
  /** A valid access token, refreshing if needed; `null` when signed out. */
  readonly getAccessToken: () => Promise<string | null>;
  readonly refresh: () => Promise<string | null>;
  readonly signOut: () => Promise<void>;
}

interface TokenBody {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
}

function isTokenBody(value: unknown): value is TokenBody {
  const body = value as Partial<TokenBody> | null;
  return (
    typeof body?.access_token === "string" &&
    typeof body.expires_in === "number" &&
    (body.refresh_token === undefined || typeof body.refresh_token === "string")
  );
}

/**
 * Web Locks serialise refreshes across tabs and Electron windows of one origin.
 * shortcut: where Web Locks are missing (React Native, old browsers) only this session is
 * serialised; add a BroadcastChannel lock if a multi-context client without Web Locks appears.
 */
function crossContextLock(name: string): <T>(callback: () => Promise<T>) => Promise<T> {
  const locks = (globalThis.navigator as { readonly locks?: LockManagerLike } | undefined)?.locks;
  return locks ? (callback) => locks.request(name, callback) : (callback) => callback();
}

export function createAccountSession(options: AccountSessionOptions): AccountSession {
  const web = options.clientId === AccountClientId.web;
  const store = options.store;
  if (!web && !store) {
    throw new Error(`${options.clientId} needs a refresh token store.`);
  }
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const withLock = crossContextLock(`vekrel-account-refresh:${options.clientId}`);
  let access: { readonly token: string; readonly expiresAtMillis: number } | null = null;
  let inFlight: Promise<string | null> | null = null;
  // Bumped by sign-out so a refresh that finishes afterwards cannot revive the session.
  let generation = 0;

  const post = async (path: string, fields: Record<string, string>): Promise<Response> => {
    try {
      return await fetchImpl(new URL(path, options.relayUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        ...(web ? { credentials: "include" } : {}),
      });
    } catch (cause) {
      throw new AccountAuthError({
        reason: "token-request-failed",
        message: "Could not reach the Vekrel relay.",
        cause,
      });
    }
  };

  const requestTokens = async (fields: Record<string, string>): Promise<TokenBody> => {
    const response = await post("/oauth/token", { ...fields, client_id: options.clientId });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const oauthError = (body as { readonly error?: unknown } | null)?.error;
      throw new AccountAuthError({
        // 400/401 are OAuth refusals (invalid_grant, invalid_client); 429 and 5xx are transient.
        reason:
          response.status === 400 || response.status === 401
            ? "token-rejected"
            : "token-request-failed",
        message: `The relay refused the token request (${typeof oauthError === "string" ? oauthError : response.status}).`,
        status: response.status,
      });
    }
    if (!isTokenBody(body) || (!web && body.refresh_token === undefined)) {
      throw new AccountAuthError({
        reason: "invalid-token-response",
        message: "The relay sent an unexpected token response.",
      });
    }
    return body;
  };

  const accept = async (body: TokenBody, issuedAtGeneration: number): Promise<string | null> => {
    if (issuedAtGeneration !== generation) {
      return null;
    }
    if (store && body.refresh_token !== undefined) {
      await store.write(body.refresh_token);
    }
    access = { token: body.access_token, expiresAtMillis: Date.now() + body.expires_in * 1_000 };
    return body.access_token;
  };

  const clearLocal = async () => {
    generation += 1;
    access = null;
    await store?.clear();
  };

  const refreshOnce = async (): Promise<string | null> => {
    const startedAt = generation;
    const refreshToken = store ? await store.read() : null;
    if (store && !refreshToken) {
      return null;
    }
    try {
      const body = await requestTokens({
        grant_type: "refresh_token",
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      });
      return await accept(body, startedAt);
    } catch (error) {
      if (error instanceof AccountAuthError && error.reason === "token-rejected") {
        if (startedAt === generation) {
          await clearLocal();
          options.onSignedOut?.();
        }
        return null;
      }
      throw error;
    }
  };

  const refresh = (): Promise<string | null> => {
    inFlight ??= withLock(refreshOnce).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    completeSignIn: async (callbackUrl, pending) => {
      const code = readSignInCallback(callbackUrl, pending);
      const startedAt = generation;
      const body = await requestTokens({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      });
      await accept(body, startedAt);
    },
    getAccessToken: async () => {
      if (access && access.expiresAtMillis - ACCESS_TOKEN_EXPIRY_SKEW_MS > Date.now()) {
        return access.token;
      }
      return refresh();
    },
    refresh,
    signOut: async () => {
      const refreshToken = store ? await store.read() : null;
      await clearLocal();
      if (web || refreshToken) {
        // Best effort: the local session is gone either way; the family expires in 30 days.
        await post("/oauth/revoke", {
          ...(refreshToken ? { token: refreshToken } : {}),
          client_id: options.clientId,
        }).catch(() => undefined);
      }
    },
  };
}
