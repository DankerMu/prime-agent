import { describe, expect, it } from "vitest";
import {
	DuplicatePromptAdmissionError,
	InvalidRestoreRecordError,
	type PendingUserQuestion,
	type PromptOutcome,
	type PromptSettlementRecord,
	PromptSettlementTracker,
	RestoreOverwriteError,
	TerminalPromptAcquireError,
	UnknownPromptError,
} from "../src/core/prompt-settlement.js";

interface Harness {
	tracker: PromptSettlementTracker;
	now: number;
	persisted: PromptSettlementRecord[];
	emitted: PromptOutcome[];
}

function createHarness(initialNow = 10): Harness {
	const harness: Harness = {
		now: initialNow,
		persisted: [],
		emitted: [],
		tracker: undefined as unknown as PromptSettlementTracker,
	};
	harness.tracker = new PromptSettlementTracker({
		now: () => harness.now,
		persist: (record) => {
			harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
		},
		emit: (outcome) => {
			harness.emitted.push(outcome);
		},
	});
	return harness;
}

function lastRecord(harness: Harness, promptId: string): PromptSettlementRecord {
	const record = harness.persisted.filter((r) => r.promptId === promptId).at(-1);
	if (!record) {
		throw new Error(`no persisted record for ${promptId}`);
	}
	return record;
}

function settlingRecord(promptId: string, overrides: Partial<PromptSettlementRecord> = {}): PromptSettlementRecord {
	return {
		promptId,
		status: "settling",
		sessionEpoch: 1,
		traceGeneration: 0,
		finalMessageIds: [],
		cancelRequested: false,
		released: false,
		admittedAt: 1,
		...overrides,
	};
}

function terminalRecord(
	promptId: string,
	status: "completed" | "failed" | "cancelled",
	overrides: Partial<PromptSettlementRecord> = {},
): PromptSettlementRecord {
	return {
		promptId,
		status,
		sessionEpoch: 1,
		traceGeneration: 0,
		finalMessageIds: [],
		cancelRequested: false,
		released: false,
		admittedAt: 1,
		settledAt: 2,
		...overrides,
	};
}

describe("PromptSettlementTracker happy path", () => {
	it("admits with a settling record and no emit; settles completed on last lease release", () => {
		const harness = createHarness();
		const { tracker } = harness;

		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 7 });
		expect(promptId).toBe("P");
		expect(harness.persisted).toEqual([
			{
				promptId: "P",
				status: "settling",
				sessionEpoch: 7,
				traceGeneration: 0,
				finalMessageIds: [],
				cancelRequested: false,
				released: false,
				admittedAt: 10,
			},
		]);
		expect(harness.emitted).toEqual([]);

		const run = tracker.acquire(promptId, "run");
		tracker.recordFinalMessage(promptId, "M");
		tracker.bumpTraceGeneration(promptId);
		harness.now = 20;
		run.release();

		expect(harness.persisted).toHaveLength(2);
		expect(lastRecord(harness, "P")).toEqual({
			promptId: "P",
			status: "completed",
			sessionEpoch: 7,
			traceGeneration: 1,
			finalMessageIds: ["M"],
			cancelRequested: false,
			released: false,
			admittedAt: 10,
			settledAt: 20,
		});
		expect(harness.emitted).toHaveLength(1);
		expect(harness.emitted[0]).toEqual({
			promptId: "P",
			status: "completed",
			advisor: "disabled",
			finalMessageIds: ["M"],
			sessionEpoch: 7,
			traceGeneration: 1,
		});
		// No pendingQuestions, no failure, no failureReason, no settleReason on either surface.
		expect("pendingQuestions" in harness.emitted[0]).toBe(false);
		expect("failure" in harness.emitted[0]).toBe(false);
		expect("failureReason" in lastRecord(harness, "P")).toBe(false);
		expect("settleReason" in lastRecord(harness, "P")).toBe(false);
	});

	it("generates a promptId with the project UUID mechanism when omitted", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ sessionEpoch: 1 });
		expect(promptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(lastRecord(harness, promptId).promptId).toBe(promptId);
	});

	it("returns distinct lease objects; each acquire counts as an independent instance", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const leaseA = harness.tracker.acquire(promptId, "run");
		const leaseB = harness.tracker.acquire(promptId, "run");
		const leaseC = harness.tracker.acquire(promptId, "retry");
		expect(leaseA).not.toBe(leaseB);
		expect(leaseB).not.toBe(leaseC);
		leaseA.release();
		expect(harness.tracker.isSettling(promptId)).toBe(true);
		expect(harness.tracker.outcome(promptId)).toBeUndefined();
		leaseB.release();
		expect(harness.tracker.isSettling(promptId)).toBe(true);
		leaseC.release();
		expect(harness.tracker.outcome(promptId)?.status).toBe("completed");
	});

	it("a lease's duplicate release is a no-op", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		lease.release();
		lease.release();
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
		expect(harness.tracker.outcome(promptId)?.status).toBe("completed");
	});
});

describe("PromptSettlementTracker lease handoff", () => {
	it("acquire-before-release handoff settles only after the new lease is released (no window)", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const run = harness.tracker.acquire(promptId, "run");
		const retry = harness.tracker.acquire(promptId, "retry");
		run.release();
		expect(harness.tracker.isSettling(promptId)).toBe(true);
		expect(harness.tracker.outcome(promptId)).toBeUndefined();
		const compaction = harness.tracker.acquire(promptId, "compaction_continuation");
		retry.release();
		expect(harness.tracker.isSettling(promptId)).toBe(true);
		compaction.release();
		expect(harness.tracker.outcome(promptId)?.status).toBe("completed");
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});

	it("release-before-acquire settles early and the later acquire throws (counterexample)", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const run = harness.tracker.acquire(promptId, "run");
		run.release();
		expect(harness.tracker.outcome(promptId)?.status).toBe("completed");
		expect(harness.tracker.isSettling(promptId)).toBe(false);
		expect(() => harness.tracker.acquire(promptId, "retry")).toThrow(TerminalPromptAcquireError);
		// No implicit grace period: no extra records, no re-open.
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});
});

