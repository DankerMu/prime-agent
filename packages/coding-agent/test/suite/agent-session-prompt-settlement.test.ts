/**
 * OpenSpec prompt-settlement, groups 2-4, shared session-level suite.
 *
 * Group 2 (issue #27): action promptId + main run lease + promptAndSettle
 * API. These tests use the retry-disabled faux provider so each error is
 * terminal and the settlement classification is observable directly.
 *
 * Group 3 (issue #28): retry lease. These tests run retry-enabled and
 * instrument the tracker's `acquire(id, "retry")` and the returned
 * `PromptLease.release` by object identity — outcome-only assertions cannot
 * see group-3 leases because the group-2 run lease already spans the retry
 * chain.
 *
 * Seam 2: in-process AgentSession + faux provider. Tests observe behavior
 * through the public callback / query / event APIs and read-only action-store
 * inspection. The tracker's private persist count is never observed;
 * `finalMessageIds` stays empty (group 7 records them).
 */

import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActionRecoveryAction, SessionActionRecoveryPayload } from "../../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { createHeartbeatPromptMessage, createRlmChildFailureMessage } from "../../src/core/messages.js";
import type { PromptLease, PromptLeaseKind } from "../../src/core/prompt-settlement.js";
import type { SessionAction } from "../../src/core/session-action-store.js";
import type { ExtensionFactory } from "../../src/index.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../../src/modes/daemon/daemon-extension-binding.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, createWaitingHarness, gatedHook, withStreaming } from "./scheduling.js";

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

interface RetryLeaseRecord {
	promptId: string;
	kind: "retry";
	releaseCalls: number;
}

/**
 * Direct group-3 instrumentation: spy the tracker's `acquire` and wrap every
 * returned `PromptLease.release` so a retry lease's acquisition and each
 * release are observed by object identity. Outcome-only assertions cannot see
 * group-3 leases because the group-2 run lease already spans the retry chain.
 */
function installRetryLeaseObserver(harness: Harness): {
	acquireLog: Array<{ promptId: string; kind: PromptLeaseKind }>;
	retryLeases: RetryLeaseRecord[];
	restore: () => void;
	acquiresOfKind: (kind: "retry") => Array<{ promptId: string; kind: "retry" }>;
} {
	const internals = harness.session as unknown as {
		_promptSettlementTracker: { acquire(promptId: string, kind: PromptLeaseKind): PromptLease };
	};
	const tracker = internals._promptSettlementTracker;
	const originalAcquire = tracker.acquire.bind(tracker);
	const acquireLog: Array<{ promptId: string; kind: PromptLeaseKind }> = [];
	const retryLeases: RetryLeaseRecord[] = [];
	const spy = vi.spyOn(tracker, "acquire").mockImplementation((promptId: string, kind: PromptLeaseKind) => {
		acquireLog.push({ promptId, kind });
		const lease = originalAcquire(promptId, kind);
		if (kind === "retry") {
			const record: RetryLeaseRecord = { promptId, kind: "retry", releaseCalls: 0 };
			// Capture the base release BEFORE wrapping: the lease object is
			// mutated in place, so `lease.release()` after the wrap would recurse.
			const baseRelease = lease.release.bind(lease);
			const wrapped = lease as PromptLease & { release: () => void };
			wrapped.release = () => {
				record.releaseCalls += 1;
				baseRelease();
			};
			retryLeases.push(record);
		}
		return lease;
	});
	return {
		acquireLog,
		retryLeases,
		acquiresOfKind: (kind) =>
			acquireLog.filter((entry) => entry.kind === kind) as Array<{
				promptId: string;
				kind: "retry";
			}>,
		restore: () => {
			spy.mockRestore();
		},
	};
}

interface ContinuationLeaseRecord {
	promptId: string;
	kind: "compaction_continuation";
	releaseCalls: number;
}

/**
 * Direct group-4 instrumentation: spy the tracker's `acquire` and wrap every
 * returned `compaction_continuation` lease's `release()` by object identity,
 * and spy `bumpTraceGeneration` with exact owners/call counts.
 */
function installContinuationObserver(harness: Harness): {
	acquireLog: Array<{ promptId: string; kind: PromptLeaseKind }>;
	acquireContexts: Array<{ promptId: string; runLeasesHeld: number; outcomeAtAcquire: unknown }>;
	continuationLeases: ContinuationLeaseRecord[];
	retryLeases: RetryLeaseRecord[];
	generationBumps: string[];
	timeline: string[];
	acquiresOfContinuation: () => Array<{ promptId: string; kind: "compaction_continuation" }>;
	restore: () => void;
} {
	const internals = harness.session as unknown as {
		_promptSettlementTracker: {
			acquire(promptId: string, kind: PromptLeaseKind): PromptLease;
			bumpTraceGeneration(promptId: string): void;
		};
	};
	const tracker = internals._promptSettlementTracker;
	const originalAcquire = tracker.acquire.bind(tracker);
	const originalBump = tracker.bumpTraceGeneration.bind(tracker);
	const acquireLog: Array<{ promptId: string; kind: PromptLeaseKind }> = [];
	const acquireContexts: Array<{ promptId: string; runLeasesHeld: number; outcomeAtAcquire: unknown }> = [];
	const continuationLeases: ContinuationLeaseRecord[] = [];
	const retryLeases: RetryLeaseRecord[] = [];
	const generationBumps: string[] = [];
	const timeline: string[] = [];
	const acquireSpy = vi.spyOn(tracker, "acquire").mockImplementation((promptId: string, kind: PromptLeaseKind) => {
		acquireLog.push({ promptId, kind });
		if (kind === "compaction_continuation") {
			timeline.push("continuation_acquire");
			// The production oracle must prove the continuation lease is acquired
			// BEFORE the old run terminal consumes the action run leases: capture
			// the run-lease count for this owner at the acquire instant.
			acquireContexts.push({
				promptId,
				runLeasesHeld: turnActions(harness).reduce(
					(count, action) => count + (action.promptIds?.includes(promptId) ? (action.runLeases?.length ?? 0) : 0),
					0,
				),
				outcomeAtAcquire: harness.session.getPromptOutcome(promptId),
			});
		}
		const lease = originalAcquire(promptId, kind);
		if (kind === "compaction_continuation") {
			const record: ContinuationLeaseRecord = { promptId, kind: "compaction_continuation", releaseCalls: 0 };
			const baseRelease = lease.release.bind(lease);
			const wrapped = lease as PromptLease & { release: () => void };
			wrapped.release = () => {
				record.releaseCalls += 1;
				baseRelease();
			};
			continuationLeases.push(record);
		} else if (kind === "retry") {
			const record: RetryLeaseRecord = { promptId, kind: "retry", releaseCalls: 0 };
			const baseRelease = lease.release.bind(lease);
			const wrapped = lease as PromptLease & { release: () => void };
			wrapped.release = () => {
				record.releaseCalls += 1;
				baseRelease();
			};
			retryLeases.push(record);
		}
		return lease;
	});
	const bumpSpy = vi.spyOn(tracker, "bumpTraceGeneration").mockImplementation((promptId: string) => {
		generationBumps.push(promptId);
		originalBump(promptId);
	});
	return {
		acquireLog,
		acquireContexts,
		continuationLeases,
		retryLeases,
		generationBumps,
		timeline,
		acquiresOfContinuation: () =>
			acquireLog.filter((entry) => entry.kind === "compaction_continuation") as Array<{
				promptId: string;
				kind: "compaction_continuation";
			}>,
		restore: () => {
			acquireSpy.mockRestore();
			bumpSpy.mockRestore();
		},
	};
}

interface ContinuationInternals {
	_lastRunPromptIds: string[];
	_currentRunOwners: string[];
	_postCompactionContinuationMessages: AgentMessage[];
	_scheduledPostCompactionContinuationMessages: AgentMessage[];
	_postCompactionContinuationScheduled: boolean;
	_postCompactionContinuationTimer: unknown;
	_continuationSchedulingPause: { release(): void } | undefined;
	_continuationPumpOwnerAction: unknown | undefined;
	_lastRunTerminalStopReason: AssistantMessage["stopReason"] | undefined;
	_pendingRequestedCompaction: { customInstructions?: string } | undefined;
	_pendingThresholdCompactionAutonomousMessages: AgentMessage[];
	_continuationSettlementWindow:
		| {
				owners: string[];
				leases: unknown[];
				obligationMessages: AgentMessage[];
				revision: number;
				state: "scheduled" | "running" | "parked";
				pumpOwned: boolean;
				overflowRecoveryOwners?: string[];
		  }
		| undefined;
	_runAutoCompaction(reason: "overflow" | "threshold" | "requested", willRetry: boolean): Promise<boolean>;
	_runPreTurnCompaction(): Promise<void>;
	_invalidatePendingAutoRefineForBranchChange(): Promise<void>;
	_continueAfterThresholdCompaction: boolean;
	_schedulePostCompactionContinue(): void;
	_scheduleContinuationForObligation(owners: string[], obligationMessages: AgentMessage[]): boolean;
	_cancelPostCompactionContinue(options?: { owners?: "release" | "cancel" | "fail" }): boolean;
	_resumeContinuationSettlementAfterManualCompact(): void;
	_runScheduledPostCompactionContinue(): Promise<void>;
	_runDirectContinuation(
		continuationMessages: AgentMessage[],
		windowAtEntry: { owners: string[]; revision: number } | undefined,
	): Promise<void>;
	_runDirectContinuationUnderMatchingRetry(
		continuationMessages: AgentMessage[],
		windowAtEntry: { owners: string[]; revision: number } | undefined,
	): Promise<void>;
	_provisionalOverflowContinuationOwners: string[];
	_retryWindow: RetryWindowTuple | undefined;
	_retryPromise: Promise<void> | undefined;
	_retryResolve: (() => void) | undefined;
	_retryAttempt: number;
	_promptSettlementTracker: {
		acquire(promptId: string, kind: PromptLeaseKind): PromptLease;
		recordFailure(promptId: string, reason: string): void;
		bumpTraceGeneration(promptId: string): void;
		isSettling(promptId: string): boolean;
	};
}

function continuationInternals(harness: Harness): ContinuationInternals {
	return harness.session as unknown as ContinuationInternals;
}

/** Extension factory that supplies a compaction summary so `_performCompaction` succeeds without a model summarizer call. */
function compactSummaryExtension(summary = "generated summary") {
	return (pi: Parameters<ExtensionFactory>[0]) => {
		pi.on("session_before_compact", async (event) => ({
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: "extension" },
			},
		}));
	};
}

/** Admit owner promptIds directly through the tracker seam (settling, zero run leases). */
function admitOwners(harness: Harness, ...owners: string[]): void {
	const tracker = (
		harness.session as unknown as {
			_promptSettlementTracker: { admit(input: { promptId: string; sessionEpoch: number }): string };
		}
	)._promptSettlementTracker;
	for (const owner of owners) {
		tracker.admit({ promptId: owner, sessionEpoch: 1 });
	}
}

/** Seed enough session history for `prepareCompaction` to find a cut point (keepRecentTokens: 1 covers just the tail). */
function seedSessionForCompaction(harness: Harness): void {
	const user = {
		role: "user",
		content: [{ type: "text", text: "older turn with enough retained context" }],
		timestamp: Date.now() - 2000,
	};
	const assistant = {
		...fauxAssistantMessage("older response"),
		timestamp: Date.now() - 1000,
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(user as never);
	harness.sessionManager.appendMessage(assistant as never);
	harness.session.agent.state.messages = [user, assistant] as AgentMessage[];
}

function appendCompactionTurn(harness: Harness, text: string): void {
	const message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
	harness.sessionManager.appendMessage(message as never);
	harness.session.agent.state.messages = [...harness.session.agent.state.messages, message];
}

function continuationMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function compactRequestTool(getHarness: () => Harness): AgentTool {
	return {
		name: "request-compact",
		label: "Request compact",
		description: "Requests model-driven compaction for the active turn",
		parameters: Type.Object({}),
		execute: async () => {
			const result = getHarness().session.handleCompactHostRequest("compact.run");
			if (result.scheduled !== true) throw new Error(`compact.run was not scheduled: ${String(result.reason)}`);
			return { content: [{ type: "text", text: "compaction requested" }], details: {} };
		},
	};
}

/** Same large-context tool the existing production threshold oracle uses to cross compaction. */
function largeContextThresholdTool(): AgentTool {
	return {
		name: "large-context",
		label: "Large context",
		description: "Returns enough context to cross the compaction threshold",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "x".repeat(800_000) }],
			details: {},
		}),
	};
}

function admitTrackedContinuationAction(harness: Harness, message: AgentMessage, wake = false): void {
	const session = harness.session as unknown as {
		_createPreparedTurnAction(
			schedule: "followUp",
			text: string,
			images: undefined,
			options: { message: AgentMessage; resumeIfIdle: boolean; noSettlementIdentity: boolean },
		): unknown;
		_admitSessionInput(action: unknown, options: { wake: boolean }): { accepted: boolean };
	};
	const text = getMessageText(message);
	expect(
		session._admitSessionInput(
			session._createPreparedTurnAction("followUp", text, undefined, {
				message,
				resumeIfIdle: true,
				noSettlementIdentity: true,
			}),
			{ wake },
		),
	).toMatchObject({ accepted: true });
}

interface RetryWindowTuple {
	capturedPromptIds: string[];
	leases: unknown[];
}

interface RetryInternals {
	_lastRunPromptIds: string[];
	_currentRunOwners: string[];
	_retryWindow: RetryWindowTuple | undefined;
	_retryAttempt: number;
	_retryPromise: Promise<void> | undefined;
	_retryResolve: (() => void) | undefined;
	_resolveRetry: () => void;
	_createRetryWindow: () => boolean;
	_handleRetryableError: (message: AssistantMessage) => Promise<boolean>;
	_handleAgentEvent: (event: AgentEvent) => void;
	_promptSettlementTracker: { acquire(promptId: string, kind: PromptLeaseKind): PromptLease };
}

function retryInternals(harness: Harness): RetryInternals {
	return harness.session as unknown as RetryInternals;
}

