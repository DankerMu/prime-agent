/**
 * Issue #27 / OpenSpec prompt-settlement group 2: action promptId + main run
 * lease + promptAndSettle API.
 *
 * Seam 2: in-process AgentSession + faux provider (retry disabled). Tests
 * observe behavior through the public callback / query / event APIs and
 * read-only action-store inspection. The tracker's private persist count is
 * never observed; `finalMessageIds` stays empty (group 7 records them).
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActionRecoveryAction, SessionActionRecoveryPayload } from "../../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { createHeartbeatPromptMessage } from "../../src/core/messages.js";
import type { SessionAction } from "../../src/core/session-action-store.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../../src/modes/daemon/daemon-extension-binding.js";
import { createHarness, getUserTexts, type Harness } from "./harness.js";
import { createWaitingHarness, withStreaming } from "./scheduling.js";

type TurnAction = SessionAction & { payload: { kind: "turn"; text: string } };

function isTurnAction(action: SessionAction): action is TurnAction {
	return action.payload.kind === "turn";
}

/** Read-only action-store inspection for observing action runtime settlement fields. */
function turnActions(harness: Harness): TurnAction[] {
	return (harness.session as unknown as { _actionStore: { ownedActions(): SessionAction[] } })._actionStore
		.ownedActions()
		.filter(isTurnAction);
}

function actionByText(harness: Harness, text: string): TurnAction {
	const action = turnActions(harness).find((candidate) => candidate.payload.text === text);
	if (!action) throw new Error(`no turn action with text: ${text}`);
	return action;
}

function isPromptSettling(harness: Harness, promptId: string): boolean {
	// A prompt is settling iff some owned turn action still holds a lease on it.
	return turnActions(harness).some(
		(action) => action.promptIds?.includes(promptId) && (action.runLeases?.length ?? 0) > 0,
	);
}

function outcomeCount(harness: Harness): number {
	return harness.eventsOfType("prompt_outcome").length;
}

