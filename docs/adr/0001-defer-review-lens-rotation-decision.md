# ADR 0001: Defer the review lens-rotation cut decision

- Status: Deferred
- Date: 2026-08-21
- Decision owner: Maintainer

## Signal

After PR #51, `docs/review-loop-log.jsonl` contains eleven merged multi-round PRs with lens attribution. Later-round verified catches remain pinned-core `2`, rotated-in `0`. PR #51's second comprehensive round was clean and added no distinct later-round catch, so the additional sample does not change the prior signal.

This remains above the configured decision threshold and favors reverting follow-up rounds to the round-1 lens mix: every later-round catch came from a round-1 lens on fix-touched test evidence.

## Deferral

Do not change reviewer policy under the implementation/merge pre-authorization. The workflow defines keep/cut as a maintainer-owned human decision, and the current authorization does not extend to narrowing future review coverage.

Keep the current pinned-core plus signal-triggered rotation policy until the maintainer explicitly chooses one of:

- revert follow-up rounds to the round-1 mix, based on the eleven-PR `core=2 / rotated=0` sample;
- keep rotation, with a stated correctness or recall rationale despite zero distinct rotated-lens catches.

Until that decision, the correctness-first default applies: no reviewer coverage is removed. No additional issue is filed because this ADR is the tracked decision record and the loop audit will continue to surface the outstanding decision.