describe("PromptSettlementTracker fences and precedence", () => {
	it("cancel wins over failure; cancelled has no failure fields", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		harness.tracker.recordFailure(promptId, "run_error");
		harness.tracker.requestCancel(promptId);
		lease.release();
		expect(harness.tracker.outcome(promptId)?.status).toBe("cancelled");
		expect("failure" in harness.tracker.outcome(promptId)!).toBe(false);
		const record = lastRecord(harness, promptId);
		expect(record.status).toBe("cancelled");
		expect("failureReason" in record).toBe(false);
		expect("settleReason" in record).toBe(false);
	});

	it("failed via recordFailure has failure.reason === failureReason and no settleReason", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		harness.tracker.recordFailure(promptId, "run_error");
		lease.release();
		const outcome = harness.tracker.outcome(promptId)!;
		expect(outcome.status).toBe("failed");
		expect(outcome.failure?.reason).toBe("run_error");
		const record = lastRecord(harness, promptId);
		expect(record.failureReason).toBe("run_error");
		expect("settleReason" in record).toBe(false);
	});

	it("recordFailure is idempotent and the last reason wins", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		harness.tracker.recordFailure(promptId, "run_error");
		harness.tracker.recordFailure(promptId, "runtime_restarted");
		lease.release();
		expect(harness.tracker.outcome(promptId)?.failure?.reason).toBe("runtime_restarted");
	});

	it("terminal mutations and lease release are no-ops", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		lease.release();
		const emitted = harness.emitted.length;
		const persisted = harness.persisted.length;
		const outcome = harness.tracker.outcome(promptId);

		harness.tracker.recordFinalMessage(promptId, "late");
		harness.tracker.bumpTraceGeneration(promptId);
		harness.tracker.requestCancel(promptId);
		harness.tracker.recordFailure(promptId, "run_error");
		harness.tracker.release(promptId);
		lease.release();
		expect(harness.emitted).toHaveLength(emitted);
		expect(harness.persisted).toHaveLength(persisted + 1); // only the released fence record
		expect(harness.tracker.outcome(promptId)).toBe(outcome);
		expect(harness.tracker.outcome(promptId)?.finalMessageIds).toEqual([]);
	});
});

describe("PromptSettlementTracker settleAll", () => {
	it("settleAll('failed') writes failure.reason === failureReason === settleReason per prompt", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		// p2 already terminal is untouched.
		const p2Lease = tracker.acquire(p2, "run");
		p2Lease.release();

		harness.now = 30;
		tracker.settleAll("failed", "runtime_restarted");

		const outcome1 = tracker.outcome(p1)!;
		expect(outcome1.status).toBe("failed");
		expect(outcome1.failure?.reason).toBe("runtime_restarted");
		const record1 = lastRecord(harness, p1);
		expect(record1.status).toBe("failed");
		expect(record1.failureReason).toBe("runtime_restarted");
		expect(record1.settleReason).toBe("runtime_restarted");
		expect(record1.settledAt).toBe(30);

		expect(tracker.outcome(p2)?.status).toBe("completed");
		const emitted = harness.emitted;
		// P1 is settled by settleAll; P2 was settled earlier by its own lease release.
		expect(emitted.map((o) => o.promptId).sort()).toEqual(["P1", "P2"]);
		expect(emitted.filter((o) => o.promptId === "P1")).toHaveLength(1);
	});

	it("settleAll('cancelled') has no failure/failureReason", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		tracker.acquire(p1, "run");
		tracker.settleAll("cancelled", "session_disposed");
		expect(tracker.outcome(p1)?.status).toBe("cancelled");
		expect("failure" in tracker.outcome(p1)!).toBe(false);
		const record = lastRecord(harness, p1);
		expect(record.settleReason).toBe("session_disposed");
		expect("failureReason" in record).toBe(false);
		expect(record.released).toBe(false);
	});

	it("settleAll('cancelled', reason, { released: true }) persists and emits once per prompt with released in the same record", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		tracker.acquire(p1, "run");
		const p2Lease = tracker.acquire(p2, "run");
		p2Lease.release(); // already terminal, untouched by settleAll

		harness.now = 40;
		tracker.settleAll("cancelled", "session_disposed", { released: true });

		expect(harness.persisted).toHaveLength(4); // 2 admission + p2 terminal + p1 settleAll
		expect(harness.emitted).toHaveLength(2);

		const record1 = lastRecord(harness, p1);
		expect(record1).toMatchObject({
			status: "cancelled",
			released: true,
			settleReason: "session_disposed",
			settledAt: 40,
		});
		expect("failureReason" in record1).toBe(false);
		expect(tracker.outcome(p1)?.status).toBe("cancelled");

		// No intermediate non-released terminal record exists for P1.
		const p1Records = harness.persisted.filter((r) => r.promptId === p1);
		expect(p1Records).toHaveLength(2);
		expect(p1Records.map((r) => r.status)).toEqual(["settling", "cancelled"]);
		expect(p1Records[1].released).toBe(true);

		const record2 = lastRecord(harness, p2);
		expect(record2.status).toBe("completed");
		expect(record2.released).toBe(false);
		expect("settleReason" in record2).toBe(false);

		// Repeat is a no-op.
		const persistedBefore = harness.persisted.length;
		const emittedBefore = harness.emitted.length;
		tracker.settleAll("cancelled", "session_disposed", { released: true });
		expect(harness.persisted).toHaveLength(persistedBefore);
		expect(harness.emitted).toHaveLength(emittedBefore);
	});

	it("released fence via settleAll rejects later acquire", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		harness.tracker.acquire(promptId, "run");
		harness.tracker.settleAll("cancelled", "session_disposed", { released: true });
		expect(() => harness.tracker.acquire(promptId, "run")).toThrow(TerminalPromptAcquireError);
	});

	it("two eligible prompts settle each exactly once with exact conditional fields and repeat no-op", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		tracker.acquire(p1, "run");
		tracker.acquire(p2, "run");
		tracker.recordFailure(p2, "run_error");

		harness.now = 50;
		tracker.settleAll("cancelled", "session_disposed", { released: true });

		// P1: cancelled, no failure fields anywhere.
		expect(tracker.outcome(p1)).toMatchObject({ promptId: "P1", status: "cancelled" });
		expect("failure" in tracker.outcome(p1)!).toBe(false);
		const record1 = lastRecord(harness, p1);
		expect(record1).toMatchObject({
			status: "cancelled",
			released: true,
			settleReason: "session_disposed",
			settledAt: 50,
		});
		expect("failureReason" in record1).toBe(false);

		// P2: also cancelled with no failure fields even though recordFailure intent existed.
		expect(tracker.outcome(p2)).toMatchObject({ promptId: "P2", status: "cancelled" });
		expect("failure" in tracker.outcome(p2)!).toBe(false);
		const record2 = lastRecord(harness, p2);
		expect(record2).toMatchObject({
			status: "cancelled",
			released: true,
			settleReason: "session_disposed",
			settledAt: 50,
		});
		expect("failureReason" in record2).toBe(false);

		// Exactly one terminal persist and one emit per prompt.
		expect(harness.persisted.filter((r) => r.promptId === p1)).toHaveLength(2);
		expect(harness.persisted.filter((r) => r.promptId === p2)).toHaveLength(2);
		expect(harness.emitted.filter((o) => o.promptId === p1)).toHaveLength(1);
		expect(harness.emitted.filter((o) => o.promptId === p2)).toHaveLength(1);

		// Repeat is a no-op.
		const persistedBefore = harness.persisted.length;
		const emittedBefore = harness.emitted.length;
		tracker.settleAll("cancelled", "session_disposed", { released: true });
		expect(harness.persisted).toHaveLength(persistedBefore);
		expect(harness.emitted).toHaveLength(emittedBefore);
	});

	it("recordFailure then cancelled+released settleAll never surfaces failure or failureReason", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		tracker.acquire(promptId, "run");
		tracker.recordFailure(promptId, "run_error");

		tracker.settleAll("cancelled", "session_disposed", { released: true });

		expect(tracker.outcome(promptId)?.status).toBe("cancelled");
		expect("failure" in tracker.outcome(promptId)!).toBe(false);
		const record = lastRecord(harness, promptId);
		expect("failureReason" in record).toBe(false);
		expect(record.settleReason).toBe("session_disposed");
		expect(record.released).toBe(true);
	});

	it("two simultaneously eligible prompts settle failed once each with exact conditional fields and repeat no-op", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		tracker.acquire(p1, "run");
		tracker.acquire(p2, "run");
		tracker.recordFinalMessage(p1, "M1");
		tracker.recordFinalMessage(p2, "M2");
		tracker.recordFailure(p2, "run_error"); // overridden by settleAll's authoritative reason

		harness.now = 70;
		tracker.settleAll("failed", "runtime_restarted");

		for (const [promptId, message] of [
			[p1, "M1"],
			[p2, "M2"],
		] as const) {
			const outcome = tracker.outcome(promptId)!;
			expect(outcome.status).toBe("failed");
			expect(outcome.failure?.reason).toBe("runtime_restarted");
			expect(outcome.finalMessageIds).toEqual([message]);
			const record = lastRecord(harness, promptId);
			expect(record.status).toBe("failed");
			expect(record.failureReason).toBe("runtime_restarted");
			expect(record.settleReason).toBe("runtime_restarted");
			expect(record.settledAt).toBe(70);
			expect(record.finalMessageIds).toEqual([message]);
			expect(harness.persisted.filter((r) => r.promptId === promptId)).toHaveLength(2);
			expect(harness.emitted.filter((o) => o.promptId === promptId)).toHaveLength(1);
		}
		expect(harness.emitted).toHaveLength(2);

		// Repeat is a no-op.
		const persistedBefore = harness.persisted.length;
		const emittedBefore = harness.emitted.length;
		tracker.settleAll("failed", "runtime_restarted");
		expect(harness.persisted).toHaveLength(persistedBefore);
		expect(harness.emitted).toHaveLength(emittedBefore);
	});
});

