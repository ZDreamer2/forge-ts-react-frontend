# README.meta.md

Specification for editing [README.md](../README.md). Defines purpose, usage patterns, and constraints.

## README.md goals and principles

- Helps independent consumers configure the exports and understand what remains their installation's responsibility, without requiring a BiCo checkout or Forge workflow knowledge.
- Serves package maintainers through supported build/check/artifact commands, not a transcript of checks or consumer migration history.
- Distinguishes source capabilities from published availability so consumers do not attempt unsupported imports. Release procedures belong to the release guide; project adoption status and acceptance evidence belong to those projects.

## AiDocFormat

[BaseDoc format](AI_DOC_PLUGIN/Formats/BaseDoc/BaseDoc.format.md)

## MUST read before editing README.md

- [StartSimple methodology](AI_DOC_PLUGIN/Theory/StartSimple.md) - Keeps adoption instructions focused on supported capabilities and observed integration needs.
- `package.json`, `src/structure.ts` and `tests/package.test.mjs` - Own public exports, inputs and installed-consumer evidence; prose cannot claim capabilities they do not implement.

## README.md typical use context

### 💡 Distinct usage patterns for README.md

#### Independent package adoption

Consumer selects frontend tooling -> package README supplies installation, configuration and acceptance commands.

### Role README.md serves during use

- Explains supported public consumption and the division between foundation and installation responsibilities.
