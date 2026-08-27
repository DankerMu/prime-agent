## Context

`packages/ai/src/models.generated.ts` is committed and imported as the source of truth for `getModel` types and runtime lookup. `packages/ai` nevertheless runs `generate-models` inside every `build`, fetching models.dev and other live catalogs before compiling. On 2026-08-26 models.dev stopped duplicating the Workers AI Kimi alias under its Cloudflare AI Gateway section. CI rewrote the valid committed snapshot, then eight test call sites failed typechecking and two Gateway tests received `undefined` at runtime. The same failure reproduced on `main` and PR #44.

## Goals / Non-Goals

**Goals:**
- Make ordinary build and CI deterministic from the committed source tree and installed dependencies.
- Keep model-catalog refresh available as an explicit maintainer command whose diff can be reviewed with any required test updates.
- Preserve all committed provider/model IDs, especially `cloudflare-ai-gateway` Workers AI aliases and their `/compat`/session-affinity behavior.

**Non-Goals:**
- Do not change Cloudflare provider routing, credentials, model IDs, or tests.
- Do not fabricate aliases from a different upstream catalog or pin a replacement online model.
- Do not redesign `getModel` missing-model behavior or the generator's external-data policy.

## Decisions

1. `packages/ai` `build` runs only `tsgo -p tsconfig.build.json`; `generate-models` remains a separate script. The committed snapshot is already versioned, packaged indirectly through compiled output, and was byte-identical on the last green main commit and current main.
2. Root, CI, release, and binary builds inherit the deterministic behavior through the existing package build entrypoint. No CI-specific bypass or environment flag is added.
3. Catalog refresh remains explicit. If current upstream data removes or changes a model used by tests, the generated diff and failing check are handled together in a dedicated catalog update rather than appearing nondeterministically during unrelated builds.
4. No runtime test is added solely to inspect package-script text. Evidence uses a pre/post snapshot digest under an offline build, the existing Gateway provider tests, the full AI suite, and root static checks.

Alternatives rejected:
- Replacing Kimi with another model only hides one drift instance and weakens live Gateway coverage.
- Deriving Gateway aliases from the Workers AI catalog invents a cross-catalog relationship that models.dev no longer declares.
- Running generation in CI and restoring the file still leaves compilation behavior dependent on mutable external data.

## Risks / Trade-offs

- [Committed catalog can age between explicit refreshes] → the generated file is already version-controlled; maintainers run `npm run generate-models` intentionally and review the resulting compatibility changes.
- [Release no longer refreshes automatically] → this is deliberate reproducibility; release consumes the reviewed snapshot, while explicit refresh remains available before a release.
- [Generator can still produce a snapshot incompatible with tests] → root `npm run check` and AI tests expose that in the same catalog-update change rather than in unrelated builds.

## Migration Plan

No runtime migration. Change the package script, verify an offline build leaves the snapshot byte-identical, then run existing package/workspace gates. Rollback is the one-line script reversal, but would reintroduce network-dependent builds.