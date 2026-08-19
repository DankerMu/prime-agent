import type { Component } from "@earendil-works/pi-tui";

type DialogComponent = Component & { dispose?(): void };

type DialogKind = "extension" | "app" | "placeholder";

interface DialogRequest<T> {
	show(
		done: (value: T) => void,
	): { component: DialogComponent; focus: Component } | Promise<{ component: DialogComponent; focus: Component }>;
	kind: DialogKind;
	signal?: AbortSignal;
	cancel?(): T;
	onEvict?(): void;
}

interface DialogHandle<T> {
	result: Promise<T>;
	settle(value: T): void;
}

interface DialogArbiterHost {
	replaceEditorSurface(component?: Component): void;
	setFocus(component: Component | null): void;
	requestRender(): void;
	getCurrentEditor(): Component;
}

interface Mounted {
	component: DialogComponent;
	focus: Component;
}

type MountedCleanupPhase = "dispose" | "clear" | "focus" | "render" | "done";

// In-progress mounted cleanup phase machine. `next` is advanced to the
// following phase before each external callback so a reentrant terminal drain
// resumes after the callback currently on stack, never re-invoking it.
interface MountedCleanup {
	component: DialogComponent;
	next: MountedCleanupPhase;
}

type Outcome = { kind: "value"; value: unknown } | { kind: "error"; error: unknown };

interface RequestEntry {
	request: DialogRequest<unknown>;
	result: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	settled: boolean;
	abortListener: (() => void) | undefined;
}

// Bounded restoration passes per episode: an editor replacement reentrant from
// every host callback cannot be chased forever, so after this many passes the
// arbiter fails closed to a blank/null surface and stays busy.
const MAX_RESTORE_PASSES = 8;

function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