describe("PromptSettlementTracker queries and errors", () => {
	it("waitForOutcome rejects for unknown prompt; outcome returns undefined; isSettling is false", async () => {
		const harness = createHarness();
		const { tracker } = harness;
		expect(tracker.outcome("unknown")).toBeUndefined();
		await expect(tracker.waitForOutcome("unknown")).rejects.toBeInstanceOf(UnknownPromptError);
		expect(tracker.isSettling("unknown")).toBe(false);
	});

	it("isSettling flips true on admit/acquire and false on terminal", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		expect(harness.tracker.isSettling(promptId)).toBe(true);
		lease.release();
		expect(harness.tracker.isSettling(promptId)).toBe(false);
	});

	it("duplicate admit throws and adds no persist/emit", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		expect(() => harness.tracker.admit({ promptId: "P", sessionEpoch: 2 })).toThrow(DuplicatePromptAdmissionError);
		expect(harness.persisted).toHaveLength(1);
		expect(harness.emitted).toHaveLength(0);
		expect(lastRecord(harness, promptId).sessionEpoch).toBe(1);
	});

	it("acquire on unknown prompt throws", () => {
		const harness = createHarness();
		expect(() => harness.tracker.acquire("unknown", "run")).toThrow(UnknownPromptError);
	});

	it("terminal acquire throws without mutating the record", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		lease.release();
		expect(() => harness.tracker.acquire(promptId, "run")).toThrow(TerminalPromptAcquireError);
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
		expect(harness.tracker.outcome(promptId)?.status).toBe("completed");
	});

	it("multiple active waiters all resolve once on settlement with the cached outcome", async () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		const waiter1 = harness.tracker.waitForOutcome(promptId);
		const waiter2 = harness.tracker.waitForOutcome(promptId);
		lease.release();
		const [outcome1, outcome2] = await Promise.all([waiter1, waiter2]);
		expect(outcome1.status).toBe("completed");
		expect(outcome2).toBe(outcome1);
		expect(harness.tracker.outcome(promptId)).toBe(outcome1);
	});

	it("waitForOutcome on an already-terminal prompt resolves immediately with the same object", async () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		lease.release();
		const outcome = harness.tracker.outcome(promptId)!;
		await expect(harness.tracker.waitForOutcome(promptId)).resolves.toBe(outcome);
	});
});

describe("PromptSettlementTracker release(promptId) fence", () => {
	it("only marks an already-terminal record released, persisting once, without settle/emit", async () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		lease.release();
		const emitted = harness.emitted.length;
		const persisted = harness.persisted.length;

		harness.tracker.release(promptId);
		const record = lastRecord(harness, promptId);
		expect(record.status).toBe("completed");
		expect(record.released).toBe(true);
		expect("settleReason" in record).toBe(false);
		expect(harness.persisted).toHaveLength(persisted + 1);
		expect(harness.emitted).toHaveLength(emitted);

		// Repeat is a no-op.
		harness.tracker.release(promptId);
		expect(harness.persisted).toHaveLength(persisted + 1);

		// Query/waiter still resolve with the same terminal outcome object.
		expect(harness.tracker.outcome(promptId)?.status).toBe("completed");
		await expect(harness.tracker.waitForOutcome(promptId)).resolves.toBe(harness.tracker.outcome(promptId));
		// Released terminal cannot be re-acquired.
		expect(() => harness.tracker.acquire(promptId, "run")).toThrow(TerminalPromptAcquireError);
	});

	it("is a no-op for active and unknown prompts", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		harness.tracker.release(promptId); // active: no-op
		harness.tracker.release("unknown"); // unknown: no-op
		expect(harness.persisted).toHaveLength(1);
		expect(harness.tracker.isSettling(promptId)).toBe(true);
	});
});

