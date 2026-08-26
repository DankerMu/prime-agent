import { describe, expect, it } from "vitest";
import {
	DuplicatePromptAdmissionError,
	type PendingUserQuestion,
	type PromptOutcome,
	type PromptSettlementRecord,
	PromptSettlementTracker,
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
		const settling: PromptSettlementRecord = {
			promptId: "P",
			status: "settling",
			sessionEpoch: 1,
			traceGeneration: 0,
			finalMessageIds: [],
			cancelRequested: false,
			released: false,
			admittedAt: 1,
		};
		const terminal: PromptSettlementRecord = {
			promptId: "P",
			status: "cancelled",
			sessionEpoch: 1,
			traceGeneration: 0,
			finalMessageIds: [],
			cancelRequested: true,
			released: false,
			admittedAt: 1,
			settledAt: 2,
			settleReason: "session_disposed",
		};
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
		const terminal: PromptSettlementRecord = {
			promptId: "P",
			status: "failed",
			sessionEpoch: 3,
			traceGeneration: 1,
			finalMessageIds: ["M"],
			cancelRequested: false,
			failureReason: "run_error",
			released: true,
			admittedAt: 1,
			settledAt: 2,
		};
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
		const settling: PromptSettlementRecord = {
			promptId: "P",
			status: "settling",
			sessionEpoch: 5,
			traceGeneration: 0,
			finalMessageIds: [],
			cancelRequested: false,
			released: false,
			admittedAt: 1,
		};
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

	it("restore of a released settling record stays inert (no lease, no settle)", () => {
		const harness = createHarness();
		const { tracker } = harness;
		const releasedSettling: PromptSettlementRecord = {
			promptId: "P",
			status: "settling",
			sessionEpoch: 5,
			traceGeneration: 0,
			finalMessageIds: [],
			cancelRequested: false,
			released: true,
			admittedAt: 1,
		};
		tracker.restore([releasedSettling]);
		expect(tracker.isSettling("P")).toBe(false);
		expect(tracker.outcome("P")).toBeUndefined();
		expect(() => tracker.acquire("P", "run")).toThrow(TerminalPromptAcquireError);
		expect(harness.persisted).toHaveLength(0);
		expect(harness.emitted).toHaveLength(0);
	});

	it("restore does not affect prompts already tracked unless the records replace them", () => {
		const harness = createHarness();
		const promptId = harness.tracker.admit({ promptId: "P", sessionEpoch: 1 });
		harness.tracker.acquire(promptId, "run");
		harness.tracker.settleAll("cancelled", "session_disposed", { released: true });
		const before = harness.persisted.length;

		const staleSettling: PromptSettlementRecord = {
			promptId: "P",
			status: "settling",
			sessionEpoch: 1,
			traceGeneration: 0,
			finalMessageIds: [],
			cancelRequested: false,
			released: false,
			admittedAt: 1,
		};
		harness.tracker.restore([staleSettling]);
		expect(harness.persisted).toHaveLength(before);
		expect(harness.tracker.outcome(promptId)).toBeUndefined();
		expect(harness.tracker.isSettling(promptId)).toBe(true);
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
