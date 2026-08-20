# ADR 0001: Defer the review lens-rotation cut decision

- Status: Deferred
- Date: 2026-08-20
- Decision owner: Maintainer

## Signal

After PR #22, `docs/review-loop-log.jsonl` contains eight merged multi-round PRs with lens attribution. Later-round verified catches are pinned-core `2`, rotated-in `0`. This meets the configured decision threshold and currently favors reverting follow-up rounds to the round-1 lens mix.

## Deferral

Keep the current pinned-core plus signal-triggered rotation policy through the remaining `tui-dialog-arbiter` closeout issue #12. The implementation/merge pre-authorization does not authorize narrowing the workflow's review policy, and changing the lens policy before the final issue would make one epic use two review regimes.

Revisit after issue #12 closes epic #2, using the then-current log. The maintainer should choose one of:

- revert follow-up rounds to the round-1 mix if rotated-in lenses still have no verified later-round catch;
- keep rotation only if issue #12 or new evidence demonstrates distinct rotated-lens recall.

Until that decision, correctness-first default applies: no reviewer coverage is removed.
