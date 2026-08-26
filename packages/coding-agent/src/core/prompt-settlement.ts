import { randomUUID } from "node:crypto";

/**
 * Settlement tracker for session-level prompt outcomes (slice 1).
 *
 * A prompt is admitted once (`admit`) and stays `settling` until the last
 * owned-work lease (`acquire`/`release`) is released. At that synchronous
 * 1 -> 0 boundary the terminal outcome is derived once with
 * cancel > failure > completed precedence. Terminal and released states never
 * reopen; `settleAll` and `release(promptId)` are the only paths that write
 * the released fence, atomically with (or after) the terminal record.
 *
 * This slice never produces `needs_user_input`/`unresolved_advisor` and
 * `advisor` is always `"disabled"`; `pendingQuestions` is never populated.
 */

export type PromptOutcomeStatus = "completed" | "needs_user_input" | "unresolved_advisor" | "failed" | "cancelled";
export type PromptAdvisorState = "passed" | "fail_open" | "unresolved" | "disabled" | "pending";

export interface PendingUserQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface PendingUserQuestion {
	toolCallId: string;
	question: string;
	options: PendingUserQuestionOption[];
	multi?: boolean;
	recommended?: number;
}

export interface PromptOutcome {
	promptId: string;
	status: PromptOutcomeStatus;
	advisor: PromptAdvisorState;
	finalMessageIds: string[];
	pendingQuestions?: PendingUserQuestion[];
	sessionEpoch: number;
	traceGeneration: number;
	failure?: { reason: string };
}

export type PromptLeaseKind = "run" | "retry" | "compaction_continuation";

export interface PromptLease {
	readonly promptId: string;
	readonly kind: PromptLeaseKind;
	release(): void;
}

export interface PromptSettlementRecord {
	promptId: string;
	status: "settling" | PromptOutcomeStatus;
	sessionEpoch: number;
	traceGeneration: number;
	finalMessageIds: string[];
	cancelRequested: boolean;
	failureReason?: string;
	settleReason?: string;
	released: boolean;
	admittedAt: number;
	settledAt?: number;
}

export interface PromptSettlementTrackerDeps {
	now(): number;
	emit(outcome: PromptOutcome): void;
	persist(record: PromptSettlementRecord): void;
}

export class DuplicatePromptAdmissionError extends Error {
	readonly code = "duplicate_prompt_admission" as const;

	constructor(readonly promptId: string) {
		super(`prompt already admitted: ${promptId}`);
		this.name = "DuplicatePromptAdmissionError";
	}
}

export class TerminalPromptAcquireError extends Error {
	readonly code = "terminal_prompt_acquire" as const;

	constructor(readonly promptId: string) {
		super(`cannot acquire a lease on terminal prompt: ${promptId}`);
		this.name = "TerminalPromptAcquireError";
	}
}

export class UnknownPromptError extends Error {
	readonly code = "unknown_prompt" as const;

	constructor(readonly promptId: string) {
		super(`unknown prompt: ${promptId}`);
		this.name = "UnknownPromptError";
	}
}

interface InternalPromptState {
	record: PromptSettlementRecord;
	/** Recorded failure intent; only materialized onto the record when the terminal status is failed. */
	failureReason?: string;
	leases: PromptLease[];
	outcome?: PromptOutcome;
	waiters: Array<(outcome: PromptOutcome) => void>;
}

export class PromptSettlementTracker {
	private readonly states = new Map<string, InternalPromptState>();

	constructor(private readonly deps: PromptSettlementTrackerDeps) {}

	/** Admit a new prompt. Returns the (generated or supplied) promptId; throws on duplicate. */
	admit(input: { promptId?: string; sessionEpoch: number }): string {
		const promptId = input.promptId ?? randomUUID();
		if (this.states.has(promptId)) {
			throw new DuplicatePromptAdmissionError(promptId);
		}
		const record: PromptSettlementRecord = {
			promptId,
			status: "settling",
			sessionEpoch: input.sessionEpoch,
			traceGeneration: 0,
			finalMessageIds: [],
			cancelRequested: false,
			released: false,
			admittedAt: this.deps.now(),
		};
		this.states.set(promptId, this.createState(record));
		this.deps.persist(record);
		return promptId;
	}

	/**
	 * Acquire an independent lease instance for the prompt. Any number of
	 * leases (same or different kind) may coexist; each is counted separately.
	 * Throws once the prompt is terminal or released.
	 */
	acquire(promptId: string, kind: PromptLeaseKind): PromptLease {
		const state = this.states.get(promptId);
		if (!state) {
			throw new UnknownPromptError(promptId);
		}
		if (!this.isActive(state)) {
			throw new TerminalPromptAcquireError(promptId);
		}
		const lease: PromptLease = {
			promptId,
			kind,
			release: () => {
				this.releaseLease(lease);
			},
		};
		state.leases.push(lease);
		return lease;
	}