function retryableError(): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
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

	describe("background primary classification (Round 1 contract)", () => {
		// A background custom primary (heartbeat / RLM child notices) must never
		// receive a candidate, tracker admission, run lease, or prompt_outcome on
		// ANY construction/replay entrypoint; only the primary message decides.
		const backgroundMessages = () => [
			createHeartbeatPromptMessage(createHeartbeatJob()),
			createRlmChildFailureMessage({ childId: "child-1", sessionName: "child", error: "boom" }),
		];

		it.each([
			{ name: "restoreFollowUpMessage", schedule: "followUp" as const },
			{ name: "restoreSteeringMessage", schedule: "steer" as const },
		])("$name keeps a heartbeat/RLM primary settlement-excluded through execution", async ({ schedule }) => {
			const harness = await createHarness();
			harnesses.push(harness);
			// One completed run per queued background turn (2 messages x 2 schedules).
			harness.setResponses(backgroundMessages().flatMap(() => [fauxAssistantMessage("bg done")]));
			for (const message of backgroundMessages()) {
				const text = `${schedule} bg ${message.customType}`;
				if (schedule === "followUp") {
					await harness.session.restoreFollowUpMessage(text, undefined, { customMessage: message });
				} else {
					await harness.session.restoreSteeringMessage(text, undefined, { customMessage: message });
				}
				const action = actionByText(harness, text);
				expect(action.noSettlementIdentity).toBe(true);
				expect(action.candidatePromptId).toBeUndefined();
				expect(action.promptIds).toBeUndefined();
				expect(action.runLeases).toBeUndefined();
			}
			// Execute the queued background turns; zero settlement identity/outcome.
			harness.session.resumeQueuedWork();
			await harness.session.waitForIdle();
			expect(outcomeCount(harness)).toBe(0);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(0);
			expect(turnActions(harness)).toEqual([]);
		});

		it.each(["followUp", "steer"] as const)(
			"sendCustomMessage streaming %s keeps a heartbeat primary settlement-excluded",
			async (deliverAs) => {
				const harness = await createHarness();
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage("streamed bg done")]);
				withStreaming(harness, true);
				await harness.session.sendCustomMessage(
					{
						customType: "heartbeat_prompt",
						content: `streamed heartbeat ${deliverAs}`,
						display: true,
						details: {},
					},
					{ deliverAs },
				);
				const action = turnActions(harness).find(
					(candidate) => candidate.payload.text === `streamed heartbeat ${deliverAs}`,
				)!;
				expect(action).toBeDefined();
				expect(action.noSettlementIdentity).toBe(true);
				expect(action.candidatePromptId).toBeUndefined();
				expect(action.promptIds).toBeUndefined();
				expect(action.runLeases).toBeUndefined();
				withStreaming(harness, false);
				harness.session.resumeQueuedWork();
				await harness.session.waitForIdle();
				expect(outcomeCount(harness)).toBe(0);
			},
		);

		it("sendCustomMessage triggerTurn keeps a heartbeat primary settlement-excluded through its run", async () => {
			let releaseRun: (() => void) | undefined;
			const runGate = new Promise<void>((resolve) => {
				releaseRun = resolve;
			});
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					await runGate;
					return fauxAssistantMessage("trigger bg done");
				},
			]);
			const pending = harness.session.sendCustomMessage(
				{ customType: "heartbeat_prompt", content: "trigger heartbeat", display: true, details: {} },
				{ triggerTurn: true },
			);
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			const action = actionByText(harness, "trigger heartbeat");
			expect(action.noSettlementIdentity).toBe(true);
			expect(action.candidatePromptId).toBeUndefined();
			expect(action.promptIds).toBeUndefined();
			expect(action.runLeases).toBeUndefined();
			releaseRun?.();
			await pending;
			await harness.session.waitForIdle();
			expect(outcomeCount(harness)).toBe(0);
		});

		it("_prompt with a custom heartbeat primary reports exactly one no-id settlement admission after completion", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("custom prompt done")]);
			const reports: Array<{ supported: true; promptId?: string }> = [];
			const settled = await harness.session.promptAndSettle("text from caller", {
				customMessage: createHeartbeatPromptMessage(createHeartbeatJob()),
				settlementAdmission: (info) => reports.push(info),
			});
			// Settlement-excluded: the call is a successful non-settlement turn, no
			// prompt_outcome is produced, and `promptAndSettle` resolves undefined.
			expect(settled).toBeUndefined();
			// The one-shot no-id report fires exactly once, only after completion.
			expect(reports).toEqual([{ supported: true }]);
			expect(outcomeCount(harness)).toBe(0);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(0);
		});

		it("reports no-id settlement admission exactly once with a throwing observer and no action leak", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("custom prompt done")]);
			let reports = 0;
			const pending = harness.session.promptAndSettle("text from caller", {
				customMessage: createHeartbeatPromptMessage(createHeartbeatJob()),
				settlementAdmission: () => {
					reports++;
					throw new Error("observer exploded");
				},
			});
			await expect(pending).resolves.toBeUndefined();
			// Observer isolation: a throw cannot double-fire or leak the action.
			expect(reports).toBe(1);
			expect(turnActions(harness)).toEqual([]);
			expect(outcomeCount(harness)).toBe(0);
		});

		it("pump terminal failure for a settlement-excluded custom primary fires zero callbacks and keeps original error semantics", async () => {
			const harness = await createHarness({ settings: { retry: { enabled: false } } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("unused")]);
			const internals = harness.session as unknown as {
				_startPreparedTurnActions(actions: unknown[], epoch: number): Promise<void>;
			};
			const boom = new Error("pump exploded");
			const spy = vi.spyOn(internals, "_startPreparedTurnActions").mockImplementation(async () => {
				throw boom;
			});
			const reports: Array<{ supported: true; promptId?: string }> = [];
			try {
				const pending = harness.session.promptAndSettle("text from caller", {
					customMessage: createHeartbeatPromptMessage(createHeartbeatJob()),
					settlementAdmission: (info) => reports.push(info),
				});
				// The settlement-excluded turn has no tracker identity, so the
				// original pump error is the authoritative failure (same as a
				// non-turn failure); no no-id success report may fire.
				await expect(pending).rejects.toThrow("pump exploded");
			} finally {
				spy.mockRestore();
			}
			expect(reports).toEqual([]);
			expect(outcomeCount(harness)).toBe(0);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(0);
			expect(turnActions(harness)).toEqual([]);
		});

		it("gives an arbitrary custom non-background primary default settlement identity", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("ordinary custom done")]);
			const settled = await harness.session.promptAndSettle("ordinary custom text", {
				customMessage: {
					role: "custom",
					customType: "ordinary_custom",
					content: "ordinary custom text",
					display: true,
					details: { source: "test" },
					timestamp: Date.now(),
				},
			});
			expect(settled).toMatchObject({ status: "completed", advisor: "disabled" });
			expect(outcomeCount(harness)).toBe(1);
		});
	});

	describe("customTrigger retry chain (Round 1 state-transition)", () => {
		it("waits for the retry chain before terminal classification and lease release", async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("recovered"),
			]);
			const agentEnds: string[] = [];
			let idAtFirstEnd: string | undefined;
			let leaseHeldAtFirstEnd = false;
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				agentEnds.push("agent_end");
				if (agentEnds.length === 1) {
					const action = turnActions(harness).find(
						(candidate) => candidate.payload.text === "retry custom trigger",
					);
					idAtFirstEnd = action?.promptIds?.[0];
					leaseHeldAtFirstEnd = (action?.runLeases?.length ?? 0) > 0;
				}
			});

			await harness.session.sendCustomMessage(
				{ customType: "retry-trigger", content: "retry custom trigger", display: false },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();

			// Two agent_end events; between them the sole run lease is still held
			// and no outcome has been produced yet.
			expect(agentEnds).toHaveLength(2);
			expect(idAtFirstEnd).toBeDefined();
			expect(leaseHeldAtFirstEnd).toBe(true);
			expect(outcomeCount(harness)).toBe(1);
			const outcomes = harness.eventsOfType("prompt_outcome");
			expect(outcomes[0]!.outcome).toMatchObject({ promptId: idAtFirstEnd, status: "completed" });
			expect(outcomes[0]!.outcome.failure).toBeUndefined();
			expect(harness.session.getPromptOutcome(idAtFirstEnd!)).toMatchObject({ status: "completed" });
		});

		it("settles failed/run_error exactly once when retry is disabled", async () => {
			const harness = await createHarness({ settings: { retry: { enabled: false } } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);

			await harness.session.sendCustomMessage(
				{ customType: "retry-disabled-trigger", content: "retry disabled trigger", display: false },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();

			const outcomes = harness.eventsOfType("prompt_outcome");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]!.outcome).toMatchObject({
				status: "failed",
				failure: { reason: "run_error" },
			});
		});
	});

	describe("restore stale retry policy (Phase 6.2 invariant closure)", () => {
		// Old/replayed recovery snapshots may serialize an identity-bearing turn
		// policy with `completionIncludesRetryChain:false` (pre-Round 1
		// customTrigger). Restore re-admits such turns with a fresh settlement
		// identity, so their main-run retry chain is owned work again and the
		// policy must be normalized to wait it; settlement-excluded background
		// turns have no identity and retain the serialized timing.

		it("normalizes an identity-bearing restored stale false policy to true; error→stop completes once after the chain", async () => {
			// Build a valid queued ordinary turn snapshot through the real queue.
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("seed done")]);
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("stale-policy turn", undefined, { resumeIfIdle: true });
			const snapshot = harness.session.getSessionActionRecoverySnapshot();
			const record = snapshot.actions.find(
				(
					action,
				): action is SessionActionRecoveryAction & {
					payload: SessionActionRecoveryPayload & { kind: "turn" };
				} => action.payload.kind === "turn",
			)!;
			expect(record.payload.executionPolicy.completionIncludesRetryChain).toBe(true);
			// Emulate a pre-fix snapshot: only the retry-chain flag goes stale.
			record.payload.executionPolicy.completionIncludesRetryChain = false;
			pause.release();
			await harness.session.waitForIdle();

			const restoredHarness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(restoredHarness);
			restoredHarness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("recovered"),
			]);
			await restoredHarness.session.restoreSessionActions(snapshot);
			const restoredAction = turnActions(restoredHarness).find(
				(action) => action.payload.text === "stale-policy turn",
			)!;
			expect(restoredAction).toBeDefined();
			expect(restoredAction.noSettlementIdentity).toBeUndefined();
			// `executionPolicy` lives on the prepared-turn payload, not the base
			// SessionTurnPayload; cast for read-only inspection.
			const restoredPolicy = (
				restoredAction.payload as unknown as { executionPolicy: { completionIncludesRetryChain: boolean } }
			).executionPolicy;
			expect(restoredPolicy.completionIncludesRetryChain).toBe(true);
			const freshId = restoredAction.promptIds![0];
			expect(freshId).toBeDefined();
			expect(restoredAction.runLeases).toHaveLength(1);
			expect(restoredHarness.session.getPromptOutcome(freshId)).toBeUndefined();

			let agentEnds = 0;
			let leaseHeldAtFirstEnd = false;
			restoredHarness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				agentEnds++;
				if (agentEnds === 1) {
					const action = turnActions(restoredHarness).find(
						(candidate) => candidate.payload.text === "stale-policy turn",
					);
					leaseHeldAtFirstEnd = (action?.runLeases?.length ?? 0) > 0;
				}
			});

			restoredHarness.session.resumeQueuedWork();
			await restoredHarness.session.waitForSessionInputIdle();
			await restoredHarness.session.waitForIdle();

			expect(agentEnds).toBe(2);
			expect(leaseHeldAtFirstEnd).toBe(true);
			const outcomes = restoredHarness.eventsOfType("prompt_outcome");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]!.outcome).toMatchObject({ promptId: freshId, status: "completed" });
			expect(outcomes[0]!.outcome.failure).toBeUndefined();
			expect(restoredHarness.session.getPromptOutcome(freshId)).toBe(outcomes[0]!.outcome);
		});

		it("settles the same stale restored snapshot failed/run_error when retry is disabled", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("seed done")]);
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("stale-policy disabled", undefined, { resumeIfIdle: true });
			const snapshot = harness.session.getSessionActionRecoverySnapshot();
			const record = snapshot.actions.find(
				(
					action,
				): action is SessionActionRecoveryAction & {
					payload: SessionActionRecoveryPayload & { kind: "turn" };
				} => action.payload.kind === "turn",
			)!;
			record.payload.executionPolicy.completionIncludesRetryChain = false;
			pause.release();
			await harness.session.waitForIdle();

			const restoredHarness = await createHarness({ settings: { retry: { enabled: false } } });
			harnesses.push(restoredHarness);
			restoredHarness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
			]);
			await restoredHarness.session.restoreSessionActions(snapshot);
			restoredHarness.session.resumeQueuedWork();
			await restoredHarness.session.waitForSessionInputIdle();
			await restoredHarness.session.waitForIdle();

			const outcomes = restoredHarness.eventsOfType("prompt_outcome");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]!.outcome).toMatchObject({
				status: "failed",
				failure: { reason: "run_error" },
			});
		});

		it("preserves the serialized false retry-chain timing for a restored settlement-excluded background primary", async () => {
			// A background (heartbeat) primary restored from a stale snapshot must
			// stay settlement-excluded and retain its serialized policy timing.
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
			const main = harness.session.promptAndSettle("main");
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			await harness.session.promptHeartbeat(createHeartbeatJob(), {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
			});
			await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["heartbeat check"]));
			const snapshot = harness.session.getSessionActionRecoverySnapshot();
			const heartbeatRecord = snapshot.actions.find(
				(
					action,
				): action is SessionActionRecoveryAction & {
					payload: SessionActionRecoveryPayload & { kind: "turn" };
				} => action.payload.kind === "turn" && action.payload.text === "heartbeat check",
			)!;
			heartbeatRecord.payload.executionPolicy.completionIncludesRetryChain = false;
			releaseMain?.();
			await main;
			await harness.session.waitForIdle();

			const restoredHarness = await createHarness();
			harnesses.push(restoredHarness);
			restoredHarness.setResponses([fauxAssistantMessage("heartbeat done")]);
			await restoredHarness.session.restoreSessionActions(snapshot);
			const restoredHeartbeat = turnActions(restoredHarness).find(
				(action) => action.payload.text === "heartbeat check",
			)!;
			expect(restoredHeartbeat.noSettlementIdentity).toBe(true);
			expect(restoredHeartbeat.candidatePromptId).toBeUndefined();
			expect(restoredHeartbeat.promptIds).toBeUndefined();
			expect(restoredHeartbeat.runLeases).toBeUndefined();
			// The temporal policy flag is preserved verbatim for excluded work.
			const restoredHeartbeatPolicy = (
				restoredHeartbeat.payload as unknown as { executionPolicy: { completionIncludesRetryChain: boolean } }
			).executionPolicy;
			expect(restoredHeartbeatPolicy.completionIncludesRetryChain).toBe(false);

			restoredHarness.session.resumeQueuedWork();
			await restoredHarness.session.waitForSessionInputIdle();
			await restoredHarness.session.waitForIdle();
			expect(restoredHarness.eventsOfType("prompt_outcome")).toHaveLength(0);
		});
	});

	describe("abort / deferred rollback boundary oracles (Round 1 test-evidence)", () => {
		it("requestAbort preserves a visible queued accepted prompt until actual clear settles it cancelled once", async () => {
			const gateA = new Promise<void>(() => {}); // never released: abort ends the run itself
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					await gateA;
					return fauxAssistantMessage("a done");
				},
			]);

			const a = harness.session.promptAndSettle("A streaming");
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			const aId = actionByText(harness, "A streaming").promptIds![0];
			let bId: string | undefined;
			const b = harness.session.promptAndSettle("visible B", {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
				settlementAdmission: (info) => (bId = info.promptId),
			});
			await vi.waitFor(() => expect(bId).toBeDefined());
			expect(actionByText(harness, "visible B").promptIds).toEqual([bId]);
			expect(actionByText(harness, "visible B").runLeases).toHaveLength(1);
			expect(outcomeCount(harness)).toBe(0);

			// Ordinary abort: A is aborted (provider-returned aborted settles it),
			// B stays visible in the store with the same identity and its one lease.
			harness.session.requestAbort();
			const aOutcome = await harness.session.waitForPromptOutcome(aId);
			expect(aOutcome.status).toBe("cancelled");
			await a; // A settles cancelled through the legacy completion too.
			expect(aOutcome.status).toBe("cancelled");
			expect(harness.session.getFollowUpMessages()).toEqual(["visible B"]);
			expect(actionByText(harness, "visible B").promptIds).toEqual([bId]);
			expect(actionByText(harness, "visible B").runLeases).toHaveLength(1);
			expect(isPromptSettling(harness, bId!)).toBe(true);
			expect(harness.session.getPromptOutcome(bId!)).toBeUndefined();
			expect(outcomeCount(harness)).toBe(1); // A cancelled only; B has no outcome.

			// Actual visible-queue removal consumes B exactly once as cancelled.
			expect(harness.session.clearQueue().followUp).toEqual(["visible B"]);
			const bOutcome = await b;
			expect(bOutcome).toMatchObject({ promptId: bId, status: "cancelled" });
			expect(bOutcome!.failure).toBeUndefined();
			expect(bOutcome).toBe(harness.session.getPromptOutcome(bId!));
			expect(isPromptSettling(harness, bId!)).toBe(false);
			expect(outcomeCount(harness)).toBe(2);
			expect(harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === bId)).toHaveLength(
				1,
			);
		});

		it("real deferred preparation/handoff rollback retains one lease/no outcome, then exactly one completed on resume", async () => {
			// Gate before_agent_start so the pump is deterministically inside
			// preparation when a second pause bumps the pump epoch and defers the
			// handoff (DeferredSessionInputError): the accepted action must roll
			// back queued with its run lease intact and no outcome.
			const hook = gatedHook({ prompt: "deferred turn" });
			const harness = await createHarness({ extensionFactories: [hook.factory] });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("deferred done")]);
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("deferred turn", undefined, { resumeIfIdle: true });
			const deferredId = actionByText(harness, "deferred turn").promptIds![0];
			expect(deferredId).toBeDefined();
			expect(actionByText(harness, "deferred turn").runLeases).toHaveLength(1);
			expect(actionByText(harness, "deferred turn").lifecycle.state).toBe("queued");

			// Start the pump; it selects/prepares and parks on the gated hook.
			pause.release();
			await vi.waitFor(() => expect(actionByText(harness, "deferred turn").lifecycle.state).toBe("preparing"));
			// Bump the pump epoch while preparation is parked: the epoch check at
			// the next preparation/handoff boundary defers the dispatch.
			const secondPause = harness.session.acquireQueuedWorkPause();
			hook.release();
			await vi.waitFor(() => expect(actionByText(harness, "deferred turn").lifecycle.state).toBe("queued"));
			expect(actionByText(harness, "deferred turn").promptIds).toEqual([deferredId]);
			expect(actionByText(harness, "deferred turn").runLeases).toHaveLength(1);
			expect(isPromptSettling(harness, deferredId)).toBe(true);
			expect(harness.session.getPromptOutcome(deferredId)).toBeUndefined();
			expect(outcomeCount(harness)).toBe(0);

			// Release the deferral: the same action resumes and settles completed
			// exactly once with the same prompt id.
			secondPause.release();
			await harness.session.waitForIdle();
			const outcomes = harness.eventsOfType("prompt_outcome");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]!.outcome).toMatchObject({ promptId: deferredId, status: "completed" });
			expect(harness.session.getPromptOutcome(deferredId)).toBe(outcomes[0]!.outcome);
			expect(isPromptSettling(harness, deferredId)).toBe(false);
		});
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

	describe("retry lease (group 3)", () => {
		it("acquires one retry lease synchronously at the first agent_end, holds it across the retry, releases once on success", async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } },
			});
			harnesses.push(harness);
			const observer = installRetryLeaseObserver(harness);
			harness.setResponses([retryableError(), fauxAssistantMessage("recovered")]);

			const agentEnds: string[] = [];
			let heldAtFirstEnd = false;
			let heldAtSecondEnd = false;
			let noOutcomeAtFirstEnd = false;
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				agentEnds.push(event.type);
				const held = observer.retryLeases.filter((lease) => lease.releaseCalls === 0).length;
				if (agentEnds.length === 1) {
					// The synchronous agent_end pre-arm already published the window
					// before any listener observes the event: one retry lease exists
					// for the owner and is still held.
					heldAtFirstEnd = held === 1 && observer.retryLeases.length === 1;
					const ownerId = observer.acquiresOfKind("retry")[0]?.promptId;
					noOutcomeAtFirstEnd = ownerId !== undefined && harness.session.getPromptOutcome(ownerId) === undefined;
				} else if (agentEnds.length === 2) {
					heldAtSecondEnd = held === 1;
				}
			});

			let ownerId: string | undefined;
			const settled = harness.session.promptAndSettle("retry single", {
				settlementAdmission: (info) => (ownerId = info.promptId),
			});
			await vi.waitFor(() => expect(ownerId).toBeDefined());
			await vi.waitFor(() => expect(agentEnds).toHaveLength(1));
			expect(heldAtFirstEnd).toBe(true);
			expect(noOutcomeAtFirstEnd).toBe(true);
			expect(harness.session.isRetrying).toBe(true);

			await vi.waitFor(() => expect(agentEnds).toHaveLength(2));
			expect(heldAtSecondEnd).toBe(true);
			// One retry lease for the whole window: never one per error agent_end.
			expect(observer.acquiresOfKind("retry")).toEqual([{ promptId: ownerId, kind: "retry" }]);
			expect(observer.retryLeases).toHaveLength(1);

			const outcome = await settled;
			expect(outcome).toMatchObject({ promptId: ownerId, status: "completed" });
			expect(outcome!.failure).toBeUndefined();
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(outcomeCount(harness)).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId!)).toBe(outcome);
			expect(harness.session.isRetrying).toBe(false);
			expect(retryInternals(harness)._retryWindow).toBeUndefined();

			observer.restore();
		});

		it('acquires one retry lease per "all" batch owner and releases the captured targets even after the mutable snapshot is clobbered', async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.session.setFollowUpMode("all");
			harness.setResponses([retryableError(), fauxAssistantMessage("recovered")]);

			// Queue both follow-ups while the pump is paused so "all" batching merges
			// them into one shared run.
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("all A", undefined, { resumeIfIdle: true });
			await harness.session.followUp("all B", undefined, { resumeIfIdle: true });
			const ids = [actionByText(harness, "all A").promptIds![0], actionByText(harness, "all B").promptIds![0]];
			expect(new Set(ids).size).toBe(2);

			const observer = installRetryLeaseObserver(harness);
			let clobbered = false;
			let noOutcomeMidRetry = false;
			let acquiresAtFirstEnd: unknown[] = [];
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end" || clobbered) return;
				clobbered = true;
				// The window is already created; the mutable snapshot must no longer
				// matter. Clobber it to prove the captured leases are the release
				// targets, never a later re-read of _lastRunPromptIds.
				retryInternals(harness)._lastRunPromptIds = ["clobbered-owner"];
				retryInternals(harness)._currentRunOwners = ["clobbered-owner"];
				// Mid-retry: both owners still settling, no outcome yet.
				noOutcomeMidRetry =
					harness.session.getPromptOutcome(ids[0]) === undefined &&
					harness.session.getPromptOutcome(ids[1]) === undefined;
				acquiresAtFirstEnd = [...observer.acquiresOfKind("retry")];
			});

			pause.release();
			const [outcomeA, outcomeB] = await Promise.all([
				harness.session.waitForPromptOutcome(ids[0]),
				harness.session.waitForPromptOutcome(ids[1]),
			]);
			expect(clobbered).toBe(true);
			expect(noOutcomeMidRetry).toBe(true);
			// The window established both owners exactly once at first creation.
			expect([...acquiresAtFirstEnd].map((entry) => (entry as { promptId: string }).promptId).sort()).toEqual(
				[...ids].sort(),
			);
			expect(outcomeA).toMatchObject({ promptId: ids[0], status: "completed" });
			expect(outcomeB).toMatchObject({ promptId: ids[1], status: "completed" });
			// Each owner acquired exactly once and its captured lease released once.
			expect(
				observer
					.acquiresOfKind("retry")
					.map((entry) => entry.promptId)
					.sort(),
			).toEqual([...ids].sort());
			expect(observer.retryLeases).toHaveLength(2);
			for (const lease of observer.retryLeases) {
				expect(lease.releaseCalls).toBe(1);
			}
			// No owner was alienated: the clobbered id was never acquired/released.
			expect(observer.acquireLog.some((entry) => entry.promptId === "clobbered-owner")).toBe(false);
			expect(outcomeCount(harness)).toBe(2);
			observer.restore();
		});

		it("does not re-acquire for a second error in the same window; one release and one completed after error→error→success", async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } },
			});
			harnesses.push(harness);
			const observer = installRetryLeaseObserver(harness);
			harness.setResponses([retryableError(), retryableError(), fauxAssistantMessage("finally ok")]);

			const agentEnds: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				agentEnds.push(event.type);
			});

			let ownerId: string | undefined;
			const settled = harness.session.promptAndSettle("triple retry", {
				settlementAdmission: (info) => (ownerId = info.promptId),
			});
			await vi.waitFor(() => expect(ownerId).toBeDefined());
			await vi.waitFor(() => expect(agentEnds).toHaveLength(3));

			// Three agent_end, but the whole chain holds exactly one window/lease.
			expect(observer.acquiresOfKind("retry")).toEqual([{ promptId: ownerId, kind: "retry" }]);
			expect(observer.retryLeases).toHaveLength(1);

			const outcome = await settled;
			expect(outcome).toMatchObject({ promptId: ownerId, status: "completed" });
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(outcomeCount(harness)).toBe(1);
			observer.restore();
		});

		it("releases exactly once on max-retry exhaustion with no residue; repeated abort/close adds nothing", async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			const observer = installRetryLeaseObserver(harness);
			harness.setResponses([retryableError(), retryableError(), retryableError()]);

			const settled = harness.session.promptAndSettle("exhausted");
			const outcome = await settled;
			expect(outcome).toMatchObject({ status: "failed", failure: { reason: "run_error" } });
			expect(outcomeCount(harness)).toBe(1);

			// One acquire for the whole window; the exact lease released once.
			expect(observer.acquiresOfKind("retry")).toHaveLength(1);
			expect(observer.retryLeases).toHaveLength(1);
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(retryInternals(harness)._retryWindow).toBeUndefined();

			expect(harness.session.isRetrying).toBe(false);

			// Repeated abort / direct close / abort again: no extra release/outcome.
			harness.session.abortRetry();
			retryInternals(harness)._resolveRetry();
			harness.session.abortRetry();
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(outcomeCount(harness)).toBe(1);
			observer.restore();
		});

		it('releases every captured owner once and fails each identity on "all" shared-run exhaustion', async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.session.setFollowUpMode("all");
			harness.setResponses([retryableError(), retryableError(), retryableError()]);

			// Queue both follow-ups while the pump is paused so "all" batching merges
			// them into one shared run with a deduped two-owner snapshot.
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("exhaust A", undefined, { resumeIfIdle: true });
			await harness.session.followUp("exhaust B", undefined, { resumeIfIdle: true });
			const ids = [
				actionByText(harness, "exhaust A").promptIds![0],
				actionByText(harness, "exhaust B").promptIds![0],
			];
			expect(new Set(ids).size).toBe(2);

			const observer = installRetryLeaseObserver(harness);
			pause.release();
			const [outcomeA, outcomeB] = await Promise.all([
				harness.session.waitForPromptOutcome(ids[0]),
				harness.session.waitForPromptOutcome(ids[1]),
			]);
			expect(outcomeA).toMatchObject({ promptId: ids[0], status: "failed", failure: { reason: "run_error" } });
			expect(outcomeB).toMatchObject({ promptId: ids[1], status: "failed", failure: { reason: "run_error" } });
			expect(outcomeCount(harness)).toBe(2);
			expect(harness.eventsOfType("prompt_outcome").filter((e) => e.outcome.promptId === ids[0])).toHaveLength(1);
			expect(harness.eventsOfType("prompt_outcome").filter((e) => e.outcome.promptId === ids[1])).toHaveLength(1);

			// Exact dedup owners each acquired exactly once for the whole chain, and
			// each captured lease released exactly once on exhaustion.
			expect(
				observer
					.acquiresOfKind("retry")
					.map((entry) => entry.promptId)
					.sort(),
			).toEqual([...ids].sort());
			expect(observer.retryLeases).toHaveLength(2);
			for (const lease of observer.retryLeases) {
				expect(lease.releaseCalls).toBe(1);
			}
			// No retry tuple residue; duplicate close does nothing.
			expect(retryInternals(harness)._retryWindow).toBeUndefined();
			expect(harness.session.isRetrying).toBe(false);
			harness.session.abortRetry();
			retryInternals(harness)._resolveRetry();
			harness.session.abortRetry();
			for (const lease of observer.retryLeases) {
				expect(lease.releaseCalls).toBe(1);
			}
			expect(outcomeCount(harness)).toBe(2);
			observer.restore();
		});

		it("creates the same window through the defensive fallback when the pre-arm was bypassed", async () => {
			let releaseParent: (() => void) | undefined;
			const parentGate = new Promise<void>((resolve) => {
				releaseParent = resolve;
			});
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					await parentGate;
					return fauxAssistantMessage("fallback parent done");
				},
			]);
			const pending = harness.session.promptAndSettle("fallback parent");
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			const ownerId = actionByText(harness, "fallback parent").promptIds![0];

			const observer = installRetryLeaseObserver(harness);
			const internals = retryInternals(harness);
			// Stable owner snapshot with NO pre-armed window: a refactor that
			// bypassed the agent_end pre-arm hits the defensive fallback.
			internals._lastRunPromptIds = [ownerId];
			expect(harness.session.isRetrying).toBe(false);
			expect(observer.acquiresOfKind("retry")).toEqual([]);

			// The fallback schedules `agent.continue()` on a 0ms timer: keep the
			// spy installed until after that timer fires so no real continuation
			// (which would consume the gated provider response) can start.
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue(undefined as never);
			try {
				const didRetry = await internals._handleRetryableError(retryableError());
				expect(didRetry).toBe(true);
				// The fallback went through the same idempotent create helper with
				// the same owner/acquire semantics.
				expect(observer.acquiresOfKind("retry")).toEqual([{ promptId: ownerId, kind: "retry" }]);
				expect(observer.retryLeases).toHaveLength(1);
				expect(observer.retryLeases[0]!.releaseCalls).toBe(0);
				expect(internals._retryWindow?.capturedPromptIds ?? "missing-window").toEqual([ownerId]);
				expect(internals._retryWindow?.leases).toHaveLength(1);
			} finally {
				internals._resolveRetry();
				// Let the scheduled 0ms continue timer fire against the mock first.
				await new Promise((resolve) => setTimeout(resolve, 5));
				continueSpy.mockRestore();
			}
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(internals._retryWindow).toBeUndefined();

			expect(harness.session.isRetrying).toBe(false);

			// The parent run still finishes normally with one completed outcome.
			releaseParent?.();
			const outcome = await pending;
			expect(outcome).toMatchObject({ promptId: ownerId, status: "completed" });
			expect(outcomeCount(harness)).toBe(1);
			observer.restore();
		});

		it("fails closed through _handleRetryableError when all-or-nothing retry acquisition keeps failing", async () => {
			let releaseA: (() => void) | undefined;
			let releaseB: (() => void) | undefined;
			const gateA = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			const gateB = new Promise<void>((resolve) => {
				releaseB = resolve;
			});
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					await gateA;
					return fauxAssistantMessage("failclosed a done");
				},
				async () => {
					await gateB;
					return fauxAssistantMessage("failclosed b done");
				},
			]);

			let parentAId: string | undefined;
			let parentBId: string | undefined;
			const parentA = harness.session.promptAndSettle("failclosed-a", {
				settlementAdmission: (info) => (parentAId = info.promptId),
			});
			await vi.waitFor(() => expect(parentAId).toBeDefined());
			const parentB = harness.session.promptAndSettle("failclosed-b", {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
				settlementAdmission: (info) => (parentBId = info.promptId),
			});
			await vi.waitFor(() => expect(parentBId).toBeDefined());
			const parentALeases = actionByText(harness, "failclosed-a").runLeases!.length;
			const parentBLeases = actionByText(harness, "failclosed-b").runLeases!.length;

			const internals = retryInternals(harness);
			// Stable two-owner snapshot with NO pre-armed window: the defensive
			// fallback must fail closed, not emit/schedule a retry without leases.
			internals._lastRunPromptIds = [parentAId!, parentBId!];

			// One self-contained spy (the acquire method must not already be
			// mocked, or bind() would capture a nested spy): it fails every retry
			// window attempt at the second owner and counts each sibling release.
			const tracker = internals._promptSettlementTracker;
			const originalAcquire = tracker.acquire.bind(tracker);
			let acquireCalls = 0;
			const retryReleaseCalls: number[] = [];
			const acquiredRetryIds: string[] = [];
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					acquireCalls += 1;
					// The SECOND retry owner's acquire fails persistly: every
					// window attempt must roll back and fail closed.
					if (acquireCalls === 2 && kind === "retry") {
						throw new Error("simulated persistent second retry owner acquire failure");
					}
					const lease = originalAcquire(promptId, kind);
					if (kind === "retry") {
						acquiredRetryIds.push(promptId);
						const wrapped = lease as PromptLease & { release: () => void };
						const baseRelease = lease.release.bind(lease);
						const index = retryReleaseCalls.length;
						retryReleaseCalls.push(0);
						wrapped.release = () => {
							retryReleaseCalls[index] = (retryReleaseCalls[index] ?? 0) + 1;
							baseRelease();
						};
					}
					return lease;
				});
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue(undefined as never);
			const sawRetryStart: string[] = [];
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") sawRetryStart.push(event.type);
			});
			try {
				const didRetry = await internals._handleRetryableError(retryableError());
				expect(didRetry).toBe(false);
				// Failed closed: no window tuple, no waiter, nothing scheduled.
				expect(internals._retryPromise).toBeUndefined();
				expect(internals._retryResolve).toBeUndefined();
				expect(internals._retryWindow).toBeUndefined();
				expect(harness.session.isRetrying).toBe(false);
				expect(sawRetryStart).toEqual([]);
				expect(continueSpy).not.toHaveBeenCalled();
				expect(internals._retryAttempt).toBe(0);
				// All-or-nothing: the first sibling was reverse-released exactly once
				// and the second owner was never acquired into a published tuple.
				expect(acquireCalls).toBe(2);
				expect(acquiredRetryIds).toEqual([parentAId]);
				expect(retryReleaseCalls).toEqual([1]);
			} finally {
				unsubscribe();
				continueSpy.mockRestore();
				acquireSpy.mockRestore();
			}

			// No owner was cancelled or terminaled and no parent run lease touched.
			expect(actionByText(harness, "failclosed-a").runLeases).toHaveLength(parentALeases);
			expect(actionByText(harness, "failclosed-b").runLeases).toHaveLength(parentBLeases);
			expect(harness.session.getPromptOutcome(parentAId!)).toBeUndefined();
			expect(harness.session.getPromptOutcome(parentBId!)).toBeUndefined();
			expect(isPromptSettling(harness, parentAId!)).toBe(true);
			expect(isPromptSettling(harness, parentBId!)).toBe(true);
			expect(outcomeCount(harness)).toBe(0);

			// Both parents still complete normally afterwards.
			releaseA?.();
			releaseB?.();
			const [outcomeA, outcomeB] = await Promise.all([parentA, parentB]);
			expect(outcomeA).toMatchObject({ promptId: parentAId, status: "completed" });
			expect(outcomeB).toMatchObject({ promptId: parentBId, status: "completed" });
			expect(outcomeCount(harness)).toBe(2);
		});

		it("rolls back the first sibling lease on a partial second-owner retry acquire and publishes no half-open window", async () => {
			let releaseA: (() => void) | undefined;
			let releaseB: (() => void) | undefined;
			const gateA = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			const gateB = new Promise<void>((resolve) => {
				releaseB = resolve;
			});
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
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
			const parentA = harness.session.promptAndSettle("retry-parent-a", {
				settlementAdmission: (info) => (parentAId = info.promptId),
			});
			await vi.waitFor(() => expect(parentAId).toBeDefined());
			const parentB = harness.session.promptAndSettle("retry-parent-b", {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
				settlementAdmission: (info) => (parentBId = info.promptId),
			});
			await vi.waitFor(() => expect(parentBId).toBeDefined());
			const parentALeases = actionByText(harness, "retry-parent-a").runLeases!.length;
			const parentBLeases = actionByText(harness, "retry-parent-b").runLeases!.length;

			const internals = retryInternals(harness);
			internals._lastRunPromptIds = [parentAId!, parentBId!];

			// Deterministic seam: the tracker's SECOND retry acquire throws so the
			// create helper must reverse-release the first sibling and publish
			// nothing.
			const tracker = internals._promptSettlementTracker;
			const originalAcquire = tracker.acquire.bind(tracker);
			let acquireCalls = 0;
			const retryReleaseCalls: number[] = [];
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					acquireCalls += 1;
					if (acquireCalls === 2 && kind === "retry") {
						throw new Error("simulated second retry owner acquire failure");
					}
					const lease = originalAcquire(promptId, kind);
					if (kind === "retry") {
						const wrapped = lease as PromptLease & { release: () => void };
						const baseRelease = lease.release.bind(lease);
						const index = retryReleaseCalls.length;
						retryReleaseCalls.push(0);
						wrapped.release = () => {
							retryReleaseCalls[index] = (retryReleaseCalls[index] ?? 0) + 1;
							baseRelease();
						};
					}
					return lease;
				});
			try {
				const created = internals._createRetryWindow();
				expect(created).toBe(false);
				expect(acquireCalls).toBe(2);
				// The first sibling's lease was reverse-released exactly once.
				expect(retryReleaseCalls).toEqual([1]);
				// No half-open tuple is published.
				expect(internals._retryPromise).toBeUndefined();
				expect(internals._retryResolve).toBeUndefined();
				expect(internals._retryWindow).toBeUndefined();

				expect(harness.session.isRetrying).toBe(false);
			} finally {
				acquireSpy.mockRestore();
			}

			// No owner was cancelled or terminaled and no parent run lease touched.
			expect(actionByText(harness, "retry-parent-a").runLeases).toHaveLength(parentALeases);
			expect(actionByText(harness, "retry-parent-b").runLeases).toHaveLength(parentBLeases);
			expect(harness.session.getPromptOutcome(parentAId!)).toBeUndefined();
			expect(harness.session.getPromptOutcome(parentBId!)).toBeUndefined();
			expect(isPromptSettling(harness, parentAId!)).toBe(true);
			expect(isPromptSettling(harness, parentBId!)).toBe(true);
			expect(outcomeCount(harness)).toBe(0);

			// Both parents complete normally afterwards.
			releaseA?.();
			releaseB?.();
			const [outcomeA, outcomeB] = await Promise.all([parentA, parentB]);
			expect(outcomeA).toMatchObject({ promptId: parentAId, status: "completed" });
			expect(outcomeB).toMatchObject({ promptId: parentBId, status: "completed" });
			expect(outcomeCount(harness)).toBe(2);
		});

		it("releases the captured retry lease exactly once on abortRetry during the sleep and on duplicate close", async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 } },
			});
			harnesses.push(harness);
			const observer = installRetryLeaseObserver(harness);
			harness.setResponses([retryableError()]);

			const sawRetryStart = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "auto_retry_start") {
						unsubscribe();
						resolve();
					}
				});
			});

			const promptPromise = harness.session.prompt("sleepy retry");
			await sawRetryStart;
			await vi.waitFor(() => expect(observer.retryLeases).toHaveLength(1));
			// The window is armed and the retry lease is held during the sleep.
			expect(observer.retryLeases[0]!.releaseCalls).toBe(0);
			expect(harness.session.isRetrying).toBe(true);

			harness.session.abortRetry();
			// abortRetry only aborts the sleep signal; the window is closed by the
			// retry handler's catch, so the release is observed asynchronously.
			await vi.waitFor(() => expect(observer.retryLeases[0]!.releaseCalls).toBe(1));
			expect(harness.session.isRetrying).toBe(false);
			expect(retryInternals(harness)._retryWindow).toBeUndefined();

			// Duplicate abort / direct close: no second release.
			harness.session.abortRetry();
			retryInternals(harness)._resolveRetry();
			await vi.waitFor(() => expect(observer.retryLeases[0]!.releaseCalls).toBe(1));

			await promptPromise;
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("preserves legacy retry events/timing for a zero-owner background retry window with zero settlement lease/outcome", async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } },
			});
			harnesses.push(harness);
			const observer = installRetryLeaseObserver(harness);
			harness.setResponses([retryableError(), fauxAssistantMessage("bg recovered")]);

			// Heartbeat primary: settlement-excluded background turn, so the run
			// has zero prompt owners. The retry window is still created (legacy
			// timing preserved) but holds zero retry leases and settles nothing.
			const sawRetryStart = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "auto_retry_start") {
						unsubscribe();
						resolve();
					}
				});
			});
			const pending = harness.session.sendCustomMessage(
				{ customType: "heartbeat_prompt", content: "zero-owner retry", display: false },
				{ triggerTurn: true },
			);
			await sawRetryStart;
			// Mid-retry: a window exists with ZERO captured owners/leases (the
			// zero-owner window is valid and keeps legacy retry timing alive).
			expect(retryInternals(harness)._retryWindow).toEqual({ capturedPromptIds: [], leases: [] });
			expect(observer.acquiresOfKind("retry")).toEqual([]);
			expect(observer.retryLeases).toEqual([]);
			expect(harness.session.isRetrying).toBe(true);

			await pending;
			await harness.session.waitForIdle();

			expect(outcomeCount(harness)).toBe(0);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
			expect(harness.session.isRetrying).toBe(false);
			expect(retryInternals(harness)._retryWindow).toBeUndefined();

			observer.restore();
		});
	});

	describe("post-compaction continuation lease and traceGeneration (group 4)", () => {
		const continuationHarnesses: Harness[] = [];

		afterEach(() => {
			vi.useRealTimers();
			while (continuationHarnesses.length > 0) continuationHarnesses.pop()?.cleanup();
		});

		it("production threshold path acquires continuation ownership before the first run terminal and settles only after the second agent_end", async () => {
			vi.useFakeTimers();
			const largeContextTool: AgentTool = {
				name: "large-context",
				label: "Large context",
				description: "Returns enough context to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "x".repeat(800_000) }],
					details: {},
				}),
			};
			const harness = await createHarness({
				tools: [largeContextTool],
				autonomous: {
					enabled: true,
					maxContinuations: 1,
					maxTurns: 100,
					gates: { commands: [], maxRetries: 1 },
				},
				settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200_001 } },
				models: [{ id: "faux-1", contextWindow: 200_000 }],
				extensionFactories: [compactSummaryExtension("production threshold summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("large-context", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("post-compaction continuation completed"),
			]);
			const ownerIds: string[] = [];
			const agentEndObservations: Array<{ outcome: unknown; continuationReleases: number[] }> = [];
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				const owner = ownerIds[0];
				observer.timeline.push("agent_end");
				agentEndObservations.push({
					outcome: owner ? harness.session.getPromptOutcome(owner) : undefined,
					continuationReleases: observer.continuationLeases.map((lease) => lease.releaseCalls),
				});
			});

			const settled = harness.session.promptAndSettle("cross the production threshold", {
				settlementAdmission: (info) => ownerIds.push(info.promptId!),
			});
			await vi.waitFor(() => expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1));
			await vi.waitFor(() => expect(harness.eventsOfType("compaction_end")).toHaveLength(1));
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				reason: "threshold",
				aborted: false,
				result: expect.objectContaining({ summary: "production threshold summary" }),
			});
			await vi.advanceTimersByTimeAsync(100);
			const outcome = await settled;

			expect(ownerIds).toHaveLength(1);
			expect(agentEndObservations).toHaveLength(2);
			expect(agentEndObservations[0]!.outcome).toBeUndefined();
			expect(observer.timeline).toEqual(["agent_end", "continuation_acquire", "agent_end"]);
			expect(observer.acquireContexts).toEqual([
				{ promptId: ownerIds[0], runLeasesHeld: 1, outcomeAtAcquire: undefined },
			]);
			expect(observer.acquiresOfContinuation()).toEqual([
				{ promptId: ownerIds[0], kind: "compaction_continuation" },
			]);
			expect(observer.continuationLeases).toHaveLength(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(agentEndObservations[1]!.continuationReleases).toEqual([0]);
			expect(outcome).toMatchObject({
				promptId: ownerIds[0],
				status: "completed",
				traceGeneration: 1,
			});
			expect(outcome?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			observer.restore();
		});

		it("does not bump generation or create a window when compaction is skipped/never run", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-id-skip";
			admitOwners(harness, ownerId);
			internals._lastRunPromptIds = [ownerId];

			// Skipped threshold compaction (wrong settings / too short): no bump.
			await internals._runAutoCompaction("threshold", false);
			expect(observer.generationBumps).toEqual([]);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(observer.acquiresOfContinuation()).toEqual([]);
			observer.restore();
		});

		it("[round-1 fix 5] successful overflow never bumps generation", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("overflow summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "owner-overflow-a";
			admitOwners(harness, ownerA);
			internals._lastRunPromptIds = [ownerA];

			// Successful overflow compaction with willRetry: NO generation bump.
			await internals._runAutoCompaction("overflow", true);
			expect(observer.generationBumps).toEqual([]);
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerA, kind: "compaction_continuation" }]);
			expect(internals._provisionalOverflowContinuationOwners).toEqual([ownerA]);
			internals._cancelPostCompactionContinue({ owners: "fail" });
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("[round-1 fix 5] public requested compaction with post-work bumps one generation, owns the continuation, and completes", async () => {
			vi.useFakeTimers();
			let harness!: Harness;
			harness = await createHarness({
				tools: [compactRequestTool(() => harness)],
				settings: { compaction: { enabled: false, keepRecentTokens: 10 } },
				extensionFactories: [compactSummaryExtension("public requested post-work summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			appendCompactionTurn(harness, "retained turn before public requested compaction");
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("retained assistant before public requested compaction"),
				timestamp: Date.now(),
			} as never);
			const observer = installContinuationObserver(harness);
			const ownerIds: string[] = [];
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("request-compact", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("public requested continuation completed"),
			]);

			const settled = harness.session.promptAndSettle("request compaction from the active turn", {
				settlementAdmission: (info) => ownerIds.push(info.promptId!),
			});
			await vi.waitFor(() => expect(harness.eventsOfType("compaction_end")).toHaveLength(1));
			const requestedEnd = harness.eventsOfType("compaction_end")[0]!;
			expect(requestedEnd).toMatchObject({
				reason: "requested",
				aborted: false,
				result: expect.objectContaining({ summary: "public requested post-work summary" }),
			});
			expect(observer.generationBumps).toEqual(ownerIds);
			expect(observer.acquiresOfContinuation()).toEqual([
				{ promptId: ownerIds[0], kind: "compaction_continuation" },
			]);
			expect(harness.session.getPromptOutcome(ownerIds[0]!)).toBeUndefined();
			await vi.advanceTimersByTimeAsync(100);
			const outcome = await settled;
			expect(outcome).toMatchObject({ promptId: ownerIds[0], status: "completed", traceGeneration: 1 });
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("[round-1 fix 5] requested success with post-work bumps one generation, owns the continuation, and completes", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("requested post-work summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "requested-post-work";
			admitOwners(harness, ownerId);
			const runLease = internals._promptSettlementTracker.acquire(ownerId, "run");
			const message = continuationMessage("requested post-work obligation");
			internals._postCompactionContinuationMessages = [message];
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerId];

			expect(await internals._runAutoCompaction("requested", false)).toBe(false);
			expect(observer.generationBumps).toEqual([ownerId]);
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerId, kind: "compaction_continuation" }]);
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerId],
				obligationMessages: [message],
				revision: 1,
				state: "scheduled",
			});
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			runLease.release();
			expect(harness.session.getPromptOutcome(ownerId)).toBeUndefined();

			const window = internals._continuationSettlementWindow!;
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});
			await internals._runDirectContinuation([message], window);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				status: "completed",
				traceGeneration: 1,
			});
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[round-1 fix 5] requested success without post-work bumps one generation and creates no window or timer", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("requested no-work summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "requested-no-post-work";
			admitOwners(harness, ownerId);
			const runLease = internals._promptSettlementTracker.acquire(ownerId, "run");
			internals._lastRunPromptIds = [ownerId];
			internals._postCompactionContinuationMessages = [];

			expect(await internals._runAutoCompaction("requested", false)).toBe(false);
			expect(observer.generationBumps).toEqual([ownerId]);
			expect(observer.acquiresOfContinuation()).toEqual([]);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			runLease.release();
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				status: "completed",
				traceGeneration: 1,
			});
			observer.restore();
		});

		it('[round-1 fix 5] requested success for "all" owners bumps and owns each exactly once', async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("requested all summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const owners = ["requested-all-a", "requested-all-b"];
			admitOwners(harness, ...owners);
			const runLeases = owners.map((owner) => internals._promptSettlementTracker.acquire(owner, "run"));
			const message = continuationMessage("requested all post-work");
			internals._postCompactionContinuationMessages = [message];
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [...owners];

			expect(await internals._runAutoCompaction("requested", false)).toBe(false);
			expect(observer.generationBumps).toEqual(owners);
			expect(observer.acquiresOfContinuation()).toEqual(
				owners.map((promptId) => ({ promptId, kind: "compaction_continuation" as const })),
			);
			expect(internals._continuationSettlementWindow?.owners).toEqual(owners);
			for (const lease of runLeases) lease.release();
			for (const owner of owners) expect(harness.session.getPromptOutcome(owner)).toBeUndefined();
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([1, 1]);
			for (const owner of owners) {
				expect(harness.session.getPromptOutcome(owner)).toMatchObject({ status: "completed", traceGeneration: 1 });
			}
			observer.restore();
		});

		it('acquires one continuation lease per "all" batch owner and completes each exactly once', async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ids = ["all-owner-a", "all-owner-b"];
			admitOwners(harness, ...ids);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [...ids];

			await internals._runAutoCompaction("threshold", false);
			expect(
				observer
					.acquiresOfContinuation()
					.map((entry) => entry.promptId)
					.sort(),
			).toEqual([...ids].sort());
			expect(observer.generationBumps.sort()).toEqual([...ids].sort());
			expect(internals._continuationSettlementWindow?.owners.sort()).toEqual([...ids].sort());
			for (const record of observer.continuationLeases) expect(record.releaseCalls).toBe(0);

			// Both owners still settling; no outcome yet.
			expect(harness.session.getPromptOutcome(ids[0])).toBeUndefined();
			expect(harness.session.getPromptOutcome(ids[1])).toBeUndefined();
			internals._cancelPostCompactionContinue();
			for (const record of observer.continuationLeases) expect(record.releaseCalls).toBe(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			observer.restore();
		});

		it("keeps A's captured tuple when A is rearmed behind an unrelated B run and never merges B", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "owner-a";
			const ownerB = "owner-b";
			admitOwners(harness, ownerA, ownerB);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerA];
			await internals._runAutoCompaction("threshold", false);
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerA, kind: "compaction_continuation" }]);

			// B becomes the current run owner; a generic wake must NOT extend A.
			internals._lastRunPromptIds = [ownerB];
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			internals._schedulePostCompactionContinue();
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerA, kind: "compaction_continuation" }]);
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("rearms on busy/already-processing without duplicate acquire/release", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-rearm";
			admitOwners(harness, ownerId);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerId];
			await internals._runAutoCompaction("threshold", false);
			expect(observer.acquiresOfContinuation()).toHaveLength(1);

			withStreaming(harness, true);
			internals._schedulePostCompactionContinue();
			await vi.advanceTimersByTimeAsync(100);
			expect(observer.acquiresOfContinuation()).toHaveLength(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			withStreaming(harness, false);
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("an old direct completion cannot fence or close a same-revision replacement window", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const oldOwner = "identity-direct-old";
			const replacementOwner = "identity-direct-new";
			admitOwners(harness, oldOwner, replacementOwner);
			const oldMessage = {
				role: "user",
				content: [{ type: "text", text: "old direct obligation" }],
				timestamp: Date.now(),
			} as AgentMessage;
			const replacementMessage = {
				role: "user",
				content: [{ type: "text", text: "replacement direct obligation" }],
				timestamp: Date.now() + 1,
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([oldOwner], [oldMessage])).toBe(true);
			const oldWindow = internals._continuationSettlementWindow!;
			const oldLease = observer.continuationLeases[0]!;
			let releaseOldRun = () => {};
			const oldRunGate = new Promise<void>((resolve) => {
				releaseOldRun = resolve;
			});
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				await oldRunGate;
			});
			const oldRun = internals._runDirectContinuation([oldMessage], oldWindow);
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));

			expect(internals._cancelPostCompactionContinue()).toBe(true);
			expect(oldLease.releaseCalls).toBe(1);
			expect(internals._scheduleContinuationForObligation([replacementOwner], [replacementMessage])).toBe(true);
			internals._postCompactionContinuationMessages = [replacementMessage];
			internals._schedulePostCompactionContinue();
			const replacementWindow = internals._continuationSettlementWindow!;
			const replacementLease = observer.continuationLeases[1]!;
			expect(replacementWindow).not.toBe(oldWindow);
			expect(replacementWindow.revision).toBe(oldWindow.revision);

			releaseOldRun();
			await oldRun;
			expect(internals._continuationSettlementWindow).toBe(replacementWindow);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(oldLease.releaseCalls).toBe(1);
			expect(replacementLease.releaseCalls).toBe(0);
			expect(harness.session.getPromptOutcome(oldOwner)).toMatchObject({ status: "completed" });
			expect(harness.session.getPromptOutcome(replacementOwner)).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			expect(internals._cancelPostCompactionContinue()).toBe(true);
			expect(replacementLease.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(replacementOwner)).toMatchObject({ status: "completed" });
			continueSpy.mockRestore();
			observer.restore();
		});

		it("an old pump handoff cannot close a same-revision replacement window", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const oldOwner = "identity-pump-old";
			const replacementOwner = "identity-pump-new";
			admitOwners(harness, oldOwner, replacementOwner);
			const oldMessage = {
				role: "user",
				content: [{ type: "text", text: "old tracked obligation" }],
				timestamp: Date.now(),
			} as AgentMessage;
			const replacementMessage = {
				role: "user",
				content: [{ type: "text", text: "replacement tracked obligation" }],
				timestamp: Date.now() + 1,
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([oldOwner], [oldMessage])).toBe(true);
			internals._postCompactionContinuationMessages = [oldMessage];
			internals._schedulePostCompactionContinue();
			const oldWindow = internals._continuationSettlementWindow!;
			const oldLease = observer.continuationLeases[0]!;
			const pumpInternals = harness.session as unknown as {
				_sessionInputPumpRequested: boolean;
				_sessionInputPump: Promise<void>;
				_scheduleSessionInputPump(): void;
			};
			let releaseOldPump = () => {};
			const oldPumpGate = new Promise<void>((resolve) => {
				releaseOldPump = resolve;
			});
			pumpInternals._sessionInputPumpRequested = true;
			pumpInternals._sessionInputPump = oldPumpGate;
			const schedulePumpSpy = vi.spyOn(pumpInternals, "_scheduleSessionInputPump").mockImplementation(() => {});
			const oldHandoff = internals._runScheduledPostCompactionContinue();
			await Promise.resolve();

			expect(internals._cancelPostCompactionContinue()).toBe(true);
			expect(oldLease.releaseCalls).toBe(1);
			expect(internals._scheduleContinuationForObligation([replacementOwner], [replacementMessage])).toBe(true);
			internals._postCompactionContinuationMessages = [replacementMessage];
			internals._schedulePostCompactionContinue();
			const replacementWindow = internals._continuationSettlementWindow!;
			const replacementLease = observer.continuationLeases[1]!;
			expect(replacementWindow).not.toBe(oldWindow);
			expect(replacementWindow.revision).toBe(oldWindow.revision);

			releaseOldPump();
			await oldHandoff;
			expect(internals._continuationSettlementWindow).toBe(replacementWindow);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(oldLease.releaseCalls).toBe(1);
			expect(replacementLease.releaseCalls).toBe(0);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			internals._cancelPostCompactionContinue();
			expect(replacementLease.releaseCalls).toBe(1);
			schedulePumpSpy.mockRestore();
			observer.restore();
		});

		it("real already-processing direct path rearms the same window without duplicate ownership", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "already-processing-real";
			admitOwners(harness, ownerId);
			const message = {
				role: "user",
				content: [{ type: "text", text: "busy continuation" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			const window = internals._continuationSettlementWindow!;
			const lease = observer.continuationLeases[0]!;
			let releaseBusyRun = () => {};
			const busyGate = new Promise<void>((resolve) => {
				releaseBusyRun = resolve;
			});
			harness.session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "existing run" }], timestamp: Date.now() },
			] as AgentMessage[];
			harness.setResponses([
				async () => {
					await busyGate;
					return fauxAssistantMessage("existing run completed");
				},
			]);
			const busyRun = harness.session.agent.continue();
			await vi.waitFor(() => expect(harness.session.agent.state.isStreaming).toBe(true));

			await internals._runDirectContinuation([message], window);
			expect(internals._continuationSettlementWindow).toBe(window);
			expect(internals._continuationSettlementWindow?.revision).toBe(1);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(observer.acquiresOfContinuation()).toHaveLength(1);
			expect(lease.releaseCalls).toBe(0);
			expect(harness.session.getPromptOutcome(ownerId)).toBeUndefined();
			releaseBusyRun();
			await busyRun;
			internals._cancelPostCompactionContinue();
			expect(lease.releaseCalls).toBe(1);
			observer.restore();
		});

		it("[round-1 fix 1] matching retry already streaming waits without a duplicate continue call", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "matching-retry-streaming";
			admitOwners(harness, ownerId);
			const message = continuationMessage("matching retry already streaming");
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._continuationSettlementWindow!.overflowRecoveryOwners = [ownerId];
			internals._schedulePostCompactionContinue();
			internals._lastRunPromptIds = [ownerId];
			const retryInternals = internals as unknown as RetryInternals;
			expect(retryInternals._createRetryWindow()).toBe(true);
			withStreaming(harness, true);
			const continueSpy = vi.spyOn(harness.session.agent, "continue");
			const scheduledRun = internals._runScheduledPostCompactionContinue();
			await Promise.resolve();
			expect(continueSpy).not.toHaveBeenCalled();
			expect(internals._continuationSettlementWindow?.state).toBe("running");

			internals._lastRunTerminalStopReason = "stop";
			retryInternals._resolveRetry();
			withStreaming(harness, false);
			await scheduledRun;
			expect(continueSpy).not.toHaveBeenCalled();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "completed" });
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[round-1 fix 6] direct continuation retry keeps queued B behind A fence, then wakes B once", async () => {
			vi.useRealTimers();
			const bGate = gatedHook({ prompt: "queued B after direct retry" });
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
				extensionFactories: [bGate.factory],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "direct-retry-a";
			admitOwners(harness, ownerA);
			const message = continuationMessage("direct retry obligation");
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerA], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			harness.session.agent.state.messages = [continuationMessage("continue direct retry")];
			const retryRecovery = createDeferred();
			let retryRecoveryStarted = false;
			harness.setResponses([
				retryableError(),
				async () => {
					retryRecoveryStarted = true;
					await retryRecovery.promise;
					return fauxAssistantMessage("direct retry recovered");
				},
				fauxAssistantMessage("queued B done"),
			]);
			await harness.session.followUp("queued B after direct retry", undefined, { resumeIfIdle: true });
			const ownerB = actionByText(harness, "queued B after direct retry").promptIds![0]!;

			await vi.waitFor(() => expect(retryRecoveryStarted).toBe(true));
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerB)).toBeUndefined();
			expect(observer.retryLeases).toHaveLength(1);
			expect(observer.retryLeases[0]!.promptId).toBe(ownerA);
			expect(observer.retryLeases[0]!.releaseCalls).toBe(0);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);

			retryRecovery.resolve();
			await vi.waitFor(() => expect(harness.session.getPromptOutcome(ownerA)).toBeDefined());
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ status: "completed" });
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			await bGate.reached;
			expect(harness.faux.state.callCount).toBe(2);
			bGate.release();
			const outcomeB = await harness.session.waitForPromptOutcome(ownerB);
			expect(harness.faux.state.callCount).toBe(3);
			expect(outcomeB).toMatchObject({ promptId: ownerB, status: "completed" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			observer.restore();
		});

		it("takes one retry lease per captured owner on a continuation retry and releases once on recovery", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			continuationHarnesses.push(harness);
			// One composed acquire spy records BOTH kinds so the continuation
			// observer and the retry observer cannot overwrite each other.
			const acquireLog: Array<{ promptId: string; kind: PromptLeaseKind }> = [];
			const continuationLeases: ContinuationLeaseRecord[] = [];
			const retryLeases: RetryLeaseRecord[] = [];
			const tracker = (
				harness.session as unknown as {
					_promptSettlementTracker: { acquire(promptId: string, kind: PromptLeaseKind): PromptLease };
				}
			)._promptSettlementTracker;
			const originalAcquire = tracker.acquire.bind(tracker);
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					acquireLog.push({ promptId, kind });
					const lease = originalAcquire(promptId, kind);
					if (kind === "compaction_continuation") {
						const record: ContinuationLeaseRecord = {
							promptId,
							kind: "compaction_continuation",
							releaseCalls: 0,
						};
						const baseRelease = lease.release.bind(lease);
						const wrapped = lease as PromptLease & { release: () => void };
						wrapped.release = () => {
							record.releaseCalls += 1;
							baseRelease();
						};
						continuationLeases.push(record);
					} else if (kind === "retry") {
						const record: RetryLeaseRecord = { promptId, kind: "retry", releaseCalls: 0 };
						const baseRelease = lease.release.bind(lease);
						const wrapped = lease as PromptLease & { release: () => void };
						wrapped.release = () => {
							record.releaseCalls += 1;
							baseRelease();
						};
						retryLeases.push(record);
					}
					return lease;
				});
			const internals = continuationInternals(harness);
			const ownerId = "owner-cont-retry";
			admitOwners(harness, ownerId);
			// Simulate a continuation-window obligation created by a successful
			// threshold compaction with post-work.
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "cont retry work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerId]);

			// Seed the transcript so `agent.continue()` (not `prompt`) drives a real
			// provider run: first a retryable error, then a successful recovery.
			harness.session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "continue from here" }], timestamp: Date.now() },
			] as AgentMessage[];
			harness.setResponses([retryableError(), fauxAssistantMessage("recovered")]);
			// A continuation agent_end that is retryable: the synchronous pre-arm
			// must acquire the CAPTURED owner (installed by the direct runner),
			// never the mutable snapshot.
			internals._lastRunPromptIds = ["clobbered-owner"];
			internals._schedulePostCompactionContinue();
			await vi.advanceTimersByTimeAsync(100);
			// The synchronous agent_end pre-arm acquired the CAPTURED owner once.
			expect(acquireLog.filter((entry) => entry.kind === "retry").map((entry) => entry.promptId)).toEqual([ownerId]);
			// The clobbered mutable snapshot was never acquired as a retry owner.
			expect(acquireLog.some((entry) => entry.promptId === "clobbered-owner")).toBe(false);
			// After the retry chain settles: retry lease released once, continuation
			// window closed once, no early outcome (run lease still held the owner).
			await vi.advanceTimersByTimeAsync(300);
			expect(retryLeases[0]!.releaseCalls).toBe(1);
			expect(continuationLeases[0]!.releaseCalls).toBe(1);
			expect(retryLeases).toHaveLength(1);
			acquireSpy.mockRestore();
		});

		it("refreshes an armed A snapshot to A+B, gives pump ownership to tracked work, and closes both exactly once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "refresh-owner-a";
			const ownerB = "refresh-owner-b";
			admitOwners(harness, ownerA, ownerB);
			const messageA = {
				role: "user",
				content: [{ type: "text", text: "snapshot A" }],
				timestamp: Date.now(),
			} as AgentMessage;
			const messageB = {
				role: "user",
				content: [{ type: "text", text: "tracked snapshot B" }],
				timestamp: Date.now() + 1,
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();
			const timerA = internals._postCompactionContinuationTimer;
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageA]);

			const accepted = harness.session as unknown as {
				_createPreparedTurnAction(
					schedule: string,
					text: string,
					images: undefined,
					options: {
						message: AgentMessage;
						resumeIfIdle: boolean;
						lineage: { inherit: string[] };
					},
				): unknown;
				_admitSessionInput(action: unknown, options: { wake: boolean }): { accepted: boolean };
			};
			expect(
				accepted._admitSessionInput(
					accepted._createPreparedTurnAction("followUp", "tracked snapshot B", undefined, {
						message: messageB,
						resumeIfIdle: true,
						lineage: { inherit: [ownerB] },
					}),
					{ wake: false },
				),
			).toMatchObject({ accepted: true });
			internals._postCompactionContinuationMessages.push(messageB);
			expect(internals._scheduleContinuationForObligation([ownerA, ownerB], [messageA, messageB])).toBe(true);

			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA, ownerB],
				obligationMessages: [messageA, messageB],
				revision: 2,
			});
			const combinedWindow = internals._continuationSettlementWindow;
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageA, messageB]);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(internals._postCompactionContinuationTimer).not.toBe(timerA);
			expect(internals._continuationSchedulingPause).toBeUndefined();
			expect(observer.acquiresOfContinuation()).toEqual([
				{ promptId: ownerA, kind: "compaction_continuation" },
				{ promptId: ownerB, kind: "compaction_continuation" },
			]);
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([0, 0]);
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue(undefined as never);
			harness.setResponses([fauxAssistantMessage("tracked B handled")]);
			internals._lastRunTerminalStopReason = undefined;

			// The first timer hands off only B's tracked action to the pump. A's
			// direct obligation and every A+B continuation lease must remain live.
			await vi.advanceTimersByTimeAsync(100);
			expect(continueSpy).not.toHaveBeenCalled();
			expect(internals._continuationSettlementWindow).toBe(combinedWindow);
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA, ownerB],
				obligationMessages: [messageA],
				state: "scheduled",
				pumpOwned: false,
			});
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageA]);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(internals._continuationSchedulingPause).toBeDefined();
			expect(internals._continuationPumpOwnerAction).toBeUndefined();
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([0, 0]);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(0);

			// The fresh timer now executes A directly exactly once; only A's
			// terminal closes the combined window and releases both owner leases.
			await vi.advanceTimersByTimeAsync(100);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([1, 1]);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ status: "completed" });
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({ status: "completed" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("extends an active direct runner and guarantees a follow-up execution without letting the old runner close it", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "active-extension-a";
			const ownerB = "active-extension-b";
			admitOwners(harness, ownerA, ownerB);
			const messageA = {
				role: "user",
				content: [{ type: "text", text: "active A" }],
				timestamp: Date.now(),
			} as AgentMessage;
			const messageB = {
				role: "user",
				content: [{ type: "text", text: "active extension B" }],
				timestamp: Date.now() + 1,
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();
			const originalWindow = internals._continuationSettlementWindow!;
			let releaseFirst = () => {};
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			const continueSpy = vi
				.spyOn(harness.session.agent, "continue")
				.mockImplementationOnce(async () => {
					await firstGate;
				})
				.mockResolvedValueOnce(undefined as never);
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
			expect(internals._continuationSettlementWindow?.state).toBe("running");

			internals._postCompactionContinuationMessages.push(messageB);
			expect(internals._scheduleContinuationForObligation([ownerA, ownerB], [messageA, messageB])).toBe(true);
			expect(internals._continuationSettlementWindow).toBe(originalWindow);
			expect(internals._continuationSettlementWindow?.revision).toBe(2);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([0, 0]);

			releaseFirst();
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(2));
			await vi.advanceTimersByTimeAsync(100);
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([1, 1]);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ status: "completed" });
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({ status: "completed" });
			continueSpy.mockRestore();
			observer.restore();
		});

		it("treats a duplicate armed obligation as a no-op for revision, lease, timer, and snapshot", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "duplicate-obligation";
			admitOwners(harness, ownerId);
			const message = {
				role: "user",
				content: [{ type: "text", text: "same object obligation" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			const window = internals._continuationSettlementWindow!;
			const timer = internals._postCompactionContinuationTimer;
			const pause = internals._continuationSchedulingPause;
			const snapshot = internals._scheduledPostCompactionContinuationMessages;

			expect(internals._scheduleContinuationForObligation([ownerId, ownerId], [message, message])).toBe(true);
			expect(internals._continuationSettlementWindow).toBe(window);
			expect(window.revision).toBe(1);
			expect(window.owners).toEqual([ownerId]);
			expect(window.leases).toHaveLength(1);
			expect(window.obligationMessages).toEqual([message]);
			expect(observer.acquiresOfContinuation()).toHaveLength(1);
			expect(internals._postCompactionContinuationTimer).toBe(timer);
			expect(internals._continuationSchedulingPause).toBe(pause);
			expect(internals._scheduledPostCompactionContinuationMessages).toBe(snapshot);
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("parks and resumes the exact lease instances across a successful manual compaction", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-manual";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "manual park work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			const leaseBefore = observer.continuationLeases[0]!;
			expect(leaseBefore.releaseCalls).toBe(0);
			const hadScheduled = internals._postCompactionContinuationScheduled;
			expect(hadScheduled).toBe(true);

			// Manual success: the internal abort is adjacent; the window survives.
			harness.setResponses([fauxAssistantMessage("unused")]);
			await harness.session.compact();
			expect(observer.continuationLeases[0]).toBe(leaseBefore);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			expect(internals._continuationSettlementWindow?.state).toBe("scheduled");
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerId]);
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerId, kind: "compaction_continuation" }]);
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("parks a visibly running direct continuation for ordinary compact and resumes the same window and leases", async () => {
			vi.useRealTimers();
			let compactionEntered = () => {};
			const compactionStarted = new Promise<void>((resolve) => {
				compactionEntered = resolve;
			});
			let releaseCompaction = () => {};
			const compactionGate = new Promise<void>((resolve) => {
				releaseCompaction = resolve;
			});
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							compactionEntered();
							await compactionGate;
							return {
								compaction: {
									summary: "parked running continuation",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: { source: "extension" },
								},
							};
						});
					},
				],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "manual-running-success";
			admitOwners(harness, ownerId);
			const message = {
				role: "user",
				content: [{ type: "text", text: "running continuation to park" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			const windowBefore = internals._continuationSettlementWindow!;
			const leaseBefore = observer.continuationLeases[0]!;
			let releaseContinuation = () => {};
			const continuationGate = new Promise<void>((resolve) => {
				releaseContinuation = resolve;
			});
			let providerCalls = 0;
			const continueSpy = vi
				.spyOn(harness.session.agent, "continue")
				.mockImplementationOnce(async () => {
					providerCalls += 1;
					await continuationGate;
				})
				.mockImplementationOnce(async () => {
					providerCalls += 1;
				});
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
			expect(internals._continuationSettlementWindow).toBe(windowBefore);
			expect(internals._continuationSettlementWindow?.state).toBe("running");

			const compactPromise = harness.session.compact();
			await compactionStarted;
			expect(internals._continuationSettlementWindow).toBe(windowBefore);
			expect(internals._continuationSettlementWindow?.state).toBe("parked");
			expect(observer.continuationLeases[0]).toBe(leaseBefore);
			expect(leaseBefore.releaseCalls).toBe(0);
			expect(harness.session.getPromptOutcome(ownerId)).toBeUndefined();
			releaseContinuation();
			releaseCompaction();
			await compactPromise;
			expect(internals._continuationSettlementWindow).toBe(windowBefore);
			expect(internals._continuationSettlementWindow?.state).toBe("scheduled");
			expect(observer.continuationLeases[0]).toBe(leaseBefore);
			expect(leaseBefore.releaseCalls).toBe(0);
			await vi.waitFor(() => expect(providerCalls).toBe(2));
			await vi.waitFor(() => expect(leaseBefore.releaseCalls).toBe(1));
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "completed" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("external requestAbort during a parked manual operation cancels once and manual finally cannot rearm", async () => {
			vi.useRealTimers();
			let compactionEntered = () => {};
			const compactionStarted = new Promise<void>((resolve) => {
				compactionEntered = resolve;
			});
			let releaseCompaction = () => {};
			const compactionGate = new Promise<void>((resolve) => {
				releaseCompaction = resolve;
			});
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							compactionEntered();
							await compactionGate;
							return {
								compaction: {
									summary: "externally aborted parked window",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						});
					},
				],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "manual-park-external-abort";
			admitOwners(harness, ownerId);
			const message = {
				role: "user",
				content: [{ type: "text", text: "park then externally abort" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			const lease = observer.continuationLeases[0]!;

			const compactPromise = harness.session.compact();
			await compactionStarted;
			expect(internals._continuationSettlementWindow?.state).toBe("parked");
			harness.session.requestAbort();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(lease.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "cancelled" });
			releaseCompaction();
			await expect(compactPromise).rejects.toThrow("Compaction cancelled");
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(lease.releaseCalls).toBe(1);
			expect(observer.acquiresOfContinuation()).toHaveLength(1);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("[round-1 fix 7] ordinary manual failure cancels and closes exactly once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-manual-fail";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "manual fail work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			expect(harness.session.getPromptOutcome(ownerId)).toBeUndefined();
			expect(observer.continuationLeases).toHaveLength(1);

			// Manual failure: no extension compaction and session too short -> skip,
			// and the ordinary (non-skipAbort) manual failure cancels window owners
			// and closes exactly once.
			await expect(harness.session.compact()).rejects.toThrow(expect.anything());
			// The window was cancelled (cancel fence before release) and closed once.
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				promptId: ownerId,
				status: "cancelled",
			});
			expect(harness.session.getPromptOutcome(ownerId)?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("external requestAbort while a running continuation is parked cancels once and manual finally cannot rearm", async () => {
			vi.useRealTimers();
			let compactionEntered = () => {};
			const compactionStarted = new Promise<void>((resolve) => {
				compactionEntered = resolve;
			});
			let releaseCompaction = () => {};
			const compactionGate = new Promise<void>((resolve) => {
				releaseCompaction = resolve;
			});
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							compactionEntered();
							await compactionGate;
							return {
								compaction: {
									summary: "externally aborted running park",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						});
					},
				],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "manual-running-external-abort";
			admitOwners(harness, ownerId);
			const message = {
				role: "user",
				content: [{ type: "text", text: "running park then external abort" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			let releaseContinuation = () => {};
			const continuationGate = new Promise<void>((resolve) => {
				releaseContinuation = resolve;
			});
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				await continuationGate;
			});
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
			expect(internals._continuationSettlementWindow?.state).toBe("running");
			const lease = observer.continuationLeases[0]!;

			const compactPromise = harness.session.compact();
			await compactionStarted;
			expect(internals._continuationSettlementWindow?.state).toBe("parked");
			harness.session.requestAbort();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(lease.releaseCalls).toBe(1);
			releaseContinuation();
			releaseCompaction();
			await expect(compactPromise).rejects.toThrow("Compaction cancelled");
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(observer.acquiresOfContinuation()).toHaveLength(1);
			expect(lease.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "cancelled" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("ordinary manual failure from a running continuation cancels and closes the window exactly once", async () => {
			vi.useRealTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => ({ cancel: true }));
					},
				],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "manual-running-failure";
			admitOwners(harness, ownerId);
			const message = {
				role: "user",
				content: [{ type: "text", text: "running continuation then compact fails" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			let releaseContinuation = () => {};
			const continuationGate = new Promise<void>((resolve) => {
				releaseContinuation = resolve;
			});
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				await continuationGate;
			});
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
			expect(internals._continuationSettlementWindow?.state).toBe("running");
			const lease = observer.continuationLeases[0]!;

			const compactPromise = harness.session.compact();
			internals._lastRunTerminalStopReason = "aborted";
			releaseContinuation();
			await expect(compactPromise).rejects.toThrow("Compaction cancelled");
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(lease.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "cancelled" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("creates no window or timer when successful threshold compaction has no prompt-owned post-work", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-no-post-work";
			admitOwners(harness, ownerId);
			internals._lastRunPromptIds = [ownerId];
			internals._postCompactionContinuationMessages = [];

			// Successful threshold compaction, no continuation work: generation
			// bumps but there is no continuation lease/window/timer.
			await internals._runAutoCompaction("threshold", false);
			expect(observer.generationBumps).toEqual([ownerId]);
			expect(observer.acquiresOfContinuation()).toEqual([]);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			observer.restore();
		});

		it("[round-1 fix 5] failed, cancelled, manual, skipAbort, overflow, and ownerless pre-turn compactions never bump", async () => {
			vi.useFakeTimers();
			const ownerId = "generation-negative-owner";

			const failedHarness = await createHarness({ withConfiguredAuth: false });
			continuationHarnesses.push(failedHarness);
			admitOwners(failedHarness, ownerId);
			const failedObserver = installContinuationObserver(failedHarness);
			continuationInternals(failedHarness)._lastRunPromptIds = [ownerId];
			await continuationInternals(failedHarness)._runAutoCompaction("threshold", false);
			expect(failedObserver.generationBumps).toEqual([]);
			failedObserver.restore();

			const cancelledHarness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [(pi) => pi.on("session_before_compact", async () => ({ cancel: true }))],
			});
			continuationHarnesses.push(cancelledHarness);
			seedSessionForCompaction(cancelledHarness);
			admitOwners(cancelledHarness, ownerId);
			const cancelledObserver = installContinuationObserver(cancelledHarness);
			continuationInternals(cancelledHarness)._lastRunPromptIds = [ownerId];
			await continuationInternals(cancelledHarness)._runAutoCompaction("threshold", false);
			expect(cancelledObserver.generationBumps).toEqual([]);
			cancelledObserver.restore();

			const manualHarness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("manual generation negative")],
			});
			continuationHarnesses.push(manualHarness);
			seedSessionForCompaction(manualHarness);
			admitOwners(manualHarness, ownerId);
			const manualObserver = installContinuationObserver(manualHarness);
			continuationInternals(manualHarness)._lastRunPromptIds = [ownerId];
			await manualHarness.session.compact();
			expect(manualObserver.generationBumps).toEqual([]);
			appendCompactionTurn(manualHarness, "after manual compact");
			await manualHarness.session.compact(undefined, { skipAbort: true });
			expect(manualObserver.generationBumps).toEqual([]);
			manualObserver.restore();

			const overflowHarness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("overflow generation negative")],
			});
			continuationHarnesses.push(overflowHarness);
			seedSessionForCompaction(overflowHarness);
			admitOwners(overflowHarness, ownerId);
			const overflowObserver = installContinuationObserver(overflowHarness);
			continuationInternals(overflowHarness)._lastRunPromptIds = [ownerId];
			await continuationInternals(overflowHarness)._runAutoCompaction("overflow", true);
			expect(overflowObserver.generationBumps).toEqual([]);
			continuationInternals(overflowHarness)._cancelPostCompactionContinue({ owners: "fail" });
			overflowObserver.restore();

			const ownerlessHarness = await createHarness({
				settings: { compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
				models: [{ id: "faux-1", contextWindow: 20 }],
				extensionFactories: [compactSummaryExtension("ownerless pre-turn generation negative")],
			});
			continuationHarnesses.push(ownerlessHarness);
			seedSessionForCompaction(ownerlessHarness);
			const ownerlessObserver = installContinuationObserver(ownerlessHarness);
			continuationInternals(ownerlessHarness)._lastRunPromptIds = [];
			await continuationInternals(ownerlessHarness)._runPreTurnCompaction();
			expect(ownerlessObserver.generationBumps).toEqual([]);
			expect(ownerlessObserver.acquiresOfContinuation()).toEqual([]);
			ownerlessObserver.restore();
		});

		it("[round-1 fix 5] production pre-turn compaction bumps only the installed next-batch owners", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
				models: [{ id: "faux-1", contextWindow: 20 }],
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const nextBatchOwners = ["next-a", "next-b"];
			admitOwners(harness, ...nextBatchOwners);
			internals._lastRunPromptIds = [...nextBatchOwners];

			// Drive the actual pre-turn caller after the pump has installed the next batch.
			await internals._runPreTurnCompaction();
			expect(observer.generationBumps.sort()).toEqual([...nextBatchOwners].sort());
			// No post-work: no window/timer.
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			observer.restore();
		});

		it("rolls back siblings, keeps the old window, and fails closed when extending with a second owner fails", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "ext-a";
			const ownerB = "ext-b";
			admitOwners(harness, ownerA, ownerB);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerA];
			await internals._runAutoCompaction("threshold", false);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			const oldWindowRevision = internals._continuationSettlementWindow?.revision;
			const postCompactionTurn = {
				role: "user",
				content: [{ type: "text", text: "post-compaction B turn" }],
				timestamp: Date.now(),
			} as AgentMessage;
			harness.sessionManager.appendMessage(postCompactionTurn as never);
			harness.session.agent.state.messages = [postCompactionTurn];

			// B's real obligation tries to extend; the second (B) acquire fails.
			const tracker = (
				harness.session as unknown as {
					_promptSettlementTracker: { acquire(promptId: string, kind: PromptLeaseKind): PromptLease };
				}
			)._promptSettlementTracker;
			const originalAcquire = tracker.acquire.bind(tracker);
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					if (kind === "compaction_continuation" && promptId === ownerB) {
						throw new Error("simulated second continuation acquire failure");
					}
					const lease = originalAcquire(promptId, kind);
					if (kind === "compaction_continuation") {
						observer.continuationLeases.push({ promptId, kind: "compaction_continuation", releaseCalls: 0 });
						const baseRelease = lease.release.bind(lease);
						const record = observer.continuationLeases.at(-1)!;
						const wrapped = lease as PromptLease & { release: () => void };
						wrapped.release = () => {
							record.releaseCalls += 1;
							baseRelease();
						};
					}
					return lease;
				});
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerA, ownerB];
			internals._postCompactionContinuationMessages = [
				{ role: "user", content: [{ type: "text", text: "b obligation" }], timestamp: Date.now() } as AgentMessage,
			];
			await internals._runAutoCompaction("threshold", false);
			// Old window intact, no B lease, revision unchanged, B failed closed.
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			expect(internals._continuationSettlementWindow?.revision).toBe(oldWindowRevision);
			expect(observer.acquiresOfContinuation().filter((entry) => entry.promptId === ownerB)).toHaveLength(0);
			acquireSpy.mockRestore();
			expect(internals._promptSettlementTracker.isSettling(ownerB)).toBe(true);
			const ownerBTerminalLease = internals._promptSettlementTracker.acquire(ownerB, "run");
			ownerBTerminalLease.release();
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			observer.restore();
		});

		it("rolls back create siblings and fails every captured owner when a fresh window acquire fails", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const internals = continuationInternals(harness);
			const owners = ["create-fail-a", "create-fail-b", "create-fail-c"];
			admitOwners(harness, ...owners);
			const tracker = internals._promptSettlementTracker;
			const observerAcquire = tracker.acquire.bind(tracker);
			const rolledBack: Array<{ promptId: string; releaseCalls: number }> = [];
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					if (kind === "compaction_continuation" && promptId === owners[2]) {
						throw new Error("simulated fresh-window sibling acquire failure");
					}
					const lease = observerAcquire(promptId, kind);
					if (kind === "compaction_continuation") {
						const record = { promptId, releaseCalls: 0 };
						const baseRelease = lease.release.bind(lease);
						lease.release = () => {
							record.releaseCalls += 1;
							baseRelease();
						};
						rolledBack.push(record);
					}
					return lease;
				});
			const obligation = {
				role: "user",
				content: [{ type: "text", text: "fresh create obligation" }],
				timestamp: Date.now(),
			} as AgentMessage;

			expect(internals._scheduleContinuationForObligation(owners, [obligation])).toBe(false);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(rolledBack).toEqual([
				{ promptId: owners[0], releaseCalls: 1 },
				{ promptId: owners[1], releaseCalls: 1 },
			]);
			for (const owner of owners) {
				if (harness.session.getPromptOutcome(owner)) continue;
				const terminalLease = tracker.acquire(owner, "run");
				terminalLease.release();
			}
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(3);
			for (const owner of owners) {
				expect(harness.session.getPromptOutcome(owner)).toMatchObject({
					promptId: owner,
					status: "failed",
					failure: { reason: "run_error" },
				});
			}
			acquireSpy.mockRestore();
		});

		it("[round-1 fix 2] production threshold create failure drops the failed action and never arms unowned work", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("create failure summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const internals = continuationInternals(harness);
			const ownerId = "production-create-failure";
			admitOwners(harness, ownerId);
			const tracker = internals._promptSettlementTracker;
			const runLease = tracker.acquire(ownerId, "run");
			const message = continuationMessage("failed threshold obligation");
			internals._postCompactionContinuationMessages = [message];
			internals._pendingThresholdCompactionAutonomousMessages = [message];
			admitTrackedContinuationAction(harness, message);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerId];
			const originalAcquire = tracker.acquire.bind(tracker);
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					if (kind === "compaction_continuation") throw new Error("continuation acquire rejected");
					return originalAcquire(promptId, kind);
				});
			const continueSpy = vi.spyOn(harness.session.agent, "continue");
			harness.setResponses([fauxAssistantMessage("failed work must never execute")]);

			await internals._runAutoCompaction("threshold", false);
			runLease.release();
			await vi.advanceTimersByTimeAsync(200);
			await harness.session.waitForSessionInputIdle();

			expect({
				window: internals._continuationSettlementWindow,
				scheduled: internals._postCompactionContinuationScheduled,
				timer: internals._postCompactionContinuationTimer,
				messages: internals._postCompactionContinuationMessages,
				pending: internals._pendingThresholdCompactionAutonomousMessages,
				failedActionStillOwned: turnActions(harness).some(
					(action) => action.payload.text === "failed threshold obligation",
				),
				providerCalls: harness.faux.state.callCount,
				continueCalls: continueSpy.mock.calls.length,
			}).toEqual({
				window: undefined,
				scheduled: false,
				timer: undefined,
				messages: [],
				pending: [],
				failedActionStillOwned: false,
				providerCalls: 0,
				continueCalls: 0,
			});
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				status: "failed",
				traceGeneration: 1,
				failure: { reason: "run_error" },
			});
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			acquireSpy.mockRestore();
		});

		it("[round-1 fix 2] production threshold extend failure preserves A and removes only B before any rearm", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("extend failure summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const internals = continuationInternals(harness);
			const [ownerA, ownerB] = ["extend-kept-a", "extend-failed-b"];
			admitOwners(harness, ownerA, ownerB);
			const tracker = internals._promptSettlementTracker;
			const runLeaseA = tracker.acquire(ownerA, "run");
			const runLeaseB = tracker.acquire(ownerB, "run");
			const messageA = continuationMessage("existing A obligation");
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();
			const oldWindow = internals._continuationSettlementWindow!;
			const oldRevision = oldWindow.revision;
			const oldLeases = oldWindow.leases;
			const oldObligationMessages = oldWindow.obligationMessages;
			const oldTimer = internals._postCompactionContinuationTimer;
			const oldSnapshot = internals._scheduledPostCompactionContinuationMessages;
			const messageB = continuationMessage("failed B obligation");
			internals._postCompactionContinuationMessages.push(messageB);
			internals._pendingThresholdCompactionAutonomousMessages = [messageB];
			admitTrackedContinuationAction(harness, messageB);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerA, ownerB];
			const originalAcquire = tracker.acquire.bind(tracker);
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					if (kind === "compaction_continuation" && promptId === ownerB) {
						throw new Error("B continuation acquire rejected");
					}
					return originalAcquire(promptId, kind);
				});

			await internals._runAutoCompaction("threshold", false);
			expect(internals._continuationSettlementWindow).toBe(oldWindow);
			expect(oldWindow.revision).toBe(oldRevision);
			expect(oldWindow.leases).toBe(oldLeases);
			expect(oldWindow.obligationMessages).toBe(oldObligationMessages);
			expect(oldWindow.obligationMessages).toEqual([messageA]);
			expect(internals._postCompactionContinuationTimer).toBe(oldTimer);
			expect(internals._scheduledPostCompactionContinuationMessages).toBe(oldSnapshot);
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageA]);
			expect(internals._postCompactionContinuationMessages).toEqual([messageA]);
			expect(internals._pendingThresholdCompactionAutonomousMessages).toEqual([]);
			expect(turnActions(harness).some((action) => action.payload.text === "failed B obligation")).toBe(false);
			expect(oldWindow.pumpOwned).toBe(false);
			expect(internals._continuationPumpOwnerAction).toBeUndefined();

			// A later internal busy rearm must still snapshot only A; failed B can
			// never enter A's direct runner under A's surviving lease.
			withStreaming(harness, true);
			await vi.advanceTimersByTimeAsync(100);
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageA]);
			expect(internals._continuationSettlementWindow).toBe(oldWindow);
			expect(oldWindow.revision).toBe(oldRevision);
			withStreaming(harness, false);
			internals._cancelPostCompactionContinue();
			runLeaseA.release();
			runLeaseB.release();
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ status: "completed", traceGeneration: 1 });
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				status: "failed",
				traceGeneration: 1,
				failure: { reason: "run_error" },
			});
			acquireSpy.mockRestore();
		});

		it("[round-1 fix 2] requested-failure acquire rejection drops the same-run resume instead of running it unowned", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({ withConfiguredAuth: false });
			continuationHarnesses.push(harness);
			const internals = continuationInternals(harness);
			const ownerId = "requested-failure-acquire-rejected";
			admitOwners(harness, ownerId);
			const tracker = internals._promptSettlementTracker;
			const runLease = tracker.acquire(ownerId, "run");
			const message = continuationMessage("failed requested resume");
			internals._postCompactionContinuationMessages = [message];
			admitTrackedContinuationAction(harness, message);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerId];
			const originalAcquire = tracker.acquire.bind(tracker);
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					if (kind === "compaction_continuation") throw new Error("resume acquire rejected");
					return originalAcquire(promptId, kind);
				});
			harness.setResponses([fauxAssistantMessage("unowned requested resume must not run")]);

			await expect(internals._runAutoCompaction("requested", false)).resolves.toBe(false);
			runLease.release();
			await vi.advanceTimersByTimeAsync(200);
			await harness.session.waitForSessionInputIdle();

			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._postCompactionContinuationMessages).toEqual([]);
			expect(turnActions(harness).some((action) => action.payload.text === "failed requested resume")).toBe(false);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				status: "failed",
				traceGeneration: 0,
				failure: { reason: "run_error" },
			});
			acquireSpy.mockRestore();
		});

		it("fails closed and resolves the old retry window when overflow willRetry acquisition fails", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("overflow summary")],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "overflow-failclosed";
			admitOwners(harness, ownerId);
			seedSessionForCompaction(harness);
			internals._lastRunPromptIds = [ownerId];
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});
			// Force every continuation acquire to fail.
			const tracker = (
				harness.session as unknown as {
					_promptSettlementTracker: { acquire(promptId: string, kind: PromptLeaseKind): PromptLease };
				}
			)._promptSettlementTracker;
			const originalAcquireCall = tracker.acquire.bind(tracker);
			const acquireSpy = vi
				.spyOn(tracker, "acquire")
				.mockImplementation((promptId: string, kind: PromptLeaseKind) => {
					if (kind === "compaction_continuation") throw new Error("simulated continuation acquire failure");
					return originalAcquireCall(promptId, kind);
				});
			try {
				await internals._runAutoCompaction("overflow", true);
			} catch {
				// Expected: no window, no schedule, old retry resolved.
			}
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryResolve).toBeUndefined();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			internals._cancelPostCompactionContinue();
			expect(observer.acquiresOfContinuation()).toEqual([]);
			acquireSpy.mockRestore();
			observer.restore();
		});

		it("[round-1 fix 3] public abortRetry leaves an ownerless generic 100ms wake intact", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			internals._lastRunPromptIds = [];
			internals._postCompactionContinuationMessages = [
				{
					role: "user",
					content: [{ type: "text", text: "ownerless cont" }],
					timestamp: Date.now(),
				} as AgentMessage,
			];
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue(undefined as never);
			internals._schedulePostCompactionContinue();
			harness.session.abortRetry();
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			await vi.advanceTimersByTimeAsync(100);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(observer.acquiresOfContinuation()).toEqual([]);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[round-1 fix 3] public abortRetry leaves a threshold continuation window and timer intact", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "threshold-survives-abort-retry";
			admitOwners(harness, ownerId);
			const message = continuationMessage("threshold continuation survives abortRetry");
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			const window = internals._continuationSettlementWindow;
			const timer = internals._postCompactionContinuationTimer;
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});

			harness.session.abortRetry();
			expect(internals._continuationSettlementWindow).toBe(window);
			expect(internals._postCompactionContinuationTimer).toBe(timer);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			expect(harness.session.getPromptOutcome(ownerId)).toBeUndefined();

			await vi.advanceTimersByTimeAsync(100);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "completed" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("releases exactly once on a direct continuation success and fences normal completion without an outcome change", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-direct-success";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "direct success work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			harness.session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "cont" }], timestamp: Date.now() },
			] as AgentMessage[];
			harness.setResponses([fauxAssistantMessage("direct cont done")]);

			internals._schedulePostCompactionContinue();
			await vi.advanceTimersByTimeAsync(250);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			// No run lease exists for this isolated owner: the last continuation
			// release settles it completed (the run had already succeeded).
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				promptId: ownerId,
				status: "completed",
			});
			expect(outcomeCount(harness)).toBe(1);
			observer.restore();
		});

		it("[round-1 fix 6] direct continuation throw keeps queued B behind the failed close, then wakes B once", async () => {
			vi.useRealTimers();
			const gate = gatedHook({ prompt: "queued B after direct throw" });
			const harness = await createHarness({ extensionFactories: [gate.factory] });
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "direct-throw-a";
			admitOwners(harness, ownerA);
			const message = continuationMessage("direct throw obligation");
			internals._postCompactionContinuationMessages = [message];
			expect(internals._scheduleContinuationForObligation([ownerA], [message])).toBe(true);
			internals._schedulePostCompactionContinue();
			await harness.session.followUp("queued B after direct throw", undefined, { resumeIfIdle: true });
			const ownerB = actionByText(harness, "queued B after direct throw").promptIds![0]!;
			const continueSpy = vi
				.spyOn(harness.session.agent, "continue")
				.mockRejectedValueOnce(new Error("direct continuation provider exploded"));
			harness.setResponses([fauxAssistantMessage("queued B done")]);

			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			await gate.reached;
			expect(harness.faux.state.callCount).toBe(0);
			gate.release();
			const outcomeB = await harness.session.waitForPromptOutcome(ownerB);
			expect(harness.faux.state.callCount).toBe(1);
			expect(outcomeB).toMatchObject({ promptId: ownerB, status: "completed" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("fences run_error and closes exactly once when the direct continuation throws non-already-processing", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-direct-throw";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "direct throw work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			const continueSpy = vi
				.spyOn(harness.session.agent, "continue")
				.mockRejectedValueOnce(new Error("provider exploded"));
			internals._schedulePostCompactionContinue();
			await vi.advanceTimersByTimeAsync(250);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			// The owner is fenced as failed (run_error) and settles failed when the
			// last lease (the continuation lease) releases.
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				status: "failed",
				failure: { reason: "run_error" },
			});
			continueSpy.mockRestore();
			observer.restore();
		});

		it("direct continuation aborted fences cancelled and closes exactly once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-direct-aborted";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "direct aborted work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			harness.session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "cont" }], timestamp: Date.now() },
			] as AgentMessage[];
			harness.setResponses([fauxAssistantMessage("aborted", { stopReason: "aborted" })]);

			internals._schedulePostCompactionContinue();
			await vi.advanceTimersByTimeAsync(250);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				status: "cancelled",
			});
			observer.restore();
		});

		it("later B compaction cannot mutate terminal A: A's generation and outcome stay frozen", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "owner-terminal-a";
			const ownerB = "owner-terminal-b";
			admitOwners(harness, ownerA, ownerB);
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerA];
			internals._postCompactionContinuationMessages = [
				{ role: "user", content: [{ type: "text", text: "A obligation" }], timestamp: Date.now() } as AgentMessage,
			];
			await internals._runAutoCompaction("threshold", false);
			// Release the window: A completes with generation 1.
			internals._cancelPostCompactionContinue();
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({
				status: "completed",
				traceGeneration: 1,
			});
			const aOutcome = harness.session.getPromptOutcome(ownerA);

			// B compacts successfully: only B's generation bumps; A stays frozen.
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "post-A" }],
				timestamp: Date.now(),
			} as never);
			harness.session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "post-A" }], timestamp: Date.now() },
			] as AgentMessage[];
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerB];
			await internals._runAutoCompaction("threshold", false);
			expect(observer.generationBumps).toEqual([ownerA, ownerB]);
			expect(harness.session.getPromptOutcome(ownerA)).toBe(aOutcome);
			expect(aOutcome!.traceGeneration).toBe(1);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerB]);
			internals._cancelPostCompactionContinue();
			observer.restore();
		});

		it("keeps the window and bumps generation to 2 when the continuation re-compacts successfully", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-recompact";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "recompact work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			// First successful threshold compaction: generation 0 -> 1 and window.
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerId];
			internals._postCompactionContinuationMessages = [obligationMessage];
			await internals._runAutoCompaction("threshold", false);
			expect(observer.generationBumps).toEqual([ownerId]);
			expect(internals._continuationSettlementWindow?.revision).toBe(1);
			internals._schedulePostCompactionContinue();
			// Add a fresh turn after the first compaction so `prepareCompaction`
			// finds a new cut point (the last entry is no longer the compaction).
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "post-first-compaction" }],
				timestamp: Date.now(),
			} as never);
			harness.session.agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "post-first-compaction" }], timestamp: Date.now() },
			] as AgentMessage[];
			// The continuation run re-compacts successfully with the same owners
			// and NEW continuation work: generation 1 -> 2 (each generation bumps
			// exactly once) and the SAME window becomes one revision newer.
			internals._lastRunPromptIds = [ownerId];
			internals._continueAfterThresholdCompaction = true;
			const newObligationMessage = {
				role: "user",
				content: [{ type: "text", text: "second-generation continuation work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [newObligationMessage];
			await internals._runAutoCompaction("threshold", false);
			expect(observer.generationBumps).toEqual([ownerId, ownerId]);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerId]);
			expect(internals._continuationSettlementWindow?.revision).toBe(2);
			expect(internals._continuationSettlementWindow?.obligationMessages).toEqual([
				obligationMessage,
				newObligationMessage,
			]);
			internals._cancelPostCompactionContinue();
			observer.restore();
		});

		it("detaches every old scheduler field before outcome reentry and preserves the listener-created replacement", async () => {
			vi.useFakeTimers();
			const harness = await createHarness();
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const oldOwner = "detach-reentry-old";
			const replacementOwner = "detach-reentry-new";
			admitOwners(harness, oldOwner, replacementOwner);
			const oldMessage = {
				role: "user",
				content: [{ type: "text", text: "old detach obligation" }],
				timestamp: Date.now(),
			} as AgentMessage;
			const replacementMessage = {
				role: "user",
				content: [{ type: "text", text: "reentrant replacement obligation" }],
				timestamp: Date.now() + 1,
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [oldMessage];
			expect(internals._scheduleContinuationForObligation([oldOwner], [oldMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			const oldTimer = internals._postCompactionContinuationTimer as ReturnType<typeof setTimeout>;
			const oldPause = internals._continuationSchedulingPause;
			const oldLease = observer.continuationLeases[0]!;
			const reentrySnapshots: Array<{
				window: unknown;
				scheduled: boolean;
				timer: unknown;
				messages: AgentMessage[];
				pause: unknown;
			}> = [];
			let replacementWindow: ContinuationInternals["_continuationSettlementWindow"];
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "prompt_outcome" || event.outcome.promptId !== oldOwner) return;
				reentrySnapshots.push({
					window: internals._continuationSettlementWindow,
					scheduled: internals._postCompactionContinuationScheduled,
					timer: internals._postCompactionContinuationTimer,
					messages: [...internals._scheduledPostCompactionContinuationMessages],
					pause: internals._continuationSchedulingPause,
				});
				internals._postCompactionContinuationMessages = [replacementMessage];
				expect(internals._scheduleContinuationForObligation([replacementOwner], [replacementMessage])).toBe(true);
				internals._schedulePostCompactionContinue();
				replacementWindow = internals._continuationSettlementWindow;
			});

			expect(internals._cancelPostCompactionContinue()).toBe(true);
			const replacementLease = observer.continuationLeases[1]!;
			expect(reentrySnapshots).toEqual([
				{ window: undefined, scheduled: false, timer: undefined, messages: [], pause: undefined },
			]);
			expect(oldLease.releaseCalls).toBe(1);
			expect(replacementWindow).toBeDefined();
			expect(internals._continuationSettlementWindow).toBe(replacementWindow);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationTimer).toBeDefined();
			expect(internals._postCompactionContinuationTimer).not.toBe(oldTimer);
			expect(internals._continuationSchedulingPause).not.toBe(oldPause);
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([replacementMessage]);
			expect(replacementLease.releaseCalls).toBe(0);

			expect(internals._cancelPostCompactionContinue()).toBe(true);
			expect(internals._cancelPostCompactionContinue()).toBe(false);
			expect(replacementLease.releaseCalls).toBe(1);
			await vi.advanceTimersByTimeAsync(100);
			expect(oldLease.releaseCalls).toBe(1);
			expect(replacementLease.releaseCalls).toBe(1);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			unsubscribe();
			observer.restore();
		});

		it("[round-1 fix 7] requestAbort cancels window owners before an exact-once release", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-abort";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "abort work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();

			harness.session.requestAbort();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			// Repeated abort/cancel: no second release, no second outcome.
			harness.session.requestAbort();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "cancelled" });
			expect(harness.session.getPromptOutcome(ownerId)?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("[round-1 fix 7] abortForUpdateRestart cancels window owners before an exact-once release", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-update-restart";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "update restart work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();

			harness.session.abortForUpdateRestart();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "cancelled" });
			expect(harness.session.getPromptOutcome(ownerId)?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("[round-1 fix 7] dispose cancels window owners then resolves the waiter exactly once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-dispose";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "dispose work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();

			const outcomePromise = harness.session.waitForPromptOutcome(ownerId);
			harness.session.dispose();
			const outcome = await outcomePromise;
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(outcome).toMatchObject({ promptId: ownerId, status: "cancelled" });
			expect(outcome.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("[round-1 fix 3] abortRetry marks overflow continuation owners failed (not cancelled) and closes exactly once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-abort-retry";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "abort retry work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._continuationSettlementWindow!.overflowRecoveryOwners = [ownerId];
			internals._schedulePostCompactionContinue();
			internals._retryAttempt = 1;
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});

			harness.session.abortRetry();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				promptId: ownerId,
				status: "failed",
				failure: { reason: "run_error" },
			});
			// The cancel fence is NOT set: abortRetry is a failure, not a prompt abort.
			harness.session.abortRetry();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			observer.restore();
		});

		it("skipAbort success and skipAbort skipped compaction both resume the parked window with the exact leases", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-skipabort";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "skipabort work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			const keptLease = observer.continuationLeases[0]!;

			// skipAbort does NOT call abort, so the parked window survives the
			// compaction and resumes after success.
			await harness.session.compact(undefined, { skipAbort: true });
			expect(internals._continuationSettlementWindow?.state).toBe("scheduled");
			expect(observer.continuationLeases[0]).toBe(keptLease);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			// Failure/skipped branch: a second compact without extension material
			// throws CompactionSkippedError, and the window still resumes.
			await expect(harness.session.compact(undefined, { skipAbort: true })).rejects.toThrow(expect.anything());
			expect(internals._continuationSettlementWindow?.state).toBe("scheduled");
			expect(observer.continuationLeases[0]).toBe(keptLease);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			observer.restore();
		});

		it("[round-1 fix 7] production branch invalidation release-closes completed once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-branch-invalid";
			admitOwners(harness, ownerId);
			const obligationMessage = {
				role: "user",
				content: [{ type: "text", text: "branch work" }],
				timestamp: Date.now(),
			} as AgentMessage;
			expect(internals._scheduleContinuationForObligation([ownerId], [obligationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();

			// Drive the real branch-change caller. It release-closes this obligation
			// without a cancel/failure fence, so the already-successful owner completes.
			await internals._invalidatePendingAutoRefineForBranchChange();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(outcomeCount(harness)).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)?.status).toBe("completed");
			expect(harness.session.getPromptOutcome(ownerId)?.failure).toBeUndefined();
			await internals._invalidatePendingAutoRefineForBranchChange();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(outcomeCount(harness)).toBe(1);
			observer.restore();
		});

		it("[round-1 fix 1] retryable error then overflow drives one recovery, closes retry/window, and wakes queued B once", async () => {
			vi.useRealTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("retry-then-overflow summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			let releaseRecovery = () => {};
			const recoveryGate = new Promise<void>((resolve) => {
				releaseRecovery = resolve;
			});
			let recoveryStarted = false;
			harness.setResponses([
				retryableError(),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
				async () => {
					recoveryStarted = true;
					await recoveryGate;
					return fauxAssistantMessage("retry-then-overflow recovered");
				},
				fauxAssistantMessage("queued B completed"),
			]);
			const ownerAIds: string[] = [];
			const A = harness.session.promptAndSettle("retry then overflow A", {
				settlementAdmission: (info) => ownerAIds.push(info.promptId!),
			});
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
			await vi.waitFor(() => expect(internals._continuationSettlementWindow?.owners).toEqual(ownerAIds));
			expect(internals._retryPromise).toBeDefined();
			const continueSpy = vi.spyOn(harness.session.agent, "continue");
			await harness.session.followUp("queued B after retry-overflow", undefined, { resumeIfIdle: true });
			const ownerB = actionByText(harness, "queued B after retry-overflow").promptIds![0]!;

			await vi.waitFor(() => expect(recoveryStarted).toBe(true));
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.session.getPromptOutcome(ownerAIds[0]!)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerB)).toBeUndefined();
			expect(observer.retryLeases).toHaveLength(1);
			expect(observer.retryLeases[0]!.releaseCalls).toBe(0);
			expect(observer.continuationLeases).toHaveLength(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);

			releaseRecovery();
			const outcomeA = await A;
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(4));
			const outcomeB = await harness.session.waitForPromptOutcome(ownerB);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryResolve).toBeUndefined();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(outcomeA).toMatchObject({ promptId: ownerAIds[0], status: "completed" });
			expect(outcomeA?.failure).toBeUndefined();
			expect(outcomeB).toMatchObject({ promptId: ownerB, status: "completed" });
			expect(harness.faux.state.callCount).toBe(4);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerAIds[0]),
			).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("overflow recovery success: provisional error suppressed, A completed, queued B calls 0 before fence and exactly 1 after pause release", async () => {
			vi.useRealTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("overflow recovery summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			// A's run ends with an overflow error (never retryable); the recovery
			// continuation response is gated so we can observe B before/after A's
			// terminal fence; B is already accepted into the session-owned queue
			// (admission is pause-free; only STARTING defers behind the pause).
			let releaseRecovery = () => {};
			const recoveryGate = new Promise<void>((resolve) => {
				releaseRecovery = resolve;
			});
			let recoveryStarted = false;
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
				async () => {
					recoveryStarted = true;
					await recoveryGate;
					return fauxAssistantMessage("recovered after overflow");
				},
				fauxAssistantMessage("B completed"),
			]);
			const ownerAId: string[] = [];
			const A = harness.session.promptAndSettle("overflow A", {
				settlementAdmission: (info) => ownerAId.push(info.promptId!),
			});
			await vi.waitFor(() => expect(ownerAId).toHaveLength(1));
			void harness.session.followUp("queued B", undefined, { resumeIfIdle: true });
			await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["queued B"]));
			const ownerBId = turnActions(harness).find((action) => action.payload.text === "queued B")!.promptIds![0];

			// A's error consumed one provider call; overflow compaction is
			// extension-provided; the recovery continuation run starts the second.
			await vi.waitFor(() => expect(recoveryStarted).toBe(true));
			expect(harness.faux.state.callCount).toBe(2);
			// The provisional error must NOT have fenced A failed at the main-run
			// terminal: A is still settling (recovery owns it), no outcome yet.
			expect(harness.session.getPromptOutcome(ownerAId[0])).toBeUndefined();
			expect(internals._continuationSettlementWindow?.owners).toEqual(ownerAId);

			// While A's recovery runs (pause held by the direct runner), B's
			// provider call count is still 0: only A's error + A's recovery ran.
			expect(harness.faux.state.callCount).toBe(2);

			// Release the recovery: A fences/close, the pause release wakes the
			// pump, and B runs exactly once under B's own promptId.
			releaseRecovery();
			const outcomeA = await A;
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(3));
			const outcomeB = await harness.session.waitForPromptOutcome(ownerBId);
			expect(harness.faux.state.callCount).toBe(3);
			expect(outcomeA).toMatchObject({ promptId: ownerAId[0], status: "completed" });
			expect(outcomeA?.failure).toBeUndefined();
			expect(outcomeB).toMatchObject({ promptId: ownerBId, status: "completed" });
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.generationBumps).toEqual([]); // overflow never bumps generation
			observer.restore();
		});

		it("overflow recovery terminal error: A failed/run_error, queued B calls 0 before fence and exactly 1 after pause release", async () => {
			vi.useRealTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("overflow recovery summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			let releaseRecovery = () => {};
			const recoveryGate = new Promise<void>((resolve) => {
				releaseRecovery = resolve;
			});
			let recoveryStarted = false;
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
				async () => {
					recoveryStarted = true;
					await recoveryGate;
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "provider still exploded",
					});
				},
				fauxAssistantMessage("B completed"),
			]);
			const ownerAId: string[] = [];
			const A = harness.session.promptAndSettle("overflow A", {
				settlementAdmission: (info) => ownerAId.push(info.promptId!),
			});
			await vi.waitFor(() => expect(ownerAId).toHaveLength(1));
			void harness.session.followUp("queued B", undefined, { resumeIfIdle: true });
			await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["queued B"]));
			const ownerBId = turnActions(harness).find((action) => action.payload.text === "queued B")!.promptIds![0];

			await vi.waitFor(() => expect(recoveryStarted).toBe(true));
			expect(harness.faux.state.callCount).toBe(2);
			// No outcome until the recovery run terminates; B has not started.
			expect(harness.session.getPromptOutcome(ownerAId[0])).toBeUndefined();
			expect(harness.faux.state.callCount).toBe(2);

			releaseRecovery();
			const outcomeA = await A;
			expect(outcomeA).toMatchObject({
				promptId: ownerAId[0],
				status: "failed",
				failure: { reason: "run_error" },
			});
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(3));
			const outcomeB = await harness.session.waitForPromptOutcome(ownerBId);
			expect(outcomeB).toMatchObject({ promptId: ownerBId, status: "completed" });
			expect(harness.faux.state.callCount).toBe(3);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.generationBumps).toEqual([]); // overflow never bumps generation
			observer.restore();
		});

		it("[round-1 fix 4] tracked pump continuation success completes captured A exactly once", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "owner-pump-tracked";
			admitOwners(harness, ownerId);
			// A tracked continuation message admitted as a session-owned turn action
			// (the group-5 autonomous continuation shape): the pump owns it.
			const continuationMessage = {
				role: "user",
				content: [{ type: "text", text: "tracked continuation" }],
				timestamp: Date.now(),
			} as AgentMessage;
			internals._postCompactionContinuationMessages = [continuationMessage];
			expect(internals._scheduleContinuationForObligation([ownerId], [continuationMessage])).toBe(true);
			internals._schedulePostCompactionContinue();
			admitTrackedContinuationAction(harness, continuationMessage, true);
			harness.setResponses([fauxAssistantMessage("tracked done")]);

			// The timer fires; the pump owns the tracked action, so the direct
			// runner must NOT call agent.continue().
			const continueSpy = vi.spyOn(harness.session.agent, "continue");
			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(200);
			expect(continueSpy).not.toHaveBeenCalled();
			// The pump consumed the tracked action and terminal-fenced captured A.
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(internals._postCompactionContinuationMessages).toEqual([]);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({ status: "completed" });
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it.each([
			{
				label: "error",
				assistant: fauxAssistantMessage("", { stopReason: "error", errorMessage: "tracked continuation failed" }),
				expected: { status: "failed", failure: { reason: "run_error" } },
			},
			{
				label: "aborted",
				assistant: fauxAssistantMessage("", { stopReason: "aborted" }),
				expected: { status: "cancelled" },
			},
		])(
			"[round-1 fix 4] tracked pump continuation $label fences captured A before exact close",
			async ({ assistant, expected }) => {
				vi.useFakeTimers();
				const harness = await createHarness({ settings: { retry: { enabled: false } } });
				continuationHarnesses.push(harness);
				const observer = installContinuationObserver(harness);
				const internals = continuationInternals(harness);
				const ownerId = `tracked-terminal-${assistant.stopReason}`;
				admitOwners(harness, ownerId);
				const message = continuationMessage(`tracked ${assistant.stopReason}`);
				internals._postCompactionContinuationMessages = [message];
				expect(internals._scheduleContinuationForObligation([ownerId], [message])).toBe(true);
				admitTrackedContinuationAction(harness, message);
				internals._schedulePostCompactionContinue();
				harness.setResponses([assistant]);
				const continueSpy = vi.spyOn(harness.session.agent, "continue");

				await vi.advanceTimersByTimeAsync(300);

				expect(continueSpy).not.toHaveBeenCalled();
				expect(internals._continuationSettlementWindow).toBeUndefined();
				expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
				const outcome = harness.session.getPromptOutcome(ownerId);
				expect(outcome).toMatchObject(expected);
				if (expected.status === "cancelled") expect(outcome?.failure).toBeUndefined();
				expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
				continueSpy.mockRestore();
				observer.restore();
			},
		);

		it("[round-1 fix 4] mixed tracked/direct window fences tracked error but retains the direct remainder", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({ settings: { retry: { enabled: false } } });
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const [ownerA, ownerB] = ["mixed-direct-a", "mixed-tracked-b"];
			admitOwners(harness, ownerA, ownerB);
			const messageA = continuationMessage("mixed direct A");
			const messageB = continuationMessage("mixed tracked B");
			internals._postCompactionContinuationMessages = [messageA, messageB];
			expect(internals._scheduleContinuationForObligation([ownerA, ownerB], [messageA, messageB])).toBe(true);
			admitTrackedContinuationAction(harness, messageB);
			internals._schedulePostCompactionContinue();
			const window = internals._continuationSettlementWindow!;
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "mixed tracked run failed" }),
			]);

			await vi.advanceTimersByTimeAsync(100);
			expect(internals._continuationSettlementWindow).toBe(window);
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA, ownerB],
				obligationMessages: [messageA],
				state: "scheduled",
				pumpOwned: false,
			});
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([0, 0]);
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerB)).toBeUndefined();
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageA]);

			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases.map((lease) => lease.releaseCalls)).toEqual([1, 1]);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				status: "failed",
				failure: { reason: "run_error" },
			});
			observer.restore();
		});

		it("pump handoff: unrelated B keeps A's original window (rearm) and never merges B into it", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension()],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "owner-pump-unrelated-a";
			const ownerB = "owner-pump-unrelated-b";
			admitOwners(harness, ownerA, ownerB);
			// Start unrelated B first. This is the genuine already-running handoff
			// category; merely queued B is covered by the direct retry/throw proofs.
			const bAccepted = harness.session as unknown as {
				_createPreparedTurnAction(
					schedule: string,
					text: string,
					images: undefined,
					options: { resumeIfIdle: boolean },
				): unknown;
				_admitSessionInput(action: unknown, options: { wake: boolean }): { accepted: boolean };
			};
			bAccepted._admitSessionInput(
				bAccepted._createPreparedTurnAction("followUp", "unrelated B", undefined, {
					resumeIfIdle: true,
				}),
				{ wake: true },
			);
			// B receives its own fresh default identity (never ownerA's tuple).
			const bId = turnActions(harness).find((action) => action.payload.text === "unrelated B")!.promptIds![0];
			expect(bId).not.toBe(ownerA);
			// Gate B's provider call so B is still streaming when A's timer fires:
			// the pump handoff runs B (unrelated) and rearms A; B must NOT be
			// merged into A's captured window.
			let releaseB = () => {};
			const bGate = new Promise<void>((resolve) => {
				releaseB = resolve;
			});
			let bStarted = false;
			harness.setResponses([
				async () => {
					bStarted = true;
					await bGate;
					return fauxAssistantMessage("B ran");
				},
			]);
			await vi.waitFor(() => expect(bStarted).toBe(true));
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerA];
			internals._postCompactionContinuationMessages = [
				{ role: "user", content: [{ type: "text", text: "A obligation" }], timestamp: Date.now() } as AgentMessage,
			];
			await internals._runAutoCompaction("threshold", false);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);

			// A's scheduled continuation has its obligation message still owned
			// and its must-run timer is pending while B runs: the pump handoff path
			// sees B (unrelated, not the tracked action) and rearms A. B must NOT
			// be merged into A's captured window (the generic-wake invariant).
			const continueSpy = vi.spyOn(harness.session.agent, "continue");
			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(50);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			expect(observer.acquiresOfContinuation().map((entry) => entry.promptId)).toEqual([ownerA]);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			// B was never merged: still exactly one owner and one lease.
			expect(internals._continuationSettlementWindow?.leases).toHaveLength(1);
			expect(continueSpy).not.toHaveBeenCalled();
			// Stop the scheduler (window release-only) and let B finish; A's tuple
			// was never extended with B.
			internals._cancelPostCompactionContinue();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			releaseB();
			await vi.advanceTimersByTimeAsync(50);
			const bOutcome = harness.session.getPromptOutcome(bId);
			expect(bOutcome).toMatchObject({ promptId: bId, status: "completed" });
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] idle mixed A+B overflow recovery runs B once under B's owners and preserves A", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("mixed overflow summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			// A's already-scheduled threshold continuation owns a live window.
			const ownerA = "mixed-owner-a";
			admitOwners(harness, ownerA);
			const messageA = continuationMessage("mixed A obligation");
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();

			// Independent B runs first, sees a retryable error, then overflows.
			// Successful overflow compaction extends the SAME live window to
			// [A,B] and stamps B's exact overflow subset. Production overflow
			// introduces no obligation message of its own: B's recovery is the
			// same-run resume, so the shared obligation snapshot stays A's.
			const ownerB = "mixed-owner-b";
			admitOwners(harness, ownerB);
			internals._lastRunPromptIds = [ownerB];
			internals._postCompactionContinuationMessages = [messageA];
			await internals._runAutoCompaction("overflow", true);
			internals._schedulePostCompactionContinue();

			// The retry chain belongs to B only: the scheduler must NOT rearm
			// forever (a window-wide classification would never match [B]); it
			// must run the idle recovery under B's owners exactly once.
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});
			internals._retryWindow = { capturedPromptIds: [ownerB], leases: [] };
			internals._lastRunTerminalStopReason = undefined;
			// Queued independent C: admitted while A's scheduling pause holds, so
			// it must NOT start until A's obligation closes (then exactly once).
			const promptSpy = vi.spyOn(harness.session.agent, "prompt").mockImplementation(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});
			await harness.session.followUp("queued C after mixed recovery", undefined, { resumeIfIdle: true });
			const ownersAtContinue: string[][] = [];
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				// The recovery run ends with a successful stop: its agent_end
				// resolves the still-active retry chain (B's own).
				ownersAtContinue.push([...internals._lastRunPromptIds]);
				internals._lastRunTerminalStopReason = "stop";
				(internals as unknown as RetryInternals)._resolveRetry();
			});
			await vi.advanceTimersByTimeAsync(100);
			// Behavioral RED assertion (pre-fix: window-wide classification
			// [A,B] !== [B] rearms forever and never calls continue).
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(promptSpy).not.toHaveBeenCalled();
			// Recovery started exactly once under B's captured owners (the retry
			// window subset), never under the mixed [A,B] window.
			expect(ownersAtContinue).toEqual([[ownerB]]);
			// B's recovery settled exactly B completed; A is NOT terminal/fenced
			// by B and remains owned by its own obligation.
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "completed",
			});
			expect(harness.session.getPromptOutcome(ownerB)?.failure).toBeUndefined();
			// B's exact continuation lease released once; A's remains live in the
			// rearmed window with no scheduler/window residue.
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA],
				overflowRecoveryOwners: [],
			});
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._retryPromise).toBeUndefined();

			// A executes exactly once under A's own owners and settles normally.
			internals._lastRunTerminalStopReason = undefined;
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(ownersAtContinue).toEqual([[ownerB], [ownerA]]);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ promptId: ownerA, status: "completed" });
			expect(harness.session.getPromptOutcome(ownerA)?.failure).toBeUndefined();
			// Queued C stayed at zero agent runs through BOTH authoritative
			// boundaries (B recovery terminal, A obligation close) and woke
			// exactly once afterward.
			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(3);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			promptSpy.mockRestore();
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] mixed A+B overflow recovery terminal error fails only B and preserves A", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("mixed overflow terminal summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "mixed-terminal-a";
			const ownerB = "mixed-terminal-b";
			admitOwners(harness, ownerA, ownerB);
			const messageA = continuationMessage("mixed terminal A obligation");
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();
			// B's overflow extends the live window; B's recovery terminal errors.
			// No synthetic B obligation message: overflow recovery is a same-run
			// resume and owns no separate message.
			internals._lastRunPromptIds = [ownerB];
			internals._postCompactionContinuationMessages = [messageA];
			await internals._runAutoCompaction("overflow", true);
			internals._schedulePostCompactionContinue();
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});
			internals._retryWindow = { capturedPromptIds: [ownerB], leases: [] };
			internals._lastRunTerminalStopReason = undefined;
			let continueCalls = 0;
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				continueCalls += 1;
				internals._lastRunTerminalStopReason = continueCalls === 1 ? "error" : "stop";
				(internals as unknown as RetryInternals)._resolveRetry();
			});
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
			// Only B is fenced failed; A stays settling with its obligation live.
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([]);
			// A then executes and completes normally, not failed by B's terminal.
			internals._lastRunTerminalStopReason = undefined;
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ promptId: ownerA, status: "completed" });
			expect(harness.session.getPromptOutcome(ownerA)?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] public abortRetry in mixed A+B fails only B, preserves and rearms A", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			continuationHarnesses.push(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "mixed-abort-a";
			const ownerB = "mixed-abort-b";
			admitOwners(harness, ownerA, ownerB);
			const messageA = continuationMessage("mixed abort A obligation");
			// Production overflow owns no separate obligation message (same-run
			// resume); the shared window obligation snapshot is A's work only.
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA, ownerB], [messageA])).toBe(true);
			internals._continuationSettlementWindow!.overflowRecoveryOwners = [ownerB];
			internals._schedulePostCompactionContinue();
			internals._retryAttempt = 1;
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});
			internals._retryWindow = { capturedPromptIds: [ownerB], leases: [] };

			harness.session.abortRetry();
			// B failed/run_error, A untouched and still settling.
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(0);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([]);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			// A's continuation then executes/settles normally.
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});
			internals._lastRunTerminalStopReason = undefined;
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ promptId: ownerA, status: "completed" });
			expect(harness.session.getPromptOutcome(ownerA)?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] partial subset removal publishes coherent A rearm before B lease release; synchronous B outcome reentry cannot resurrect A", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("mixed reentry close summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "mixed-reentry-close-a";
			const ownerB = "mixed-reentry-close-b";
			admitOwners(harness, ownerA, ownerB);
			const messageA = continuationMessage("mixed reentry close A obligation");
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();
			const mixedWindow = internals._continuationSettlementWindow!;
			const aPause = internals._continuationSchedulingPause;
			const aLease = mixedWindow.leases[0]!;
			// B's overflow extends the SAME live window. Production overflow adds
			// no obligation message of its own: no synthetic B message is used.
			internals._lastRunPromptIds = [ownerB];
			await internals._runAutoCompaction("overflow", true);
			expect(internals._continuationSettlementWindow).toBe(mixedWindow);
			expect(mixedWindow.owners).toEqual([ownerA, ownerB]);
			expect(mixedWindow.overflowRecoveryOwners).toEqual([ownerB]);
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});
			internals._retryWindow = { capturedPromptIds: [ownerB], leases: [] };
			internals._lastRunTerminalStopReason = undefined;
			const continueCalls: string[][] = [];
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				continueCalls.push([...internals._lastRunPromptIds]);
				internals._lastRunTerminalStopReason = "stop";
				(internals as unknown as RetryInternals)._resolveRetry();
			});
			const reentryFacts = {
				seen: false,
				sameWindow: false,
				owners: [] as string[],
				leases: [] as unknown[],
				messages: [] as AgentMessage[],
				revision: -1,
				state: "" as string,
				pumpOwned: false,
				overflowOwners: [] as string[],
				scheduled: false,
				timerDefined: false,
				snapshot: [] as AgentMessage[],
				pauseSame: false,
				closeReturned: false,
			};
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "prompt_outcome" || event.outcome.promptId !== ownerB) return;
				// The remaining A tuple MUST already be coherent at this synchronous
				// reentry point: B's continuation lease release is the first side
				// effect that can reenter session APIs, and it must observe A fully
				// detached from B and rearmed at the newer revision. Facts are
				// recorded here (assertions inside a session listener would be
				// swallowed by `_emit` observer isolation).
				const window = internals._continuationSettlementWindow;
				reentryFacts.seen = true;
				reentryFacts.sameWindow = window === mixedWindow;
				reentryFacts.owners = window?.owners ? [...window.owners] : [];
				reentryFacts.leases = window?.leases ? [...window.leases] : [];
				reentryFacts.messages = window?.obligationMessages ? [...window.obligationMessages] : [];
				reentryFacts.revision = window?.revision ?? -1;
				reentryFacts.state = window?.state ?? "";
				reentryFacts.pumpOwned = window?.pumpOwned ?? false;
				reentryFacts.overflowOwners = window?.overflowRecoveryOwners ? [...window.overflowRecoveryOwners] : [];
				reentryFacts.scheduled = internals._postCompactionContinuationScheduled;
				reentryFacts.timerDefined = internals._postCompactionContinuationTimer !== undefined;
				reentryFacts.snapshot = [...internals._scheduledPostCompactionContinuationMessages];
				reentryFacts.pauseSame = internals._continuationSchedulingPause === aPause;
				// The listener closes/cancels the remaining A tuple exactly once.
				reentryFacts.closeReturned = internals._cancelPostCompactionContinue({ owners: "cancel" });
			});

			await vi.advanceTimersByTimeAsync(100);
			// B recovered exactly once under B and got exactly B's recovery status.
			expect(reentryFacts.seen).toBe(true);
			expect(reentryFacts.sameWindow).toBe(true);
			expect(reentryFacts.owners).toEqual([ownerA]);
			expect(reentryFacts.leases).toEqual([aLease]);
			expect(reentryFacts.messages).toEqual([messageA]);
			expect(reentryFacts.revision).toBe(3);
			expect(reentryFacts.state).toBe("scheduled");
			expect(reentryFacts.pumpOwned).toBe(false);
			expect(reentryFacts.overflowOwners).toEqual([]);
			expect(reentryFacts.scheduled).toBe(true);
			expect(reentryFacts.timerDefined).toBe(true);
			expect(reentryFacts.snapshot).toEqual([messageA]);
			expect(reentryFacts.pauseSame).toBe(true);
			expect(reentryFacts.closeReturned).toBe(true);
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "completed",
			});

			await vi.advanceTimersByTimeAsync(100);
			// B recovered exactly once under B and got exactly B's recovery status.
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "completed",
			});
			expect(harness.session.getPromptOutcome(ownerB)?.failure).toBeUndefined();
			// The reentrant close released A exactly once with the cancel classification.
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({
				promptId: ownerA,
				status: "cancelled",
			});
			expect(harness.session.getPromptOutcome(ownerA)?.failure).toBeUndefined();
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(continueCalls).toEqual([[ownerB]]);
			// After the callback returns, no stale/ownerless scheduler or timer is
			// resurrected and no late continue() occurs.
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([]);
			expect(internals._continuationSchedulingPause).toBeUndefined();
			await vi.advanceTimersByTimeAsync(200);
			expect(continueCalls).toEqual([[ownerB]]);
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
			unsubscribe();
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] partial subset removal leaves a listener-created replacement window/timer/snapshot untouched after B release", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("mixed reentry replacement summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "mixed-reentry-replacement-a";
			const ownerB = "mixed-reentry-replacement-b";
			const replacementOwner = "mixed-reentry-replacement-new";
			admitOwners(harness, ownerA, ownerB, replacementOwner);
			const messageA = continuationMessage("mixed reentry replacement A obligation");
			const replacementMessage = continuationMessage("mixed reentry replacement obligation");
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			internals._schedulePostCompactionContinue();
			const mixedWindow = internals._continuationSettlementWindow!;
			internals._lastRunPromptIds = [ownerB];
			await internals._runAutoCompaction("overflow", true);
			internals._retryPromise = new Promise<void>((resolve) => {
				internals._retryResolve = resolve;
			});
			internals._retryWindow = { capturedPromptIds: [ownerB], leases: [] };
			internals._lastRunTerminalStopReason = undefined;
			const continueCalls: string[][] = [];
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				continueCalls.push([...internals._lastRunPromptIds]);
				internals._lastRunTerminalStopReason = "stop";
				(internals as unknown as RetryInternals)._resolveRetry();
			});
			const replacementFacts = {
				seenCallbackEntry: false,
				sameWindow: false,
				owners: [] as string[],
				revision: -1,
				state: "" as string,
				overflowOwners: [] as string[],
				scheduled: false,
				timerDefined: false,
				snapshot: [] as AgentMessage[],
				closeReturned: false,
				replacementCreated: false,
			};
			let replacementWindow: ContinuationInternals["_continuationSettlementWindow"] | undefined;
			let replacementTimer: unknown;
			let replacementSnapshot: AgentMessage[] | undefined;
			let replacementPause: unknown | undefined;
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "prompt_outcome" || event.outcome.promptId !== ownerB) return;
				// Record the coherent A tuple at callback entry, then close A and
				// publish a replacement sibling from inside the listener. Facts are
				// recorded here because a throwing assertion inside a session
				// listener is isolated by `_emit`.
				const window = internals._continuationSettlementWindow;
				replacementFacts.seenCallbackEntry = true;
				replacementFacts.sameWindow = window === mixedWindow;
				replacementFacts.owners = window?.owners ? [...window.owners] : [];
				replacementFacts.revision = window?.revision ?? -1;
				replacementFacts.state = window?.state ?? "";
				replacementFacts.overflowOwners = window?.overflowRecoveryOwners ? [...window.overflowRecoveryOwners] : [];
				replacementFacts.scheduled = internals._postCompactionContinuationScheduled;
				replacementFacts.timerDefined = internals._postCompactionContinuationTimer !== undefined;
				replacementFacts.snapshot = [...internals._scheduledPostCompactionContinuationMessages];
				replacementFacts.closeReturned = internals._cancelPostCompactionContinue({ owners: "cancel" });
				internals._postCompactionContinuationMessages = [replacementMessage];
				internals._scheduleContinuationForObligation([replacementOwner], [replacementMessage]);
				internals._schedulePostCompactionContinue();
				replacementFacts.replacementCreated =
					internals._continuationSettlementWindow !== undefined &&
					internals._postCompactionContinuationTimer !== undefined;
				replacementWindow = internals._continuationSettlementWindow;
				replacementTimer = internals._postCompactionContinuationTimer;
				replacementSnapshot = internals._scheduledPostCompactionContinuationMessages;
				replacementPause = internals._continuationSchedulingPause;
			});

			await vi.advanceTimersByTimeAsync(100);
			expect(replacementFacts.seenCallbackEntry).toBe(true);
			expect(replacementFacts.sameWindow).toBe(true);
			expect(replacementFacts.owners).toEqual([ownerA]);
			expect(replacementFacts.revision).toBe(3);
			expect(replacementFacts.state).toBe("scheduled");
			expect(replacementFacts.overflowOwners).toEqual([]);
			expect(replacementFacts.scheduled).toBe(true);
			expect(replacementFacts.timerDefined).toBe(true);
			expect(replacementFacts.snapshot).toEqual([messageA]);
			expect(replacementFacts.closeReturned).toBe(true);
			expect(replacementFacts.replacementCreated).toBe(true);
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "completed",
			});
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({
				promptId: ownerA,
				status: "cancelled",
			});
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			// The partial helper must leave the exact replacement object/timer/
			// snapshot/pause untouched after it released B.
			expect(replacementWindow).toBeDefined();
			expect(internals._continuationSettlementWindow).toBe(replacementWindow);
			expect(internals._postCompactionContinuationTimer).toBe(replacementTimer);
			expect(internals._scheduledPostCompactionContinuationMessages).toBe(replacementSnapshot);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._continuationSchedulingPause).toBe(replacementPause);
			// The replacement's lease is untouched by the partial helper.
			expect(observer.continuationLeases[2]!.releaseCalls).toBe(0);
			// The replacement then runs exactly once under its own owner and settles.
			internals._lastRunTerminalStopReason = undefined;
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(continueCalls).toEqual([[ownerB], [replacementOwner]]);
			expect(observer.continuationLeases[2]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(replacementOwner)).toMatchObject({
				promptId: replacementOwner,
				status: "completed",
			});
			expect(harness.session.getPromptOutcome(replacementOwner)?.failure).toBeUndefined();
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(3);
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._continuationSchedulingPause).toBeUndefined();
			unsubscribe();
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] production: B retry->overflow->recovery runs once under B inside A's live mixed window; A then C settle once with no B message residue", async () => {
			vi.useRealTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("mixed production summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "mixed-prod-a";
			admitOwners(harness, ownerA);
			const messageA = continuationMessage("mixed production A obligation");
			const callLog: string[] = [];
			let releaseBFirst = () => {};
			const bFirstGate = new Promise<void>((resolve) => {
				releaseBFirst = resolve;
			});
			let bFirstStarted = false;
			let releaseRecovery = () => {};
			const recoveryGate = new Promise<void>((resolve) => {
				releaseRecovery = resolve;
			});
			let recoveryStarted = false;
			let aStarted = false;
			let cStarted = false;
			let aBoundaryFacts:
				| {
						owners: string[];
						overflowOwners: string[];
						windowMessages: AgentMessage[];
						globalMessages: AgentMessage[];
						scheduledMessages: AgentMessage[];
						actionTexts: string[];
				  }
				| undefined;
			harness.setResponses([
				async () => {
					callLog.push("B-first-run");
					bFirstStarted = true;
					await bFirstGate;
					return retryableError();
				},
				() => {
					callLog.push("B-overflow-error");
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
				},
				async () => {
					callLog.push("B-recovery");
					recoveryStarted = true;
					await recoveryGate;
					return fauxAssistantMessage("B recovered after overflow");
				},
				async () => {
					callLog.push("A-continuation");
					aStarted = true;
					// At the instant A's continuation starts, B's subset removal is
					// complete: the window/global/scheduled obligation sets and the
					// action store must contain only A's surviving work (plus queued
					// C), never a completed/failed B obligation message or action.
					aBoundaryFacts = {
						owners: [...(internals._continuationSettlementWindow?.owners ?? [])],
						overflowOwners: [...(internals._continuationSettlementWindow?.overflowRecoveryOwners ?? [])],
						windowMessages: [...(internals._continuationSettlementWindow?.obligationMessages ?? [])],
						globalMessages: [...internals._postCompactionContinuationMessages],
						scheduledMessages: [...internals._scheduledPostCompactionContinuationMessages],
						actionTexts: turnActions(harness).map((action) => action.payload.text),
					};
					return fauxAssistantMessage("A continuation done");
				},
				async () => {
					callLog.push("C-run");
					cStarted = true;
					return fauxAssistantMessage("C done");
				},
			]);
			// B is admitted and dispatched FIRST (gated on its first provider call)
			// so the production pump selects it ahead of A's tracked continuation
			// action; B's whole retry->overflow->recovery chain stays inside B's
			// single dispatch (completionIncludesRetryChain), so no queued work can
			// start until that dispatch returns.
			const bOwnerIds: string[] = [];
			let resolveBAdmitted = () => {};
			const bAdmitted = new Promise<void>((resolve) => {
				resolveBAdmitted = resolve;
			});
			const bOutcomeP = harness.session.promptAndSettle("mixed production B", {
				settlementAdmission: (info) => {
					bOwnerIds.push(info.promptId!);
					resolveBAdmitted();
				},
			});
			await bAdmitted;
			await vi.waitFor(() => expect(bFirstStarted).toBe(true));
			// Narrow seam: establish A's pre-existing continuation window (owner,
			// lease, obligation message, tracked pump action, armed scheduler)
			// while B is already streaming. Production threshold staging would
			// require A to have run first, which reorders the sequence this test
			// needs; everything after this seam (B retry, overflow compaction,
			// recovery, A/C runs) is real.
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			admitTrackedContinuationAction(harness, messageA);
			internals._schedulePostCompactionContinue();
			expect(internals._continuationSettlementWindow).toMatchObject({ owners: [ownerA] });
			const aLease = internals._continuationSettlementWindow!.leases[0]!;
			const aLeaseRecord = observer.continuationLeases[0]!;
			await harness.session.followUp("queued C after mixed production recovery", undefined, { resumeIfIdle: true });
			const ownerC = actionByText(harness, "queued C after mixed production recovery").promptIds![0]!;

			const agent = harness.session.agent;
			const realContinue = agent.continue.bind(agent);
			const ownersAtContinue: string[][] = [];
			const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async () => {
				ownersAtContinue.push([...internals._lastRunPromptIds]);
				await realContinue();
			});

			releaseBFirst();
			await vi.waitFor(() => expect(recoveryStarted).toBe(true));
			// Exactly two production continues, both under B: the retry continue
			// (after the retryable error) and the overflow recovery continue. The
			// recovery is the one following the overflow compaction inside the
			// shared [A,B] window; A has not falsely started or terminated.
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(ownersAtContinue).toEqual([[bOwnerIds[0]], [bOwnerIds[0]]]);
			expect(callLog).toEqual(["B-first-run", "B-overflow-error", "B-recovery"]);
			expect(harness.faux.state.callCount).toBe(3);
			// B's recovery runs exactly once under B while B is still inside the
			// SHARED [A,B] window; A is not falsely terminal; A/C have not started.
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA, ...bOwnerIds]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual(bOwnerIds);
			expect((internals._continuationSettlementWindow?.leases ?? [])[0]).toBe(aLease);
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(bOwnerIds[0]!)).toBeUndefined();
			expect(aStarted).toBe(false);
			expect(cStarted).toBe(false);
			expect(observer.retryLeases).toHaveLength(1);
			expect(observer.continuationLeases).toHaveLength(2);
			expect(observer.retryLeases[0]!.promptId).toBe(bOwnerIds[0]);
			expect(observer.continuationLeases[1]!.promptId).toBe(bOwnerIds[0]);

			releaseRecovery();
			const outcomeB = await bOutcomeP;
			await vi.waitFor(() => expect(aStarted).toBe(true));
			// Boundary proof: after B's subset removal, no completed/failed B
			// obligation/message/action remains under A — only A's work and the
			// genuinely unrelated queued C.
			expect(aBoundaryFacts).toMatchObject({
				owners: [ownerA],
				overflowOwners: [],
				windowMessages: [messageA],
				globalMessages: [messageA],
				scheduledMessages: [messageA],
			});
			expect(aBoundaryFacts?.actionTexts).toEqual([
				"mixed production A obligation",
				"queued C after mixed production recovery",
			]);
			expect(aBoundaryFacts?.actionTexts).not.toContain("mixed production B");
			const outcomeA = await harness.session.waitForPromptOutcome(ownerA);
			await vi.waitFor(() => expect(cStarted).toBe(true));
			const outcomeC = await harness.session.waitForPromptOutcome(ownerC);
			expect(callLog).toEqual(["B-first-run", "B-overflow-error", "B-recovery", "A-continuation", "C-run"]);
			expect(harness.faux.state.callCount).toBe(5);
			expect(outcomeB).toMatchObject({ promptId: bOwnerIds[0], status: "completed" });
			expect(outcomeB?.failure).toBeUndefined();
			expect(outcomeA).toMatchObject({ promptId: ownerA, status: "completed" });
			expect(outcomeA?.failure).toBeUndefined();
			expect(outcomeC).toMatchObject({ promptId: ownerC, status: "completed" });
			// Exactly two production continues, both under B (retry chain +
			// overflow recovery); A's continuation and C run through the session
			// pump `agent.prompt`, never a B-contaminated continue. The retry
			// window and both continuation leases cleared exactly once.
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(ownersAtContinue).toEqual([[bOwnerIds[0]], [bOwnerIds[0]]]);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryWindow).toBeUndefined();
			expect(internals._retryResolve).toBeUndefined();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._postCompactionContinuationMessages).toEqual([]);
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([]);
			expect(observer.retryLeases[0]!.releaseCalls).toBe(1);
			expect(aLeaseRecord.releaseCalls).toBe(1);
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerA),
			).toHaveLength(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === bOwnerIds[0]),
			).toHaveLength(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerC),
			).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[mixed-owner fix] requested compaction failure resumes the same run with ownership acquired before old ownership releases", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				withConfiguredAuth: false,
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("requested resume summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerId = "requested-failure-resume";
			admitOwners(harness, ownerId);
			const runLease = internals._promptSettlementTracker.acquire(ownerId, "run");
			const message = continuationMessage("requested failure resume work");
			internals._postCompactionContinuationMessages = [message];
			internals._continueAfterThresholdCompaction = true;
			internals._lastRunPromptIds = [ownerId];

			// First requested compaction fails (auth missing): the same run must
			// resume, the continuation ownership is acquired before the old run
			// lease is released, and NO generation is bumped.
			await internals._runAutoCompaction("requested", false);
			expect(observer.generationBumps).toEqual([]);
			const window = internals._continuationSettlementWindow!;
			expect(window).toMatchObject({
				owners: [ownerId],
				obligationMessages: [message],
				revision: 1,
				state: "scheduled",
			});
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerId, kind: "compaction_continuation" }]);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			// The acquire happened while the owner was still settling (no outcome yet).
			expect(observer.acquireContexts[0]).toMatchObject({
				promptId: ownerId,
				outcomeAtAcquire: undefined,
			});
			// Old run lease release: owner STILL settling (the continuation lease
			// was acquired before the old ownership released — no 0-lease gap and
			// no premature completed outcome).
			runLease.release();
			expect(harness.session.getPromptOutcome(ownerId)).toBeUndefined();
			// The continuation runs once and settles the resumed run completed.
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});
			internals._lastRunTerminalStopReason = undefined;
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerId)).toMatchObject({
				promptId: ownerId,
				status: "completed",
				traceGeneration: 0,
			});
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(1);
			continueSpy.mockRestore();
			observer.restore();
		});

		// ===========================================================================
		// [partition-model fix] Round 2 depth closure: first-error overflow subset
		// is authoritative for scheduler priority/abortRetry; pump complement A is
		// consumed at A's own terminal while B's overflow recovery remains pending.
		// ===========================================================================

		it("[partition-production fix] production: during A's streaming run, B admitted after A queued first-error overflow + C; B recovery runs once under B before A/C", async () => {
			// Fake timers are incompatible with this fully production path: gated
			// `agent.prompt`/tool execution plus `advanceTimersByTimeAsync(0)`
			// timer-storms, and `vi.waitFor` auto-advances 50ms into the 100ms
			// recovery timer. Real timers + an observational overflow-stamp
			// deferred are the deterministic subset-stamp signal. A 0ms
			// A-before-B discriminator could not be constructed without
			// manufacturing timing; see the follow-up report.
			vi.useRealTimers();
			const largeContextTool = largeContextThresholdTool();
			const harness = await createHarness({
				tools: [largeContextTool],
				autonomous: {
					enabled: true,
					maxContinuations: 1,
					maxTurns: 100,
					gates: { commands: [], maxRetries: 1 },
				},
				settings: {
					retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
					compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200_001 },
				},
				models: [{ id: "faux-1", contextWindow: 200_000 }],
				extensionFactories: [compactSummaryExtension("partition production threshold summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const callLog: string[] = [];
			const aFirstGate = createDeferred();
			let aFirstStarted = false;
			const bFirstGate = createDeferred();
			let bFirstStarted = false;
			const recoveryGate = createDeferred();
			let recoveryStarted = false;
			const aContinuationGate = createDeferred();
			let aContinuationStarted = false;
			const cGate = createDeferred();
			let cStarted = false;
			const overflowStamp = createDeferred();
			const stampFacts = {
				recoveryStarted: false,
				aContinuationStarted: false,
				cStarted: false,
				continueCalls: 0,
				callLog: [] as string[],
			};
			let aBoundaryFacts:
				| {
						owners: string[];
						overflowOwners: string[];
						windowMessages: string[];
						actionTexts: string[];
				  }
				| undefined;
			harness.setResponses([
				async () => {
					callLog.push("A-initial-tool");
					aFirstStarted = true;
					await aFirstGate.promise;
					return fauxAssistantMessage(fauxToolCall("large-context", {}), { stopReason: "toolUse" });
				},
				async () => {
					callLog.push("B-first-error");
					bFirstStarted = true;
					await bFirstGate.promise;
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "prompt is too long",
					});
				},
				async () => {
					callLog.push("B-recovery");
					recoveryStarted = true;
					await recoveryGate.promise;
					return fauxAssistantMessage("B recovered after first-error overflow");
				},
				async () => {
					callLog.push("A-continuation");
					aContinuationStarted = true;
					aBoundaryFacts = {
						owners: [...(internals._continuationSettlementWindow?.owners ?? [])],
						overflowOwners: [...(internals._continuationSettlementWindow?.overflowRecoveryOwners ?? [])],
						windowMessages: (internals._continuationSettlementWindow?.obligationMessages ?? []).map((message) =>
							getMessageText(message),
						),
						actionTexts: turnActions(harness).map((action) => action.payload.text),
					};
					await aContinuationGate.promise;
					return fauxAssistantMessage("A continuation done");
				},
				async () => {
					callLog.push("C-run");
					cStarted = true;
					await cGate.promise;
					return fauxAssistantMessage("C done");
				},
			]);

			const aOwnerIds: string[] = [];
			const aSettledP = harness.session.promptAndSettle("partition production A", {
				settlementAdmission: (info) => aOwnerIds.push(info.promptId!),
			});
			await vi.waitFor(() => {
				expect(aFirstStarted).toBe(true);
				expect(harness.session.isStreaming).toBe(true);
			});
			expect(aOwnerIds).toHaveLength(1);
			const ownerA = aOwnerIds[0]!;

			// Public independent B: promptAndSettle while A streams throws without
			// streamingBehavior (documented `_prompt` contract). followUp-mode
			// queues B into the FIFO `when_run_idle` lane with its own admitted
			// prompt identity and run lease, before A's later threshold continuation.
			const bOwnerIds: string[] = [];
			const bSettledP = harness.session.promptAndSettle("partition production B", {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
				settlementAdmission: (info) => bOwnerIds.push(info.promptId!),
			});
			await vi.waitFor(() => expect(bOwnerIds).toHaveLength(1));
			expect(harness.session.getFollowUpMessages()).toEqual(["partition production B"]);
			expect(actionByText(harness, "partition production B").runLeases).toHaveLength(1);
			const ownerB = bOwnerIds[0]!;

			const agent = harness.session.agent;
			const realContinue = agent.continue.bind(agent);
			const ownersAtContinue: string[][] = [];
			const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async () => {
				ownersAtContinue.push([...internals._lastRunPromptIds]);
				await realContinue();
			});
			const promptSpy = vi.spyOn(agent, "prompt");
			const realRunAutoCompaction = internals._runAutoCompaction.bind(internals);
			const compactionSpy = vi
				.spyOn(internals, "_runAutoCompaction")
				.mockImplementation(async (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => {
					const result = await realRunAutoCompaction(reason, willRetry);
					if (reason === "overflow") {
						stampFacts.recoveryStarted = recoveryStarted;
						stampFacts.aContinuationStarted = aContinuationStarted;
						stampFacts.cStarted = cStarted;
						stampFacts.continueCalls = continueSpy.mock.calls.length;
						stampFacts.callLog = [...callLog];
						overflowStamp.resolve();
					}
					return result;
				});

			aFirstGate.resolve();
			await vi.waitFor(() => {
				expect(harness.eventsOfType("compaction_end").some((event) => event.reason === "threshold")).toBe(true);
				expect(observer.generationBumps).toEqual([ownerA]);
				expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			});
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				reason: "threshold",
				aborted: false,
				result: expect.objectContaining({ summary: "partition production threshold summary" }),
			});
			expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
			expect(observer.acquiresOfContinuation()).toEqual([{ promptId: ownerA, kind: "compaction_continuation" }]);
			const aLeaseRecord = observer.continuationLeases[0]!;
			expect(aLeaseRecord.releaseCalls).toBe(0);

			await harness.session.followUp("queued C after partition recovery", undefined, { resumeIfIdle: true });
			const ownerC = actionByText(harness, "queued C after partition recovery").promptIds![0]!;

			await vi.waitFor(() => expect(bFirstStarted).toBe(true));
			expect(aContinuationStarted).toBe(false);
			expect(cStarted).toBe(false);
			expect(callLog).toEqual(["A-initial-tool", "B-first-error"]);

			bFirstGate.resolve();
			await overflowStamp.promise;
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([ownerB]);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA, ownerB]);
			expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["threshold", "overflow"]);
			expect(observer.continuationLeases[1]!.promptId).toBe(ownerB);
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(0);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryWindow).toBeUndefined();
			expect(internals._retryAttempt).toBe(0);
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerB)).toBeUndefined();
			// Stamp-boundary snapshot: captured synchronously when production
			// overflow compaction returns, before the 100ms timer is relevant.
			expect(stampFacts.aContinuationStarted).toBe(false);
			expect(stampFacts.recoveryStarted).toBe(false);
			expect(stampFacts.cStarted).toBe(false);
			expect(stampFacts.continueCalls).toBe(0);
			expect(stampFacts.callLog).toEqual(["A-initial-tool", "B-first-error"]);
			expect(aContinuationStarted).toBe(false);
			expect(cStarted).toBe(false);

			await vi.waitFor(() => expect(recoveryStarted || aContinuationStarted).toBe(true));
			expect(aContinuationStarted).toBe(false);
			expect(recoveryStarted).toBe(true);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(ownersAtContinue).toEqual([[ownerB]]);
			expect(cStarted).toBe(false);
			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(callLog).toEqual(["A-initial-tool", "B-first-error", "B-recovery"]);
			recoveryGate.resolve();
			const outcomeB = await bSettledP;
			expect(outcomeB).toMatchObject({ promptId: ownerB, status: "completed" });
			expect(outcomeB?.failure).toBeUndefined();
			await vi.waitFor(() => expect(aContinuationStarted).toBe(true));
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([]);
			expect(aBoundaryFacts?.owners).toEqual([ownerA]);
			expect(aBoundaryFacts?.overflowOwners).toEqual([]);
			expect(aBoundaryFacts?.windowMessages.join("\n")).not.toMatch(/partition production B/i);
			expect(aBoundaryFacts?.actionTexts).not.toContain("partition production B");
			aContinuationGate.resolve();
			const outcomeA = await aSettledP;
			await vi.waitFor(() => expect(cStarted).toBe(true));
			cGate.resolve();
			const outcomeC = await harness.session.waitForPromptOutcome(ownerC);
			expect(callLog).toEqual(["A-initial-tool", "B-first-error", "B-recovery", "A-continuation", "C-run"]);
			expect(outcomeA).toMatchObject({ promptId: ownerA, status: "completed", traceGeneration: 1 });
			expect(outcomeA?.failure).toBeUndefined();
			expect(outcomeC).toMatchObject({ promptId: ownerC, status: "completed" });
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(ownersAtContinue).toEqual([[ownerB]]);
			expect(promptSpy).toHaveBeenCalledTimes(3);
			expect(aLeaseRecord.releaseCalls).toBe(1);
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryWindow).toBeUndefined();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._continuationSchedulingPause).toBeUndefined();
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerA),
			).toHaveLength(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerB),
			).toHaveLength(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerC),
			).toHaveLength(1);
			compactionSpy.mockRestore();
			continueSpy.mockRestore();
			promptSpy.mockRestore();
			observer.restore();
		}, 30_000);

		it("[partition-production fix] abortRetry on production first-error overflow subset fails exactly B without retry tuple; A then C still settle once", async () => {
			vi.useRealTimers();
			const largeContextTool = largeContextThresholdTool();
			const harness = await createHarness({
				tools: [largeContextTool],
				autonomous: {
					enabled: true,
					maxContinuations: 1,
					maxTurns: 100,
					gates: { commands: [], maxRetries: 1 },
				},
				settings: {
					retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
					compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200_001 },
				},
				models: [{ id: "faux-1", contextWindow: 200_000 }],
				extensionFactories: [compactSummaryExtension("partition abort threshold summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const callLog: string[] = [];
			const aFirstGate = createDeferred();
			let aFirstStarted = false;
			const bFirstGate = createDeferred();
			let bFirstStarted = false;
			const aContinuationGate = createDeferred();
			let aContinuationStarted = false;
			const cGate = createDeferred();
			let cStarted = false;
			harness.setResponses([
				async () => {
					callLog.push("A-initial-tool");
					aFirstStarted = true;
					await aFirstGate.promise;
					return fauxAssistantMessage(fauxToolCall("large-context", {}), { stopReason: "toolUse" });
				},
				async () => {
					callLog.push("B-first-error");
					bFirstStarted = true;
					await bFirstGate.promise;
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "prompt is too long",
					});
				},
				async () => {
					callLog.push("A-continuation");
					aContinuationStarted = true;
					await aContinuationGate.promise;
					return fauxAssistantMessage("A continuation done after abort");
				},
				async () => {
					callLog.push("C-run");
					cStarted = true;
					await cGate.promise;
					return fauxAssistantMessage("C done after abort");
				},
			]);

			const aOwnerIds: string[] = [];
			const aSettledP = harness.session.promptAndSettle("partition abort A", {
				settlementAdmission: (info) => aOwnerIds.push(info.promptId!),
			});
			await vi.waitFor(() => {
				expect(aFirstStarted).toBe(true);
				expect(harness.session.isStreaming).toBe(true);
			});
			const ownerA = aOwnerIds[0]!;
			const bOwnerIds: string[] = [];
			const bSettledP = harness.session.promptAndSettle("partition abort B", {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				resumeIfIdle: true,
				settlementAdmission: (info) => bOwnerIds.push(info.promptId!),
			});
			await vi.waitFor(() => expect(bOwnerIds).toHaveLength(1));
			const ownerB = bOwnerIds[0]!;

			const agent = harness.session.agent;
			const realContinue = agent.continue.bind(agent);
			const ownersAtContinue: string[][] = [];
			const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async () => {
				ownersAtContinue.push([...internals._lastRunPromptIds]);
				await realContinue();
			});

			aFirstGate.resolve();
			await vi.waitFor(() => {
				expect(harness.eventsOfType("compaction_end").some((event) => event.reason === "threshold")).toBe(true);
				expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			});
			expect(observer.generationBumps).toEqual([ownerA]);
			const aLeaseRecord = observer.continuationLeases[0]!;
			await harness.session.followUp("queued C after partition abort", undefined, { resumeIfIdle: true });
			const ownerC = actionByText(harness, "queued C after partition abort").promptIds![0]!;
			await vi.waitFor(() => expect(bFirstStarted).toBe(true));
			const realRunAutoCompaction = internals._runAutoCompaction.bind(internals);
			const abortFacts = {
				aborted: false,
				retryPromiseDefined: false,
				retryAttempt: -1,
				aContinuationStarted: false,
				recoveryStarted: false,
				callLog: [] as string[],
			};
			const compactionSpy = vi
				.spyOn(internals, "_runAutoCompaction")
				.mockImplementation(async (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => {
					const result = await realRunAutoCompaction(reason, willRetry);
					if (reason === "overflow" && !abortFacts.aborted) {
						// Production overflow just stamped the subset and armed recovery;
						// this is still the agent_end continuation, before the 100ms
						// timer and before the finally-queued pump can start A.
						abortFacts.retryPromiseDefined = internals._retryPromise !== undefined;
						abortFacts.retryAttempt = internals._retryAttempt;
						abortFacts.aContinuationStarted = aContinuationStarted;
						abortFacts.recoveryStarted = callLog.includes("B-recovery");
						abortFacts.callLog = [...callLog];
						harness.session.abortRetry();
						abortFacts.aborted = true;
					}
					return result;
				});
			bFirstGate.resolve();
			await vi.waitFor(() => expect(abortFacts.aborted).toBe(true));
			expect(abortFacts.retryPromiseDefined).toBe(false);
			expect(abortFacts.retryAttempt).toBe(0);
			expect(abortFacts.aContinuationStarted).toBe(false);
			expect(abortFacts.recoveryStarted).toBe(false);
			expect(abortFacts.callLog).toEqual(["A-initial-tool", "B-first-error"]);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryWindow).toBeUndefined();
			expect(internals._retryAttempt).toBe(0);
			await vi.waitFor(() => expect(harness.session.getPromptOutcome(ownerB)).toBeDefined());
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(observer.continuationLeases[1]!.promptId).toBe(ownerB);
			expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
			expect(aLeaseRecord.releaseCalls).toBe(0);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([]);
			const outcomeB = await bSettledP;
			expect(outcomeB).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(callLog).not.toContain("B-recovery");
			expect(continueSpy).toHaveBeenCalledTimes(0);

			await vi.waitFor(() => expect(aContinuationStarted).toBe(true));
			aContinuationGate.resolve();
			const outcomeA = await aSettledP;
			await vi.waitFor(() => expect(cStarted).toBe(true));
			cGate.resolve();
			const outcomeC = await harness.session.waitForPromptOutcome(ownerC);
			expect(callLog).toEqual(["A-initial-tool", "B-first-error", "A-continuation", "C-run"]);
			expect(outcomeA).toMatchObject({ promptId: ownerA, status: "completed", traceGeneration: 1 });
			expect(outcomeA?.failure).toBeUndefined();
			expect(outcomeC).toMatchObject({ promptId: ownerC, status: "completed" });
			expect(continueSpy).toHaveBeenCalledTimes(0);
			expect(aLeaseRecord.releaseCalls).toBe(1);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._continuationSettlementWindow).toBeUndefined();
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._continuationSchedulingPause).toBeUndefined();
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerA),
			).toHaveLength(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerB),
			).toHaveLength(1);
			expect(
				harness.eventsOfType("prompt_outcome").filter((event) => event.outcome.promptId === ownerC),
			).toHaveLength(1);
			compactionSpy.mockRestore();
			continueSpy.mockRestore();
			observer.restore();
		}, 30_000);

		/**
		 * Deterministic complement construction helper: mixed `[A,B]` window where
		 * A is the tracked pump complement and B is the first-error overflow
		 * subset pending with NO retry tuple. A's tracked action is admitted and
		 * the scheduler armed (pump-owned); the REAL scheduler handoff dispatches
		 * A's tracked action FIRST (gated on its provider response); B's subset
		 * is stamped mid-flight (no revision bump, no retry resources); then A's
		 * real terminal drives the REAL pump complement consumption. Everything
		 * after the stamp is production scheduling/consumption code.
		 */
		async function stageTrackedComplementWindow(
			harness: Harness,
			internals: ContinuationInternals,
			ownerA: string,
			ownerB: string,
			messageA: AgentMessage,
			releaseA: () => void,
			aStarted: () => boolean,
		): Promise<{ scheduledRun: Promise<void> }> {
			admitOwners(harness, ownerA, ownerB);
			internals._postCompactionContinuationMessages = [messageA];
			expect(internals._scheduleContinuationForObligation([ownerA], [messageA])).toBe(true);
			admitTrackedContinuationAction(harness, messageA);
			internals._schedulePostCompactionContinue();
			const scheduledRun = internals._runScheduledPostCompactionContinue();
			await vi.waitFor(() => expect(aStarted()).toBe(true));
			// B's first-error overflow happens WHILE A's tracked run streams: no
			// retry tuple, no synthetic message; only the exact owner/lease/subset
			// runtime partition metadata is added to the SAME window object.
			internals._lastRunPromptIds = [ownerB];
			internals._postCompactionContinuationMessages = [messageA];
			await internals._runAutoCompaction("overflow", true);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA, ownerB]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([ownerB]);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryAttempt).toBe(0);
			internals._lastRunTerminalStopReason = undefined;
			releaseA();
			return { scheduledRun };
		}

		it.each([
			{
				label: "success",
				assistant: fauxAssistantMessage("complement success"),
				expected: { status: "completed" },
			},
			{
				label: "error",
				assistant: fauxAssistantMessage("", { stopReason: "error", errorMessage: "complement failed" }),
				expected: { status: "failed", failure: { reason: "run_error" } },
			},
			{
				label: "aborted",
				assistant: fauxAssistantMessage("", { stopReason: "aborted" }),
				expected: { status: "cancelled" },
			},
		])(
			"[partition-model fix] tracked pump complement $label consumes A once at its own terminal while B first-error overflow subset remains pending; B recovery runs once under B",
			async ({ assistant, expected }) => {
				vi.useFakeTimers();
				const harness = await createHarness({
					settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
					extensionFactories: [compactSummaryExtension("complement summary")],
				});
				continuationHarnesses.push(harness);
				seedSessionForCompaction(harness);
				const observer = installContinuationObserver(harness);
				const internals = continuationInternals(harness);
				const ownerA = `partition-complement-${expected.status}`;
				const ownerB = `partition-complement-b-${expected.status}`;
				const messageA = continuationMessage(`${expected.status} complement A obligation`);
				let releaseA = () => {};
				const aGate = new Promise<void>((resolve) => {
					releaseA = resolve;
				});
				let aStarted = false;
				harness.setResponses([
					async () => {
						aStarted = true;
						await aGate;
						return assistant;
					},
				]);
				const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
					// B's recovery: run under B exactly once, after A's complement
					// consumption.
					internals._lastRunTerminalStopReason = "stop";
				});
				// Start A's pump dispatch, stamp B mid-flight, then release A's real
				// terminal: the pump consumes A's complement at its terminal,
				// leaving only B pending, then B recovers once under B.
				const { scheduledRun } = await stageTrackedComplementWindow(
					harness,
					internals,
					ownerA,
					ownerB,
					messageA,
					releaseA,
					() => aStarted,
				);
				await scheduledRun;
				await vi.advanceTimersByTimeAsync(100);
				await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
				// A got its own real terminal; B recovered once under B.
				expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ promptId: ownerA, ...expected });
				expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({ promptId: ownerB, status: "completed" });
				expect(harness.session.getPromptOutcome(ownerB)?.failure).toBeUndefined();
				expect(observer.continuationLeases[0]!.releaseCalls).toBe(1);
				expect(observer.continuationLeases[1]!.releaseCalls).toBe(1);
				expect(internals._continuationSettlementWindow).toBeUndefined();
				expect(internals._postCompactionContinuationScheduled).toBe(false);
				expect(harness.eventsOfType("prompt_outcome")).toHaveLength(2);
				continueSpy.mockRestore();
				observer.restore();
			},
		);

		it("[partition-model fix] tracked A error with remaining direct D and first-error overflow B preserves A,D owners/leases and D's message until B recovery; D then settles from retained tracked intent", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("remainder ADB summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "partition-remainder-a";
			const ownerD = "partition-remainder-d";
			const ownerB = "partition-remainder-b";
			admitOwners(harness, ownerA, ownerD, ownerB);
			const messageA = continuationMessage("remainder tracked A obligation");
			const messageD = continuationMessage("remainder direct D obligation");
			internals._postCompactionContinuationMessages = [messageA, messageD];
			expect(internals._scheduleContinuationForObligation([ownerA, ownerD], [messageA, messageD])).toBe(true);
			admitTrackedContinuationAction(harness, messageA);
			internals._schedulePostCompactionContinue();
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA, ownerD],
				obligationMessages: [messageA, messageD],
			});
			const aLease = observer.continuationLeases[0]!;
			const dLease = observer.continuationLeases[1]!;
			let releaseA = () => {};
			const aGate = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			let aStarted = false;
			harness.setResponses([
				async () => {
					aStarted = true;
					await aGate;
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "tracked A remainder failed",
					});
				},
			]);
			const ownersAtContinue: string[][] = [];
			const dContinueGate = createDeferred();
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				const owners = [...(internals._lastRunPromptIds ?? [])];
				ownersAtContinue.push(owners);
				if (ownersAtContinue.length > 1) await dContinueGate.promise;
				internals._lastRunTerminalStopReason = "stop";
			});

			const scheduledRun = internals._runScheduledPostCompactionContinue();
			await vi.waitFor(() => expect(aStarted).toBe(true));
			// Mid-flight first-error overflow of B: no retry tuple, no independent
			// overflow message. Window becomes [A,D,B] with overflow subset [B].
			internals._lastRunPromptIds = [ownerB];
			internals._postCompactionContinuationMessages = [messageA, messageD];
			await internals._runAutoCompaction("overflow", true);
			expect(internals._continuationSettlementWindow?.owners).toEqual([ownerA, ownerD, ownerB]);
			expect(internals._continuationSettlementWindow?.overflowRecoveryOwners).toEqual([ownerB]);
			expect(internals._retryPromise).toBeUndefined();
			expect(internals._retryAttempt).toBe(0);
			expect(observer.continuationLeases[2]!.promptId).toBe(ownerB);
			const bLease = observer.continuationLeases[2]!;
			internals._lastRunTerminalStopReason = undefined;
			releaseA();
			await scheduledRun;

			// After A's tracked terminal and BEFORE B recovery: remaining
			// non-overflow obligation D still exists, so A,D owners/leases stay
			// in the window with D's message. Overflow subset [B] is pending.
			// Existing mixed tracked/direct contract: tracked error fences A and D
			// as run_error intent, but neither lease is released yet.
			expect(aLease.releaseCalls).toBe(0);
			expect(dLease.releaseCalls).toBe(0);
			expect(bLease.releaseCalls).toBe(0);
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerD)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerB)).toBeUndefined();
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA, ownerD, ownerB],
				obligationMessages: [messageD],
				overflowRecoveryOwners: [ownerB],
				state: "scheduled",
				pumpOwned: false,
			});
			expect(internals._postCompactionContinuationMessages).toEqual([messageD]);
			expect(internals._scheduledPostCompactionContinuationMessages).toEqual([messageD]);
			expect(internals._continuationPumpOwnerAction).toBeUndefined();

			await vi.advanceTimersByTimeAsync(100);
			// B recovered once under B; remaining window is A,D with D only.
			// Do not waitFor here: fake-timer waitFor auto-advances 50ms and
			// would fire D's rearmed 100ms timer.
			expect(bLease.releaseCalls).toBe(1);
			expect(ownersAtContinue[0]).toEqual([ownerB]);
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(ownersAtContinue[1]).toEqual([ownerA, ownerD]);
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "completed",
			});
			expect(harness.session.getPromptOutcome(ownerB)?.failure).toBeUndefined();
			expect(aLease.releaseCalls).toBe(0);
			expect(dLease.releaseCalls).toBe(0);
			expect(harness.session.getPromptOutcome(ownerA)).toBeUndefined();
			expect(harness.session.getPromptOutcome(ownerD)).toBeUndefined();
			expect(internals._continuationSettlementWindow).toMatchObject({
				owners: [ownerA, ownerD],
				obligationMessages: [messageD],
				overflowRecoveryOwners: [],
			});

			dContinueGate.resolve();
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			// D's direct run executed once (second continue, owners A,D) then the
			// retained tracked-error intent settled both A and D failed/run_error.
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(ownersAtContinue).toEqual([[ownerB], [ownerA, ownerD]]);
			expect(aLease.releaseCalls).toBe(1);
			expect(dLease.releaseCalls).toBe(1);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({
				promptId: ownerA,
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(harness.session.getPromptOutcome(ownerD)).toMatchObject({
				promptId: ownerD,
				status: "failed",
				failure: { reason: "run_error" },
			});
			expect(harness.eventsOfType("prompt_outcome")).toHaveLength(3);
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._continuationSchedulingPause).toBeUndefined();
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[partition-model fix] complement-removal synchronous reentry: A prompt_outcome listener observes coherent B-only publication, can close B, and no stale timer survives", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("complement reentry close summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "partition-reentry-a";
			const ownerB = "partition-reentry-b";
			const messageA = continuationMessage("partition reentry A obligation");
			let releaseA = () => {};
			const aGate = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			let aStarted = false;
			harness.setResponses([
				async () => {
					aStarted = true;
					await aGate;
					return fauxAssistantMessage("complement done");
				},
			]);
			const reentryFacts = {
				seen: false,
				owners: [] as string[],
				overflowOwners: [] as string[],
				leases: [] as unknown[],
				messages: [] as AgentMessage[],
				revision: -1,
				state: "" as string,
				scheduled: false,
				timerDefined: false,
				snapshot: [] as AgentMessage[],
				closeReturned: false,
			};
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementationOnce(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "prompt_outcome" || event.outcome.promptId !== ownerA) return;
				// A's complement release is the first synchronous reentry: the
				// remaining tuple must be EXACTLY B (owner/lease/subset/revision/
				// state/timer/snapshot/pause) and coherent.
				const window = internals._continuationSettlementWindow;
				reentryFacts.seen = true;
				reentryFacts.owners = window?.owners ? [...window.owners] : [];
				reentryFacts.overflowOwners = window?.overflowRecoveryOwners ? [...window.overflowRecoveryOwners] : [];
				reentryFacts.leases = window?.leases ? [...window.leases] : [];
				reentryFacts.messages = window?.obligationMessages ? [...window.obligationMessages] : [];
				reentryFacts.revision = window?.revision ?? -1;
				reentryFacts.state = window?.state ?? "";
				reentryFacts.scheduled = internals._postCompactionContinuationScheduled;
				reentryFacts.timerDefined = internals._postCompactionContinuationTimer !== undefined;
				reentryFacts.snapshot = [...internals._scheduledPostCompactionContinuationMessages];
				// Listener closes B exactly once; no stale ownerless timer after return.
				reentryFacts.closeReturned = internals._cancelPostCompactionContinue({ owners: "fail" });
			});
			const { scheduledRun } = await stageTrackedComplementWindow(
				harness,
				internals,
				ownerA,
				ownerB,
				messageA,
				releaseA,
				() => aStarted,
			);
			await scheduledRun;
			await vi.advanceTimersByTimeAsync(100);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(reentryFacts.seen).toBe(true);
			expect(reentryFacts.owners).toEqual([ownerB]);
			expect(reentryFacts.overflowOwners).toEqual([ownerB]);
			expect(reentryFacts.leases).toHaveLength(1);
			expect(reentryFacts.messages).toEqual([]);
			expect(reentryFacts.state).toBe("scheduled");
			expect(reentryFacts.scheduled).toBe(true);
			expect(reentryFacts.timerDefined).toBe(true);
			expect(reentryFacts.closeReturned).toBe(true);
			// B failed via the reentrant close; A completed at its own terminal.
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ promptId: ownerA, status: "completed" });
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			// No stale timer/window residue after the listener returns.
			expect(internals._postCompactionContinuationTimer).toBeUndefined();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._continuationSchedulingPause).toBeUndefined();
			expect(continueSpy).toHaveBeenCalledTimes(0);
			await vi.advanceTimersByTimeAsync(300);
			expect(continueSpy).toHaveBeenCalledTimes(0);
			unsubscribe();
			continueSpy.mockRestore();
			observer.restore();
		});

		it("[partition-model fix] complement-removal synchronous reentry: listener-created B replacement survives untouched after A release", async () => {
			vi.useFakeTimers();
			const harness = await createHarness({
				settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [compactSummaryExtension("complement reentry replacement summary")],
			});
			continuationHarnesses.push(harness);
			seedSessionForCompaction(harness);
			const observer = installContinuationObserver(harness);
			const internals = continuationInternals(harness);
			const ownerA = "partition-reentry-repl-a";
			const ownerB = "partition-reentry-repl-b";
			const ownerC = "partition-reentry-repl-c";
			admitOwners(harness, ownerC);
			const messageA = continuationMessage("partition reentry replacement A obligation");
			const replacementMessage = continuationMessage("partition reentry replacement C obligation");
			let releaseA = () => {};
			const aGate = new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			let aStarted = false;
			harness.setResponses([
				async () => {
					aStarted = true;
					await aGate;
					return fauxAssistantMessage("complement done");
				},
				fauxAssistantMessage("replacement C done"),
			]);
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				internals._lastRunTerminalStopReason = "stop";
			});
			const replacementFacts = {
				seen: false,
				owners: [] as string[],
				overflowOwners: [] as string[],
				revision: -1,
				scheduled: false,
				timerDefined: false,
			};
			let replacementWindow: unknown;
			let replacementTimer: unknown;
			let replacementSnapshot: AgentMessage[] | undefined;
			let replacementPause: unknown | undefined;
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "prompt_outcome" || event.outcome.promptId !== ownerA) return;
				const window = internals._continuationSettlementWindow;
				replacementFacts.seen = true;
				replacementFacts.owners = window?.owners ? [...window.owners] : [];
				replacementFacts.overflowOwners = window?.overflowRecoveryOwners ? [...window.overflowRecoveryOwners] : [];
				replacementFacts.revision = window?.revision ?? -1;
				replacementFacts.scheduled = internals._postCompactionContinuationScheduled;
				replacementFacts.timerDefined = internals._postCompactionContinuationTimer !== undefined;
				// Close B and publish a replacement C obligation from inside the listener.
				internals._cancelPostCompactionContinue({ owners: "fail" });
				internals._postCompactionContinuationMessages = [replacementMessage];
				internals._scheduleContinuationForObligation([ownerC], [replacementMessage]);
				internals._schedulePostCompactionContinue();
				replacementWindow = internals._continuationSettlementWindow;
				replacementTimer = internals._postCompactionContinuationTimer;
				replacementSnapshot = internals._scheduledPostCompactionContinuationMessages;
				replacementPause = internals._continuationSchedulingPause;
			});
			const { scheduledRun } = await stageTrackedComplementWindow(
				harness,
				internals,
				ownerA,
				ownerB,
				messageA,
				releaseA,
				() => aStarted,
			);
			await scheduledRun;
			// The A-outcome listener fired synchronously during A's complement
			// release and published a replacement C window; the helper must not
			// have touched it. (No timer advance yet: the replacement's own timer
			// must still be pending here.)
			expect(replacementFacts.seen).toBe(true);
			expect(replacementFacts.owners).toEqual([ownerB]);
			expect(replacementFacts.overflowOwners).toEqual([ownerB]);
			expect(harness.session.getPromptOutcome(ownerA)).toMatchObject({ promptId: ownerA, status: "completed" });
			expect(harness.session.getPromptOutcome(ownerB)).toMatchObject({
				promptId: ownerB,
				status: "failed",
				failure: { reason: "run_error" },
			});
			// The replacement object/timer/snapshot/pause are untouched by the helper.
			expect(internals._continuationSettlementWindow).toBe(replacementWindow);
			expect(internals._postCompactionContinuationTimer).toBe(replacementTimer);
			expect(internals._scheduledPostCompactionContinuationMessages).toBe(replacementSnapshot);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._continuationSchedulingPause).toBe(replacementPause);
			// The replacement C obligation was acquired exactly once (the release
			// record index follows A/B acquisition order and is not asserted by
			// index here because the wrapped record list is what the observer
			// captured; the acquire log is the exact acquisition evidence).
			expect(observer.acquiresOfContinuation().map((entry) => entry.promptId)).toEqual([ownerA, ownerB, ownerC]);
			// Replacement runs once under C.
			internals._lastRunTerminalStopReason = undefined;
			await vi.advanceTimersByTimeAsync(150);
			await vi.waitFor(() => expect(internals._continuationSettlementWindow).toBeUndefined());
			expect(harness.session.getPromptOutcome(ownerC)).toMatchObject({ promptId: ownerC, status: "completed" });
			expect(observer.continuationLeases.at(-1)!.promptId).toBe(ownerC);
			expect(observer.continuationLeases.at(-1)!.releaseCalls).toBe(1);
			expect(internals._continuationSchedulingPause).toBeUndefined();
			unsubscribe();
			continueSpy.mockRestore();
			observer.restore();
		});
	});
});