describe("PromptSettlementTracker snapshot/restore", () => {
	it("snapshot returns deep copies; mutating it does not affect the tracker", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		harness.tracker.acquire(promptId, "run");
		harness.tracker.recordFinalMessage(promptId, "M");

		const snapshot = harness.tracker.snapshot();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0].finalMessageIds).toEqual(["M"]);
		snapshot[0].finalMessageIds.push("tampered");
		snapshot[0].sessionEpoch = 999;
		snapshot.push({ ...snapshot[0], promptId: "bogus" });

		const after = harness.tracker.snapshot();
		expect(after).toHaveLength(1);
		expect(after[0].finalMessageIds).toEqual(["M"]);
		expect(after[0].sessionEpoch).toBe(1);
		expect(harness.tracker.outcome(promptId)).toBeUndefined();
	});

	it("restore takes the last record per promptId and makes no persist/emit", () => {
		const harness = createHarness();
		const { tracker } = harness;
		const settling = settlingRecord("P", { sessionEpoch: 1, admittedAt: 1 });
		const terminal = terminalRecord("P", "cancelled", {
			sessionEpoch: 1,
			cancelRequested: true,
			settledAt: 2,
			settleReason: "session_disposed",
		});
		tracker.restore([settling, terminal]);
		expect(harness.persisted).toHaveLength(0);
		expect(harness.emitted).toHaveLength(0);
		expect(tracker.outcome("P")?.status).toBe("cancelled");
		expect("settleReason" in tracker.outcome("P")!).toBe(false); // reason stays in ledger only
		expect(harness.tracker.isSettling("P")).toBe(false);
		expect(() => tracker.acquire("P", "run")).toThrow(TerminalPromptAcquireError);
	});

	it("restored terminal/released records are immutable and share one cached outcome object", async () => {
		const harness = createHarness();
		const { tracker } = harness;
		const terminal = terminalRecord("P", "failed", {
			sessionEpoch: 3,
			traceGeneration: 1,
			finalMessageIds: ["M"],
			failureReason: "run_error",
			released: true,
			admittedAt: 1,
			settledAt: 2,
		});
		tracker.restore([terminal]);
		const outcome = tracker.outcome("P")!;
		expect(outcome).toMatchObject({
			promptId: "P",
			status: "failed",
			advisor: "disabled",
			finalMessageIds: ["M"],
			sessionEpoch: 3,
			traceGeneration: 1,
			failure: { reason: "run_error" },
		});
		await expect(tracker.waitForOutcome("P")).resolves.toBe(outcome);
		// Immutable outcome: no new terminal record can be written, no emit is made,
		// and snapshot of the record stays fixed even though the query result is one shared object.
		expect(tracker.snapshot()[0].finalMessageIds).toEqual(["M"]);
		expect(tracker.outcome("P")!.status).toBe("failed");
	});

	it("restores active records so later acquire/release can settle; no live leases restored", () => {
		const harness = createHarness();
		const { tracker } = harness;
		const settling = settlingRecord("P", { sessionEpoch: 5, admittedAt: 1 });
		tracker.restore([settling]);
		expect(tracker.isSettling("P")).toBe(true);
		expect(tracker.outcome("P")).toBeUndefined();
		// The restored state carries no leases, so a fresh acquire can settle.
		const lease = tracker.acquire("P", "run");
		harness.now = 60;
		lease.release();
		const record = lastRecord(harness, "P");
		expect(record.status).toBe("completed");
		expect(record.admittedAt).toBe(1);
		expect(record.settledAt).toBe(60);
		expect(tracker.outcome("P")?.status).toBe("completed");
	});

	it("restore of a released settling record is rejected synchronously and changes nothing", async () => {
		const harness = createHarness();
		const { tracker } = harness;
		const releasedSettling = settlingRecord("P", { released: true, admittedAt: 1 });
		expect(() => tracker.restore([releasedSettling])).toThrow(InvalidRestoreRecordError);
		expect(tracker.outcome("P")).toBeUndefined();
		expect(tracker.isSettling("P")).toBe(false);
		expect(harness.persisted).toHaveLength(0);
		expect(harness.emitted).toHaveLength(0);
		// No identity was created, so nothing can be waiting on it.
		await expect(tracker.waitForOutcome("P")).rejects.toBeInstanceOf(UnknownPromptError);
	});

	it("a restore batch with a valid record followed by settling+released rejects atomically, installing neither identity", () => {
		const harness = createHarness();
		const { tracker } = harness;
		const valid = settlingRecord("VALID", { sessionEpoch: 1, admittedAt: 1 });
		const invalid = settlingRecord("INVALID", { released: true, admittedAt: 1 });

		expect(() => tracker.restore([valid, invalid])).toThrow(InvalidRestoreRecordError);
		expect(tracker.isSettling("VALID")).toBe(false);
		expect(tracker.outcome("VALID")).toBeUndefined();
		expect(tracker.outcome("INVALID")).toBeUndefined();
		expect(harness.persisted).toHaveLength(0);
		expect(harness.emitted).toHaveLength(0);
		// The valid record can still be restored cleanly afterwards.
		tracker.restore([valid]);
		expect(tracker.isSettling("VALID")).toBe(true);
	});

	it("restore over an already tracked identity is rejected atomically and never reopens a terminal prompt", async () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		harness.tracker.acquire(promptId, "run");
		harness.tracker.settleAll("cancelled", "session_disposed", { released: true });
		const before = harness.persisted.length;
		const beforeOutcome = harness.tracker.outcome(promptId);

		// A stale settling record must not reopen the terminal/released identity.
		const staleSettling = settlingRecord("P", { sessionEpoch: 1, admittedAt: 1 });
		expect(() => harness.tracker.restore([staleSettling])).toThrow(RestoreOverwriteError);
		expect(harness.tracker.outcome(promptId)).toBe(beforeOutcome);
		expect(harness.tracker.outcome(promptId)?.status).toBe("cancelled");
		expect(harness.tracker.isSettling(promptId)).toBe(false);
		expect(() => harness.tracker.acquire(promptId, "run")).toThrow(TerminalPromptAcquireError);
		expect(harness.persisted).toHaveLength(before);
		expect(harness.emitted).toHaveLength(1);
	});

	it("restore over an active identity is rejected atomically without dropping its lease or waiter", async () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		harness.tracker.recordFinalMessage(promptId, "M");
		const waiter = harness.tracker.waitForOutcome(promptId);

		// A restored settling record for the same id must not overwrite the live state.
		const stale = settlingRecord("P", { sessionEpoch: 1, admittedAt: 1, finalMessageIds: [] });
		expect(() => harness.tracker.restore([stale])).toThrow(RestoreOverwriteError);
		expect(harness.tracker.isSettling(promptId)).toBe(true);
		expect(harness.tracker.outcome(promptId)).toBeUndefined();

		// The original lease and waiter are intact and complete normally.
		lease.release();
		const outcome = await waiter;
		expect(outcome.status).toBe("completed");
		expect(outcome.finalMessageIds).toEqual(["M"]);
		expect(harness.tracker.outcome(promptId)).toBe(outcome);
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});
});

