# @zdreamer/forge-ts-react-frontend

One opinionated frontend foundation for Forge's React CodebaseType, shared by standalone applications and embedded frontends. MIT licensed.

Source: <https://github.com/ZDreamer2/forge-ts-react-frontend>.

## Bootstrap status

`0.1.0` establishes the npm identity, independent repository and checked release pipeline. It contains only package metadata, this README and the license. It exports no presets, checkers, testing helpers or runtime API, and is not yet a usable frontend foundation. Publication status is authoritative on [npm](https://www.npmjs.com/package/@zdreamer/forge-ts-react-frontend), not implied by this source version.

The intended direction is one versioned package with separate public entry points as capabilities are adopted. Exact contents and exports remain to be agreed; no existing BiCo packages or tools have been extracted, and no application has adopted this package. BiCo host integration and AiAgent-specific behavior remain with their owners. This package is the frontend counterpart of `@zdreamer/forge-ts-service`, not a wrapper around its service-specific conventions.

## Development

Use the exact Node version in `.nvmrc`; Corepack selects `pnpm@11.15.1` from `package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --config.verify-deps-before-run=error check
npm pack --ignore-scripts
```

This checkout is an independent installation with its own lockfile, a seven-day third-party release-age floor and no allowed dependency lifecycle scripts. There are currently no dependencies. Tests use Node's built-in runner: they pack the publication artifact, assert its exact allowlist, install it in an isolated npm consumer, and exercise the release guard against registry and event scenarios. No frontend behavior is tested or provided yet.

CI runs those checks and uploads an inspectable tarball with `pack.json`. The release workflow dry-runs a missing npm package; the first actual publication is owner-operated. After bootstrap and trusted-publisher setup, pushes to `main` automatically publish unpublished manifest versions through the same verification gate. Versions are not bumped automatically. Do not push a version bump unless its release is authorized.

See [release operations](docs/releasing.md) for first publication, npm trusted-publisher setup and subsequent releases. No publishing credentials belong in this repository or its GitHub secrets.
