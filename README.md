# @zdreamer/forge-ts-react-frontend

One opinionated frontend foundation for Forge's React CodebaseType, shared by standalone applications and embedded frontends. MIT licensed.

Source: <https://github.com/ZDreamer2/forge-ts-react-frontend>.

## Contents and release status

This source adds two development-tooling exports:

- `@zdreamer/forge-ts-react-frontend/biome` — formatting and recommended lint rules.
- `@zdreamer/forge-ts-react-frontend/tsconfig` — strict browser/React TypeScript checking.

There is no runtime API, build step, architecture checker, test harness, Vite configuration or application generator in this slice. The presets do not enforce the whole frontend guidance contract. BiCo host integration and application-specific behavior remain with their owners; this is not a wrapper around the service-specific `@zdreamer/forge-ts-service` conventions.

`0.2.0` introduces these presets and required exact tool peers; `0.1.0` and `0.1.1` were infrastructure-only releases. Consumers upgrading from `0.1.x` now install Biome and TypeScript alongside the package, but still supply their own file coverage and host integration. Publication status is authoritative on [npm](https://www.npmjs.com/package/@zdreamer/forge-ts-react-frontend), not implied by the source version.

## Installation

Use Node `>=24.18.1 <25`. The package declares exact required tool peers: Biome `2.5.4` and TypeScript `7.0.2`, matching the existing BiCo baseline without a tool upgrade. React and its types remain application dependencies; the presets do not install a React runtime. npm/pnpm auto-install required peers by default; with peer auto-installation disabled, install these exact tool versions explicitly.

For registry adoption after the release is available:

```sh
npm install --save-dev --save-exact @zdreamer/forge-ts-react-frontend@0.2.0
```

For local artifact verification, run `npm pack --ignore-scripts` in this checkout, then install the resulting `zdreamer-forge-ts-react-frontend-0.2.0.tgz` in a separate consumer using its actual absolute path. Do not use `npm link` or sibling-source imports as packaging evidence.

A local tarball is verification input, not a permanent cross-repository dependency or evidence of registry adoption. Keep the consumer's normal lockfile, release-age floor and lifecycle-script policy; migrate to an approved exact registry version when released. Neither peer needs an allowed dependency lifecycle script.

## Consumer configuration

`biome.json`:

```json
{
  "extends": ["@zdreamer/forge-ts-react-frontend/biome"],
  "files": {
    "includes": ["src/**", "*.json", "!**/routeTree.gen.ts"]
  }
}
```

The preset owns tab indentation, 120-column formatting and recommended lint rules. Each installation owns file coverage and exclusions; use paths that actually exist in your application. The preset has no BiCo globs, service environment restrictions or execution-root assumptions.

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

The preset supplies ES2023 and browser DOM libraries, bundler resolution, preserved modules, automatic React JSX, strict checking, exact optional properties, checked indexed access, no switch fallthrough, isolated modules, verbatim module syntax, erasable syntax and no emit. Explicit TypeScript import extensions are supported. Vite or another browser bundler owns asset emission; this is not a Node/service TypeScript configuration.

There are no default roots, includes, aliases or ambient type packages. `types: []` prevents installed Node/test ambient globals from silently becoming browser APIs. Imports still resolve their own types, including JSX types from React. Add `vite/client`, Node configuration-file types or test globals only to the programs that need them. A shared BiCo program can retain its existing explicit type list; splitting that program is not required by this extraction. Keep one TanStack Router registration per TypeScript program.

Example scripts for a consumer with a single program and its own test/build commands:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check ."
  }
}
```

These are tooling checks, not a complete frontend acceptance gate. The installation also owns structural enforcement, actual test discovery/execution, build checks and host/browser verification. Existing BiCo discovery and aggregate commands remain in place; do not replace them with this single-program example.

### BiCo adoption boundary

Local tarball verification retained BiCo's file coverage, program discovery and explicit `vite/client`, `node` and `@testing-library/jest-dom/vitest` typings. Replacing only the shared options with package extensions preserved both effective TypeScript programs and passed the supported `./app pnpm check` gate. That temporary checkpoint restored its dependency/configuration changes and did not establish permanent adoption.

BiCo registry adoption uses exact `0.2.0`, with development runtime pins aligned to `24.18.1` and an approved `minimumReleaseAgeExclude` entry for this exact first-party package name. Peers and transitive dependencies retain the seven-day age floor. Runtime pin edits alone do not update an existing container: rebuild it and verify the actual Node version before supported installation/checks. The local-artifact checkpoint above is not evidence of completed registry adoption.

## Development and verification

Use the exact Node version in `.nvmrc`; Corepack selects `pnpm@11.15.1` from `package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --config.verify-deps-before-run=error check
npm pack --ignore-scripts
```

This checkout is an independent installation with its own lockfile, a seven-day third-party release-age floor and no allowed dependency lifecycle scripts. The gate checks package sources with the shared Biome preset; tests use Node's built-in runner. The package test packs the publication artifact, checks its exact allowlist and SHA-512, installs it into an isolated npm consumer and exercises both exports with passing React/browser code and deliberate lint/type errors. It verifies consumer coverage, ambient type isolation and effective compiler options. It needs registry/network access for exact tool peers and fixture types; it does not use sibling-source imports, global tools or publishing credentials. Tests and invalid fixtures are not published.

CI runs the same checks and uploads an inspectable tarball with `pack.json`. After owner bootstrap and trusted-publisher setup, pushes to `main` automatically publish unpublished manifest versions through the verification gate. Versions are never bumped automatically; the unchanged already-published version skips automatic release. Do not push a version bump unless its release is authorized.

See [release operations](docs/releasing.md) for artifact validation and publication procedures. No publishing credentials belong in this repository or its GitHub secrets.
