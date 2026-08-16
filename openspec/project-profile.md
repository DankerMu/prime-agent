# Project Profile

Living artifact maintained by `subagent-workflow` Phase 0.5.

Project profile: Prime Agent TypeScript monorepo (Generic-derived)

Entry surfaces:
- `packages/coding-agent/src/cli.ts`, `src/main.ts`, interactive TUI, RPC/daemon modes, and extension UI context
- Shared runtime libraries under `packages/{tui,ai,agent}` and `prime-agent-runtime/`

Contracts:
- Extension APIs and host-request result/error shapes
- TUI editor-surface ownership, focus, render, and session teardown ordering
- Daemon/RPC process, session, and cancellation lifecycles

Risk axes:
- Focus/container ownership races and lost Promise settlement in interactive TUI flows
- Session replacement, abort, teardown, hot reload, and asynchronous component lifecycle ordering
- Cross-package TypeScript API compatibility and generated/bundled assets

Typical evidence:
- Focused Vitest/Node tests at changed public seams, TypeScript build/check, coding-agent CI suite, and full workspace tests

Command entry points:
- Install: `npm ci`
- Static checks: `npm run check`
- Coding-agent focused test (run from package root): `npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts`
- CI-only aggregate gates: root build plus coding-agent shards/process/kernel and workspace tests from `.github/workflows/ci.yml`

Verification matrix:
- Interactive TUI state/focus/extension surface -> specific Vitest files from `packages/coding-agent` -> scenario assertions and zero failed tests
- Cross-package TypeScript/API surface -> `npm run check` -> exit 0 with no lint/type/check errors
- Unchanged workspace consumers -> GitHub CI build and test matrix -> every visible check succeeds
- Process/session teardown surface -> relevant specific Vitest file locally; GitHub CI process smoke when process behavior changes -> exit 0

Domain risk packs:
- TUI focus/render lifecycle
- Session/extension teardown lifecycle

Domain expanded-triggers:
- `editorContainer`, `setFocus`, dialog/overlay ownership, `session_replaced`, `resetExtensionUI`, `stop`/`dispose`, extension UI callbacks
