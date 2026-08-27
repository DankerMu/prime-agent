## 1. Deterministic AI build

- [x] 1.1 Change `packages/ai` ordinary build to compile the committed `models.generated.ts` without invoking `generate-models`; preserve the explicit generator command and all runtime provider/model contracts.
- [x] 1.2 Capture a pre-fix red proof where ordinary build changes the snapshot digest, then verify the fixed build succeeds with offline npm/network settings and leaves the digest byte-identical.
- [x] 1.3 Run the focused Cloudflare Gateway `/compat` and session-affinity tests, the full AI suite, root `npm run check`, and root/package build.

Fixture level: expanded
Change surface:
- `packages/ai/package.json` build and generation entrypoints; committed `packages/ai/src/models.generated.ts` is an unchanged input.
Must preserve:
- `npm run generate-models` remains the explicit refresh command.
- Existing `getModel` IDs/types, Cloudflare `/compat` URL, Gateway auth headers, and Workers AI session-affinity behavior remain unchanged.
Seams under test:
- AI package build, `getModel` lookup through existing provider tests, root typecheck, and aggregate workspace build.
Risk packs:
- Public API / CLI / script entry: selected - build and generator commands are public maintainer entrypoints.
- Config / project setup: selected - package script controls every CI and release build.
- File IO / path safety / overwrite: selected - ordinary build must stop overwriting the tracked snapshot; path trust mechanics are unchanged.
- Schema / columns / units / field names: selected - generated provider/model keys form the TypeScript lookup contract.
- Auth / permissions / secrets: not selected - no credential handling changes.
- Concurrency / shared state / ordering: not selected - build is serial and no shared runtime state changes.
- Resource limits / large input / discovery: not selected - external discovery remains only in the unchanged explicit generator.
- Legacy compatibility / examples: selected - committed Gateway/Workers aliases and existing callers must remain valid.
- Error handling / rollback / partial outputs: selected - ordinary build must leave source byte-identical even without catalog network access.
- Release / packaging / dependency compatibility: selected - root, release, binary, and CI builds all call the package build.
- Documentation / migration notes: not selected - script names remain; no user migration.
- TUI focus/render lifecycle: not selected - unrelated package.
- Session/extension teardown lifecycle: not selected - unrelated runtime.
Required evidence:
- Pre-fix checksum guard: current `npm run build --workspace @earendil-works/pi-ai` changes `models.generated.ts` -> nonzero guard; restore the file afterward.
- Fixed offline build with pre/post SHA-256 -> exit 0 and identical digest.
- Focused `openai-completions-empty-tools` tests -> seven passed, including Gateway `/compat` and affinity assertions.
- Full AI suite -> zero failures; root `npm run check` and `npm run build` -> exit 0.
Non-goals:
- No model replacement, generated snapshot refresh, provider routing change, or `getModel` redesign.