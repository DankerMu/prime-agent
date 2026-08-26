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
 * Persistence contract: every `deps.persist` call receives an independent
 * point-in-time snapshot of the ledger record that the tracker never mutates
 * and never aliases with live state. Live state is committed only after its
 * snapshot persists successfully, so a failed transition leaves the prior
 * state (including leases and waiters) retryable.
 *
 * Observer contract: a throwing `deps.emit` is isolated (consistent with
 * `AgentSession._emit`) and never prevents waiter delivery, terminal
 * visibility, or the settlement of the remaining `settleAll` batch.
 *
 * Reentrancy contract: callback code (`persist`/`emit`) runs synchronously
 * inside transitions, so a private reservation/busy fence reserves an
 * admission promptId before its persist callback and marks every identity
 * with a terminal/released transition in flight. Reentrant same-id admit/
 * restore, lease acquisition, record mutation, release, and settleAll are
 * deterministically blocked; a `settleAll` fences its whole invocation-start
 * eligible set so one prompt's callback cannot alter a sibling before its
 * commit. Fences are cleared in `finally` on success and failure alike, so
 * failed transitions stay retryable and queries/waiter registration keep
 * observing the pre-commit state.
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

export class InvalidRestoreRecordError extends Error {
	readonly code = "invalid_restore_record" as const;

	constructor(readonly promptId: string) {
		super(`invalid settlement record for prompt: ${promptId}`);
		this.name = "InvalidRestoreRecordError";
	}
}

export class RestoreOverwriteError extends Error {
	readonly code = "restore_overwrite" as const;

