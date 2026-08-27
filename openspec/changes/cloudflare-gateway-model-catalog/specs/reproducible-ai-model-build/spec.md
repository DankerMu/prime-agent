## ADDED Requirements

### Requirement: Ordinary builds consume the committed AI model snapshot

The AI package and workspace build entrypoints MUST compile the committed `packages/ai/src/models.generated.ts` without invoking network-backed model generation and MUST NOT modify that snapshot. The explicit `generate-models` command MUST remain available as the maintainer-owned refresh path.

#### Scenario: Offline package build preserves the catalog

- **WHEN** a clean checkout with installed dependencies runs the AI package build while external model-catalog access is unavailable
- **THEN** the build succeeds from the committed snapshot and the snapshot's byte digest is unchanged

#### Scenario: Existing Gateway model contract survives an ordinary build

- **WHEN** an ordinary build completes and callers query `cloudflare-ai-gateway` model `workers-ai/@cf/moonshotai/kimi-k2.6`
- **THEN** typechecking and runtime lookup continue to return the committed OpenAI-compatible Gateway model with its `/compat` route and session-affinity metadata

#### Scenario: Catalog refresh is explicit

- **WHEN** a maintainer intentionally runs `npm run generate-models` in `packages/ai`
- **THEN** the generator remains able to fetch catalogs and update `models.generated.ts` for review as a separate source change