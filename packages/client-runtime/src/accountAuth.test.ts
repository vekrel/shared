import * as Base64Url from "effect/encoding/Base64Url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AccountAuthError,
  AccountClientId,
  beginSignIn,
  createAccountSession,
  readSignInCallback,
  type RefreshTokenStore,
} from "./accountAuth.ts";

const RELAY = "https://relay.example.test";
const APP_REDIRECT = "vekrel://auth/callback";

const challengeOf = async (verifier: string) =>
  Base64Url.encode(
    new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );

/**
 * A fake `/oauth/token` + `/oauth/revoke` that rotates like the relay: every refresh
 * rotates, presenting a rotated token revokes the whole family, and the web client's
 * refresh token lives only in a cookie jar sent with `credentials: "include"`.
 */
function fakeRelay() {
  let serial = 0;
  const tokens = new Map<string, { family: number; rotated: boolean }>();
  const revokedFamilies = new Set<number>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const jar = { refresh: null as string | null };
  const requests: Array<Record<string, string>> = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const issue = (family: number, web: boolean) => {
    serial += 1;
    const refresh = `refresh-${serial}`;
    tokens.set(refresh, { family, rotated: false });
    if (web) jar.refresh = refresh;
    return json(200, {
      access_token: `access-${serial}`,
      token_type: "Bearer",
      expires_in: 600,
      ...(web ? {} : { refresh_token: refresh }),
      id_token: "id",
    });
  };

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    requests.push({ path: url.pathname, ...form });
    const web = form.client_id === AccountClientId.web;
    const cookie = init?.credentials === "include" ? jar.refresh : null;

    if (url.pathname === "/oauth/revoke") {
      const presented = form.token ?? cookie;
      const row = presented ? tokens.get(presented) : undefined;
      if (row) revokedFamilies.add(row.family);
      if (init?.credentials === "include") jar.refresh = null;
      return new Response(null, { status: 200 });
    }

    if (form.grant_type === "authorization_code") {
      const pending = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      if (
        !pending ||
        pending.redirectUri !== form.redirect_uri ||
        pending.challenge !== (await challengeOf(form.code_verifier ?? ""))
      ) {
        return json(400, { error: "invalid_grant", error_description: "bad code" });
      }
      return issue(serial + 1000, web);
    }

    const presented = form.refresh_token ?? cookie;
    if (!presented) {
      return json(400, {
        error: "invalid_request",
        error_description: "refresh_token is required",
      });
    }
    const row = tokens.get(presented);
    if (!row || revokedFamilies.has(row.family)) {
      return json(400, { error: "invalid_grant", error_description: "revoked" });
    }
    if (row.rotated) {
      revokedFamilies.add(row.family);
      return json(400, { error: "invalid_grant", error_description: "reused" });
    }
    row.rotated = true;
    // The rotation is committed; the response arrives later, as over a network.
    await Promise.resolve();
    return issue(row.family, web);
  });

  return {
    fetch,
    jar,
    requests,
    revokedFamilies,
    tokenRequests: () => requests.filter((request) => request.path === "/oauth/token"),
    addCode: (code: string, challenge: string, redirectUri: string) =>
      codes.set(code, { challenge, redirectUri }),
    /** A live refresh family for a client that keeps its token in a store. */
    seedRefresh: () => {
      tokens.set("refresh-seed", { family: 1, rotated: false });
      return "refresh-seed";
    },
  };
}

