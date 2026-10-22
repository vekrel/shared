Shared packages and build tooling for Vekrel. Derived from T3 Code (MIT, see NOTICE). App repos pull `packages/` with `git subtree pull --prefix=packages <this repo> main --squash`.

## Deviations from upstream T3 Code 8d3b061
- Root package name is `@vekrel/shared-workspace` (`@vekrel/shared` collides with `packages/shared`).
- Removed root scripts that reference absent apps/native code: dev:marketing, migrate-dev-db, start, start:desktop, start:marketing, build, build:marketing, build:desktop, build:resource-monitor, knip:check, test:perf:v2-wire, test:resource-monitor, test:desktop-smoke, dist:gnome-extension.
- Removed `patchedDependencies` entries (and patch files) for app-only deps (Expo, React Native, Electron, etc.), plus two orphan Expo patches.
- `pnpm typecheck`: only `scripts` fails (6 TS2307: imports of `../apps/*/package.json` and `.github/scripts/ci-changes.cjs`); all `packages/*` pass. Resolves once consumed in an app repo.
