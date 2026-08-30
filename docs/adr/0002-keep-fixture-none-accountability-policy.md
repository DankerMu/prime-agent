# ADR 0002: Keep the fixture-none accountability policy

- Status: Accepted
- Date: 2026-08-30
- Decision owner: Workflow default (keep when in doubt); maintainer may revisit

## Signal

After PR #63 self-accounting, `docs/review-loop-log.jsonl` contains eight merged `fixture:none` PRs with total `gate_net_catch=0`.

All eight samples are post-merge, append-only review-accountability PRs (#48, #49, #53, #55, #57, #59, #61, and #63). Each records an already-merged implementation PR, carries no runtime/public-contract/test-oracle/build/dependency/OpenSpec behavior change, and therefore legitimately uses the existing zero-round “review not required” path.

The zero catch count is expected for a tier that runs no comprehensive implementation review. It does not show that the remaining fixture-none safeguards—scope audit, append-entry validation, repository check, CI, branch-tip integrity, self-accounting, and loop-log audit—are unnecessary.

## Decision

Keep the current `fixture:none` policy and eligibility boundary:

- no comprehensive implementation cross-review when the diff is strictly mechanical accountability bookkeeping and the Phase 2 audit finds no risk;
- retain all deterministic evidence, validation, CI, branch-tip, self-accounting, and merge-integrity gates;
- escalate out of `none` immediately if a PR changes runtime behavior, a public contract, test semantics, build/CI policy, dependencies, or OpenSpec behavior.

Do not narrow or cut the remaining gates from this sample. A future decision may revisit the tier only with evidence from a materially different `fixture:none` population or a demonstrated cost/problem in the retained safeguards.

## Consequences

- The eight-sample keep/cut obligation is discharged without weakening review coverage or merge evidence.
- Accountability PRs remain cheap but auditable.
- This decision does not alter ADR 0001: lens rotation remains separately deferred to the maintainer.