describe("PromptSettlementTracker persisted snapshot isolation", () => {
	it("persist receives references without cloning and each snapshot is a distinct immutable point-in-time record", () => {
		const retained: PromptSettlementRecord[] = [];
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				retained.push(record);
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 7 });
		const admission = retained[0];
		expect(admission.status).toBe("settling");
		expect(admission.finalMessageIds).toEqual([]);

		const lease = tracker.acquire(promptId, "run");
		tracker.recordFinalMessage(promptId, "M");
		lease.release();
		expect(retained).toHaveLength(2);
		const terminal = retained[1];

		// Distinct objects, not clones of the live record.
		expect(terminal).not.toBe(admission);
		expect(terminal.finalMessageIds).not.toBe(admission.finalMessageIds);

		// The admission snapshot stays settling even though the live record moved on.
		expect(admission.status).toBe("settling");
		expect(admission.finalMessageIds).toEqual([]);

		// Mutating an externally retained snapshot cannot affect the tracker.
		terminal.finalMessageIds.push("tampered");
		terminal.status = "cancelled";
		terminal.sessionEpoch = 999;
		admission.finalMessageIds.push("tampered");
		expect(tracker.outcome(promptId)?.status).toBe("completed");
		expect(tracker.outcome(promptId)?.finalMessageIds).toEqual(["M"]);
		expect(tracker.outcome(promptId)?.sessionEpoch).toBe(7);

		// A later released fence is yet another independent snapshot.
		tracker.release(promptId);
		expect(retained).toHaveLength(3);
		const released = retained[2];
		expect(released.released).toBe(true);
		expect(released).not.toBe(terminal);
		expect(terminal.released).toBe(false);
		released.finalMessageIds.push("tampered");
		expect(tracker.outcome(promptId)?.finalMessageIds).toEqual(["M"]);
		expect(tracker.snapshot()[0].finalMessageIds).toEqual(["M"]);
	});

	it("settleAll(...,{released:true}) snapshots are independent point-in-time records that external mutation cannot affect", () => {
		const retained: PromptSettlementRecord[] = [];
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				retained.push(record);
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 7 });
		const admission = retained[0];
		harness.now = 50;
		tracker.settleAll("cancelled", "session_disposed", { released: true });
		expect(retained).toHaveLength(2);
		const terminal = retained[1];

		// Admission snapshot stays settling/released-false; terminal is distinct and carries both fences.
		expect(admission.status).toBe("settling");
		expect(admission.released).toBe(false);
		expect(terminal.status).toBe("cancelled");
		expect(terminal.released).toBe(true);
		expect(terminal.settleReason).toBe("session_disposed");
		expect(terminal.settledAt).toBe(50);
		expect(terminal).not.toBe(admission);
		expect(terminal.finalMessageIds).not.toBe(admission.finalMessageIds);

		// External mutation of either snapshot cannot affect the tracker or the other snapshot.
		terminal.finalMessageIds.push("tampered");
		terminal.status = "failed";
		terminal.released = false;
		admission.finalMessageIds.push("tampered");
		expect(tracker.outcome(promptId)?.status).toBe("cancelled");
		expect(tracker.outcome(promptId)?.finalMessageIds).toEqual([]);
		expect(tracker.snapshot()[0].finalMessageIds).toEqual([]);
		expect(tracker.snapshot()[0].status).toBe("cancelled");
		expect(tracker.snapshot()[0].released).toBe(true);
	});
});

