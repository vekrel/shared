# Vekrel-Shared

What this repo is: the shared TypeScript packages (contracts, client runtime, provider adapters, source-control adapters) and build tooling used by every Vekrel app repo. Not runnable on its own.

Shared packages and build tooling for Vekrel. Highly inspired by T3 Code (MIT, see NOTICE). App repos pull `packages/` with `git subtree pull --prefix=packages <this repo> main --squash`.

## Deviations from upstream T3 Code 8d3b061
- Root package name is `@vekrel/shared-workspace` (`@vekrel/shared` collides with `packages/shared`).
- Removed root scripts that reference absent apps/native code: dev:marketing, migrate-dev-db, start, start:desktop, start:marketing, build, build:marketing, build:desktop, build:resource-monitor, knip:check, test:perf:v2-wire, test:resource-monitor, test:desktop-smoke, dist:gnome-extension.
- Removed `patchedDependencies` entries (and patch files) for app-only deps (Expo, React Native, Electron, etc.), plus two orphan Expo patches.
- `scripts` is not a workspace member (kept on disk); app repos copy their own scripts from T3 Code. `pnpm typecheck` exits 0.
