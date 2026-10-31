---
edit-only-context: docs/README.meta.md
---

# @zdreamer/forge-ts-react-frontend

Opinionated development tooling for standalone and embedded React frontends. MIT licensed.

Source: <https://github.com/ZDreamer2/forge-ts-react-frontend>.

| Export | Purpose |
|---|---|
| `/biome` | Formatting and recommended lint rules |
| `/tsconfig` | Strict browser/React TypeScript configuration |
| `/structure` | Node-only structural policy and coverage checks |
| `/testing` | Vitest lifecycle ownership for deferred work, HTTP and QueryClients |
| `/testing/http` | Standalone Node HTTP interception without Vitest or Query Core |

Version `0.4.0` adds the testing exports. Confirm registry availability before installing a source manifest version. This package supplies development tooling; React rendering, application providers and fixtures belong to consumers.

## Installation

Use Node `>=24.18.1 <25`, Biome `2.5.4` and TypeScript `7.0.2`. Both tools are exact required peers; install them explicitly if peer auto-installation is disabled. React and its types remain application dependencies.

```sh
npm install --save-dev --save-exact @zdreamer/forge-ts-react-frontend@0.4.0
```

Retain your installation's lockfile, release-age floor and lifecycle-script policy. Neither peer requires a dependency lifecycle script. First-party exact pins may advance during normal development; [release and adoption guidance](docs/releasing.md#routine-release-and-adoption) owns that policy and the registry-consumption sequence.

## Presets

`biome.json`:

```json
{
  "extends": ["@zdreamer/forge-ts-react-frontend/biome"],
  "files": {
    "includes": ["src/**", "*.json", "!**/routeTree.gen.ts"]
  }
}
```

The preset selects tab indentation, 120-column formatting and recommended lint rules. The installation supplies actual source roots and exclusions.

`tsconfig.json`:

```json
{
  "extends": "@zdreamer/forge-ts-react-frontend/tsconfig",
  "include": ["src"],
  "compilerOptions": {
    "types": ["vite/client"]
  }
}
```

The preset selects strict ES2023/browser checking, bundler resolution, React JSX, erasable syntax and no emit. Your bundler owns asset emission. Roots, aliases and ambient type packages are installation-owned: the default `types: []` prevents installed Node/test globals from becoming browser APIs. Add ambient types only to the programs needing them. Keep one TanStack Router registration per TypeScript program.

## Structural enforcement

Use `/structure` in Node tooling, not browser code. It checks the shared App/Component/Lib/category/group grammar, relative-import visibility, test placement and test-only imports, committed route-tree currency, and ownership/empty-category recommendations.

```ts
import { createStructureChecker } from "@zdreamer/forge-ts-react-frontend/structure";

const checker = createStructureChecker({
  root: process.cwd(),
  scopes: [{ root: "ui/src", level: "app", entry: "main.tsx" }],
  testOnlyImports: ["@project/testing"],
});

const findings = checker.checkStructure();
const scanned = checker.scanImports();
```

The installation supplies topology rather than rule overrides:

- `scopes`: app roots with named entries, or package roots with `level: "package"`. Roots are canonical repository-relative source directories, such as `ui/src`; repository-root scopes (`.`) and dot/parent segments are unsupported. The engine walks each scope, including assets and empty directories. Missing, empty, duplicate and overlapping scopes fail visibly.
- Apps require their entry and `App.tsx`. `allowedRootFiles` permits additional exact root filenames; `additionalFileCategories` permits app-root file categories with host-owned semantics. Neither weakens shared encapsulation.
- `testSupportPackages` binds local package scopes to import specifiers and grants their implementations test-support privileges. `testOnlyImports` restricts external support imports without granting local privileges. `Lib/Testing/` recognition and test-runtime restrictions remain shared policy.
- `routeTree` names the committed file under `Routes/`, defaulting to `routeTree.gen.ts`.

The factory also exposes `classifySource(path)`. Findings carry `rule`, `severity`, `path` and `message`; fail on errors, not recommendations. Configuration and filesystem failures can throw and should be reported as execution failures.

Two exports validate coverage against independent inputs:

- `compareFileCoverage("source" | "test", discovered, collected)` rejects empty discovery, missing/extra files and duplicates.
- `compareImportGraph(scanned, modules)` compares scanned static specifiers with an independently parsed graph: `{ source, dependencies: [{ module }] }[]`. Normalize parser-specific specifiers before comparison. Literal dynamic imports and re-exports are scanned; computed imports/globs are not.