describe("PromptSettlementTracker callback reentrancy fence", () => {
	it("a same-id admit and restore inside the admit persist callback are both blocked; exactly one admission state results", () => {
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
				if (record.status === "settling") {
					// Reentrant same-id admission is deterministically blocked.
					expect(() => harness.tracker.admit({ promptId: "P", sessionEpoch: 2 })).toThrow(
						DuplicatePromptAdmissionError,
					);
					// Reentrant same-id restore is blocked too.
					expect(() => harness.tracker.restore([settlingRecord("P", { sessionEpoch: 9 })])).toThrow(
						RestoreOverwriteError,
					);
				}
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		expect(promptId).toBe("P");
		expect(tracker.isSettling("P")).toBe(true);
		expect(tracker.outcome("P")).toBeUndefined();
		expect(harness.persisted).toHaveLength(1); // exactly one admission record
		expect(harness.persisted[0].sessionEpoch).toBe(1);
		expect(harness.emitted).toHaveLength(0);
	});

	it("a callback-admitted different promptId during an admission stays independent and settles normally", () => {
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
				if (
					record.promptId === "P" &&
					record.status === "settling" &&
					!harness.persisted.some((r) => r.promptId === "Q")
				) {
					harness.tracker.admit({ promptId: "Q", sessionEpoch: 2 });
				}
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		tracker.admit({ promptId: "P", sessionEpoch: 1 });
		expect(tracker.isSettling("P")).toBe(true);
		expect(tracker.isSettling("Q")).toBe(true);
		expect(harness.persisted).toHaveLength(2);
	});

	it("last-lease persist callback acquire/mutations/same-lease release are blocked; terminal reflects the pre-callback candidate", async () => {
		const harness = createHarness();
		let callbackSaw: { acquireThrew: boolean; mutated: boolean; recursiveReleaseAttempts: number } | undefined;
		let innerWaiter: Promise<PromptOutcome> | undefined;
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
				if (record.status !== "settling") {
					const acquireThrew = (() => {
						try {
							harness.tracker.acquire("P", "run");
							return false;
						} catch {
							return true;
						}
					})();
					// Mutations and same-lease release are no-ops while busy.
					harness.tracker.recordFinalMessage("P", "late");
					harness.tracker.bumpTraceGeneration("P");
					harness.tracker.requestCancel("P");
					harness.tracker.recordFailure("P", "late_failure");
					leaseRef.release();
					leaseRef.release();
					// A waiter registered during a successful persist observes the
					// pre-commit (active) state and resolves when the transition commits.
					innerWaiter = harness.tracker.waitForOutcome("P");
					callbackSaw = { acquireThrew, mutated: true, recursiveReleaseAttempts: 2 };
				}
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const leaseRef = tracker.acquire(promptId, "run");
		tracker.recordFinalMessage(promptId, "M");
		const waiter = tracker.waitForOutcome(promptId);

		leaseRef.release();

		expect(callbackSaw?.acquireThrew).toBe(true);
		expect(callbackSaw?.recursiveReleaseAttempts).toBe(2);
		// The waiter registered inside the persist callback resolves too.
		const innerOutcome = await innerWaiter!;
		expect(innerOutcome).toBe(tracker.outcome(promptId));
		expect(innerOutcome.status).toBe("completed");
		// No extra lease, no extra persist, no double outcome.
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
		const outcome = await waiter;
		expect(outcome.status).toBe("completed");
		expect(outcome.finalMessageIds).toEqual(["M"]);
		expect(tracker.outcome(promptId)).toBe(outcome);
		// The terminal record reflects the pre-callback candidate: no late mutation landed.
		const record = lastRecord(harness, promptId);
		expect(record.status).toBe("completed");
		expect(record.finalMessageIds).toEqual(["M"]);
		expect(record.cancelRequested).toBe(false);
		expect("failureReason" in record).toBe(false);
		expect("settleReason" in record).toBe(false);
	});

	it("terminal tracker.release persist callback recursive release persists exactly once", () => {
		const harness = createHarness();
		let recursiveAttempts = 0;
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
				if (record.status !== "settling" && record.released) {
					recursiveAttempts += 1;
					harness.tracker.release("P");
				}
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		tracker.restore([terminalRecord("P", "completed", { admittedAt: 1, settledAt: 2 })]);
		expect(harness.persisted).toHaveLength(0);

		tracker.release("P");

		expect(recursiveAttempts).toBe(1); // the nested release was a no-op
		expect(harness.persisted).toHaveLength(1); // exactly one released record
		expect(harness.persisted[0].released).toBe(true);
	});

	it("settleAll callback on P1 cannot mutate or acquire the invocation-start sibling P2 before it commits", async () => {
		const harness = createHarness();
		let callbackTriedAcquireP2 = false;
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
				if (record.promptId === "P1" && record.status !== "settling" && !callbackTriedAcquireP2) {
					callbackTriedAcquireP2 = true;
					expect(() => harness.tracker.acquire("P2", "run")).toThrow(TerminalPromptAcquireError);
					harness.tracker.recordFinalMessage("P2", "late");
					harness.tracker.requestCancel("P2");
					harness.tracker.recordFailure("P2", "late_failure");
				}
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		tracker.acquire(p1, "run");
		tracker.acquire(p2, "run");
		tracker.recordFinalMessage(p1, "M1");
		tracker.recordFinalMessage(p2, "M2");
		const waiter2 = tracker.waitForOutcome(p2);

		tracker.settleAll("cancelled", "session_disposed", { released: true });

		expect(callbackTriedAcquireP2).toBe(true);
		// P2's terminal fields reflect the invocation-start state; the late mutation never landed.
		const record2 = lastRecord(harness, p2);
		expect(record2.status).toBe("cancelled");
		expect(record2.finalMessageIds).toEqual(["M2"]);
		expect(record2.cancelRequested).toBe(false);
		expect("failureReason" in record2).toBe(false);
		expect(record2.released).toBe(true);
		expect(record2.settleReason).toBe("session_disposed");
		expect(harness.persisted.filter((r) => r.promptId === p2)).toHaveLength(2);
		expect(harness.emitted.filter((o) => o.promptId === p2)).toHaveLength(1);
		const outcome2 = await waiter2;
		expect(outcome2.status).toBe("cancelled");
		expect(outcome2.finalMessageIds).toEqual(["M2"]);
		expect(tracker.outcome(p2)).toBe(outcome2);
	});
});

