# ADR 0001: Defer the review lens-rotation cut decision

- Status: Deferred
- Date: 2026-08-21
- Decision owner: Maintainer

## Signal

After PR #60, `docs/review-loop-log.jsonl` contains thirteen merged multi-round PRs with lens attribution. Later-round verified catches are pinned-core `5`, rotated-in `0`. PR #60 contributed one Round 2 `state-transition` catch from the pinned `integration` lens; its Round 3 was clean.

This remains above the configured decision threshold and favors reverting follow-up rounds to the round-1 lens mix: every later-round catch came from a lens already present in Round 1.

## Deferral

Do not change reviewer policy under the implementation/merge pre-authorization. The workflow defines keep/cut as a maintainer-owned human decision, and the current authorization does not extend to narrowing future review coverage.

Keep the current pinned-core plus signal-triggered rotation policy until the maintainer explicitly chooses one of:

- revert follow-up rounds to the round-1 mix, based on the thirteen-PR `core=5 / rotated=0` sample;
- keep rotation, with a stated correctness or recall rationale despite zero distinct rotated-lens catches.

Until that decision, the correctness-first default applies: no reviewer coverage is removed. No additional issue is filed because this ADR is the tracked decision record and the loop audit will continue to surface the outstanding decision.