	constructor(readonly promptId: string) {
		super(`cannot restore over an already tracked prompt: ${promptId}`);
		this.name = "RestoreOverwriteError";
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
	/** promptIds with an admission persist in flight (reserved, not yet in `states`). */
	private readonly admissions = new Set<string>();
	/** promptIds with a terminal/released transition in flight (blocking reentrant mutation). */
	private readonly busy = new Set<string>();

	constructor(private readonly deps: PromptSettlementTrackerDeps) {}

	/** Admit a new prompt. Returns the (generated or supplied) promptId; throws on duplicate. */
	admit(input: { promptId?: string; sessionEpoch: number }): string {
		const promptId = input.promptId ?? randomUUID();
		if (this.states.has(promptId) || this.admissions.has(promptId)) {
			throw new DuplicatePromptAdmissionError(promptId);
		}
		// Reserve the identity before the `now()`/persist callbacks so a
		// reentrant same-id admit/restore is blocked; the reservation is
		// cleared on success and failure alike, keeping a failed admit
		// unknown/retryable.
		let record: PromptSettlementRecord;
		this.admissions.add(promptId);
		try {
			record = {
				promptId,
				status: "settling",
				sessionEpoch: input.sessionEpoch,
				traceGeneration: 0,
				finalMessageIds: [],
				cancelRequested: false,
				released: false,
				admittedAt: this.deps.now(),
			};
			// Persist an independent snapshot first; only on success does the
			// identity enter the live map so a failed admit stays retryable.
			this.deps.persist(this.cloneRecord(record));
		} finally {
			this.admissions.delete(promptId);
		}
		this.states.set(promptId, this.createState(record));
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
		// A prompt with a terminal/released transition in flight cannot take
		// new work; the terminal commit follows the pre-callback candidate.
		if (!this.isActive(state) || this.busy.has(promptId)) {
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

	/** Append an assistant entry id to the prompt's final message list (no-op after terminal or during a pending transition). */
	recordFinalMessage(promptId: string, entryId: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state) || this.busy.has(promptId)) {
			return;
		}
		state.record.finalMessageIds.push(entryId);
	}

	/** Increment the trace generation counter (no-op after terminal or during a pending transition). */
	bumpTraceGeneration(promptId: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state) || this.busy.has(promptId)) {
			return;
		}
		state.record.traceGeneration += 1;
	}

	/** Abort fence; idempotent, wins over a recorded failure at settlement. */
	requestCancel(promptId: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state) || this.busy.has(promptId)) {
			return;
		}
		state.record.cancelRequested = true;
	}

	/** Failure intent; idempotent, superseded by a cancel fence. */
	recordFailure(promptId: string, reason: string): void {
		const state = this.states.get(promptId);
		if (!state || !this.isActive(state) || this.busy.has(promptId)) {
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
		if (!state || this.isActive(state) || state.record.released || this.busy.has(promptId)) {
			return;
		}
		const next = this.cloneRecord(state.record);
		next.released = true;
		// Mark the transition busy so a reentrant release of the same prompt
		// cannot double-persist; cleared on success and failure alike, so a
		// failure stays terminal-but-unreleased and retryable.
		this.busy.add(promptId);
		try {
			// Persist an independent released snapshot before committing it; a
			// failure leaves the record terminal but unreleased and retryable.
			this.deps.persist(this.cloneRecord(next));
		} finally {
			this.busy.delete(promptId);
		}
		state.record = next;
	}

	/**
	 * Atomically settle every prompt that is active and non-released at
	 * invocation start with the given status/reason. The reason always lands
	 * in the ledger `settleReason`; when `options.released` is set, the
	 * released fence is written in the same persist. For `failed`, the
	 * supplied reason is authoritative and fills
	 * `outcome.failure`/`failureReason` even if `recordFailure` stored a
	 * different intent. Idempotent: repeated calls affect nothing. Prompts
	 * admitted (or restored) by a persist/emit callback during the batch are
	 * not part of the invocation-start eligible set and stay active.
	 */
	settleAll(status: "cancelled" | "failed", reason: string, options?: { released?: boolean }): void {
		// Busy identities are excluded so a reentrant settleAll inside a batch
		// sees an empty eligible set instead of double-settling pending prompts.
		const eligible = [...this.states.values()].filter(
			(state) => this.isActive(state) && !this.busy.has(state.record.promptId),
		);
		if (eligible.length === 0) {
			return;
		}
		// Fence the whole invocation-start eligible set for the duration of
		// the batch so a callback for one prompt cannot mutate or acquire a
		// sibling before its own commit. Cleared in `finally` even on a
		// persist failure, preserving the already successful partial progress.
		for (const state of eligible) {
			this.busy.add(state.record.promptId);
		}
		try {
			for (const state of eligible) {
				const { record: next, outcome } = this.buildTerminal(
					state.record,
					status === "failed" ? reason : undefined,
					status,
					reason,
				);
				if (options?.released) {
					next.released = true;
				}
				this.persistAndCommit(state, next, outcome);
				this.emitOutcome(state);
			}
		} finally {
			for (const state of eligible) {
				this.busy.delete(state.record.promptId);
			}
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
		// A known but non-active prompt has no terminal outcome and could
		// never discharge a waiter; reject instead of leaking a pending one.
		if (!this.isActive(state)) {
			return Promise.reject(new UnknownPromptError(promptId));
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
	 * Restore records. On an empty tracker the last record per promptId wins;
	 * active (settling, not released) records can be re-acquired and settled
	 * again, terminal/released records are immutable and queryable. No
	 * persist/emit is made and no live leases are restored.
	 *
	 * The whole batch is validated before any mutation: a structurally
	 * invalid record (`status:"settling"` combined with `released:true`)
	 * rejects the batch atomically, and any promptId already tracked rejects
	 * rather than overwriting an identity that may hold leases, waiters, or a
	 * terminal outcome.
	 */
	restore(records: PromptSettlementRecord[]): void {
		const latest = new Map<string, PromptSettlementRecord>();
		for (const record of records) {
			if (record.status === "settling" && record.released) {
				throw new InvalidRestoreRecordError(record.promptId);
			}
			latest.set(record.promptId, record);
		}
		// A reserved (admission in flight) or busy (terminal transition in
		// flight) identity is also untouchable by restore.
		const rejected = [...latest.keys()].filter(
			(promptId) => this.states.has(promptId) || this.admissions.has(promptId) || this.busy.has(promptId),
		);
		if (rejected.length > 0) {
			throw new RestoreOverwriteError(rejected[0]);
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
		// A busy identity (terminal transition in flight) cannot re-release.
		if (!state || !this.isActive(state) || this.busy.has(lease.promptId)) {
			return;
		}
		const index = state.leases.indexOf(lease);
		if (index < 0) {
			return;
		}
		if (state.leases.length > 1) {
			state.leases.splice(index, 1);
			return;
		}
		// Last lease: derive the terminal transition against a snapshot of
		// the live record. Persist it first; only on success is the lease
		// removed and the terminal record/outcome committed, so a failed
		// persist leaves the same lease retryable with waiters/intents intact.
		// The identity is marked busy for the persist so a reentrant acquire,
		// mutation, or same-lease release cannot diverge from the candidate or
		// double-persist; cleared in `finally` on success and failure alike.
		this.busy.add(state.record.promptId);
		try {
			const status = state.record.cancelRequested
				? "cancelled"
				: state.failureReason !== undefined
					? "failed"
					: "completed";
			const { record: next, outcome } = this.buildTerminal(state.record, state.failureReason, status);
			this.persistAndCommit(state, next, outcome);
			state.leases.splice(index, 1);
		} finally {
			this.busy.delete(state.record.promptId);
		}
		this.emitOutcome(state);
	}

	/**
	 * Persist an independent point-in-time snapshot of the candidate terminal
	 * record, then commit the candidate (a distinct object) as live state.
	 * The cached terminal outcome identity is preserved for emit/query/wait.
	 */
	private persistAndCommit(state: InternalPromptState, next: PromptSettlementRecord, outcome: PromptOutcome): void {
		this.deps.persist(this.cloneRecord(next));
		state.record = next;
		state.outcome = outcome;
	}

	/** Derive the terminal record and outcome without mutating live state. */
	private buildTerminal(
		record: PromptSettlementRecord,
		failureReason: string | undefined,
		status: "completed" | "failed" | "cancelled",
		settleReason?: string,
	): { record: PromptSettlementRecord; outcome: PromptOutcome } {
		const next = this.cloneRecord(record);
		next.status = status;
		if (settleReason !== undefined) {
			next.settleReason = settleReason;
		}
		next.settledAt = this.deps.now();
		const outcome: PromptOutcome = {
			promptId: next.promptId,
			status,
			advisor: "disabled",
			finalMessageIds: [...next.finalMessageIds],
			sessionEpoch: next.sessionEpoch,
			traceGeneration: next.traceGeneration,
		};
		if (status === "failed") {
			const reason = failureReason ?? settleReason ?? "run_error";
			outcome.failure = { reason };
			next.failureReason = reason;
		}
		return { record: next, outcome };
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
		// An observer failure is isolated: it must not prevent waiter
		// delivery or, in settleAll, the settlement of sibling prompts.
		try {
			this.deps.emit(outcome);
		} catch {
			// A failing observer must not block terminal visibility or the
			// rest of the batch (consistent with AgentSession._emit).
		}
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