function isPromiseLike(value: unknown): value is Promise<Mounted> {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

export class DialogArbiter {
	private readonly host: DialogArbiterHost;
	private queue: RequestEntry[] = [];
	private current: RequestEntry | undefined;
	private mounted: DialogComponent | undefined;
	private mountedCleanup: MountedCleanup | undefined;
	// Editor restoration is pending: set from any visible/stale clear until a
	// mounted dialog or a converged editor restore replaces the surface.
	private editorRestorePending = false;
	// Identity the editor surface still holds while no dialog is mounted. Used
	// only to detect at handoff time that the preserved surface became stale;
	// every restore target is a fresh getCurrentEditor(), never this identity.
	private preservedEditor: Component | undefined;
	// True from scheduling through queue handoff or the entire restoration
	// episode; cleared only after a post-callback identity check converges or a
	// successor becomes current.
	private handoffPending = false;
	private settling = false;
	private disposed = false;

	constructor(host: DialogArbiterHost) {
		this.host = host;
	}

	present<T>(request: DialogRequest<T>): DialogHandle<T> {
		const entry = this.createEntry(request);
		const handle: DialogHandle<T> = {
			result: entry.result as Promise<T>,
			settle: (value) => this.settleEntry(entry, { kind: "value", value }),
		};
		if (this.disposed) {
			this.settleEntry(entry, this.cancelOutcome(entry));
			return handle;
		}
		if (request.signal?.aborted) {
			this.settleEntry(entry, { kind: "error", error: abortError() });
			return handle;
		}
		this.attachAbortListener(entry);
		// An active mounted cleanup owns the arbiter just like a settlement does:
		// a request presented from its callbacks must stay queued until the
		// cleanup's clear/focus-null/render completes. The settling guard alone
		// is insufficient because the mounted cleanup phase machine runs outside
		// any single settleEntry frame.
		if (
			this.settling ||
			this.mountedCleanup !== undefined ||
			this.current !== undefined ||
			this.queue.length > 0 ||
			this.handoffPending
		) {
			this.queue.push(entry);
		} else {
			this.current = entry;
			this.preservedEditor = this.host.getCurrentEditor();
			this.startConstructing(entry);
		}
		return handle;
	}

	cancelKind(kind: DialogKind): void {
		if (this.disposed) return;
		if (this.current && this.current.request.kind === kind && !this.current.settled) {
			this.settleEntry(this.current, this.cancelOutcome(this.current));
		}
		for (const entry of [...this.queue]) {
			if (entry.request.kind === kind && !entry.settled) {
				this.settleEntry(entry, this.cancelOutcome(entry));
			}
		}
	}

	disposeAll(): void {
		if (this.disposed) {
			// Already terminal: a mounted cleanup may be mid-flight on this stack.
			// Drain it before returning so every nested invocation returns only
			// after the active cleanup reaches done.
			this.drainMountedCleanup();
			return;
		}
		this.disposed = true;
		// Finish an interrupted mounted cleanup before queued cancellation
		// begins, preserving current-before-queue ownership order. cleanupCurrent
		// drains any newly created cleanup synchronously itself, so no later
		// drain is needed once current and queue settle.
		this.drainMountedCleanup();
		if (this.current && !this.current.settled) {
			this.settleEntry(this.current, this.cancelOutcome(this.current));
		}
		for (const entry of [...this.queue]) {
			if (!entry.settled) {
				this.settleEntry(entry, this.cancelOutcome(entry));
			}
		}
		this.queue = [];
		this.preservedEditor = undefined;
		this.editorRestorePending = false;
		this.handoffPending = false;
	}

	isBusy(): boolean {
		return (
			this.disposed ||
			this.settling ||
			// Defensive ownership: an active mounted cleanup owns the arbiter even
			// if a reentrant settle cleared the settling flag (see settleEntry).
			this.mountedCleanup !== undefined ||
			this.current !== undefined ||
			this.queue.length > 0 ||
			this.handoffPending ||
			this.editorRestorePending
		);
	}

	private createEntry<T>(request: DialogRequest<T>): RequestEntry {
		let resolve!: (value: unknown) => void;
		let reject!: (error: unknown) => void;
		const result = new Promise<unknown>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		void result.catch(() => {});
		return { request, result, resolve, reject, settled: false, abortListener: undefined };
	}

	private attachAbortListener(entry: RequestEntry): void {
		const signal = entry.request.signal;
		if (!signal || signal.aborted) return;
		const listener = () => {
			this.settleEntry(entry, { kind: "error", error: abortError() });
		};
		entry.abortListener = listener;
		signal.addEventListener("abort", listener, { once: true });
	}

	private removeAbortListener(entry: RequestEntry): void {
		if (!entry.abortListener) return;
		entry.request.signal?.removeEventListener("abort", entry.abortListener);
		entry.abortListener = undefined;
	}

	private settleEntry(entry: RequestEntry, outcome: Outcome): void {
		if (entry.settled) return;
		entry.settled = true;
		this.removeAbortListener(entry);
		// A settlement episode owns the arbiter until its outermost settleEntry
		// finishes: a nested settlement (e.g. a signal abort raised from a cleanup
		// callback) must not clear the outer guard, or a subsequent reentrant
		// present could construct synchronously inside the cleanup.
		const wasSettling = this.settling;
		this.settling = true;
		try {
			if (this.current === entry) {
				this.current = undefined;
				this.cleanupCurrent(entry);
				this.scheduleHandoff();
			} else {
				const index = this.queue.indexOf(entry);
				if (index !== -1) this.queue.splice(index, 1);
				this.callOnEvict(entry);
				// A reentrant present from the cleanup hook queued a request while
				// the arbiter is idle; without a handoff it would stall forever.
				if (!this.disposed && this.current === undefined && this.queue.length > 0 && !this.handoffPending) {
					this.scheduleHandoff();
				}
			}
		} finally {
			this.settling = wasSettling;
		}
		this.settleResult(entry, outcome);
	}

	private cleanupCurrent(entry: RequestEntry): void {
		if (this.mounted) {
			const component = this.mounted;
			this.mounted = undefined;
			this.mountedCleanup = { component, next: "dispose" };
			this.drainMountedCleanup();
			// Only a still-live arbiter arms editor restoration; a reentrant
			// terminal disposeAll drains to done and keeps the state cleared.
			if (!this.disposed) this.editorRestorePending = true;
		} else {
			this.callOnEvict(entry);
			// The preserved editor surface stays in place until the handoff decides
			// whether it is still the current editor; the identity comparison runs
			// at handoff time so an editor replacement during the handoff window is
			// still detected.
		}
	}

	// Cleanup-ownership containment: runs one host surface/focus/render callback
	// so a throw never changes the already-chosen outcome or stops the remaining
	// phases of the current mounted-cleanup / stale-clear / restore / fail-closed
	// pass. present() never throws here and no handoff microtask may become an
	// unhandled exception.
	private runCleanupCallback(callback: () => void): void {
		try {
			callback();
		} catch {
			/* cleanup errors never change the result or block the queue */
		}
	}

	private drainMountedCleanup(): void {
		const cleanup = this.mountedCleanup;
		if (!cleanup) return;
		while (this.mountedCleanup === cleanup) {
			switch (cleanup.next) {
				case "dispose":
					cleanup.next = "clear";
					this.disposeComponent(cleanup.component);
					break;
				case "clear":
					cleanup.next = "focus";
					// Host surface-clear is cleanup ownership: a throw is contained
					// per phase and must not change the already-chosen outcome or
					// stop the remaining phases/queue handoff.
					this.runCleanupCallback(() => this.host.replaceEditorSurface(undefined));
					break;
				case "focus":
					cleanup.next = "render";
					// Same containment for the focus-null setter: a throwing
					// focusable component must not break the cleanup phase machine.
					this.runCleanupCallback(() => this.host.setFocus(null));
					break;
				case "render":
					cleanup.next = "done";
					this.runCleanupCallback(() => this.host.requestRender());
					break;
				case "done":
					this.mountedCleanup = undefined;
					return;
			}
		}
	}

	private settleResult(entry: RequestEntry, outcome: Outcome): void {
		if (outcome.kind === "value") {
			entry.resolve(outcome.value);
		} else {
			entry.reject(outcome.error);
		}
	}

	private callOnEvict(entry: RequestEntry): void {
		try {
			entry.request.onEvict?.();
		} catch {
			/* cleanup hook errors never change the result or block the queue */
		}
	}

	private disposeComponent(component: DialogComponent): void {
		try {
			component.dispose?.();
		} catch {
			/* cleanup errors never change the result or block the queue */
		}
	}

	private scheduleHandoff(): void {
		if (this.disposed || this.handoffPending) return;
		this.handoffPending = true;
		queueMicrotask(() => this.runHandoff(0));
	}

	private runHandoff(pass: number): void {
		if (this.disposed) {
			this.handoffPending = false;
			return;
		}

		const next = this.queue.find((entry) => !entry.settled);
		if (next) {
			if (this.isStalePreserved()) {
				this.preservedEditor = undefined;
				// Stale-clear is cleanup ownership, same as mounted cleanup: each
				// host callback throw is contained per phase and never changes the
				// already-chosen handoff, so the successor below still constructs
				// (or restoration/idle still runs if the queue emptied inside the
				// callbacks). Terminal reentry is a different invariant and is
				// guarded after every callback.
				this.runCleanupCallback(() => this.host.replaceEditorSurface(undefined));
				if (this.disposed) return;
				this.runCleanupCallback(() => this.host.setFocus(null));
				if (this.disposed) return;
				this.runCleanupCallback(() => this.host.requestRender());
				if (this.disposed) return;
				this.editorRestorePending = true;
			}
			if (this.disposed) return;
			// Re-select the active entry after the clear callbacks: a reentrant
			// present or settle may have changed the queue head.
			const active = this.queue.find((entry) => !entry.settled);
			if (active) {
				const index = this.queue.indexOf(active);
				this.queue.splice(index, 1);
				this.current = active;
				this.handoffPending = false;
				this.startConstructing(active);
				return;
			}
			// Every queued entry settled inside the clear callbacks: fall through
			// to restoration/idle handling below.
		}

		const stalePreserved = this.isStalePreserved();
		if (!this.editorRestorePending && !stalePreserved) {
			this.preservedEditor = undefined;
			this.handoffPending = false;
			return;
		}
		if (stalePreserved) {
			this.editorRestorePending = true;
			this.preservedEditor = undefined;
		}
		this.restorePass(pass);
	}

	private isStalePreserved(): boolean {
		const preserved = this.preservedEditor;
		return preserved !== undefined && preserved !== this.host.getCurrentEditor();
	}

	private restorePass(pass: number): void {
		const target = this.host.getCurrentEditor();
		// Restoration is cleanup ownership, same as mounted cleanup: each host
		// callback throw is contained per phase, never changes the already-chosen
		// outcome, and the remaining phases still run before the identity is
		// re-read below.
		this.runCleanupCallback(() => this.host.replaceEditorSurface(target));
		if (this.disposed) return;
		this.runCleanupCallback(() => this.host.setFocus(target));
		if (this.disposed) return;
		this.runCleanupCallback(() => this.host.requestRender());
		if (this.disposed) return;
		// Re-read the current editor after all synchronous host callbacks: a
		// reentrant editor replacement may have changed it, so the surface/focus
		// just applied can already be stale.
		const current = this.host.getCurrentEditor();
		if (current === target) {
			this.editorRestorePending = false;
			if (this.queue.some((entry) => !entry.settled)) {
				// A request queued reentrantly during the callbacks: keep the
				// converged editor preserved and hand it over on the next microtask.
				this.preservedEditor = target;
				queueMicrotask(() => this.runHandoff(0));
			} else {
				this.preservedEditor = undefined;
				this.handoffPending = false;
			}
			return;
		}
		// The surface actually holds `target` while the current editor moved on;
		// preserve the real surface identity and retry on a later microtask.
		this.preservedEditor = target;
		this.editorRestorePending = true;
		if (pass + 1 < MAX_RESTORE_PASSES) {
			queueMicrotask(() => this.runHandoff(pass + 1));
		} else {
			this.failClosed();
		}
	}

	// Bounded escape: a replacement that changes the current editor on every
	// pass can never converge, so leave the surface blank and focus null, stay
	// busy, and schedule nothing further. disposeAll() is the terminal escape.
	private failClosed(): void {
		this.preservedEditor = undefined;
		// Fail-closed writes are cleanup ownership too: each host callback throw
		// is contained per phase so the episode still ends fail-closed busy
		// (editorRestorePending + handoffPending set, no further microtask).
		this.runCleanupCallback(() => this.host.replaceEditorSurface(undefined));
		if (this.disposed) return;
		this.runCleanupCallback(() => this.host.setFocus(null));
		if (this.disposed) return;
		this.runCleanupCallback(() => this.host.requestRender());
		if (this.disposed) return;
		this.editorRestorePending = true;
		this.handoffPending = true;
	}

	private startConstructing(entry: RequestEntry): void {
		const done = (value: unknown) => this.settleEntry(entry, { kind: "value", value });
		let result: Mounted | Promise<Mounted>;
		try {
			result = entry.request.show(done);
		} catch (error) {
			this.settleEntry(entry, { kind: "error", error });
			return;
		}
		if (isPromiseLike(result)) {
			result.then(
				(mounted) => {
					if (entry.settled) {
						this.disposeComponent(mounted.component);
					} else {
						this.mount(entry, mounted);
					}
				},
				(error) => {
					if (!entry.settled) {
						this.settleEntry(entry, { kind: "error", error });
					}
				},
			);
		} else if (!entry.settled) {
			this.mount(entry, result);
		} else {
			this.disposeComponent(result.component);
		}
	}

	private mount(entry: RequestEntry, mounted: Mounted): void {
		this.mounted = mounted.component;
		this.editorRestorePending = false;
		this.preservedEditor = undefined;
		// Every host mount callback is presentation construction: on the first
		// thrown host error the owning active request settles with that exact
		// error, then normal mounted cleanup runs under the contained-cleanup
		// policy and the queue advances. present() must never throw here, and an
		// async .then continuation must never reject unobserved.
		if (!this.runMountCallback(entry, () => this.host.replaceEditorSurface(mounted.component))) return;
		// A synchronous host callback may terminally dispose or settle the owning
		// request (cleanupCurrent then performs the authoritative clear/focus/null
		// and render). Stop the outer mount before any later host callback.
		if (this.disposed || entry.settled) return;
		if (!this.runMountCallback(entry, () => this.host.setFocus(mounted.focus))) return;
		if (this.disposed || entry.settled) return;
		this.runMountCallback(entry, () => this.host.requestRender());
	}

	// Runs one host mount callback. Returns false on the first thrown host error;
	// the owning request settles with the exact error only if it is still active
	// (a callback that reentrantly settled/disposed the entry first keeps its
	// first settlement authoritative). Returns true when the callback completed
	// without error or when it is a no-op because the entry already terminated.
	private runMountCallback(entry: RequestEntry, callback: () => void): boolean {
		if (this.disposed || entry.settled) return true;
		try {
			callback();
			return true;
		} catch (error) {
			// The mount error settles the owning active request exactly once; if
			// the callback already settled/disposed the entry, the first outcome
			// is preserved.
			if (!this.disposed && !entry.settled) {
				this.settleEntry(entry, { kind: "error", error });
			}
			return false;
		}
	}

	private cancelOutcome(entry: RequestEntry): Outcome {
		const cancel = entry.request.cancel;
		if (!cancel) return { kind: "error", error: abortError() };
		try {
			return { kind: "value", value: cancel() };
		} catch (error) {
			return { kind: "error", error };
		}
	}
}
