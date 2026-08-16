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

type Outcome = { kind: "value"; value: unknown } | { kind: "error"; error: unknown };

interface RequestEntry {
	request: DialogRequest<unknown>;
	result: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	settled: boolean;
	abortListener: (() => void) | undefined;
}

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
	private surfaceCleared = false;
	private handoffScheduled = false;
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
		if (this.settling || this.current !== undefined || this.queue.length > 0 || this.handoffScheduled) {
			this.queue.push(entry);
		} else {
			this.current = entry;
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
		if (this.disposed) return;
		this.disposed = true;
		if (this.current && !this.current.settled) {
			this.settleEntry(this.current, this.cancelOutcome(this.current));
		}
		for (const entry of [...this.queue]) {
			if (!entry.settled) {
				this.settleEntry(entry, this.cancelOutcome(entry));
			}
		}
		this.queue = [];
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
			}
		} finally {
			this.settling = false;
		}
		this.settleResult(entry, outcome);
	}

	private cleanupCurrent(entry: RequestEntry): void {
		if (this.mounted) {
			const component = this.mounted;
			this.mounted = undefined;
			this.disposeComponent(component);
			this.host.replaceEditorSurface(undefined);
			this.host.setFocus(null);
			this.host.requestRender();
			this.surfaceCleared = true;
		} else {
			this.callOnEvict(entry);
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
		if (this.disposed || this.handoffScheduled) return;
		this.handoffScheduled = true;
		queueMicrotask(() => {
			this.handoffScheduled = false;
			if (this.disposed) return;
			const next = this.queue.find((entry) => !entry.settled);
			if (next) {
				const index = this.queue.indexOf(next);
				this.queue.splice(index, 1);
				this.current = next;
				this.startConstructing(next);
			} else if (this.surfaceCleared) {
				this.restoreEditor();
			}
		});
	}

	private restoreEditor(): void {
		const editor = this.host.getCurrentEditor();
		this.host.replaceEditorSurface(editor);
		this.host.setFocus(editor);
		this.host.requestRender();
		this.surfaceCleared = false;
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
						this.mount(mounted);
					}
				},
				(error) => {
					if (!entry.settled) {
						this.settleEntry(entry, { kind: "error", error });
					}
				},
			);
		} else if (!entry.settled) {
			this.mount(result);
		} else {
			this.disposeComponent(result.component);
		}
	}

	private mount(mounted: Mounted): void {
		this.mounted = mounted.component;
		this.surfaceCleared = false;
		this.host.replaceEditorSurface(mounted.component);
		this.host.setFocus(mounted.focus);
		this.host.requestRender();
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