describe("PromptSettlementTracker persist failure retry", () => {
	it("one-shot admit persist failure leaves no identity; the same promptId can be admitted and settled after retry", async () => {
		let attempts = 0;
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("disk full");
				}
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		expect(() => tracker.admit({ promptId: "P", sessionEpoch: 1 })).toThrow("disk full");
		expect(tracker.isSettling("P")).toBe(false);
		expect(tracker.outcome("P")).toBeUndefined();
		expect(() => tracker.acquire("P", "run")).toThrow(UnknownPromptError);
		await expect(tracker.waitForOutcome("P")).rejects.toBeInstanceOf(UnknownPromptError);
		expect(harness.persisted).toHaveLength(0);
		expect(harness.emitted).toHaveLength(0);

		// Retry with the same promptId succeeds.
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		expect(promptId).toBe("P");
		const lease = tracker.acquire(promptId, "run");
		lease.release();
		expect(tracker.outcome(promptId)?.status).toBe("completed");
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});

	it("one-shot last-lease persist failure keeps the lease, waiters and intents; retrying the same release settles exactly once", async () => {
		let attempts = 0;
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				attempts += 1;
				if (attempts === 2) {
					throw new Error("disk full");
				}
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = tracker.acquire(promptId, "run");
		tracker.recordFinalMessage(promptId, "M");
		tracker.recordFailure(promptId, "run_error");
		const waiter = tracker.waitForOutcome(promptId);

		expect(() => lease.release()).toThrow("disk full");
		// The failed persist leaves the state active and the retry capability intact.
		expect(tracker.isSettling(promptId)).toBe(true);
		expect(tracker.outcome(promptId)).toBeUndefined();
		expect(harness.persisted).toHaveLength(1);
		expect(harness.emitted).toHaveLength(0);
		// The prompt stays active (lease retained), so new leases are still acquirable.
		expect(tracker.isSettling(promptId)).toBe(true);

		// Releasing the same lease again retries and completes exactly once.
		lease.release();
		const outcome = await waiter;
		expect(outcome.status).toBe("failed");
		expect(outcome.failure?.reason).toBe("run_error");
		expect(tracker.outcome(promptId)).toBe(outcome);
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);

		// Any further release is a no-op.
		lease.release();
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});

	it("one-shot terminal tracker.release persist failure stays terminal but unreleased and retryable", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = harness.tracker.acquire(promptId, "run");
		lease.release();

		let attempts = 0;
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("disk full");
				}
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		// Re-create the terminal state through restore (no persist/emit).
		harness.persisted = [];
		harness.emitted = [];
		harness.tracker.restore([terminalRecord("P", "completed", { admittedAt: 1, settledAt: 2 })]);
		expect(harness.persisted).toHaveLength(0);

		expect(() => harness.tracker.release("P")).toThrow("disk full");
		expect(harness.persisted).toHaveLength(0);
		expect(harness.tracker.outcome("P")?.status).toBe("completed");
		expect(harness.tracker.snapshot()[0].released).toBe(false);

		// Retry writes the released fence exactly once.
		harness.tracker.release("P");
		expect(harness.persisted).toHaveLength(1);
		expect(harness.persisted[0].released).toBe(true);
		harness.tracker.release("P"); // no-op
		expect(harness.persisted).toHaveLength(1);
	});

	it("settleAll persist failure on the second prompt keeps earlier items settled once and the rest active and retryable", async () => {
		let attempts = 0;
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				attempts += 1;
				// Attempts 1-3 are the three admissions, 4 is P1's settleAll
				// terminal persist, and 5 is P2's settleAll terminal persist,
				// which fails (the "second prompt" of the batch).
				if (attempts === 5) {
					throw new Error("disk full");
				}
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		const p3 = tracker.admit({ promptId: "P3", sessionEpoch: 3 });
		tracker.acquire(p1, "run");
		tracker.acquire(p2, "run");
		tracker.acquire(p3, "run");
		const waiter2 = tracker.waitForOutcome(p2);

		expect(() => tracker.settleAll("failed", "runtime_restarted")).toThrow("disk full");
		// P1 settled once; P2 (failing) and P3 stay active.
		expect(tracker.outcome(p1)?.status).toBe("failed");
		expect(tracker.outcome(p1)?.failure?.reason).toBe("runtime_restarted");
		expect(tracker.isSettling(p2)).toBe(true);
		expect(tracker.isSettling(p3)).toBe(true);
		expect(harness.persisted).toHaveLength(4); // 3 admissions + P1 terminal (P2's threw)
		expect(harness.emitted).toHaveLength(1); // only P1 emitted
		// P2's waiter stays pending through the failure (no reject, no resolve).
		let settled = false;
		void waiter2.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		// Retry closes the remaining prompts exactly once and leaves P1 untouched.
		tracker.settleAll("failed", "runtime_restarted");
		expect(tracker.outcome(p2)?.status).toBe("failed");
		expect(tracker.outcome(p3)?.status).toBe("failed");
		expect(harness.persisted.filter((r) => r.promptId === p1)).toHaveLength(2);
		expect(harness.persisted.filter((r) => r.promptId === p2)).toHaveLength(2);
		expect(harness.persisted.filter((r) => r.promptId === p3)).toHaveLength(2);
		expect(harness.emitted).toHaveLength(3);
		// P2's waiter now resolves with the cached terminal outcome.
		const outcome2 = await waiter2;
		expect(outcome2.status).toBe("failed");
		expect(outcome2.failure?.reason).toBe("runtime_restarted");
		expect(tracker.outcome(p2)).toBe(outcome2);
	});
});

describe("PromptSettlementTracker emit failure isolation", () => {
	it("a throwing emit after direct lease settlement still resolves waiters with the cached outcome", async () => {
		let emitCalls = 0;
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (_outcome) => {
				emitCalls += 1;
				throw new Error("observer down");
			},
		});
		const { tracker } = harness;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = tracker.acquire(promptId, "run");
		tracker.recordFinalMessage(promptId, "M");
		const waiter = tracker.waitForOutcome(promptId);

		lease.release();
		const outcome = await waiter;
		expect(outcome.status).toBe("completed");
		expect(outcome.finalMessageIds).toEqual(["M"]);
		expect(tracker.outcome(promptId)).toBe(outcome);
		expect(harness.persisted).toHaveLength(2);
		expect(emitCalls).toBe(1);
	});

	it("a throwing emit on the first of two settleAll prompts still settles both exactly once", async () => {
		let emitCalls = 0;
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (_outcome) => {
				emitCalls += 1;
				throw new Error("observer down");
			},
		});
		const { tracker } = harness;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		tracker.acquire(p1, "run");
		tracker.acquire(p2, "run");
		const waiter2 = tracker.waitForOutcome(p2);

		tracker.settleAll("cancelled", "session_disposed", { released: true });

		expect(tracker.outcome(p1)?.status).toBe("cancelled");
		expect(tracker.outcome(p2)?.status).toBe("cancelled");
		expect(harness.persisted).toHaveLength(4); // 2 admissions + 2 terminal
		expect(harness.persisted.filter((r) => r.promptId === p1)).toHaveLength(2);
		expect(harness.persisted.filter((r) => r.promptId === p2)).toHaveLength(2);
		expect(emitCalls).toBe(2);
		const outcome2 = await waiter2;
		expect(outcome2.status).toBe("cancelled");
		expect(tracker.outcome(p2)).toBe(outcome2);
	});
});

