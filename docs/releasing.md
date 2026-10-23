# Release operations

## Verification and release boundary

`ci.yml` checks pushes to `main`, pull requests and manual runs. It installs the frozen pnpm installation, runs the package/release-infrastructure tests, packs with lifecycle scripts disabled and uploads `npm-package-<full commit SHA>` for 14 days. The artifact contains one tarball and `pack.json`.

`publish.yml` serializes release attempts without cancelling active jobs. It runs on pushes to `main`, or manually on `main` with an exact manifest version and `publish=false` by default:

- A registry HTTP 404 means the package is missing: verify and dry-run only. Explicit workflow publication is rejected; first publication is owner-operated.
- For an existing package, an unpublished manifest version on a push is verified and published automatically with provenance. An already-published version skips automatic release.
- Manual dry-runs verify existing versions too, but skip npm's dry-run when that version already exists. Manual `publish=true` requires an existing package and an unpublished version.
- Registry errors other than HTTP 404, malformed responses, identity mismatches and network failures stop the release. An existing version cannot be republished.

Verification calls the same reusable CI workflow with the expected version. The release job downloads its own run's artifact, validates name/version/filename and SHA-512, then publishes that tarball without installing project dependencies or executing package lifecycle scripts. Actions are immutable-SHA pinned; checkout retains no Git credentials. Only the release job has `id-token: write`; no npm token, repository secret or GitHub environment is used. Tags and pull requests do not publish. The npm tag is `latest`; the workflow creates neither Git tags nor GitHub Releases.

A dry-run proves artifact preparation, not npm ownership, publisher configuration or provenance. Those require an actual publication and registry verification.

The current source artifact allowlist is `LICENSE`, `README.md`, `package.json`, `presets/biome-preset.json` and `presets/tsconfig.json`. Package tests and release artifact validation enforce the same list. `0.2.0` is the first version containing presets and required tool peers; `0.1.x` was metadata-only. Check registry availability rather than inferring publication from the manifest version. The first-publication instructions below describe the historical metadata-only bootstrap, not the current artifact.

## Routine release and adoption

1. Obtain owner approval for the next unused version and publication. Review capability changes where warranted; release bookkeeping alone does not need another review round.
2. Run the package's `check` command on the release source after explicit dependency setup. It already packs and tests an installed artifact; do not repeat that exercise manually.
3. Push the approved version to `main`. CI runs the same gate in its own environment; Publish validates and publishes the checked CI artifact. Observe those results rather than reconstructing their internal checks by hand.
4. Confirm registry availability, compare registry integrity with the checked CI artifact, and verify a fresh exact-version registry consumer and its signatures/provenance. The local-artifact test does not cover registry delivery. Inspect raw attestation internals when publishing infrastructure changes or a mismatch needs investigation, not as a routine parallel checklist.
5. For the selected adopting installation, exact-pin the release, install with its normal frozen/policy controls, then run its affected aggregate gate once. Run additional build/browser verification where the change requires it; do not rerun unrelated consumers automatically.

Reuse passing evidence while its checked inputs, coverage and execution environment remain unchanged. Prose-only follow-ups do not require repeating unaffected consumer suites; changes to documented behavior or verification contracts can require new checks. Record the version, release/CI links, adoption result and unresolved limitations concisely. Never remove or overwrite a published version to fix a release.

The bootstrap and publisher-configuration sections below are setup/recovery references, not steps to repeat for every release. This repository's bootstrap and trusted publishing are already established.

## First publication: owner-operated (historical bootstrap)

The initial version is `0.1.0`, an infrastructure-only bootstrap with no public API. Confirm that this limited release is still intended before publishing.

1. Obtain a successful CI or Publish dry-run for the exact source commit. Download its checked artifact, not an arbitrary local build:

   ```sh
   RELEASE_DIR="$(mktemp -d)"
   gh run download RUN_ID --repo ZDreamer2/forge-ts-react-frontend \
     --name npm-package-FULL_COMMIT_SHA --dir "$RELEASE_DIR"
   ```

2. Inspect `pack.json`: name `@zdreamer/forge-ts-react-frontend`, version `0.1.0`, files exactly `LICENSE`, `README.md`, `package.json`. Compare its `integrity` with `sha512-` plus the base64 SHA-512 digest of the downloaded tarball. Keep the checked artifact unchanged.

3. In your own terminal, using the pinned Node version and npm `11.19.0`:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   npm publish "$RELEASE_DIR"/zdreamer-forge-ts-react-frontend-0.1.0.tgz \
     --ignore-scripts --access public --registry=https://registry.npmjs.org/
   npm logout --registry=https://registry.npmjs.org/
   ```

   Confirm the npm identity is `zdreamer`; approve browser/2FA prompts yourself. Stop if the package/version already exists and inspect it rather than overwriting or blindly bumping. Keep passwords, tokens, OTPs and recovery codes out of files, logs, secrets and chat. This initial owner publication has no CI-issued OIDC provenance.

4. Verify the public version, integrity and fresh registry installation. Initial publication does not prove trusted publishing; configure it below for a subsequent version.

## Configure trusted publishing

The npm package must exist first. Prepare the next useful version and a successful manual dry-run before configuring the publisher: npm currently requires a successful publication within two days of configuration, otherwise recreate it. Do not push the unpublished version to `main` until ready: after bootstrap, that push attempts automatic publication.

On npmjs.com, open `@zdreamer/forge-ts-react-frontend` -> Settings -> Trusted Publisher -> GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `ZDreamer2` |
| Repository | `forge-ts-react-frontend` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |

The filename is `publish.yml`, not `.github/workflows/publish.yml`. Use GitHub-hosted runners, no npm publishing token. Recheck [npm's trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/) when performing setup. Saving settings does not validate the publisher; an actual authorized release must prove OIDC and provenance.

If verification of an authorized new version fails before publication, fix it and retry that same unpublished version. Version changes and publication remain explicit owner decisions.