The installation supplies discovery, parser/resolver integration and the aggregate gate. Resolved graph/package boundaries and host-specific restrictions need separate checks; this export does not enforce them. Combine the checks with typing, linting, tests and build/host verification. Semantic cohesion, export kinds and mount-only behavior require review or other checks; the engine does not enforce the entire frontend contract.

## Testing

The testing exports are ESM tooling for tests in Node 24. Importing either export starts no HTTP interception. `/testing/http` needs neither Vitest nor Query Core; callers create a scenario explicitly and await its `finish()` in teardown or `finally`.

`/testing` registers real Vitest `beforeEach`/`afterEach` hooks. Harness consumers explicitly install its optional peers, Vitest and `@tanstack/query-core`; the implementation is tested with `4.1.11` and `5.102.8`. Optional peers let preset/structure consumers install without a test runtime. Keep one compatible Query Core runtime with your React Query installation. MSW `2.15.0` is the implementation dependency; consumers importing its handler builders declare MSW directly. Node interception needs no browser-worker postinstall.

An installation using the tested harness versions can use:

```sh
npm install --save-dev --save-exact @zdreamer/forge-ts-react-frontend@0.4.0 vitest@4.1.11 @tanstack/query-core@5.102.8 msw@2.15.0
```

Declare one lifecycle at module scope; resources are fresh for each sequential test:

```ts
import { createTestSuiteLifecycle } from "@zdreamer/forge-ts-react-frontend/testing";
import { http } from "msw";
import { expect, it } from "vitest";

const suite = createTestSuiteLifecycle();

it("observes the acknowledged response", async () => {
  const network = suite.createHttpScenario();
  const response = network.deferResponse();
  network.use(http.get("https://example.test/title", ({ request }) => response.handle(request)));

  const title = fetch("https://example.test/title").then((result) => result.text());
  response.release(new Response("Arrived"));

  expect(await title).toBe("Arrived");
});
```

Unmatched ordinary and asset requests fail closed, and handler failures remain teardown diagnostics even if application code catches the request error. Later `network.use(...)` handlers override initial handlers. Controlled responses cancel on abort or teardown; each handles one request. Overlapping HTTP owners in one environment are rejected. Sequential tests inside isolated Vitest file workers can still run in parallel across files; do not use `it.concurrent` for lifecycle-owning tests.

Acquire promise controls with `suite.defer<T>({ label, unfinished })`, supplying a required fallback outcome such as `{ type: "resolve", value }` or `{ type: "reject", reason }`. Explicit completion is first-call-wins, with immediate rejection observation. Acquire real clients with `suite.createQueryClient(config?)`; configuration passes through unchanged. Your provider uses that client. DOM cases choose jsdom and install their React, React DOM and Testing Library dependencies.

For React, use `beforeCancel: [() => cleanup()]` to unmount consumers and `runCleanup: (finish) => act(finish)` to wrap disposal. Release responses inside `act` when they drive React updates, then await the visible application result. Providers, endpoint payloads, browser polyfills and stream/reader completion remain consumer-owned.

Teardown attempts caller unmount, query cancellation, unfinished promise outcomes and response cancellation, bounded promise/mutation settlement, caller `afterCancel`, cache clearing, HTTP draining and exact restoration. Promises and mutations share an internal one-second settlement budget; diagnostics retain unresolved labels and mutation keys. Arbitrary cleanup callbacks must terminate themselves. A failed cleanup wrapper still triggers owned disposal. `suite.finish()` permits early idempotent cleanup.

Opt into browser restoration with `browser: { documentAttributes: ["data-theme"] }`. The snapshot covers URL/history, fetch/scrollTo/clipboard descriptors, configured document attributes and local/session storage before `prepare` runs. Cleanup and restoration also run after partial preparation failure.

## Package development

Use the exact Node version in `.nvmrc`; Corepack selects the pinned pnpm version.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --config.verify-deps-before-run=error check
```

`check` builds all exports, typechecks the TypeScript suites and runner configuration, lints sources and runs the Node and Vitest suites, including an isolated packed consumer. It needs registry access for that consumer's dependencies. It does not install development dependencies, publish or deploy. Package acceptance does not replace an adopting project's own gate.

Rebuild committed `dist/` files after source edits. For manual artifact verification, run `npm pack --ignore-scripts` after building and install the tarball in an independent consumer. A tarball is verification input, not a permanent cross-repository dependency or registry-adoption evidence.

CI uses the same gate. Pushing an unpublished manifest version to `main` can publish automatically; follow the task's release authority and normal owner acceptance. See [release operations](docs/releasing.md).
