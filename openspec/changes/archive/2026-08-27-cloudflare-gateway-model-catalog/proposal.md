## Why

`packages/ai` currently refreshes `src/models.generated.ts` from mutable online catalogs during every build. Upstream catalog drift can therefore rewrite tracked source inside CI and make unrelated commits fail typechecking or provider tests even though the committed model snapshot is valid.

## What Changes

- Make ordinary AI/workspace builds compile the committed `models.generated.ts` snapshot without invoking network-backed model generation or modifying source files.
- Keep `npm run generate-models` as the explicit maintainer action for refreshing and reviewing the snapshot.
- Preserve the committed Cloudflare AI Gateway Workers AI aliases and all existing `getModel`/provider behavior.

## Capabilities

### New Capabilities

- `reproducible-ai-model-build`: deterministic build behavior and explicit model-catalog refresh ownership.

### Modified Capabilities

None.

## Impact

- `packages/ai/package.json` build script.
- Existing generated catalog and Cloudflare Gateway tests remain behaviorally unchanged.
- Root builds, package builds, CI, release builds, and binary builds consume the checked-in snapshot.

Fixture level: expanded. The generated catalog is a public typed contract and release input; `design.md` records the build/generation separation.