function createHeartbeatJob() {
	return {
		id: "hb-1",
		status: "active" as const,
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/s.jsonl",
		cwd: "/tmp",
		prompt: "heartbeat check",
		schedule: { kind: "interval" as const, expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		runCount: 1,
	};
}

describe("AgentSession prompt settlement (group 2)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("accepts a turn with a lease before enqueue and settles completed once", async () => {
		// Gate the agent start so the accepted action stays observable while its
		// run is preparing/committing.
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let unsubscribe = () => {};
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_start") return;
			unsubscribe();
			await startGate;
		});

		const callbacks: Array<{ supported: true; promptId?: string }> = [];
		let promptId: string | undefined;
		const settled = harness.session.promptAndSettle("first", {
			settlementAdmission: (info) => {
				callbacks.push(info);
				promptId = info.promptId;
			},
		});

		await vi.waitFor(() => expect(promptId).toBeDefined());
		// The accepted action holds one run lease and the tracker is settling.
		expect(actionByText(harness, "first").promptIds).toEqual([promptId]);
		expect(actionByText(harness, "first").runLeases).toHaveLength(1);
		expect(isPromptSettling(harness, promptId!)).toBe(true);
		expect(harness.session.getPromptOutcome(promptId!)).toBeUndefined();

		releaseStart?.();
		const outcome = await settled;
		expect(outcome).toEqual({
			promptId,
			status: "completed",
			advisor: "disabled",
			finalMessageIds: [],
			sessionEpoch: expect.any(Number),
			traceGeneration: 0,
		});
		expect(callbacks).toEqual([{ supported: true, promptId }]);
		// Event / query / wait return the same cached object, emitted exactly once.
		const events = harness.eventsOfType("prompt_outcome");
		expect(events).toHaveLength(1);
		expect(events[0]!.outcome).toBe(outcome);
		expect(harness.session.getPromptOutcome(promptId!)).toBe(outcome);
		await expect(harness.session.waitForPromptOutcome(promptId!)).resolves.toBe(outcome);
		expect(isPromptSettling(harness, promptId!)).toBe(false);
	});

	it("records run_error and settles failed on a terminal provider error", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);

		const outcome = await harness.session.promptAndSettle("boom");
		expect(outcome).toMatchObject({
			status: "failed",
			advisor: "disabled",
			finalMessageIds: [],
			failure: { reason: "run_error" },
		});
		const events = harness.eventsOfType("prompt_outcome");
		expect(events).toHaveLength(1);
		expect(events[0]!.outcome).toBe(outcome);
		expect(harness.session.getPromptOutcome(outcome!.promptId)).toBe(outcome);
	});

	it("does not let a prior failed run's fence leak into a later successful run", async () => {
		// A failed run settles failed; the next run (new prompt id) must settle
		// completed, not inherit the stale failure fence.
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
			fauxAssistantMessage("recovered"),
		]);

		const failed = await harness.session.promptAndSettle("fail run");
		expect(failed).toMatchObject({ status: "failed", failure: { reason: "run_error" } });

		const recovered = await harness.session.promptAndSettle("success run");
		expect(recovered).toMatchObject({ status: "completed" });
		expect(recovered!.promptId).not.toBe(failed!.promptId);
		expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
		expect(harness.eventsOfType("prompt_outcome")[1]!.outcome).toBe(recovered);
	});

	it("applies an aborted terminal classification to every shared all-batch owner", async () => {
		// Both batch owners share one run that ends aborted; both must settle
		// cancelled (never completed), each with exactly one outcome.
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([fauxAssistantMessage("aborted", { stopReason: "aborted" })]);
		// Queue both follow-ups while the pump is paused so "all" batching merges
		// them into one shared run.
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("batch-a", undefined, { resumeIfIdle: true });
		await harness.session.followUp("batch-b", undefined, { resumeIfIdle: true });
		const ids = [actionByText(harness, "batch-a").promptIds![0], actionByText(harness, "batch-b").promptIds![0]];
		expect(new Set(ids).size).toBe(2);
		pause.release();
		const [outcomeA, outcomeB] = await Promise.all([
			harness.session.waitForPromptOutcome(ids[0]),
			harness.session.waitForPromptOutcome(ids[1]),
		]);
		expect(outcomeA).toMatchObject({ promptId: ids[0], status: "cancelled" });
		expect(outcomeA.failure).toBeUndefined();
		expect(outcomeB).toMatchObject({ promptId: ids[1], status: "cancelled" });
		expect(outcomeB.failure).toBeUndefined();
		expect(outcomeCount(harness)).toBe(2);
		expect(harness.eventsOfType("prompt_outcome").filter((e) => e.outcome.promptId === ids[0])).toHaveLength(1);
		expect(harness.eventsOfType("prompt_outcome").filter((e) => e.outcome.promptId === ids[1])).toHaveLength(1);
	});

	it("treats a pump terminal throw as failed/run_error with exactly one event and idempotent cleanup", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);
		const internals = harness.session as unknown as { _lastRunPromptIds: string[]; _currentRunOwners: string[] };
		const sessionWithStart = harness.session as unknown as {
			_startPreparedTurnActions(actions: unknown[], epoch: number): Promise<void>;
		};
		const spy = vi.spyOn(sessionWithStart, "_startPreparedTurnActions").mockImplementation(async () => {
			throw new Error("pump exploded");
		});

		const settled = harness.session.promptAndSettle("crash");
		await expect(settled).resolves.toMatchObject({
			status: "failed",
			failure: { reason: "run_error" },
		});
		spy.mockRestore();

		// Cleanup ran once: owners cleared, action store empty, no settling residue.
		const events = harness.eventsOfType("prompt_outcome");
		expect(events).toHaveLength(1);
		expect(internals._lastRunPromptIds).toEqual([]);
		expect(internals._currentRunOwners).toEqual([]);
		expect(turnActions(harness)).toEqual([]);
		// A repeated clear is a no-op with zero extra outcome.
		harness.session.clearQueue();
		expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
	});

	it("gives two queued prompts independent ids/leases and one outcome each; A completing does not terminal B", async () => {
		let releaseFirst: (() => void) | undefined;
		let releaseSecond: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await firstGate;
				return fauxAssistantMessage("first done");
			},
			async () => {
				await secondGate;
				return fauxAssistantMessage("second done");
			},
		]);

		const firstIds: string[] = [];
		const secondIds: string[] = [];
		const first = harness.session.promptAndSettle("first", {
			settlementAdmission: (info) => firstIds.push(info.promptId!),
		});
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const second = harness.session.promptAndSettle("second", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
			settlementAdmission: (info) => secondIds.push(info.promptId!),
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["second"]));

		expect(actionByText(harness, "first").promptIds).toHaveLength(1);
		expect(actionByText(harness, "second").promptIds).toHaveLength(1);
		expect(actionByText(harness, "first").promptIds![0]).not.toBe(actionByText(harness, "second").promptIds![0]);
		expect(actionByText(harness, "first").runLeases).toHaveLength(1);
		expect(actionByText(harness, "second").runLeases).toHaveLength(1);
		const secondId = secondIds[0]!;
		expect(isPromptSettling(harness, secondId)).toBe(true);

		releaseFirst?.();
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual([]));
		// A settled, B is now running (not terminal) and still holds its lease.
		expect(harness.eventsOfType("prompt_outcome").some((event) => event.outcome.promptId === secondId)).toBe(false);
		expect(isPromptSettling(harness, secondId)).toBe(true);

		releaseSecond?.();
		await Promise.all([first, second]);
		expect(outcomeCount(harness)).toBe(2);
		const ids = harness.eventsOfType("prompt_outcome").map((event) => event.outcome.promptId);
		expect(new Set(ids).size).toBe(2);
		expect(harness.eventsOfType("prompt_outcome").every((event) => event.outcome.status === "completed")).toBe(true);
	});

	it('shares one run under "all" batching with deduped owner snapshots and per-owner settlement', async () => {
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let unsubscribe = () => {};
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([fauxAssistantMessage("shared run done")]);
		unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_start") return;
			unsubscribe();
			await startGate;
		});

		// Queue both follow-ups while the pump is paused so "all" batching merges
		// them into a single run. `followUp` queues without the admission fence.
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("batch A", undefined, { resumeIfIdle: true });
		await harness.session.followUp("batch B", undefined, { resumeIfIdle: true });
		const ids = [actionByText(harness, "batch A").promptIds![0], actionByText(harness, "batch B").promptIds![0]];
		expect(new Set(ids).size).toBe(2);
		// Each accepted action already holds its own run lease before the run.
		expect(actionByText(harness, "batch A").runLeases).toHaveLength(1);
		expect(actionByText(harness, "batch B").runLeases).toHaveLength(1);
		expect(outcomeCount(harness)).toBe(0);

		// Start the pump; both actions batch into one shared run.
		pause.release();
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		// Mid-run owner snapshots equal the deduped batch owners.
		const internals = harness.session as unknown as { _lastRunPromptIds: string[]; _currentRunOwners: string[] };
		expect([...internals._lastRunPromptIds].sort()).toEqual([...ids].sort());
		expect([...internals._currentRunOwners].sort()).toEqual([...ids].sort());
		expect(harness.session.getPromptOutcome(ids[0])).toBeUndefined();
		expect(harness.session.getPromptOutcome(ids[1])).toBeUndefined();

		releaseStart?.();
		await harness.session.waitForIdle();
		expect(outcomeCount(harness)).toBe(2);
		for (const id of ids) {
			expect(harness.session.getPromptOutcome(id)).toMatchObject({ status: "completed", finalMessageIds: [] });
		}
		expect(internals._lastRunPromptIds).toEqual([]);
		expect(internals._currentRunOwners).toEqual([]);
	});

	it("does not settle while a synchronous tool is pending; settles after the run ends", async () => {
		const { harness, waitForToolStart, releaseToolExecution, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final"),
		]);
		await waitForToolStart;
		// The waiting harness already started a "start" prompt; observe its id.
		const promptId = actionByText(harness, "start").promptIds![0];
		expect(promptId).toBeDefined();
		// While the tool is pending, no outcome exists and the lease is held.
		expect(outcomeCount(harness)).toBe(0);
		expect(harness.session.getPromptOutcome(promptId)).toBeUndefined();
		expect(isPromptSettling(harness, promptId)).toBe(true);

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		expect(outcomeCount(harness)).toBe(1);
		expect(harness.session.getPromptOutcome(promptId)).toMatchObject({ status: "completed", finalMessageIds: [] });
	});

	it("gives steer and followUp inputs fresh distinct identities that never merge into the running prompt", async () => {
		const { harness, waitForToolStart, releaseToolExecution, promptPromise } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steer done"),
			fauxAssistantMessage("followup done"),
		]);
		await waitForToolStart;

		// The waiting harness's "start" prompt is the running turn.
		const runId = actionByText(harness, "start").promptIds![0];

		// Queue both a steer and a followUp while the run is pending.
		await harness.session.steer("steer", undefined, { resumeIfIdle: true });
		await harness.session.followUp("followup", undefined, { resumeIfIdle: true });
		const steerAction = actionByText(harness, "steer");
		const followUpAction = actionByText(harness, "followup");
		const steerId = steerAction.promptIds![0];
		const followUpId = followUpAction.promptIds![0];
		// Each input gets its own lease and a fresh, distinct identity.
		expect(steerAction.runLeases).toHaveLength(1);
		expect(followUpAction.runLeases).toHaveLength(1);
		expect(new Set([runId, steerId, followUpId]).size).toBe(3);
		expect(harness.session.getPromptOutcome(steerId)).toBeUndefined();
		expect(harness.session.getPromptOutcome(followUpId)).toBeUndefined();
		expect(harness.session.getPromptOutcome(runId)).toBeUndefined();

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		// Each input settles exactly once with its own completed outcome.
		const events = harness.eventsOfType("prompt_outcome");
		const ids = new Set(events.map((event) => event.outcome.promptId));
		expect(ids.has(runId)).toBe(true);
		expect(ids.has(steerId)).toBe(true);
		expect(ids.has(followUpId)).toBe(true);
		expect(harness.session.getPromptOutcome(runId)).toMatchObject({ status: "completed" });
		expect(harness.session.getPromptOutcome(steerId)).toMatchObject({ status: "completed" });
		expect(harness.session.getPromptOutcome(followUpId)).toMatchObject({ status: "completed" });
		expect(events.filter((event) => event.outcome.promptId === steerId)).toHaveLength(1);
		expect(events.filter((event) => event.outcome.promptId === followUpId)).toHaveLength(1);
	});

	it("reports successful non-turn inputs as supported without an id and keeps the candidate reusable", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("turn done")]);

		const reports: string[] = [];
		const commandResult = await harness.session.promptAndSettle("/autonomous status", {
			settlementAdmission: (info) => reports.push(info.promptId ?? ""),
		});
		expect(commandResult).toBeUndefined();
		expect(reports).toEqual([""]);
		expect(outcomeCount(harness)).toBe(0);

		// A pre-allocated candidate used by a successful non-turn stays free.
		const reusedCandidate = "reusable-candidate";
		const commandResult2 = await harness.session.promptAndSettle("/autonomous status", {
			promptId: reusedCandidate,
			settlementAdmission: (info) => reports.push(info.promptId ?? ""),
		});
		expect(commandResult2).toBeUndefined();
		expect(reports).toEqual(["", ""]);
		expect(harness.session.getPromptOutcome(reusedCandidate)).toBeUndefined();

		const turnResult = await harness.session.promptAndSettle("real turn", { promptId: reusedCandidate });
		expect(turnResult?.promptId).toBe(reusedCandidate);
		expect(turnResult?.status).toBe("completed");
	});

	it("rejects a duplicate pre-allocated candidate with no event/record and no accepted id report", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);

		const first = harness.session.promptAndSettle("first", { promptId: "dup-id" });
		await first;

		const callbacks: Array<{ supported: true; promptId?: string }> = [];
		await expect(
			harness.session.promptAndSettle("second", {
				promptId: "dup-id",
				settlementAdmission: (info) => callbacks.push(info),
			}),
		).rejects.toMatchObject({ code: "duplicate_prompt_admission" });
		expect(callbacks).toEqual([]);
		expect(outcomeCount(harness)).toBe(1);
	});

	it("fires settlementAdmission for handled input and extension commands as supported without an id", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => (event.text === "handled" ? { action: "handled" } : undefined));
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		const reports: string[] = [];
		await harness.session.promptAndSettle("handled", {
			settlementAdmission: (info) => reports.push(info.promptId ?? ""),
		});
		await harness.session.promptAndSettle("/testcmd hi", {
			settlementAdmission: (info) => reports.push(info.promptId ?? ""),
		});
		expect(reports).toEqual(["", ""]);
		expect(commandRuns).toEqual(["hi"]);
		expect(outcomeCount(harness)).toBe(0);
	});

	it("rejects pre-admission failures (coalesce/disposing) without a new event or identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("owned done")]);
		withStreaming(harness, true);
		const reports: Array<{ supported: true; promptId?: string }> = [];
		await harness.session.prompt("first", {
			streamingBehavior: "followUp",
			followUpQueueKey: "k",
			settlementAdmission: (info) => reports.push(info),
		});
		const eventsBefore = outcomeCount(harness);
		// Same-key follow-up coalesces: not accepted, no callback, rejects like
		// promptAndWait would.
		await expect(
			harness.session.promptAndSettle("second", {
				streamingBehavior: "followUp",
				followUpQueueKey: "k",
				settlementAdmission: (info) => reports.push(info),
			}),
		).rejects.toThrow("equivalent follow-up is already pending");
		withStreaming(harness, false);
		expect(reports).toHaveLength(1); // only the first accepted turn reported
		expect(outcomeCount(harness)).toBe(eventsBefore);

		// Disposing rejects pre-admission with no new event/identity. (The
		// dispose itself cancels the previously accepted queued "first" turn —
		// session teardown semantics belong to group 6 — so only assert that the
		// post-dispose submission adds no callback and no new identity.)
		const reportsAtDispose = reports.length;
		harness.session.dispose();
		await expect(
			harness.session.promptAndSettle("after dispose", {
				settlementAdmission: (info) => reports.push(info),
			}),
		).rejects.toThrow("disposing or disposed");
		expect(reports.length).toBe(reportsAtDispose);
		expect(turnActions(harness).some((action) => action.payload.text === "after dispose")).toBe(false);
	});

	it.each([
		{ name: "the same followUpQueueKey", queueKey: "k" },
		{ name: "a different followUpQueueKey", queueKey: "k-other" },
	])(
		"rejects promptAndSettle when a prior unfinished prompt already owns the agentMessageId ($name)",
		async ({ queueKey }) => {
			// Per-call isolation: a prior PLAIN prompt() owns an unfinished queued
			// action with the caller's agentMessageId but never registers a
			// completion deferred. A second promptAndSettle with the SAME id must
			// reject with the completion-id error instead of coalescing into the old
			// action (same key) or admitting a duplicate (different key) — the
			// collision is agentMessageId completion ownership, not the queue key.
			const agentMessageId = "fixed-completion-id";
			let releaseMain: (() => void) | undefined;
			const mainGate = new Promise<void>((resolve) => {
				releaseMain = resolve;
			});
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					await mainGate;
					return fauxAssistantMessage("main done");
				},
				fauxAssistantMessage("first done"),
			]);
			const main = harness.session.prompt("main");
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));

			// A prior plain prompt() queues an unfinished action with the fixed id.
			await harness.session.prompt("first", {
				agentMessageId,
				followUpQueueKey: "k",
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
			});
			await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["first"]));
			const firstAction = turnActions(harness).find((action) => action.payload.text === "first")!;
			const firstId = firstAction.promptIds![0];
			expect(firstAction.agentMessageId).toBe(agentMessageId);

			// The second call must reject immediately (before any release), leaving
			// zero admission callback, action, or outcome residue.
			const reports: Array<{ supported: true; promptId?: string }> = [];
			let settled: { status: "resolved"; value: unknown } | { status: "rejected"; error: unknown } | undefined;
			const second = harness.session
				.promptAndSettle("second", {
					agentMessageId,
					followUpQueueKey: queueKey,
					streamingBehavior: "followUp",
					queueIfBusy: true,
					resumeIfIdle: true,
					settlementAdmission: (info) => reports.push(info),
				})
				.then(
					(value) => {
						settled = { status: "resolved", value };
					},
					(error) => {
						settled = { status: "rejected", error };
					},
				);

			await vi.waitFor(() => expect(settled?.status).toBe("rejected"));
			const rejection = settled as { status: "rejected"; error: unknown };
			expect(rejection.error).toBeInstanceOf(Error);
			expect((rejection.error as Error).message).toBe(`Prompt completion id is already in use: ${agentMessageId}`);
			expect(reports).toEqual([]);
			expect(turnActions(harness).some((action) => action.payload.text === "second")).toBe(false);
			expect(outcomeCount(harness)).toBe(0);

			// The prior turn still completes normally with its own outcome.
			releaseMain?.();
			await main;
			await harness.session.waitForIdle();
			expect(harness.session.getPromptOutcome(firstId)).toMatchObject({ status: "completed" });
			expect(outcomeCount(harness)).toBe(2); // main + first only
			await second;
		},
	);

	it("runs the duplicate-action preflight before any tracker admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const internals = harness.session as unknown as {
			_admitSessionInput(action: unknown, options?: object): { accepted: boolean };
			_promptSettlementTracker: { admit(input: { promptId: string; sessionEpoch: number }): string };
		};
		// Occupy an action id in the store via the private seam, then attempt a
		// default turn with the SAME id: assertCanEnqueue (duplicate ticket) must
		// reject BEFORE the tracker's admit is ever called.
		const occupiedId = "duplicate-preflight-id";
		internals._admitSessionInput(
			{
				id: occupiedId,
				source: "internal",
				delivery: "when_run_idle",
				wake: "external_resume",
				payload: { kind: "turn", text: "occupied", records: [], queueVisible: false },
				lifecycle: { state: "queued" },
				candidatePromptId: "occupied-candidate",
			} as unknown as SessionAction,
			{},
		);
		const admitSpy = vi.spyOn(internals._promptSettlementTracker, "admit");

		expect(() =>
			internals._admitSessionInput(
				{
					id: occupiedId,
					source: "internal",
					delivery: "when_run_idle",
					wake: "external_resume",
					payload: { kind: "turn", text: "duplicate", records: [], queueVisible: false },
					lifecycle: { state: "queued" },
					candidatePromptId: "duplicate-candidate",
				} as unknown as SessionAction,
				{},
			),
		).toThrow("Duplicate session action id");
		expect(admitSpy).not.toHaveBeenCalled();
		expect(harness.session.getPromptOutcome("duplicate-candidate")).toBeUndefined();
		expect(harness.eventsOfType("prompt_outcome")).toHaveLength(0);
		// The duplicate never entered the store.
		expect(turnActions(harness).some((action) => action.payload.text === "duplicate")).toBe(false);
	});

	it("runs the non-queued lifecycle preflight before any tracker admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const internals = harness.session as unknown as {
			_admitSessionInput(action: unknown, options?: object): { accepted: boolean };
			_promptSettlementTracker: { admit(input: { promptId: string; sessionEpoch: number }): string };
		};
		const admitSpy = vi.spyOn(internals._promptSettlementTracker, "admit");

		// An action whose lifecycle is not "queued" hits assertNewAction's second
		// explicit throw (only queued actions can be enqueued) before tracker admit.
		expect(() =>
			internals._admitSessionInput(
				{
					id: "non-queued-preflight-id",
					source: "internal",
					delivery: "when_run_idle",
					wake: "external_resume",
					payload: { kind: "turn", text: "non-queued", records: [], queueVisible: false },
					lifecycle: { state: "selected" },
					candidatePromptId: "non-queued-candidate",
				} as unknown as SessionAction,
				{},
			),
		).toThrow("Only queued session actions can be enqueued");
		expect(admitSpy).not.toHaveBeenCalled();
		expect(harness.session.getPromptOutcome("non-queued-candidate")).toBeUndefined();
		expect(harness.eventsOfType("prompt_outcome")).toHaveLength(0);
	});

	it("cancels an accepted queued default action via clearQueue with no settling residue and idempotent cleanup", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await firstGate;
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage("unused"),
		]);

		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		let clearedId: string | undefined;
		const cleared = harness.session.promptAndSettle("clear me", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
			settlementAdmission: (info) => (clearedId = info.promptId),
		});
		await vi.waitFor(() => expect(clearedId).toBeDefined());
		expect(isPromptSettling(harness, clearedId!)).toBe(true);

		expect(harness.session.clearQueue().followUp).toEqual(["clear me"]);
		const outcome = await cleared;
		expect(outcome).toMatchObject({ promptId: clearedId, status: "cancelled" });
		expect(isPromptSettling(harness, clearedId!)).toBe(false);
		expect(harness.session.getPromptOutcome(clearedId!)).toBe(outcome);

		// Second clear is a no-op with zero extra events.
		const eventsAfterClear = outcomeCount(harness);
		harness.session.clearQueue();
		expect(outcomeCount(harness)).toBe(eventsAfterClear);

		releaseFirst?.();
		await first;
	});

	it("cancels an accepted queued action via mutateQueuedMessage delete and stays idempotent", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await firstGate;
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage("unused"),
		]);

		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		let deletedId: string | undefined;
		const deleted = harness.session.promptAndSettle("delete me", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
			settlementAdmission: (info) => (deletedId = info.promptId),
		});
		await vi.waitFor(() => expect(deletedId).toBeDefined());

		expect(harness.session.mutateQueuedMessage("followUp", 0, "delete me", { type: "delete" })).toBe("applied");
		const outcome = await deleted;
		expect(outcome).toMatchObject({ promptId: deletedId, status: "cancelled" });
		expect(outcomeCount(harness)).toBe(1);
		// Second delete on an already-removed item rejects; no extra outcome.
		expect(harness.session.mutateQueuedMessage("followUp", 0, "delete me", { type: "delete" })).toBe("rejected");
		expect(outcomeCount(harness)).toBe(1);
		releaseFirst?.();
		await first;
	});

	it("inherits sibling leases all-or-nothing: partial acquire rolls back without touching parent leases", async () => {
		// Two ACTIVE parents (both gated mid-run), fixed unique ids.
		let releaseA: (() => void) | undefined;
		let releaseB: (() => void) | undefined;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const gateB = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await gateA;
				return fauxAssistantMessage("a done");
			},
			async () => {
				await gateB;
				return fauxAssistantMessage("b done");
			},
		]);

		let parentAId: string | undefined;
		let parentBId: string | undefined;
		const parentA = harness.session.promptAndSettle("parent-a", {
			settlementAdmission: (info) => (parentAId = info.promptId),
		});
		await vi.waitFor(() => expect(parentAId).toBeDefined());
		const parentB = harness.session.promptAndSettle("parent-b", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
			settlementAdmission: (info) => (parentBId = info.promptId),
		});
		await vi.waitFor(() => expect(parentBId).toBeDefined());
		const parentALeases = actionByText(harness, "parent-a").runLeases!.length;
		const parentBLeases = actionByText(harness, "parent-b").runLeases!.length;

		// Deterministic seam: make the tracker's SECOND acquire throw so the
		// inherit admission must reverse-release the first sibling lease.
		const internals = harness.session as unknown as {
			_promptSettlementTracker: {
				acquire(promptId: string, kind: "run"): unknown;
			};
		};
		const originalAcquire = internals._promptSettlementTracker.acquire.bind(internals._promptSettlementTracker);
		let acquireCalls = 0;
		vi.spyOn(internals._promptSettlementTracker, "acquire").mockImplementation((promptId: string, kind: "run") => {
			acquireCalls += 1;
			if (acquireCalls === 2) {
				throw new Error("simulated sibling acquire failure");
			}
			return originalAcquire(promptId, kind);
		});

		const admit = (
			harness.session as unknown as {
				_admitSessionInput(action: unknown, options?: object): { accepted: boolean };
			}
		)._admitSessionInput.bind(harness.session);
		let inheritId = 0;
		const makeInheritAction = (owners: string[]) => {
			inheritId += 1;
			const text = `inherit-${inheritId}`;
			return {
				id: text,
				source: "internal",
				delivery: "when_run_idle",
				wake: "external_resume",
				payload: { kind: "turn", text, records: [], queueVisible: false },
				lifecycle: { state: "queued" },
				lineage: { inherit: owners },
			} as unknown as SessionAction;
		};

		// Prevalidation passes for two active owners; the second acquire throws,
		// so the first acquired sibling lease is reverse-released and the whole
		// action never enters the store.
		const rejected = admit(makeInheritAction([parentAId!, parentBId!]));
		expect(rejected.accepted).toBe(false);
		expect(acquireCalls).toBe(2);
		vi.restoreAllMocks();
		// Neither parent lost a lease nor was cancelled/terminaled.
		expect(actionByText(harness, "parent-a").runLeases).toHaveLength(parentALeases);
		expect(actionByText(harness, "parent-b").runLeases).toHaveLength(parentBLeases);
		expect(harness.session.getPromptOutcome(parentAId!)).toBeUndefined();
		expect(harness.session.getPromptOutcome(parentBId!)).toBeUndefined();
		expect(turnActions(harness).some((action) => action.payload.text.startsWith("inherit-"))).toBe(false);

		// Both parents complete normally and each emits exactly one outcome.
		releaseA?.();
		releaseB?.();
		const [outcomeA, outcomeB] = await Promise.all([parentA, parentB]);
		expect(outcomeA).toMatchObject({ promptId: parentAId, status: "completed" });
		expect(outcomeB).toMatchObject({ promptId: parentBId, status: "completed" });
		expect(outcomeCount(harness)).toBe(2);
		expect(harness.eventsOfType("prompt_outcome").filter((e) => e.outcome.promptId === parentAId)).toHaveLength(1);
		expect(harness.eventsOfType("prompt_outcome").filter((e) => e.outcome.promptId === parentBId)).toHaveLength(1);
	});

	it("drops an inherit action whose owner is unknown or terminal before admission, without emitting", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		let parentId: string | undefined;
		const parent = harness.session.promptAndSettle("parent", {
			settlementAdmission: (info) => (parentId = info.promptId),
		});
		await parent;
		expect(harness.session.getPromptOutcome(parentId!)).toMatchObject({ status: "completed" });

		const admit = (
			harness.session as unknown as {
				_admitSessionInput(action: unknown, options?: object): { accepted: boolean };
			}
		)._admitSessionInput.bind(harness.session);
		// Unknown owner: dropped pre-admission without entering the store.
		const unknownDropped = admit({
			id: "inherit-unknown",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			payload: { kind: "turn", text: "inherit-unknown", records: [], queueVisible: false },
			lifecycle: { state: "queued" },
			lineage: { inherit: ["never-admitted-owner"] },
		} as unknown as SessionAction);
		expect(unknownDropped.accepted).toBe(false);
		// Terminal owner: dropped pre-admission without entering the store.
		const terminalDropped = admit({
			id: "inherit-terminal",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			payload: { kind: "turn", text: "inherit-terminal", records: [], queueVisible: false },
			lifecycle: { state: "queued" },
			lineage: { inherit: [parentId!] },
		} as unknown as SessionAction);
		expect(terminalDropped.accepted).toBe(false);
		expect(turnActions(harness).some((action) => action.payload.text.startsWith("inherit-"))).toBe(false);
		expect(outcomeCount(harness)).toBe(1);
	});

	it("lets an inherit action acquire an extra sibling lease and release-only on removal", async () => {
		let releaseParent: (() => void) | undefined;
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await parentGate;
				return fauxAssistantMessage("done");
			},
		]);
		let parentId: string | undefined;
		const parent = harness.session.promptAndSettle("parent", {
			settlementAdmission: (info) => (parentId = info.promptId),
		});
		await vi.waitFor(() => expect(parentId).toBeDefined());

		const admit = (
			harness.session as unknown as {
				_admitSessionInput(action: unknown, options?: object): { accepted: boolean };
			}
		)._admitSessionInput.bind(harness.session);
		const inheritAction = {
			id: "inherit-sibling-1",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			payload: { kind: "turn", text: "inherit-sibling-1", records: [], queueVisible: false },
			lifecycle: { state: "queued" },
			lineage: { inherit: [parentId!] },
		} as unknown as SessionAction;
		const accepted = admit(inheritAction);
		expect(accepted.accepted).toBe(true);
		expect(inheritAction.promptIds).toEqual([parentId]);
		expect(inheritAction.runLeases).toHaveLength(1);
		// Two independent run leases now coexist on the same owner.
		expect(isPromptSettling(harness, parentId!)).toBe(true);
		expect(turnActions(harness).filter((action) => action.promptIds?.includes(parentId!))).toHaveLength(2);

		// Non-abort removal (inherit branch): release-only, no requestCancel.
		const removed = (
			harness.session as unknown as {
				_cancelSessionActions(predicate: (action: unknown) => boolean, error: Error): unknown[];
			}
		)._cancelSessionActions((action) => action === inheritAction, new Error("removed"));
		expect(removed).toContain(inheritAction);
		// Parent still settling with its own lease intact.
		expect(isPromptSettling(harness, parentId!)).toBe(true);

		releaseParent?.();
		await parent;
		expect(harness.session.getPromptOutcome(parentId!)).toMatchObject({ status: "completed" });
		expect(outcomeCount(harness)).toBe(1);
	});

	it("keeps concurrent promptAndSettle callbacks isolated and tolerates a throwing callback", async () => {
		let releaseA: (() => void) | undefined;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await aGate;
				return fauxAssistantMessage("a done");
			},
			fauxAssistantMessage("b done"),
		]);

		const seen: string[] = [];
		const a = harness.session.promptAndSettle("a", {
			settlementAdmission: (info) => {
				seen.push(`a:${info.promptId}`);
				throw new Error("observer exploded");
			},
		});
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const b = harness.session.promptAndSettle("b", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
			settlementAdmission: (info) => seen.push(`b:${info.promptId}`),
		});
		await vi.waitFor(() => expect(seen).toHaveLength(2));

		// Each callback saw exactly its own admission; the throwing observer did
		// not prevent A from being accepted.
		const aId = seen.find((entry) => entry.startsWith("a:"))!.slice(2);
		const bId = seen.find((entry) => entry.startsWith("b:"))!.slice(2);
		expect(aId).not.toBe(bId);
		expect(isPromptSettling(harness, aId)).toBe(true);

		releaseA?.();
		const [outcomeA, outcomeB] = await Promise.all([a, b]);
		expect(outcomeA?.promptId).toBe(aId);
		expect(outcomeB?.promptId).toBe(bId);
		expect(outcomeCount(harness)).toBe(2);
	});

	it("excludes settlement identity from the recovery snapshot and generates a fresh id on restore", async () => {
		let releaseRun: (() => void) | undefined;
		const runGate = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await runGate;
				return fauxAssistantMessage("done");
			},
		]);
		// Keep the run in flight so the follow-up action stays queued and lands
		// in the snapshot. Read the QUEUED action's real old settlement id before
		// taking the snapshot.
		const pending = harness.session.promptAndSettle("queued for restore", {
			settlementAdmission: () => {},
		});
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const queued = harness.session.promptAndSettle("queued second", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["queued second"]));
		const queuedOldId = actionByText(harness, "queued second").promptIds![0];
		expect(queuedOldId).toBeDefined();

		const snapshot = harness.session.getSessionActionRecoverySnapshot();
		const record = snapshot.actions.find((action) => action.payload.kind === "turn")!;
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("promptIds");
		expect(serialized).not.toContain("runLeases");
		expect(serialized).not.toContain("candidatePromptId");
		expect(serialized).not.toContain(queuedOldId);

		// Let the in-flight run finish and the queued prompt settle in the
		// original session (no live identity leaks into restore).
		releaseRun?.();
		await Promise.all([pending, queued]);

		const restoredHarness = await createHarness();
		harnesses.push(restoredHarness);
		restoredHarness.setResponses([fauxAssistantMessage("restored done")]);
		await restoredHarness.session.restoreSessionActions(snapshot);
		const restoredAction = turnActions(restoredHarness).find((action) => action.payload.text === "queued second")!;
		const freshId = restoredAction.promptIds![0];
		expect(freshId).toBeDefined();
		expect(freshId).not.toBe(queuedOldId);

		await restoredHarness.session.resumeQueuedWork();
		await restoredHarness.session.waitForSessionInputIdle();
		await restoredHarness.session.waitForIdle();
		expect(restoredHarness.session.getPromptOutcome(freshId)).toMatchObject({ status: "completed" });
		// The old settlement id is unknown in the restored tracker.
		expect(restoredHarness.session.getPromptOutcome(queuedOldId)).toBeUndefined();
		expect(restoredHarness.eventsOfType("prompt_outcome").map((event) => event.outcome.promptId)).toEqual([freshId]);
	});

	it("settles a main turn while a background heartbeat is already pending, without a heartbeat identity", async () => {
		// Gate the main provider response so the main turn is streaming while the
		// heartbeat is accepted/queued behind it; then release the main run and
		// prove its outcome does not wait for the pending heartbeat completion.
		let releaseMain: (() => void) | undefined;
		let releaseHeartbeat: (() => void) | undefined;
		const mainGate = new Promise<void>((resolve) => {
			releaseMain = resolve;
		});
		const heartbeatGate = new Promise<void>((resolve) => {
			releaseHeartbeat = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await mainGate;
				return fauxAssistantMessage("main done");
			},
			async () => {
				await heartbeatGate;
				return fauxAssistantMessage("heartbeat done");
			},
		]);

		let promptId: string | undefined;
		const main = harness.session.promptAndSettle("main", {
			settlementAdmission: (info) => (promptId = info.promptId),
		});
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));

		// The heartbeat is accepted/queued while the main run is still streaming;
		// its completion stays pending until the gate releases.
		const heartbeat = harness.session.promptHeartbeat(createHeartbeatJob(), {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["heartbeat check"]));

		// The heartbeat action has NO settlement identity (background exclusion):
		// no candidate, no promptIds/runLeases, marker set.
		const heartbeatAction = actionByText(harness, "heartbeat check");
		expect(heartbeatAction.candidatePromptId).toBeUndefined();
		expect(heartbeatAction.promptIds).toBeUndefined();
		expect(heartbeatAction.runLeases).toBeUndefined();
		expect(heartbeatAction.noSettlementIdentity).toBe(true);

		// Release the main run: its outcome settles WITHOUT waiting for the
		// still-pending heartbeat completion.
		releaseMain?.();
		const outcome = await main;
		expect(outcome).toMatchObject({ promptId, status: "completed" });
		expect(outcomeCount(harness)).toBe(1);
		expect(harness.session.getPromptOutcome(promptId!)).toBe(outcome);

		// Releasing the gate completes the heartbeat without any settlement
		// record or event for it.
		releaseHeartbeat?.();
		await heartbeat;
		await harness.session.waitForIdle();
		expect(outcomeCount(harness)).toBe(1);
		expect(harness.session.getPromptOutcome(promptId!)).toBe(outcome);
	});

	it("re-derives the background marker for a restored queued heartbeat and emits no outcome", async () => {
		// A queued heartbeat action is snapshotted and restored into a fresh
		// session: the runtime marker is not serialized, but restore re-derives it
		// from the durable custom message, so the restored heartbeat still runs
		// without a settlement identity and produces zero prompt_outcome.
		let releaseMain: (() => void) | undefined;
		const mainGate = new Promise<void>((resolve) => {
			releaseMain = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await mainGate;
				return fauxAssistantMessage("main done");
			},
			fauxAssistantMessage("heartbeat done"),
		]);
		const main = harness.session.promptAndSettle("main");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const heartbeat = harness.session.promptHeartbeat(createHeartbeatJob(), {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["heartbeat check"]));
		const queuedHeartbeat = actionByText(harness, "heartbeat check");
		expect(queuedHeartbeat.noSettlementIdentity).toBe(true);
		expect(queuedHeartbeat.candidatePromptId).toBeUndefined();

		// The snapshot keeps the durable custom message but no settlement marker.
		const snapshot = harness.session.getSessionActionRecoverySnapshot();
		const serialized = JSON.stringify(snapshot);
		expect(serialized).toContain("heartbeat_prompt");
		expect(serialized).not.toContain("noSettlementIdentity");
		expect(serialized).not.toContain("promptIds");
		expect(serialized).not.toContain("runLeases");
		expect(serialized).not.toContain("candidatePromptId");

		// Finish the original session cleanly.
		releaseMain?.();
		await main;
		await heartbeat;
		await harness.session.waitForIdle();

		// Restore into a fresh session: the heartbeat must stay background-excluded.
		const restoredHarness = await createHarness();
		harnesses.push(restoredHarness);
		restoredHarness.setResponses([fauxAssistantMessage("restored main done")]);
		await restoredHarness.session.restoreSessionActions(snapshot);
		const restoredHeartbeat = turnActions(restoredHarness).find(
			(action) => action.payload.text === "heartbeat check",
		)!;
		expect(restoredHeartbeat.noSettlementIdentity).toBe(true);
		expect(restoredHeartbeat.candidatePromptId).toBeUndefined();
		expect(restoredHeartbeat.promptIds).toBeUndefined();
		expect(restoredHeartbeat.runLeases).toBeUndefined();

		await restoredHarness.session.resumeQueuedWork();
		await restoredHarness.session.waitForSessionInputIdle();
		await restoredHarness.session.waitForIdle();
		expect(restoredHarness.eventsOfType("prompt_outcome")).toHaveLength(0);
	});

	it("keeps a normal user-primary turn's settlement identity when a background prefix record restores beside it", async () => {
		// A legitimate normal user-primary turn may carry a custom background
		// prefix (e.g. pending next-turn context) whose custom message happens to
		// be a supported background type. On snapshot restore the background
		// marker must be derived ONLY from the primary record; a heartbeat prefix
		// must never strip the ordinary turn of its promptId/lease/outcome.
		let releaseMain: (() => void) | undefined;
		const mainGate = new Promise<void>((resolve) => {
			releaseMain = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await mainGate;
				return fauxAssistantMessage("main done");
			},
		]);
		// Queue a normal user-primary turn (visible-queued follow-up) so it lands
		// in the recovery snapshot while the main run is in flight.
		const main = harness.session.promptAndSettle("main");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const queued = harness.session.promptAndSettle("queued ordinary", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			resumeIfIdle: true,
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["queued ordinary"]));
		const oldId = actionByText(harness, "queued ordinary").promptIds![0];
		expect(oldId).toBeDefined();

		// Build a valid snapshot whose queued turn also carries a custom heartbeat
		// PREFIX record (matching ownerActionId, unique id, role "prefix") ahead of
		// its normal user primary record.
		const snapshot = harness.session.getSessionActionRecoverySnapshot();
		const record = snapshot.actions.find(
			(
				action,
			): action is SessionActionRecoveryAction & {
				payload: SessionActionRecoveryPayload & { kind: "turn" };
			} => action.payload.kind === "turn",
		)!;
		record.payload.records = [
			{
				id: "prefix-heartbeat-1",
				role: "prefix",
				message: createHeartbeatPromptMessage(createHeartbeatJob()),
				ownerActionId: record.id,
			},
			...record.payload.records,
		];

		// Finish the original session cleanly.
		releaseMain?.();
		await main;
		await queued;
		await harness.session.waitForIdle();

		// Restore into a fresh session: the ordinary primary must keep its
		// settlement identity even though a background prefix record rides along.
		const restoredHarness = await createHarness();
		harnesses.push(restoredHarness);
		restoredHarness.setResponses([fauxAssistantMessage("restored done")]);
		await restoredHarness.session.restoreSessionActions(snapshot);
		const restoredAction = turnActions(restoredHarness).find((action) => action.payload.text === "queued ordinary")!;
		expect(restoredAction.noSettlementIdentity).toBeUndefined();
		expect(restoredAction.candidatePromptId).toBeUndefined();
		const freshId = restoredAction.promptIds![0];
		expect(freshId).toBeDefined();
		expect(freshId).not.toBe(oldId);
		expect(restoredAction.runLeases).toHaveLength(1);

		// The restored ordinary turn executes and settles exactly one completed
		// prompt_outcome with the fresh id.
		await restoredHarness.session.resumeQueuedWork();
		await restoredHarness.session.waitForSessionInputIdle();
		await restoredHarness.session.waitForIdle();
		const events = restoredHarness.eventsOfType("prompt_outcome");
		expect(events).toHaveLength(1);
		expect(events[0]!.outcome).toMatchObject({ promptId: freshId, status: "completed" });
		expect(restoredHarness.session.getPromptOutcome(freshId)).toMatchObject({
			promptId: freshId,
			status: "completed",
		});
		expect(restoredHarness.session.getPromptOutcome(oldId)).toBeUndefined();
	});

	it("classifies heartbeat and RLM child notices as background-injected turns", async () => {
		// Table-driven discriminator evidence for every supported background
		// customType, via the private action-creation seam.
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const sessionInternals = harness.session as unknown as {
			_createPreparedTurnAction(schedule: string, text: string, images: undefined, options: object): TurnAction;
			_isBackgroundInjectedMessage(message: { customType: string }): boolean;
		};

		const backgroundTypes = ["heartbeat_prompt", "rlm_child_failure", "rlm_child_terminal_notice"];
		for (const customType of backgroundTypes) {
			expect(sessionInternals._isBackgroundInjectedMessage({ customType })).toBe(true);
			const action = sessionInternals._createPreparedTurnAction("followUp", "bg", undefined, {
				message: { customType, role: "custom", content: "bg", display: true, details: {}, timestamp: 0 },
				noSettlementIdentity: true,
			});
			expect(action.noSettlementIdentity).toBe(true);
			expect(action.candidatePromptId).toBeUndefined();
		}

		// A normal user turn still gets a fresh candidate (public default lineage).
		expect(sessionInternals._isBackgroundInjectedMessage({ customType: "session_slash_command" })).toBe(false);
		const userAction = sessionInternals._createPreparedTurnAction("followUp", "user", undefined, {});
		expect(userAction.noSettlementIdentity).toBeUndefined();
		expect(userAction.candidatePromptId).toBeDefined();
	});

	it("regresses prompt / promptUntilAccepted / promptAndWait timing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one done"),
			fauxAssistantMessage("two done"),
			fauxAssistantMessage("three done"),
		]);

		// prompt resolves after completion.
		await harness.session.prompt("plain");
		expect(getUserTexts(harness)).toContain("plain");
		await harness.session.waitForIdle();

		// promptUntilAccepted resolves at ownership commit; the turn still runs.
		let accepted = false;
		const untilAccepted = harness.session.promptUntilAccepted("until accepted").then(() => {
			accepted = true;
		});
		await untilAccepted;
		expect(accepted).toBe(true);
		await harness.session.waitForIdle();

		// promptAndWait resolves at completion settle.
		await harness.session.promptAndWait("wait for me");
		expect(getUserTexts(harness)).toContain("wait for me");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("sends a non-turn failure through the original error without reporting an accepted id", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("failcmd", {
						description: "failing command",
						handler: async () => {
							throw new Error("command exploded");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);
		const reports: string[] = [];
		await expect(
			harness.session.promptAndSettle("/failcmd", {
				settlementAdmission: (info) => reports.push(info.promptId ?? ""),
			}),
		).rejects.toThrow("command exploded");
		expect(reports).toEqual([]);
		expect(outcomeCount(harness)).toBe(0);
	});

	it("rejects a queued session command whose dispatch append fails, without a settlement record", async () => {
		// Reuse the queue suite's durable-append failure seam: a queued
		// `/autonomous ...` session command whose invocation append throws.
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);
		const pause = harness.session.acquireQueuedWorkPause();
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("durable invocation append failed");
		});
		const reports: string[] = [];
		const pending = harness.session.promptAndSettle("/autonomous status", {
			settlementAdmission: (info) => reports.push(info.promptId ?? ""),
		});
		// While the command is queued, no settlement record exists for it.
		expect(outcomeCount(harness)).toBe(0);
		expect(turnActions(harness).some((action) => action.payload.text === "/autonomous status")).toBe(false);

		pause.release();
		await expect(pending).rejects.toThrow("durable invocation append failed");
		// The failed non-turn reports no accepted id and leaves no record/event.
		expect(reports).toEqual([]);
		expect(outcomeCount(harness)).toBe(0);

		// The pre-allocated candidate stays reusable by a later accepted turn.
		const reused = await harness.session.promptAndSettle("after failed command", {
			promptId: "reusable-after-command-failure",
		});
		expect(reused).toMatchObject({ promptId: "reusable-after-command-failure", status: "completed" });
	});

	it("drops prompt_outcome from the daemon session-event broadcast", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		// Minimal runtime stub satisfying the bindings the daemon binding uses.
		const runtime = {
			session: harness.session,
			setRuntimeEnvScope: vi.fn((fn: () => unknown) => fn()),
			setSubagentRuntimeHost: vi.fn(),
			setRebindSession: vi.fn(),
			newSession: vi.fn(),
			fork: vi.fn(),
			switchSession: vi.fn(),
			navigateTree: vi.fn(),
			reload: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const state = {
			activeSessionId: "active-1",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "g",
			lastEventSequence: 0,
		} as unknown as ActiveSessionState;
		const broadcast = vi.fn();
		await bindActiveSessionState(state, {
			broadcast,
			shutdown: () => {},
		});

		// Direct AgentSession subscribers see the outcome.
		const directSeen: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "prompt_outcome") directSeen.push(event.outcome.promptId);
		});

		await harness.session.prompt("main");
		expect(directSeen).toHaveLength(1);

		// The daemon broadcast never carries prompt_outcome; a regular session
		// event does. `broadcast(state, message)` and the message is
		// `{ type: "session_event", event }` for session events.
		const broadcastedTypes = broadcast.mock.calls
			.map((call) => {
				const message = call[1] as { type?: string; event?: { type: string } };
				return message.type === "session_event" ? message.event?.type : message.type;
			})
			.filter((type): type is string => typeof type === "string");
		expect(broadcastedTypes).not.toContain("prompt_outcome");
		expect(broadcastedTypes).toContain("agent_end");
	});
});