describe("PromptSettlementTracker settleAll reentrancy", () => {
	it("a prompt admitted by a persist or emit callback during settleAll stays active without the old settleReason", () => {
		let admittedDuring: string | undefined;
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
				if (record.status !== "settling" && !admittedDuring) {
					admittedDuring = harness.tracker.admit({ promptId: "NEW", sessionEpoch: 9 });
				}
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
			},
		});
		const { tracker } = harness;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		const p2 = tracker.admit({ promptId: "P2", sessionEpoch: 2 });
		tracker.acquire(p1, "run");
		tracker.acquire(p2, "run");

		tracker.settleAll("cancelled", "session_disposed", { released: true });

		expect(admittedDuring).toBe("NEW");
		// The new prompt is not part of the invocation-start batch.
		expect(tracker.isSettling("NEW")).toBe(true);
		expect(tracker.outcome("NEW")).toBeUndefined();
		expect("settleReason" in tracker.snapshot().find((r) => r.promptId === "NEW")!).toBe(false);
		expect(harness.emitted.filter((o) => o.promptId === "NEW")).toHaveLength(0);
		expect(harness.persisted.filter((r) => r.promptId === "NEW")).toHaveLength(1); // admission only

		// The original batch settled normally.
		expect(tracker.outcome(p1)?.status).toBe("cancelled");
		expect(tracker.outcome(p2)?.status).toBe("cancelled");
		expect(harness.emitted.filter((o) => o.promptId === "P1")).toHaveLength(1);
		expect(harness.emitted.filter((o) => o.promptId === "P2")).toHaveLength(1);
	});

	it("an emit callback that admits a prompt during settleAll also leaves the new prompt outside the batch", () => {
		const harness = createHarness();
		harness.tracker = new PromptSettlementTracker({
			now: () => harness.now,
			persist: (record) => {
				harness.persisted.push({ ...record, finalMessageIds: [...record.finalMessageIds] });
			},
			emit: (outcome) => {
				harness.emitted.push(outcome);
				harness.tracker.admit({ promptId: "FROM_EMIT", sessionEpoch: 9 });
			},
		});
		const { tracker } = harness;
		const p1 = tracker.admit({ promptId: "P1", sessionEpoch: 1 });
		tracker.acquire(p1, "run");

		tracker.settleAll("cancelled", "session_disposed");

		expect(tracker.isSettling("FROM_EMIT")).toBe(true);
		expect(tracker.outcome("FROM_EMIT")).toBeUndefined();
		expect("settleReason" in tracker.snapshot().find((r) => r.promptId === "FROM_EMIT")!).toBe(false);
		expect(tracker.outcome(p1)?.status).toBe("cancelled");
		// Both prompts emit exactly once: P1 via settleAll, FROM_EMIT not at all.
		expect(harness.emitted).toHaveLength(1);
	});
});

describe("PromptSettlementTracker restore-then-settleAll recovery", () => {
	it("restored terminal/released records are untouched by settleAll with no extra persist/emit and same outcome identity", async () => {
		const harness = createHarness();
		const { tracker } = harness;
		tracker.restore([
			terminalRecord("A", "completed", { admittedAt: 1, settledAt: 2 }),
			terminalRecord("B", "cancelled", {
				released: true,
				admittedAt: 1,
				settledAt: 2,
				settleReason: "session_disposed",
			}),
		]);
		const beforeA = tracker.outcome("A");
		const beforeB = tracker.outcome("B");

		tracker.settleAll("failed", "runtime_restarted", { released: true });

		expect(harness.persisted).toHaveLength(0);
		expect(harness.emitted).toHaveLength(0);
		expect(tracker.outcome("A")).toBe(beforeA);
		expect(tracker.outcome("B")).toBe(beforeB);
		expect(tracker.outcome("A")?.status).toBe("completed");
		expect(tracker.outcome("B")?.status).toBe("cancelled");
		expect(tracker.snapshot().find((r) => r.promptId === "A")?.released).toBe(false);
		expect(tracker.snapshot().find((r) => r.promptId === "B")?.released).toBe(true);
		await expect(tracker.waitForOutcome("A")).resolves.toBe(beforeA);
		await expect(tracker.waitForOutcome("B")).resolves.toBe(beforeB);
	});
});

describe("PendingUserQuestion shape (ask-user.md §3.1/§3.3)", () => {
	it("preserves the original ask shape: label/description/preview options, no synthetic ids", () => {
		const questions: PendingUserQuestion[] = [
			{
				toolCallId: "call_1",
				question: "Which runtime?",
				options: [
					{ label: "Node", description: "Fast startup" },
					{ label: "Python", preview: "**3.12**" },
					{ label: "Bun" },
				],
				recommended: 1,
			},
			{
				toolCallId: "call_2",
				question: "Anything else?",
				options: [],
				multi: true,
			},
		];

		// No model-generated option value or question id is invented by the type.
		expect(questions).toEqual([
			{
				toolCallId: "call_1",
				question: "Which runtime?",
				options: [
					{ label: "Node", description: "Fast startup" },
					{ label: "Python", preview: "**3.12**" },
					{ label: "Bun" },
				],
				recommended: 1,
			},
			{
				toolCallId: "call_2",
				question: "Anything else?",
				options: [],
				multi: true,
			},
		]);
		// Options keep their original order.
		expect(questions[0].options.map((o) => o.label)).toEqual(["Node", "Python", "Bun"]);
		// The exact shape survives a structured-clone round trip.
		const roundTripped = structuredClone(questions) as PendingUserQuestion[];
		expect(roundTripped).toEqual(questions);
	});
});

describe("PromptSettlementTracker settleAll failure precedence", () => {
	it("settleAll('failed', reason) overrides a prior recordFailure intent everywhere", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		tracker.acquire(promptId, "run");
		tracker.recordFailure(promptId, "run_error");

		harness.now = 30;
		tracker.settleAll("failed", "runtime_restarted");

		expect(tracker.outcome(promptId)?.status).toBe("failed");
		expect(tracker.outcome(promptId)?.failure?.reason).toBe("runtime_restarted");
		const record = lastRecord(harness, promptId);
		expect(record.failureReason).toBe("runtime_restarted");
		expect(record.settleReason).toBe("runtime_restarted");
		expect(record.settledAt).toBe(30);
		// Exactly one terminal persist and one emit for the prompt.
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});

	it("ordinary lease release still honors the recorded failure intent", () => {
		const harness = createHarness();
		const tracker = harness.tracker;
		const promptId = tracker.admit({ promptId: "P", sessionEpoch: 1 });
		const lease = tracker.acquire(promptId, "run");
		tracker.recordFailure(promptId, "run_error");
		lease.release();
		expect(tracker.outcome(promptId)?.failure?.reason).toBe("run_error");
		const record = lastRecord(harness, promptId);
		expect(record.failureReason).toBe("run_error");
		expect("settleReason" in record).toBe(false);
		expect(harness.persisted).toHaveLength(2);
		expect(harness.emitted).toHaveLength(1);
	});
});
