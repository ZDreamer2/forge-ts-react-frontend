# releasing.meta.md

Specification for editing [releasing.md](releasing.md). Defines purpose, usage patterns, and constraints.

## releasing.md goals and principles

- Helps release operators publish a checked artifact and verify registry adoption without repeating completed publisher bootstrap.
- Keeps approval, artifact identity and registry verification explicit. Workflows and package tests own executable validation; the guide explains their operational boundary rather than duplicating file allowlists.
- Separates routine release steps from setup/recovery references and leaves release results with the issue record.

## AiDocFormat

[BaseDoc format](AI_DOC_PLUGIN/Formats/BaseDoc/BaseDoc.format.md)

## MUST read before editing releasing.md

- [StartSimple methodology](AI_DOC_PLUGIN/Theory/StartSimple.md) - Limits operational guidance to supported procedures and consequential failure boundaries.
- `.github/workflows/publish.yml`, `.github/workflows/ci.yml` and `tests/release-workflow.test.mjs` - Own the publication triggers, permissions and artifact validation described here.

## releasing.md typical use context

### 💡 Distinct usage patterns for releasing.md

#### Authorized publication

Owner approves a package release -> operator follows routine release/adoption steps -> setup sections are consulted only for recovery.

### Role releasing.md serves during use

- Defines publication authority and the evidence needed to distinguish prepared artifacts from delivered registry adoption.