	/** Append an assistant entry id to the prompt's final message list (no-op after terminal). */
	recordFinalMessage(promptId: string, entryId: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state)) {
			return;
		}
		state.record.finalMessageIds.push(entryId);
	}

	/** Increment the trace generation counter (no-op after terminal). */
	bumpTraceGeneration(promptId: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state)) {
			return;
		}
		state.record.traceGeneration += 1;
	}

	/** Abort fence; idempotent, wins over a recorded failure at settlement. */
	requestCancel(promptId: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state)) {
			return;
		}
		state.record.cancelRequested = true;
	}

	/** Failure intent; idempotent, superseded by a cancel fence. */
	recordFailure(promptId: string, reason: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state)) {
			return;
		}
		state.failureReason = reason;
	}

	/**
	 * Released fence for an already-terminal record. Persists the changed
	 * terminal record exactly once; active/unknown prompts are no-ops. Never
	 * settles, never emits, idempotent.
	 */
	release(promptId: string): void {
		const state = this.states.get(promptId);
		if (!state || this.isActive(state) || state.record.released) {
			return;
		}
		state.record.released = true;
		this.deps.persist(state.record);
	}

	/**
	 * Atomically settle every active, non-released prompt with the given
	 * status/reason. The reason always lands in the ledger `settleReason`;
	 * when `options.released` is set, the released fence is written in the
	 * same persist. For `failed`, the supplied reason is authoritative and
	 * fills `outcome.failure`/`failureReason` even if `recordFailure` stored
	 * a different intent. Idempotent: repeated calls affect nothing.
	 */
	settleAll(status: "cancelled" | "failed", reason: string, options?: { released?: boolean }): void {
		for (const state of this.states.values()) {
			if (!this.isActive(state)) {
				continue;
			}
			this.settleTerminal(state, status, reason);
			if (status === "failed") {
				// settleAll's explicit reason is authoritative over any prior
				// recordFailure intent (persistence spec: failureReason === settleReason).
				state.record.failureReason = reason;
				state.outcome!.failure = { reason };
			}
			state.record.settledAt = this.deps.now();
			if (options?.released) {
				state.record.released = true;
			}
			this.deps.persist(state.record);
			this.emitOutcome(state);
		}
	}

	/** Synchronous terminal outcome for the prompt, or undefined when unknown or still settling. */
	outcome(promptId: string): PromptOutcome | undefined {
		return this.states.get(promptId)?.outcome;
	}

	/** Resolve with the terminal outcome; rejects for unknown prompts. */
	waitForOutcome(promptId: string): Promise<PromptOutcome> {
		const state = this.states.get(promptId);
		if (!state) {
			return Promise.reject(new UnknownPromptError(promptId));
		}
		if (state.outcome) {
			return Promise.resolve(state.outcome);
		}
		return new Promise<PromptOutcome>((resolve) => {
			state.waiters.push(resolve);
		});
	}

	/** True only while the prompt is admitted, still settling, and not released. */
	isSettling(promptId: string): boolean {
		const state = this.states.get(promptId);
		return !!state && this.isActive(state);
	}

	/** Deep-copy snapshot of the current records (for persistence/recovery). */
	snapshot(): PromptSettlementRecord[] {
		return [...this.states.values()].map((state) => this.cloneRecord(state.record));
	}

	/**
	 * Restore records. The last record per promptId wins; no persist/emit is
	 * made and no live leases are restored. Active (settling, not released)
	 * records can be re-acquired and settled again; terminal/released records
	 * are immutable and queryable.
	 */
	restore(records: PromptSettlementRecord[]): void {
		const latest = new Map<string, PromptSettlementRecord>();
		for (const record of records) {
			latest.set(record.promptId, record);
		}
		for (const [promptId, record] of latest) {
			const cloned = this.cloneRecord(record);
			const state = this.createState(cloned);
			state.outcome = this.terminalOutcomeFromRecord(cloned);
			this.states.set(promptId, state);
		}
	}

	private releaseLease(lease: PromptLease): void {
		const state = this.states.get(lease.promptId);
		if (!state || !this.isActive(state)) {
			return;
		}
		const index = state.leases.indexOf(lease);
		if (index < 0) {
			return;
		}
		state.leases.splice(index, 1);
		if (state.leases.length > 0) {
			return;
		}
		const status = state.record.cancelRequested
			? "cancelled"
			: state.failureReason !== undefined
				? "failed"
				: "completed";
		this.settleTerminal(state, status);
		state.record.settledAt = this.deps.now();
		this.deps.persist(state.record);
		this.emitOutcome(state);
	}

	private settleTerminal(
		state: InternalPromptState,
		status: "completed" | "failed" | "cancelled",
		settleReason?: string,
	): void {
		state.record.status = status;
		if (settleReason !== undefined) {
			state.record.settleReason = settleReason;
		}
		const outcome: PromptOutcome = {
			promptId: state.record.promptId,
			status,
			advisor: "disabled",
			finalMessageIds: [...state.record.finalMessageIds],
			sessionEpoch: state.record.sessionEpoch,
			traceGeneration: state.record.traceGeneration,
		};
		if (status === "failed") {
			const reason = state.failureReason ?? settleReason ?? "run_error";
			outcome.failure = { reason };
			state.record.failureReason = reason;
		}
		state.outcome = outcome;
	}

	private terminalOutcomeFromRecord(record: PromptSettlementRecord): PromptOutcome | undefined {
		if (record.status === "settling") {
			return undefined;
		}
		const outcome: PromptOutcome = {
			promptId: record.promptId,
			status: record.status,
			advisor: "disabled",
			finalMessageIds: [...record.finalMessageIds],
			sessionEpoch: record.sessionEpoch,
			traceGeneration: record.traceGeneration,
		};
		if (record.status === "failed") {
			outcome.failure = { reason: record.failureReason ?? "run_error" };
		}
		return outcome;
	}

	private emitOutcome(state: InternalPromptState): void {
		if (!state.outcome) {
			return;
		}
		const outcome = state.outcome;
		this.deps.emit(outcome);
		for (const resolve of state.waiters.splice(0)) {
			resolve(outcome);
		}
	}

	private isActive(state: InternalPromptState): boolean {
		return state.record.status === "settling" && !state.record.released;
	}

	private createState(record: PromptSettlementRecord): InternalPromptState {
		return { record, failureReason: record.failureReason, leases: [], waiters: [] };
	}

	private cloneRecord(record: PromptSettlementRecord): PromptSettlementRecord {
		return {
			...record,
			finalMessageIds: [...record.finalMessageIds],
		};
	}
}