function memoryStore(initial: string | null): RefreshTokenStore & { value: string | null } {
  const store = {
    value: initial,
    read: async () => store.value,
    write: async (token: string) => {
      store.value = token;
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

/** A Web Locks `LockManager` shared by every "tab" of one origin. */
function sharedWebLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request: <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
      const run = tail.then(callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("beginSignIn", () => {
  it("sends the S256 challenge of the pending verifier and a fresh state", async () => {
    const first = beginSignIn({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      redirectUri: APP_REDIRECT,
    });
    const second = beginSignIn({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      redirectUri: APP_REDIRECT,
    });
    const url = new URL(first.url);

    expect(url.origin + url.pathname).toBe(`${RELAY}/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe("vekrel-mobile");
    expect(url.searchParams.get("redirect_uri")).toBe(APP_REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await challengeOf(first.pending.verifier));
    expect(url.searchParams.get("state")).toBe(first.pending.state);
    expect(first.pending.verifier).not.toBe(second.pending.verifier);
    expect(first.pending.state).not.toBe(second.pending.state);
  });
});

describe("readSignInCallback", () => {
  const { pending } = beginSignIn({
    relayUrl: RELAY,
    clientId: AccountClientId.desktop,
    redirectUri: APP_REDIRECT,
  });
  const reason = (url: string) => {
    try {
      readSignInCallback(url, pending);
    } catch (error) {
      expect(error).toBeInstanceOf(AccountAuthError);
      return (error as AccountAuthError).reason;
    }
    return "accepted";
  };

  it("returns the code when the state matches", () => {
    expect(readSignInCallback(`${APP_REDIRECT}?code=c1&state=${pending.state}`, pending)).toBe(
      "c1",
    );
  });

  it("refuses a state mismatch, a missing state, and an error from a foreign state", () => {
    expect(reason(`${APP_REDIRECT}?code=c1&state=other`)).toBe("state-mismatch");
    expect(reason(`${APP_REDIRECT}?code=c1`)).toBe("state-mismatch");
    expect(reason(`${APP_REDIRECT}?error=access_denied&state=other`)).toBe("state-mismatch");
  });

  it("reports a relay error and a missing code for the right state", () => {
    expect(reason(`${APP_REDIRECT}?error=access_denied&state=${pending.state}`)).toBe(
      "authorization-denied",
    );
    expect(reason(`${APP_REDIRECT}?state=${pending.state}`)).toBe("missing-code");
  });
});

describe("createAccountSession", () => {
  it("exchanges the code with the verifier and stores the refresh token", async () => {
    const relay = fakeRelay();
    const store = memoryStore(null);
    const session = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      store,
      fetch: relay.fetch,
    });
    const { pending } = beginSignIn({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      redirectUri: APP_REDIRECT,
    });
    relay.addCode("code-1", await challengeOf(pending.verifier), APP_REDIRECT);

    await session.completeSignIn(`${APP_REDIRECT}?code=code-1&state=${pending.state}`, pending);

    expect(relay.requests[0]).toMatchObject({
      grant_type: "authorization_code",
      client_id: "vekrel-mobile",
      code: "code-1",
      redirect_uri: APP_REDIRECT,
      code_verifier: pending.verifier,
    });
    expect(store.value).toMatch(/^refresh-/u);
    expect(await session.getAccessToken()).toMatch(/^access-/u);
    expect(relay.tokenRequests()).toHaveLength(1);
  });

  it("does not exchange a code whose state does not match", async () => {
    const relay = fakeRelay();
    const session = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      store: memoryStore(null),
      fetch: relay.fetch,
    });
    const { pending } = beginSignIn({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      redirectUri: APP_REDIRECT,
    });

    await expect(
      session.completeSignIn(`${APP_REDIRECT}?code=code-1&state=forged`, pending),
    ).rejects.toMatchObject({ reason: "state-mismatch" });
    expect(relay.fetch).not.toHaveBeenCalled();
  });

  it("makes one refresh request for concurrent callers", async () => {
    const relay = fakeRelay();
    const store = memoryStore(relay.seedRefresh());
    const session = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.desktop,
      store,
      fetch: relay.fetch,
    });

    const tokens = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.refresh(),
      session.getAccessToken(),
    ]);

    expect(relay.tokenRequests()).toHaveLength(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^access-/u);
    expect(relay.revokedFamilies.size).toBe(0);
    expect(await session.getAccessToken()).toBe(tokens[0]);
    expect(relay.tokenRequests()).toHaveLength(1);
  });

  it("serialises refreshes across tabs with Web Locks so the cookie is never reused", async () => {
    const relay = fakeRelay();
    relay.jar.refresh = relay.seedRefresh();
    vi.stubGlobal("navigator", { locks: sharedWebLocks() });
    const signedOut = vi.fn();
    const tab = () =>
      createAccountSession({
        relayUrl: RELAY,
        clientId: AccountClientId.web,
        fetch: relay.fetch,
        onSignedOut: signedOut,
      });

    const [a, b] = await Promise.all([tab().getAccessToken(), tab().getAccessToken()]);

    expect(a).toMatch(/^access-/u);
    expect(b).toMatch(/^access-/u);
    expect(relay.revokedFamilies.size).toBe(0);
    expect(signedOut).not.toHaveBeenCalled();
    for (const request of relay.tokenRequests()) {
      expect(request).toEqual({
        path: "/oauth/token",
        grant_type: "refresh_token",
        client_id: "vekrel-web",
      });
    }
  });

  it("without Web Locks two tabs present one cookie twice and the relay revokes the family", async () => {
    // Why the lock matters: this is the race the previous test is protected from.
    const relay = fakeRelay();
    relay.jar.refresh = relay.seedRefresh();
    vi.stubGlobal("navigator", {});
    const tab = () =>
      createAccountSession({ relayUrl: RELAY, clientId: AccountClientId.web, fetch: relay.fetch });

    const results = await Promise.all([tab().getAccessToken(), tab().getAccessToken()]);

    expect(results).toContain(null);
    expect(relay.revokedFamilies.size).toBe(1);
  });

  it("signs out when the relay refuses the refresh token", async () => {
    const relay = fakeRelay();
    const store = memoryStore("refresh-unknown");
    const onSignedOut = vi.fn();
    const session = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      store,
      fetch: relay.fetch,
      onSignedOut,
    });

    expect(await session.getAccessToken()).toBeNull();
    expect(store.value).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(await session.getAccessToken()).toBeNull();
    expect(relay.tokenRequests()).toHaveLength(1);
  });

  it("keeps the session when the relay cannot be reached", async () => {
    const store = memoryStore("refresh-1");
    const onSignedOut = vi.fn();
    const session = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.mobile,
      store,
      fetch: async () => {
        throw new TypeError("network down");
      },
      onSignedOut,
    });

    await expect(session.getAccessToken()).rejects.toMatchObject({
      reason: "token-request-failed",
    });
    expect(store.value).toBe("refresh-1");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("signs out by revoking the family: body token for apps, cookie for web", async () => {
    const relay = fakeRelay();
    const store = memoryStore(relay.seedRefresh());
    const app = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.desktop,
      store,
      fetch: relay.fetch,
    });
    await app.signOut();
    expect(relay.requests.at(-1)).toEqual({
      path: "/oauth/revoke",
      token: "refresh-seed",
      client_id: "vekrel-desktop",
    });
    expect(store.value).toBeNull();
    expect(await app.getAccessToken()).toBeNull();

    relay.jar.refresh = "refresh-seed";
    const web = createAccountSession({
      relayUrl: RELAY,
      clientId: AccountClientId.web,
      fetch: relay.fetch,
    });
    await web.signOut();
    expect(relay.requests.at(-1)).toEqual({ path: "/oauth/revoke", client_id: "vekrel-web" });
    expect(relay.jar.refresh).toBeNull();
  });
});
