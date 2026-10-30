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

Version `0.3.0` adds `/structure`; `0.2.0` supplies the presets only. This package supplies no React runtime, test harness or application generator.

## Installation

Use Node `>=24.18.1 <25`, Biome `2.5.4` and TypeScript `7.0.2`. Both tools are exact required peers; install them explicitly if peer auto-installation is disabled. React and its types remain application dependencies.

```sh
npm install --save-dev --save-exact @zdreamer/forge-ts-react-frontend@0.3.0
```

Retain your installation's lockfile, release-age floor and lifecycle-script policy. Neither peer requires a dependency lifecycle script.

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

## Package development

Use the exact Node version in `.nvmrc`; Corepack selects the pinned pnpm version.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --config.verify-deps-before-run=error check
```

`check` builds the engine, lints sources and runs tests, including an isolated packed consumer. It needs registry access for that consumer's dependencies. It does not install development dependencies, publish or deploy. Package acceptance does not replace an adopting project's own gate.

Rebuild committed `dist/` files after source edits. For manual artifact verification, run `npm pack --ignore-scripts` after building and install the tarball in an independent consumer. A tarball is verification input, not a permanent cross-repository dependency or registry-adoption evidence.

CI uses the same gate. Pushing an unpublished manifest version to `main` can publish automatically; do not bump or push a release version without approval. See [release operations](docs/releasing.md).
