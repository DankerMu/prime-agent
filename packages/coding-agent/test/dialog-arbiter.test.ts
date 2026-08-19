import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type TestDialogComponent = Component & { dispose?(): void };
type TestDialogKind = "extension" | "app" | "placeholder";
interface TestDialogRequest<T> {
	show(
		done: (value: T) => void,
	):
		| { component: TestDialogComponent; focus: Component }
		| Promise<{ component: TestDialogComponent; focus: Component }>;
	kind: TestDialogKind;
	signal?: AbortSignal;
	cancel?(): T;
	onEvict?(): void;
}
type TestDialogArbiterHost = {
	replaceEditorSurface(component?: Component): void;
	setFocus(component: Component | null): void;
	requestRender(): void;
	getCurrentEditor(): Component;
};

type NamedComponent = TestDialogComponent & { name: string };

function makeComponent(name: string, disposeImpl?: () => void) {
	const disposals: string[] = [];
	const component: NamedComponent = {
		name,
		render: () => [name],
		invalidate: () => {},
		dispose: vi.fn(() => {
			disposals.push(name);
			disposeImpl?.();
		}),
	};
	return { component, disposals };
}

type HostSpies = {
	replace: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	render: ReturnType<typeof vi.fn>;
};

function createHost() {
	const events: string[] = [];
	let currentEditor: Component = makeComponent("editor").component;
	const replace = vi.fn((component?: Component) => {
		events.push(component ? `replace:${(component as { name?: string }).name ?? "?"}` : "replace:clear");
	});
	const focus = vi.fn((component: Component | null) => {
		events.push(component ? `focus:${(component as { name?: string }).name ?? "?"}` : "focus:null");
	});
	const render = vi.fn(() => events.push("render"));
	const host: TestDialogArbiterHost = {
		replaceEditorSurface: replace,
		setFocus: focus,
		requestRender: render,
		getCurrentEditor: () => currentEditor,
	};
	return {
		host,
		events,
		spies: { replace, focus, render } satisfies HostSpies,
		setCurrentEditor: (editor: Component) => {
			currentEditor = editor;
		},
	};
}

function syncRequest(
	kind: TestDialogKind,
	name = "d",
	showImpl?: (done: (value: unknown) => void) => { component: TestDialogComponent; focus: Component },
	options: { signal?: AbortSignal; cancel?: () => unknown; onEvict?: () => void } = {},
): { request: TestDialogRequest<unknown>; show: ReturnType<typeof vi.fn>; component: TestDialogComponent } {
	const { component } = makeComponent(name);
	const show = vi.fn((done) => {
		return showImpl ? showImpl(done) : { component, focus: component };
	});
	return {
		request: { show, kind, ...options },
		show,
		component,
	};
}

function asyncRequest(
	kind: TestDialogKind,
	name = "a",
	options: { signal?: AbortSignal; cancel?: () => unknown; onEvict?: () => void } = {},
): {
	request: TestDialogRequest<unknown>;
	show: ReturnType<typeof vi.fn>;
	resolve: (mounted: { component: TestDialogComponent; focus: Component }) => void;
	reject: (error: unknown) => void;
	component: TestDialogComponent;
} {
	const { component } = makeComponent(name);
	let resolve!: (mounted: { component: TestDialogComponent; focus: Component }) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<{ component: TestDialogComponent; focus: Component }>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const show = vi.fn(() => promise);
	return {
		request: { show, kind, ...options },
		show,
		resolve: (mounted) => resolve(mounted),
		reject,
		component,
	};
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Narrow typed structural access to the arbiter's terminal restoration/handoff
// flags. There is no public observable seam for these after disposeAll, so the
// tests read the private fields directly to prove they are not re-armed.
function readTerminalPendingState(arbiter: DialogArbiter): { editorRestorePending: boolean; handoffPending: boolean } {
	const state = arbiter as unknown as { editorRestorePending: boolean; handoffPending: boolean };
	return { editorRestorePending: state.editorRestorePending, handoffPending: state.handoffPending };
}

describe("DialogArbiter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows concurrent requests in FIFO order, each resolving once with its own value", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app");
		const b = syncRequest("app");
		const c = syncRequest("app");
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);
		const hc = arbiter.present(c.request);

		expect(a.show).toHaveBeenCalledTimes(1);
		expect(b.show).not.toHaveBeenCalled();
		expect(c.show).not.toHaveBeenCalled();

		ha.settle("a");
		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(await ha.result).toBe("a");

		hb.settle("b");
		await flush();
		expect(c.show).toHaveBeenCalledTimes(1);
		expect(await hb.result).toBe("b");

		hc.settle("c");
		await flush();
		expect(await hc.result).toBe("c");
		expect(events).toContain("replace:editor");
		expect(events).toContain("focus:editor");
	});

	it("is symmetric under either arrival order", async () => {
		for (const firstKind of ["extension", "app"] as const) {
			const secondKind = firstKind === "extension" ? "app" : "extension";
			const { host, events } = createHost();
			const arbiter = new DialogArbiter(host);
			const first = syncRequest(firstKind);
			const second = syncRequest(secondKind);
			const hFirst = arbiter.present(first.request);
			const hSecond = arbiter.present(second.request);

			expect(first.show).toHaveBeenCalledTimes(1);
			expect(second.show).not.toHaveBeenCalled();

			hFirst.settle("first");
			await flush();
			expect(second.show).toHaveBeenCalledTimes(1);
			expect(await hFirst.result).toBe("first");

			hSecond.settle("second");
			await flush();
			expect(await hSecond.result).toBe("second");
			expect(events).toContain("replace:editor");
			expect(events).toContain("focus:editor");
		}
	});

	it("done-first wins over abort; abort and second done are no-ops", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const controller = new AbortController();
		const a = makeComponent("a");
		let done!: (value: unknown) => void;
		const aRequest: TestDialogRequest<unknown> = {
			show: (d) => {
				done = d;
				return { component: a.component, focus: a.component };
			},
			kind: "app",
			signal: controller.signal,
		};
		const b = syncRequest("app", "b");
		const ha = arbiter.present(aRequest);
		const hb = arbiter.present(b.request);

		// Settle via the actual done callback passed to show, not the external handle.
		done("answered");
		controller.abort();
		done("second");

		expect(await ha.result).toBe("answered");
		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		hb.settle("b");
		expect(await hb.result).toBe("b");
	});

	it("abort-first wins; late done is a no-op and the queue advances once", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const controller = new AbortController();
		const a = makeComponent("a");
		let done!: (value: unknown) => void;
		const aRequest: TestDialogRequest<unknown> = {
			show: (d) => {
				done = d;
				return { component: a.component, focus: a.component };
			},
			kind: "app",
			signal: controller.signal,
		};
		const b = syncRequest("app", "b");
		const ha = arbiter.present(aRequest);
		const hb = arbiter.present(b.request);

		controller.abort();
		done("late");

		await expect(ha.result).rejects.toMatchObject({ name: "AbortError" });
		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		hb.settle("b");
		expect(await hb.result).toBe("b");
	});

	it("rejects once with the original error on synchronous show throw and continues the queue", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const onEvict = vi.fn();
		const a: TestDialogRequest<unknown> = {
			show: () => {
				throw boom;
			},
			kind: "app",
			onEvict,
		};
		const b = syncRequest("app");
		const ha = arbiter.present(a);
		arbiter.present(b.request);

		await expect(ha.result).rejects.toBe(boom);
		expect(onEvict).toHaveBeenCalledTimes(1);
		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).not.toContain("replace:editor");
		expect(events).not.toContain("focus:editor");
	});

	it("rejects once with the original error on async reject and continues the queue", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("async boom");
		const onEvict = vi.fn();
		const a: TestDialogRequest<unknown> = {
			show: () => Promise.reject(boom),
			kind: "app",
			onEvict,
		};
		const b = syncRequest("app");
		const ha = arbiter.present(a);
		arbiter.present(b.request);

		expect(events).toEqual([]);
		await flush();
		await expect(ha.result).rejects.toBe(boom);
		expect(onEvict).toHaveBeenCalledTimes(1);
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).not.toContain("replace:editor");
	});

	it("disposes a late async component that resolves after the request was settled", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const controller = new AbortController();
		const a = asyncRequest("app", "a", { signal: controller.signal });
		const ha = arbiter.present(a.request);
		controller.abort();

		await expect(ha.result).rejects.toMatchObject({ name: "AbortError" });
		expect(a.component.dispose).not.toHaveBeenCalled();
		expect(events).toEqual([]);

		a.resolve({ component: a.component, focus: a.component });
		await flush();
		expect(a.component.dispose).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);
	});

	it("never flashes a queued request that is aborted", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app");
		const controllerB = new AbortController();
		const b = syncRequest("app", "d", undefined, { signal: controllerB.signal });
		const c = syncRequest("app");
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);
		arbiter.present(c.request);

		controllerB.abort();
		await expect(hb.result).rejects.toMatchObject({ name: "AbortError" });
		expect(b.show).not.toHaveBeenCalled();
		expect(events).not.toContain("replace:clear");

		ha.settle("a");
		await flush();
		expect(c.show).toHaveBeenCalledTimes(1);
		expect(await ha.result).toBe("a");
	});

	it("never flashes a constructing request that is aborted via its signal before its component arrives", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "a");
		const controllerB = new AbortController();
		const b = asyncRequest("app", "b", { signal: controllerB.signal });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		ha.settle("a");
		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toContain("replace:clear");
		expect(events).toContain("focus:null");

		// Abort via the arbiter-owned signal listener, not the factory promise.
		controllerB.abort();
		await flush();
		await expect(hb.result).rejects.toMatchObject({ name: "AbortError" });
		expect(events).not.toContain("replace:b");
		expect(events).toContain("replace:editor");
		expect(events).toContain("focus:editor");
		expect(b.component.dispose).not.toHaveBeenCalled();

		// The late component resolution is disposed exactly once.
		b.resolve({ component: b.component, focus: b.component });
		await flush();
		expect(b.component.dispose).toHaveBeenCalledTimes(1);
		expect(events).not.toContain("replace:b");
	});

	it("settles a pre-aborted request immediately without queueing or touching the UI", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const controller = new AbortController();
		controller.abort();
		const onEvict = vi.fn();
		const a: TestDialogRequest<unknown> = {
			show: () => ({ component: makeComponent("x").component, focus: makeComponent("f").component }),
			kind: "app",
			signal: controller.signal,
			onEvict,
		};
		const ha = arbiter.present(a);

		await expect(ha.result).rejects.toMatchObject({ name: "AbortError" });
		expect(onEvict).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);

		const b = syncRequest("app");
		arbiter.present(b.request);
		expect(b.show).toHaveBeenCalledTimes(1);
	});

	it("removes a queued request that is settled externally before it is shown", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("placeholder");
		const b = syncRequest("placeholder", "d", undefined, { onEvict: vi.fn() });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		hb.settle("pre-shown");
		expect(await hb.result).toBe("pre-shown");
		expect(b.show).not.toHaveBeenCalled();

		ha.settle("a");
		await flush();
		expect(events).toContain("replace:editor");
		expect(events).toContain("focus:editor");
	});

	it("cleans up mounted components by dispose and never-mounted entries by onEvict, exactly once", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const aOnEvict = vi.fn();
		const a = syncRequest("app", "d", undefined, { onEvict: aOnEvict });
		const bOnEvict = vi.fn();
		const b = syncRequest("app", "d", undefined, { onEvict: bOnEvict });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		ha.settle("a");
		expect(a.component.dispose).toHaveBeenCalledTimes(1);
		expect(aOnEvict).not.toHaveBeenCalled();

		hb.settle("b");
		expect(b.show).not.toHaveBeenCalled();
		expect(bOnEvict).toHaveBeenCalledTimes(1);
		expect(b.component.dispose).not.toHaveBeenCalled();
	});

	it("calls onEvict at eviction and disposes the late component of an evicted constructing request", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app");
		const onEvict = vi.fn();
		const b = asyncRequest("app", "a", { onEvict });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		ha.settle("a");
		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);

		hb.settle("evicted");
		expect(onEvict).toHaveBeenCalledTimes(1);
		expect(b.component.dispose).not.toHaveBeenCalled();
		expect(await hb.result).toBe("evicted");

		b.resolve({ component: b.component, focus: b.component });
		await flush();
		expect(b.component.dispose).toHaveBeenCalledTimes(1);
		expect(events).not.toContain("replace:b");
	});

	it("ignores cleanup hook errors without changing the result or blocking the queue", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "d", undefined, {
			onEvict: () => {
				throw new Error("evict boom");
			},
		});
		const b = syncRequest("app", "d", undefined, {
			onEvict: () => {
				throw new Error("evict boom 2");
			},
		});
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		ha.settle("a");
		expect(await ha.result).toBe("a");

		hb.settle("b");
		expect(await hb.result).toBe("b");
	});

	it("tolerates a throwing mounted component dispose", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "d", undefined, {
			onEvict: undefined,
		});
		a.component.dispose = vi.fn(() => {
			throw new Error("dispose boom");
		});
		const ha = arbiter.present(a.request);

		ha.settle("a");
		expect(await ha.result).toBe("a");
		expect(a.component.dispose).toHaveBeenCalledTimes(1);
	});

	it("cancelKind cancels only matching kinds with the request cancel value", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("extension", "a", undefined, { cancel: () => "cancel-a" });
		const b = syncRequest("app", "b");
		const c = syncRequest("extension", "c", undefined, { cancel: () => "cancel-c" });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);
		const hc = arbiter.present(c.request);

		arbiter.cancelKind("extension");

		// Settled synchronously; only the current component is disposed.
		expect(a.component.dispose).toHaveBeenCalledTimes(1);
		expect(c.show).not.toHaveBeenCalled();
		expect(b.show).not.toHaveBeenCalled();
		expect(await ha.result).toBe("cancel-a");
		expect(await hc.result).toBe("cancel-c");

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		hb.settle("b");
		expect(await hb.result).toBe("b");
		expect(events).toContain("replace:editor");
	});

	it("rejects with AbortError when cancelKind/disposeAll hit a request without a cancel factory", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("extension");
		const ha = arbiter.present(a.request);

		arbiter.cancelKind("extension");
		await expect(ha.result).rejects.toMatchObject({ name: "AbortError" });
	});

	it("a throwing cancel factory rejects only that request and processing continues", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("cancel boom");
		const a = syncRequest("extension", "d", undefined, {
			cancel: () => {
				throw boom;
			},
		});
		const b = syncRequest("extension", "d", undefined, { cancel: () => "cancel-b" });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		arbiter.cancelKind("extension");

		await expect(ha.result).rejects.toBe(boom);
		expect(await hb.result).toBe("cancel-b");
		expect(events).toContain("replace:clear");
	});

	it("observes fire-and-forget rejections internally while await still rejects", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = syncRequest("app");
			const ha = arbiter.present(a.request);
			arbiter.disposeAll();
			await flush();
			expect(unhandled).toEqual([]);
			await expect(ha.result).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it("disposeAll is terminal and idempotent, settling current and queue synchronously", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "d", undefined, { cancel: () => "cancel-a" });
		const b = syncRequest("app", "d", undefined, { cancel: () => "cancel-b", onEvict: vi.fn() });
		const c = syncRequest("app", "d", undefined, { cancel: () => "cancel-c", onEvict: vi.fn() });
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);
		const hc = arbiter.present(c.request);

		arbiter.disposeAll();
		arbiter.disposeAll();

		expect(await ha.result).toBe("cancel-a");
		expect(a.component.dispose).toHaveBeenCalledTimes(1);
		expect(await hb.result).toBe("cancel-b");
		expect(await hc.result).toBe("cancel-c");
		expect(b.show).not.toHaveBeenCalled();
		expect(c.show).not.toHaveBeenCalled();
		expect(events).toContain("replace:clear");
		expect(events).toContain("focus:null");
		expect(events).not.toContain("replace:editor");
		expect(events).not.toContain("focus:editor");
	});

	it("present after dispose settles immediately without queueing or touching the UI", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "d", undefined, { cancel: () => "cancel-a" });
		const ha = arbiter.present(a.request);
		arbiter.disposeAll();
		expect(await ha.result).toBe("cancel-a");

		const before = events.length;
		const onEvict = vi.fn();
		const late = syncRequest("app", "d", undefined, { cancel: () => "late-cancel", onEvict });
		const hLate = arbiter.present(late.request);
		expect(await hLate.result).toBe("late-cancel");
		expect(late.show).not.toHaveBeenCalled();
		expect(onEvict).toHaveBeenCalledTimes(1);
		expect(events.length).toBe(before);
	});

	it("restores the dynamic current editor, not a captured one", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app");
		const ha = arbiter.present(a.request);
		const replacement = makeComponent("custom-editor").component;
		setCurrentEditor(replacement);

		ha.settle("a");
		await flush();

		expect(events).toContain("replace:custom-editor");
		expect(events).toContain("focus:custom-editor");
		expect(events).not.toContain("replace:editor");
	});

	it("treats synchronous reentry as an ordinary enqueue without recursion or intermediate editor focus", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		let done!: (value: unknown) => void;
		const a = makeComponent("a");
		const aRequest: TestDialogRequest<unknown> = {
			show: (d) => {
				done = d;
				return { component: a.component, focus: a.component };
			},
			kind: "app",
		};
		const ha = arbiter.present(aRequest);

		// Reentry: present B, then settle A, all in the same synchronous tick.
		const b = syncRequest("app", "b");
		const hb = arbiter.present(b.request);
		done("a");

		expect(b.show).not.toHaveBeenCalled();
		expect(events).toContain("replace:clear");
		expect(events).toContain("focus:null");
		expect(events).not.toContain("focus:editor");
		expect(events).not.toContain("replace:b");

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toContain("replace:b");
		expect(events).toContain("focus:b");
		expect(await ha.result).toBe("a");
		hb.settle("b");
		expect(await hb.result).toBe("b");
	});

	it("reentrant present from a mounted dispose() is enqueued and not erased", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const b = syncRequest("app", "b");
		const a = makeComponent("a");
		const aRequest: TestDialogRequest<unknown> = {
			show: () => {
				return { component: a.component, focus: a.component };
			},
			kind: "app",
		};
		a.component.dispose = vi.fn(() => {
			arbiter.present(b.request);
		});
		const ha = arbiter.present(aRequest);

		ha.settle("a");

		expect(b.show).not.toHaveBeenCalled();
		expect(events).not.toContain("replace:b");
		expect(events).not.toContain("focus:b");

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toContain("replace:b");
		expect(events).toContain("focus:b");
		expect(events.indexOf("replace:b")).toBeGreaterThan(events.indexOf("replace:clear"));
		expect(await ha.result).toBe("a");
	});

	it("reentrant present from a never-mounted onEvict() is enqueued and shows on handoff", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const b = syncRequest("app", "b");
		const a: TestDialogRequest<unknown> = {
			show: () => {
				throw boom;
			},
			kind: "app",
			onEvict: () => {
				arbiter.present(b.request);
			},
		};
		const ha = arbiter.present(a);

		expect(b.show).not.toHaveBeenCalled();
		expect(events).toEqual([]);

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["replace:b", "focus:b", "render"]);
		await expect(ha.result).rejects.toBe(boom);
	});

	it("reentrant present from onEvict during sync done-before-return is enqueued", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const b = syncRequest("app", "b");
		const a = makeComponent("a");
		const aRequest: TestDialogRequest<unknown> = {
			show: (done) => {
				done("a");
				return { component: a.component, focus: a.component };
			},
			kind: "app",
			onEvict: () => {
				arbiter.present(b.request);
			},
		};
		const ha = arbiter.present(aRequest);

		expect(b.show).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(a.component.dispose).toHaveBeenCalledTimes(1);

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toContain("replace:b");
		expect(events).toContain("focus:b");
		expect(await ha.result).toBe("a");
	});

	it("reentrant present from a cancel factory during cancelKind is enqueued", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const b = syncRequest("app", "b");
		const a = makeComponent("a");
		const aRequest: TestDialogRequest<unknown> = {
			show: () => {
				return { component: a.component, focus: a.component };
			},
			kind: "extension",
			cancel: () => {
				arbiter.present(b.request);
				return "cancel-a";
			},
		};
		const ha = arbiter.present(aRequest);

		arbiter.cancelKind("extension");

		expect(b.show).not.toHaveBeenCalled();
		expect(events).not.toContain("replace:b");

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toContain("replace:b");
		expect(events).toContain("focus:b");
		expect(await ha.result).toBe("cancel-a");
	});

	it("a reentrant present from onEvict during a pre-aborted settlement is enqueued and drained by a handoff", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const controller = new AbortController();
		controller.abort();
		const b = syncRequest("app", "b");
		const c = syncRequest("app", "c");
		let hb: { settle: (value: unknown) => void; result: Promise<unknown> };
		const a: TestDialogRequest<unknown> = {
			show: () => ({ component: makeComponent("a").component, focus: makeComponent("f").component }),
			kind: "app",
			signal: controller.signal,
			onEvict: () => {
				hb = arbiter.present(b.request);
			},
		};
		const ha = arbiter.present(a);

		// Pre-aborted A settles immediately; B is enqueued, never shown recursively.
		expect(b.show).not.toHaveBeenCalled();
		expect(events).toEqual([]);

		const hc = arbiter.present(c.request);
		expect(c.show).not.toHaveBeenCalled();

		await flush();
		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["replace:b", "focus:b", "render"]);
		await expect(ha.result).rejects.toMatchObject({ name: "AbortError" });

		hb!.settle("b");
		await flush();
		expect(c.show).toHaveBeenCalledTimes(1);
		expect(await hb!.result).toBe("b");

		hc.settle("c");
		await flush();
		expect(await hc.result).toBe("c");
		expect(events).toContain("replace:editor");
		expect(events).toContain("focus:editor");
	});

	it("keeps the surface empty and focus null while a queued successor constructs asynchronously", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "a");
		const b = asyncRequest("app", "b");
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		ha.settle("a");
		await flush();

		expect(b.show).toHaveBeenCalledTimes(1);
		expect(events).toContain("replace:clear");
		expect(events).toContain("focus:null");
		expect(events).not.toContain("focus:editor");

		b.resolve({ component: b.component, focus: b.component });
		await flush();
		expect(events).toContain("replace:b");
		expect(events).toContain("focus:b");

		hb.settle("b");
		await flush();
		expect(events).toContain("replace:editor");
		expect(events).toContain("focus:editor");
	});

	it("keeps the current editor mounted and focused while an initial request constructs asynchronously", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		expect(events).toEqual([]);

		initial.resolve({ component: initial.component, focus: initial.component });
		await flush();
		expect(events).toEqual(["replace:a", "focus:a", "render"]);

		h.settle("done");
		expect(await h.result).toBe("done");
	});

	it("restores the replaced current editor when an initial async constructing request rejects without mounting", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		expect(events).toEqual([]);

		// The host replaces the current editor while the request constructs with
		// no mounted component and the old editor still owns the surface.
		const replacement = makeComponent("replacement-editor").component;
		setCurrentEditor(replacement);

		initial.reject(boom);
		await expect(h.result).rejects.toBe(boom);
		await flush();

		expect(events).toContain("replace:replacement-editor");
		expect(events).toContain("focus:replacement-editor");
		expect(events).not.toContain("replace:editor");
		expect(initial.component.dispose).not.toHaveBeenCalled();
		expect(arbiter.isBusy()).toBe(false);
	});

	it("stays busy inside the host restoration callback for a stale preserved-editor restore with no successor", async () => {
		const { host, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		expect(arbiter.isBusy()).toBe(true);

		// The host replaces the current editor while the request constructs with
		// no mounted component and the old editor still owns the surface.
		setCurrentEditor(makeComponent("replacement-editor").component);

		let busyDuringRestore: boolean | undefined;
		const originalReplace = host.replaceEditorSurface;
		host.replaceEditorSurface = (component?: Component) => {
			busyDuringRestore = arbiter.isBusy();
			originalReplace(component);
		};

		// No-successor termination with a stale preserved editor: the handoff
		// restores the current editor dynamically.
		initial.reject(boom);
		await expect(h.result).rejects.toBe(boom);
		await flush();

		expect(busyDuringRestore).toBe(true);
		expect(arbiter.isBusy()).toBe(false);
	});

	it.each([
		{ name: "replaceEditorSurface", changeIn: "replace" as const },
		{ name: "setFocus", changeIn: "focus" as const },
		{ name: "requestRender", changeIn: "render" as const },
	])(
		"converges to the replacement editor when %s reentrantly replaces it during stale restoration",
		async ({ changeIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const boom = new Error("boom");
			const initial = asyncRequest("app", "a");
			const h = arbiter.present(initial.request);

			const b = makeComponent("b").component;
			const c = makeComponent("c").component;
			setCurrentEditor(b);

			let changed = false;
			let busyDuringRestore: boolean | undefined;
			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			const originalRender = host.requestRender;
			if (changeIn === "replace") {
				host.replaceEditorSurface = (component?: Component) => {
					busyDuringRestore = arbiter.isBusy();
					if (!changed) {
						changed = true;
						setCurrentEditor(c);
					}
					originalReplace(component);
				};
			} else if (changeIn === "focus") {
				host.setFocus = (component: Component | null) => {
					busyDuringRestore = arbiter.isBusy();
					if (!changed) {
						changed = true;
						setCurrentEditor(c);
					}
					originalFocus(component);
				};
			} else {
				host.requestRender = () => {
					busyDuringRestore = arbiter.isBusy();
					if (!changed) {
						changed = true;
						setCurrentEditor(c);
					}
					originalRender();
				};
			}

			initial.reject(boom);
			await expect(h.result).rejects.toBe(boom);
			await flush();

			// A later microtask converges surface/focus/current to the latest editor.
			expect(events).toContain("replace:c");
			expect(events).toContain("focus:c");
			expect(events[events.length - 3]).toBe("replace:c");
			expect(busyDuringRestore).toBe(true);
			expect(arbiter.isBusy()).toBe(false);
		},
	);

	it("converges to the third editor across two consecutive reentrant replacements without synchronous recursion", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		const b = makeComponent("b").component;
		const c = makeComponent("c").component;
		const d = makeComponent("d").component;
		setCurrentEditor(b);

		// Microtask-boundary observer of the first restore pass: it is enqueued
		// inside the first pass's first identity-changing replace callback, which
		// runs before the arbiter decides to retry (the retry is scheduled only
		// after every callback of the pass returns). A synchronous recursive
		// restorePass would have already completed the later passes when the
		// observer drains, so the boundary assertions below fail red against it.
		const boundary = { replaceCalls: -1, secondPassReplaced: false };
		// Timer-boundary marker scheduled in the same replace callback, also
		// before the arbiter registers its retry. The marker fires only after the
		// microtask queue drains, so with a microtask retry it observes the later
		// passes already started/completed; a setTimeout-based retry registers
		// after the marker and would be observed as not yet started.
		const marker = { replaceCalls: -1, finalConverged: false };
		let markerTimer: ReturnType<typeof setTimeout> | undefined;
		const originalReplace = host.replaceEditorSurface;
		const originalFocus = host.setFocus;
		host.replaceEditorSurface = (component?: Component) => {
			if (component === b) {
				setCurrentEditor(c);
				queueMicrotask(() => {
					boundary.replaceCalls = events.filter((e) => e.startsWith("replace:")).length;
					boundary.secondPassReplaced = events.some((e) => e === "replace:c");
				});
				markerTimer = setTimeout(() => {
					marker.replaceCalls = events.filter((e) => e.startsWith("replace:")).length;
					marker.finalConverged = events.some((e) => e === "replace:d");
				}, 0);
			}
			originalReplace(component);
		};
		host.setFocus = (component: Component | null) => {
			if (component === c) setCurrentEditor(d);
			originalFocus(component);
		};

		initial.reject(boom);
		await expect(h.result).rejects.toBe(boom);
		await flush();

		expect(events).toContain("replace:d");
		expect(events).toContain("focus:d");
		expect(events[events.length - 3]).toBe("replace:d");
		// Each pass is a separate microtask; replace runs exactly once per editor.
		expect(events.filter((e) => e.startsWith("replace:"))).toHaveLength(3);
		expect(arbiter.isBusy()).toBe(false);

		// At the observer point the first pass had run alone: the second restore
		// pass had not started yet. A synchronous recursive restorePass would have
		// completed both later passes before the observer drained, so both
		// boundary assertions fail red against such an implementation.
		expect(boundary.replaceCalls).toBe(1);
		expect(boundary.secondPassReplaced).toBe(false);

		// The timer marker fired after the microtask drain (during flush): the
		// second pass and the final convergence were already started/completed by
		// then. A setTimeout-based retry would have been registered after the
		// marker and observed here as not started, failing red.
		expect(marker.replaceCalls).toBeGreaterThanOrEqual(2);
		expect(marker.replaceCalls).toBe(3);
		expect(marker.finalConverged).toBe(true);
		if (markerTimer !== undefined) clearTimeout(markerTimer);
	});

	it("queues a reentrant present during restoration and constructs the successor on a later microtask without recursion or stall", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		// Make the preserved editor stale so a real restoration pass runs and its
		// replace callback can reentrantly present the successor.
		setCurrentEditor(makeComponent("b").component);

		const successor = makeComponent("succ");
		let succDone: ((value: unknown) => void) | undefined;
		const successorShow = vi.fn((done: (value: unknown) => void) => {
			succDone = done;
			return { component: successor.component, focus: successor.component };
		});
		const successorRequest: TestDialogRequest<unknown> = { show: successorShow, kind: "app" };

		let presented = false;
		const originalReplace = host.replaceEditorSurface;
		host.replaceEditorSurface = (component?: Component) => {
			if (!presented && component) {
				presented = true;
				arbiter.present(successorRequest);
			}
			originalReplace(component);
		};

		initial.reject(boom);
		await expect(h.result).rejects.toBe(boom);
		await flush();

		// The successor is shown exactly once, on the microtask after the restore
		// converged, never synchronously inside the restore callbacks.
		expect(successorShow).toHaveBeenCalledTimes(1);
		expect(events.indexOf("replace:succ")).toBeGreaterThan(events.indexOf("replace:b"));
		expect(events.slice(-3)).toEqual(["replace:succ", "focus:succ", "render"]);

		// Settling the successor restores the current editor (b) and the arbiter idles.
		succDone!("ok");
		await flush();
		expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);
		expect(arbiter.isBusy()).toBe(false);
	});

	it("fails closed after exactly eight restoration passes under every-pass replacement and settles queued requests on dispose without post-dispose UI", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);
		let hOutcome: unknown = "pending";
		void h.result.then(
			(value) => {
				hOutcome = value;
			},
			(error) => {
				hOutcome = error;
			},
		);
		setCurrentEditor(makeComponent("editor0").component);

		let pass = 0;
		const originalReplace = host.replaceEditorSurface;
		host.replaceEditorSurface = (component?: Component) => {
			setCurrentEditor(makeComponent(`editor${++pass}`).component);
			originalReplace(component);
		};

		initial.reject(boom);
		await flush();
		await flush();

		expect(hOutcome).toBe(boom);
		// Exactly eight named restore passes, then one final clear/null/render.
		expect(events.filter((e) => e.startsWith("replace:editor"))).toHaveLength(8);
		expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);

		// No event growth after additional turns; the arbiter stays busy.
		const settledCount = events.length;
		await flush();
		await flush();
		expect(events.length).toBe(settledCount);
		expect(arbiter.isBusy()).toBe(true);

		// Subsequent requests queue and never show.
		const successor = syncRequest("app", "succ");
		const hSucc = arbiter.present(successor.request);
		let succOutcome: unknown = "pending";
		let succSettlements = 0;
		void hSucc.result.then(
			(value) => {
				succOutcome = value;
				succSettlements += 1;
			},
			(error) => {
				succOutcome = error;
				succSettlements += 1;
			},
		);
		expect(successor.show).not.toHaveBeenCalled();
		await flush();
		expect(successor.show).not.toHaveBeenCalled();

		// The queued request remains pending: fail-closed queues rather than
		// immediately evicting or rejecting. An implementation that evicts/rejects
		// on arrival or on the drained turns would settle here, failing red.
		expect(succOutcome).toBe("pending");
		expect(succSettlements).toBe(0);

		// disposeAll settles the queue with no post-dispose UI.
		const beforeDispose = events.length;
		arbiter.disposeAll();
		await expect(hSucc.result).rejects.toMatchObject({ name: "AbortError" });
		expect(succOutcome).toBeInstanceOf(Error);
		expect((succOutcome as Error).name).toBe("AbortError");
		expect(succSettlements).toBe(1);
		await flush();
		expect(events.length).toBe(beforeDispose);
		expect(successor.show).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "replace callback", disposeIn: "replace" as const },
		{ name: "focus callback", disposeIn: "focus" as const },
		{ name: "render callback", disposeIn: "render" as const },
	])(
		"a reentrant disposeAll from the %s of a stale no-successor restore produces no later host UI events or scheduled work",
		async ({ disposeIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const boom = new Error("boom");
			const initial = asyncRequest("app", "a");
			const h = arbiter.present(initial.request);
			let outcome: unknown = "pending";
			void h.result.then(
				(value) => {
					outcome = value;
				},
				(error) => {
					outcome = error;
				},
			);
			setCurrentEditor(makeComponent("b").component);

			let disposed = false;
			let getCurrentEditorCallsAfterDispose = 0;
			const originalGetCurrentEditor = host.getCurrentEditor;
			host.getCurrentEditor = () => {
				if (disposed) getCurrentEditorCallsAfterDispose += 1;
				return originalGetCurrentEditor();
			};
			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			const originalRender = host.requestRender;
			if (disposeIn === "replace") {
				host.replaceEditorSurface = (component?: Component) => {
					originalReplace(component);
					if (!disposed) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			} else if (disposeIn === "focus") {
				host.setFocus = (component: Component | null) => {
					originalFocus(component);
					if (!disposed) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			} else {
				host.requestRender = () => {
					// Change the current editor before disposing so an omitted
					// post-render guard would schedule another restore pass.
					originalRender();
					if (!disposed) {
						setCurrentEditor(makeComponent("c").component);
						disposed = true;
						arbiter.disposeAll();
					}
				};
			}

			initial.reject(boom);
			await expect(h.result).rejects.toBe(boom);
			await flush();
			await flush();

			// The request settled once (rejected with the exact error); no further
			// host callback/event may occur after the disposing callback.
			expect(outcome).toBe(boom);
			// The restore pass stops at the disposing stage: replace only, replace
			// + focus, or replace + focus + render depending on the stage.
			const expectedTail =
				disposeIn === "replace"
					? ["replace:b"]
					: disposeIn === "focus"
						? ["replace:b", "focus:b"]
						: ["replace:b", "focus:b", "render"];
			expect(events).toEqual(expectedTail);
			// After the render-stage dispose, no later getCurrentEditor read (which
			// an omitted guard would perform to detect a stale restore target) and
			// no re-armed terminal restoration/handoff state.
			expect(getCurrentEditorCallsAfterDispose).toBe(0);
			expect(readTerminalPendingState(arbiter)).toEqual({ editorRestorePending: false, handoffPending: false });
			const settledCount = events.length;
			await flush();
			await flush();
			expect(events.length).toBe(settledCount);
			expect(arbiter.isBusy()).toBe(true);
		},
	);

	it.each([
		{ name: "clear callback", disposeIn: "clear" as const },
		{ name: "focus callback", disposeIn: "focus" as const },
		{ name: "render callback", disposeIn: "render" as const },
	])(
		"a reentrant disposeAll from the %s of the stale clear before a successor settles the successor unshown with no later UI events",
		async ({ disposeIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const a = asyncRequest("app", "a");
			const ha = arbiter.present(a.request);
			const b = syncRequest("app", "b", undefined, { cancel: () => "cancel-B" });
			const hb = arbiter.present(b.request);
			let bOutcome: unknown = "pending";
			void hb.result.then(
				(value) => {
					bOutcome = value;
				},
				(error) => {
					bOutcome = error;
				},
			);
			setCurrentEditor(makeComponent("replacement").component);

			// Dispose from the chosen stale-clear stage: the clear callback
			// disposes in the replace stage; the focus and render stages dispose
			// after their own event has been emitted.
			let disposed = false;
			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			const originalRender = host.requestRender;
			if (disposeIn === "clear") {
				host.replaceEditorSurface = (component?: Component) => {
					originalReplace(component);
					if (!disposed && component === undefined) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			} else if (disposeIn === "focus") {
				host.setFocus = (component: Component | null) => {
					originalFocus(component);
					if (!disposed && component === null) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			} else {
				host.requestRender = () => {
					originalRender();
					if (!disposed) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			}

			ha.settle("a");
			await expect(ha.result).resolves.toBe("a");
			await flush();
			await flush();

			// The successor was settled by dispose (its cancel value), never
			// constructed.
			expect(b.show).not.toHaveBeenCalled();
			expect(await hb.result).toBe("cancel-B");
			expect(bOutcome).toBe("cancel-B");
			// No UI event after the disposing stage: clear only, clear + focus, or
			// clear + focus + render depending on the stage.
			const expectedTail =
				disposeIn === "clear"
					? ["replace:clear"]
					: disposeIn === "focus"
						? ["replace:clear", "focus:null"]
						: ["replace:clear", "focus:null", "render"];
			expect(events).toEqual(expectedTail);
			expect(readTerminalPendingState(arbiter)).toEqual({ editorRestorePending: false, handoffPending: false });
			const settledCount = events.length;
			await flush();
			await flush();
			expect(events.length).toBe(settledCount);
			expect(arbiter.isBusy()).toBe(true);
		},
	);

	it.each([
		{ name: "final clear", disposeIn: "clear" as const },
		{ name: "final focus", disposeIn: "focus" as const },
		{ name: "final render", disposeIn: "render" as const },
	])(
		"a reentrant disposeAll from the failClosed %s produces no later UI events and keeps terminal pending state cleared",
		async ({ disposeIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const boom = new Error("boom");
			const initial = asyncRequest("app", "a");
			const h = arbiter.present(initial.request);
			let outcome: unknown = "pending";
			void h.result.then(
				(value) => {
					outcome = value;
				},
				(error) => {
					outcome = error;
				},
			);
			setCurrentEditor(makeComponent("editor0").component);

			// Every replace pass changes the current editor so the restore never
			// converges and eventually fails closed; the chosen failClosed stage
			// disposes reentrantly.
			let pass = 0;
			let failingClosed = false;
			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			const originalRender = host.requestRender;
			host.replaceEditorSurface = (component?: Component) => {
				setCurrentEditor(makeComponent(`editor${++pass}`).component);
				if (component === undefined) failingClosed = true;
				originalReplace(component);
				if (disposeIn === "clear" && component === undefined) {
					arbiter.disposeAll();
				}
			};
			if (disposeIn === "focus") {
				host.setFocus = (component: Component | null) => {
					originalFocus(component);
					if (component === null) {
						arbiter.disposeAll();
					}
				};
			}
			if (disposeIn === "render") {
				host.requestRender = () => {
					originalRender();
					if (failingClosed) {
						arbiter.disposeAll();
					}
				};
			}

			initial.reject(boom);
			await flush();
			await flush();

			expect(outcome).toBe(boom);
			// The failClosed sequence ran once and stopped at the disposing stage:
			// clear only, clear + focus, or clear + focus + render.
			if (disposeIn === "clear") {
				expect(events.at(-1)).toBe("replace:clear");
				expect(events.filter((e) => e === "replace:clear")).toHaveLength(1);
				expect(events.filter((e) => e === "render")).toHaveLength(8);
			} else if (disposeIn === "focus") {
				expect(events.at(-1)).toBe("focus:null");
				expect(events.filter((e) => e === "render")).toHaveLength(8);
			} else {
				expect(events.at(-1)).toBe("render");
				expect(events.filter((e) => e === "render")).toHaveLength(9);
			}
			// The terminal restoration/handoff state stays cleared (disposeAll
			// cleared it and the returning failClosed must not re-arm it).
			expect(readTerminalPendingState(arbiter)).toEqual({ editorRestorePending: false, handoffPending: false });
			const settledCount = events.length;
			await flush();
			await flush();
			expect(events.length).toBe(settledCount);
			expect(arbiter.isBusy()).toBe(true);
		},
	);

	it.each([
		{ name: "replace callback", disposeIn: "replace" as const },
		{ name: "focus callback", disposeIn: "focus" as const },
	])(
		"a reentrant disposeAll from the mount %s leaves the terminal cleanup authoritative with no later mount events",
		async ({ disposeIn }) => {
			const { host, events } = createHost();
			const arbiter = new DialogArbiter(host);
			const a = makeComponent("a");

			let disposed = false;
			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			if (disposeIn === "replace") {
				host.replaceEditorSurface = (component?: Component) => {
					originalReplace(component);
					if (!disposed && component) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			} else {
				host.setFocus = (component: Component | null) => {
					originalFocus(component);
					if (!disposed && component) {
						disposed = true;
						arbiter.disposeAll();
					}
				};
			}

			const request: TestDialogRequest<unknown> = {
				show: () => ({ component: a.component, focus: a.component }),
				kind: "app",
				cancel: () => "cancel-mount",
			};
			const ha = arbiter.present(request);
			let outcome: unknown = "pending";
			void ha.result.then(
				(value) => {
					outcome = value;
				},
				(error) => {
					outcome = error;
				},
			);

			// The request settles exactly once via its cancel value; the component
			// is disposed exactly once by the terminal cleanup.
			expect(await ha.result).toBe("cancel-mount");
			expect(outcome).toBe("cancel-mount");
			expect(a.component.dispose).toHaveBeenCalledTimes(1);

			// cleanupCurrent's terminal clear/focus-null/render is the authoritative
			// last surface sequence; the outer mount must not refocus the disposed
			// component or issue an extra render after the disposing callback.
			expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);
			expect(events.filter((e) => e === "render")).toHaveLength(1);

			const settledCount = events.length;
			await flush();
			await flush();
			expect(events.length).toBe(settledCount);
			expect(arbiter.isBusy()).toBe(true);
		},
	);

	it.each([
		{ name: "mounted component dispose", stage: "dispose" as const },
		{ name: "cleanup clear", stage: "clear" as const },
		{ name: "cleanup focus", stage: "focus" as const },
		{ name: "cleanup render", stage: "render" as const },
	])(
		"a reentrant disposeAll from the %s drains the full mounted cleanup synchronously and emits no UI after its return",
		async ({ stage }) => {
			const { host, events } = createHost();
			const arbiter = new DialogArbiter(host);
			const a = makeComponent("a");
			const b = syncRequest("app", "b", undefined, { cancel: () => "cancel-B" });

			// A is mounted as the visible current request; B queues behind it with
			// an observed cancel outcome.
			const ha = arbiter.present({ show: () => ({ component: a.component, focus: a.component }), kind: "app" });
			const hb = arbiter.present(b.request);
			expect(events).toEqual(["replace:a", "focus:a", "render"]);

			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			const originalRender = host.requestRender;
			if (stage === "dispose") {
				a.component.dispose = vi.fn(() => {
					arbiter.disposeAll();
					// The nested terminal call must have completed the remaining
					// cleanup phases synchronously before it returns.
					events.push("dispose:return");
				});
			} else if (stage === "clear") {
				host.replaceEditorSurface = (component?: Component) => {
					originalReplace(component);
					if (component === undefined) {
						arbiter.disposeAll();
						events.push("clear:return");
					}
				};
			} else if (stage === "focus") {
				host.setFocus = (component: Component | null) => {
					originalFocus(component);
					if (component === null) {
						arbiter.disposeAll();
						events.push("focus:return");
					}
				};
			} else {
				host.requestRender = () => {
					originalRender();
					arbiter.disposeAll();
					events.push("render:return");
				};
			}

			ha.settle("A-value");

			// A retains its original normal settlement exactly once.
			expect(await ha.result).toBe("A-value");
			// The mounted component is disposed exactly once.
			expect(a.component.dispose).toHaveBeenCalledTimes(1);
			// B settles once via the terminal cancel outcome and never shows.
			expect(await hb.result).toBe("cancel-B");
			expect(b.show).not.toHaveBeenCalled();

			// The full mounted cleanup sequence (clear, focus-null, render) ran
			// exactly once in order, and the disposing stage's return marker follows
			// the completed sequence with no UI event after it.
			const marker = `${stage}:return`;
			expect(events).toEqual(["replace:a", "focus:a", "render", "replace:clear", "focus:null", "render", marker]);
			expect(events.indexOf("replace:clear")).toBe(3);
			expect(events.lastIndexOf(marker)).toBe(events.length - 1);

			// Terminal: no event growth, busy forever, and a later present settles
			// immediately with no UI.
			const settledCount = events.length;
			await flush();
			await flush();
			expect(events.length).toBe(settledCount);
			expect(arbiter.isBusy()).toBe(true);

			const late = syncRequest("app", "late", undefined, { cancel: () => "cancel-late" });
			const hLate = arbiter.present(late.request);
			expect(await hLate.result).toBe("cancel-late");
			expect(late.show).not.toHaveBeenCalled();
			expect(events.length).toBe(settledCount);
		},
	);

	it("a reentrant disposeAll from every mounted cleanup phase runs one full cleanup sequence and unwinds returns in reverse nesting order", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = makeComponent("a");
		const b = syncRequest("app", "b", undefined, { cancel: () => "cancel-B" });

		// A is mounted as the visible current request; B queues behind it with
		// an observed cancel outcome.
		const ha = arbiter.present({ show: () => ({ component: a.component, focus: a.component }), kind: "app" });
		const hb = arbiter.present(b.request);
		expect(events).toEqual(["replace:a", "focus:a", "render"]);

		// Every mounted cleanup phase reentrantly disposes and records its own
		// return marker, so nested returns must unwind in reverse nesting order
		// (render, focus, clear, dispose) after the single cleanup sequence.
		const originalReplace = host.replaceEditorSurface;
		const originalFocus = host.setFocus;
		const originalRender = host.requestRender;
		a.component.dispose = vi.fn(() => {
			arbiter.disposeAll();
			events.push("dispose:return");
		});
		host.replaceEditorSurface = (component?: Component) => {
			originalReplace(component);
			if (component === undefined) {
				arbiter.disposeAll();
				events.push("clear:return");
			}
		};
		host.setFocus = (component: Component | null) => {
			originalFocus(component);
			if (component === null) {
				arbiter.disposeAll();
				events.push("focus:return");
			}
		};
		host.requestRender = () => {
			originalRender();
			arbiter.disposeAll();
			events.push("render:return");
		};

		ha.settle("A-value");

		// A retains its original normal settlement exactly once.
		expect(await ha.result).toBe("A-value");
		// The mounted component is disposed exactly once.
		expect(a.component.dispose).toHaveBeenCalledTimes(1);
		// B settles once via the terminal cancel outcome and never shows.
		expect(await hb.result).toBe("cancel-B");
		expect(b.show).not.toHaveBeenCalled();

		// The cleanup sequence (clear, focus-null, render) ran exactly once in
		// order; only then do the nested return markers unwind in reverse
		// nesting order, with no UI event after them.
		expect(events).toEqual([
			"replace:a",
			"focus:a",
			"render",
			"replace:clear",
			"focus:null",
			"render",
			"render:return",
			"focus:return",
			"clear:return",
			"dispose:return",
		]);

		// Terminal: no event growth, busy forever, and a later present settles
		// immediately with no UI.
		const settledCount = events.length;
		await flush();
		await flush();
		expect(events.length).toBe(settledCount);
		expect(arbiter.isBusy()).toBe(true);

		const late = syncRequest("app", "late", undefined, { cancel: () => "cancel-late" });
		const hLate = arbiter.present(late.request);
		expect(await hLate.result).toBe("cancel-late");
		expect(late.show).not.toHaveBeenCalled();
		expect(events.length).toBe(settledCount);
	});

	it("keeps the editor surface untouched when an initial async constructing request rejects without an editor replacement", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		expect(events).toEqual([]);

		initial.reject(boom);
		await expect(h.result).rejects.toBe(boom);
		await flush();
		await flush();

		expect(events).toEqual([]);
		expect(arbiter.isBusy()).toBe(false);
	});

	it("disposeAll on an initial async constructing request after an editor replacement settles with AbortError, disposes the late component once and never touches the UI", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		expect(events).toEqual([]);

		// The host replaces the current editor while the request constructs with
		// no mounted component and the old editor still owns the surface.
		const replacement = makeComponent("replacement-editor").component;
		setCurrentEditor(replacement);

		// disposeAll is terminal: the no-mounted request settles via the default
		// cancel semantics (AbortError) and the preserved editor identity must not
		// resurface as any UI action after dispose.
		arbiter.disposeAll();
		arbiter.disposeAll();

		await expect(h.result).rejects.toMatchObject({ name: "AbortError" });
		expect(initial.component.dispose).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(arbiter.isBusy()).toBe(true);

		// A late component resolution is disposed exactly once and never mounts or
		// drives any UI call after the terminal dispose.
		initial.resolve({ component: initial.component, focus: initial.component });
		await flush();
		await flush();
		expect(initial.component.dispose).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);
		expect(arbiter.isBusy()).toBe(true);

		// A present after dispose settles immediately without touching the UI.
		const late = syncRequest("app", "late");
		const hLate = arbiter.present(late.request);
		await expect(hLate.result).rejects.toMatchObject({ name: "AbortError" });
		expect(late.show).not.toHaveBeenCalled();
		expect(events).toEqual([]);
	});

	it("clears a stale editor surface before a successor constructs when the current editor changed during an initial async construction", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = asyncRequest("app", "a");
		const b = asyncRequest("app", "b");
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		expect(events).toEqual([]);

		const replacement = makeComponent("replacement-editor").component;
		setCurrentEditor(replacement);

		ha.settle("a");
		expect(await ha.result).toBe("a");
		await flush();

		expect(b.show).toHaveBeenCalledTimes(1);
		// The stale old editor is cleared before the successor constructs; the
		// replacement editor is never focused between dialogs.
		expect(events).toContain("replace:clear");
		expect(events).toContain("focus:null");
		expect(events).not.toContain("focus:replacement-editor");
		expect(events).not.toContain("focus:editor");
		expect(events).not.toContain("replace:b");

		b.resolve({ component: b.component, focus: b.component });
		await flush();
		expect(events).toContain("replace:b");
		expect(events).toContain("focus:b");
		expect(events).not.toContain("focus:replacement-editor");
		expect(events.indexOf("replace:clear")).toBeLessThan(events.indexOf("replace:b"));

		hb.settle("b");
		await flush();
		expect(events).toContain("replace:replacement-editor");
		expect(events).toContain("focus:replacement-editor");
	});

	it("restores the replaced current editor after a sync done before the async component resolves and disposes the late component once", async () => {
		const { host, events, setCurrentEditor } = createHost();
		const arbiter = new DialogArbiter(host);
		const { component } = makeComponent("a");
		let resolveComponent!: (mounted: { component: TestDialogComponent; focus: Component }) => void;
		const componentPromise = new Promise<{ component: TestDialogComponent; focus: Component }>((resolve) => {
			resolveComponent = resolve;
		});
		const a: TestDialogRequest<unknown> = {
			show: (done) => {
				done("first");
				return componentPromise;
			},
			kind: "app",
		};
		const ha = arbiter.present(a);

		const replacement = makeComponent("replacement-editor").component;
		setCurrentEditor(replacement);

		expect(await ha.result).toBe("first");
		await flush();

		expect(events).toContain("replace:replacement-editor");
		expect(events).toContain("focus:replacement-editor");
		expect(arbiter.isBusy()).toBe(false);

		resolveComponent({ component, focus: component });
		await flush();
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(events).not.toContain("replace:a");
		expect(events).not.toContain("focus:a");
	});

	it("emits render and focus in the expected order across a visible settlement and handoff", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "a");
		const b = syncRequest("app", "b");
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		expect(events).toEqual(["replace:a", "focus:a", "render"]);

		ha.settle("a");
		expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);

		await flush();
		expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);

		hb.settle("b");
		await flush();
		expect(events.slice(-3)).toEqual(["replace:editor", "focus:editor", "render"]);
		expect(events).not.toContain("focus:editor2");
	});

	it("reports not busy for a fresh, usable arbiter", () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);

		expect(arbiter.isBusy()).toBe(false);
	});

	it("reports busy while an initial request constructs asynchronously and while it is mounted", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const initial = asyncRequest("app", "a");
		const h = arbiter.present(initial.request);

		expect(arbiter.isBusy()).toBe(true);

		initial.resolve({ component: initial.component, focus: initial.component });
		expect(arbiter.isBusy()).toBe(true);
		await flush();
		expect(arbiter.isBusy()).toBe(true);

		h.settle("done");
		expect(await h.result).toBe("done");
	});

	it("stays busy between a visible settlement and the microtask handoff", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "a");
		const ha = arbiter.present(a.request);

		ha.settle("a");
		expect(arbiter.isBusy()).toBe(true);

		await flush();
		expect(arbiter.isBusy()).toBe(false);
	});

	it("stays busy inside the reentrant host restoration callback until it completes", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "a");
		const ha = arbiter.present(a.request);
		let busyDuringRestore: boolean | undefined;
		const originalReplace = host.replaceEditorSurface;
		host.replaceEditorSurface = (component?: Component) => {
			busyDuringRestore = arbiter.isBusy();
			originalReplace(component);
		};

		ha.settle("a");
		await flush();

		expect(busyDuringRestore).toBe(true);
		expect(arbiter.isBusy()).toBe(false);
	});

	it("reports busy while a queued request owns the arbiter and idle again after final restoration", async () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = syncRequest("app", "a");
		const b = syncRequest("app", "b");
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);

		expect(arbiter.isBusy()).toBe(true);

		ha.settle("a");
		await flush();
		expect(arbiter.isBusy()).toBe(true);

		hb.settle("b");
		await flush();
		expect(arbiter.isBusy()).toBe(false);
		expect(await ha.result).toBe("a");
		expect(await hb.result).toBe("b");
	});

	it("a mounted dispose that aborts a queued request and presents a new one keeps the new request queued until cleanup and handoff complete", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const a = makeComponent("a");
		const controllerB = new AbortController();
		const b = syncRequest("app", "b", undefined, { signal: controllerB.signal });
		const c = syncRequest("app", "c");
		const ha = arbiter.present({ show: () => ({ component: a.component, focus: a.component }), kind: "app" });
		const hb = arbiter.present(b.request);
		expect(events).toEqual(["replace:a", "focus:a", "render"]);

		let hc: { settle: (value: unknown) => void; result: Promise<unknown> } | undefined;
		let cShowCallsInside: number | undefined;
		let busyAfterAbort: boolean | undefined;
		let busyAfterPresent: boolean | undefined;
		a.component.dispose = vi.fn(() => {
			controllerB.abort();
			busyAfterAbort = arbiter.isBusy();
			hc = arbiter.present(c.request);
			busyAfterPresent = arbiter.isBusy();
			cShowCallsInside = c.show.mock.calls.length;
		});

		ha.settle("a");

		// The nested B settlement must not clear the outer cleanup ownership: the
		// arbiter stays busy and C stays queued inside the dispose callback.
		expect(busyAfterAbort).toBe(true);
		expect(busyAfterPresent).toBe(true);
		expect(cShowCallsInside).toBe(0);
		expect(c.show).not.toHaveBeenCalled();
		// A's full cleanup sequence (clear, focus-null, render) completes before
		// any later handoff may construct C.
		expect(events).toEqual(["replace:a", "focus:a", "render", "replace:clear", "focus:null", "render"]);

		// B was aborted via its signal by the dispose callback.
		await expect(hb.result).rejects.toMatchObject({ name: "AbortError" });
		expect(await ha.result).toBe("a");

		// C shows exactly once, on the later handoff microtask, after the cleanup.
		await flush();
		expect(c.show).toHaveBeenCalledTimes(1);
		expect(events.slice(-3)).toEqual(["replace:c", "focus:c", "render"]);
		expect(events.indexOf("replace:c")).toBeGreaterThan(events.indexOf("replace:clear"));

		// C settles normally and the arbiter restores the editor and idles.
		hc!.settle("c");
		expect(await hc!.result).toBe("c");
		await flush();
		expect(events.slice(-3)).toEqual(["replace:editor", "focus:editor", "render"]);
		expect(arbiter.isBusy()).toBe(false);
	});

	it("a never-mounted onEvict that aborts a queued request and presents a new one keeps the new request queued until outer settlement and handoff complete", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const boom = new Error("boom");
		const controllerB = new AbortController();
		const b = syncRequest("app", "b", undefined, { signal: controllerB.signal });
		const c = syncRequest("app", "c");
		let hc: { settle: (value: unknown) => void; result: Promise<unknown> } | undefined;
		let cShowCallsInside: number | undefined;
		let busyAfterAbort: boolean | undefined;
		let busyAfterPresent: boolean | undefined;
		const a = asyncRequest("app", "a", {
			onEvict: () => {
				controllerB.abort();
				busyAfterAbort = arbiter.isBusy();
				hc = arbiter.present(c.request);
				busyAfterPresent = arbiter.isBusy();
				cShowCallsInside = c.show.mock.calls.length;
			},
		});
		const ha = arbiter.present(a.request);
		const hb = arbiter.present(b.request);
		expect(events).toEqual([]);

		// A rejects; its onEvict runs on the rejection microtask and records the
		// state at onEvict time, before any handoff microtask.
		a.reject(boom);
		await flush();

		// Inside onEvict the nested B settlement must not clear the outer
		// ownership: C never shows recursively and the arbiter stays busy.
		expect(cShowCallsInside).toBe(0);
		expect(busyAfterAbort).toBe(true);
		expect(busyAfterPresent).toBe(true);
		expect(c.show).toHaveBeenCalledTimes(1);
		await expect(ha.result).rejects.toBe(boom);
		await expect(hb.result).rejects.toMatchObject({ name: "AbortError" });
		// C shows exactly once, via the handoff scheduled by the outer settlement.
		expect(events.slice(-3)).toEqual(["replace:c", "focus:c", "render"]);

		// C settles normally and the arbiter restores the editor and idles.
		hc!.settle("c");
		expect(await hc!.result).toBe("c");
		await flush();
		expect(events.slice(-3)).toEqual(["replace:editor", "focus:editor", "render"]);
		expect(arbiter.isBusy()).toBe(false);
	});

	it("a host clear-callback throw during mounted cleanup is contained: A keeps its value, cleanup completes, and the queue advances", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = syncRequest("app", "a");
			const b = syncRequest("app", "b");
			const ha = arbiter.present(a.request);
			const hb = arbiter.present(b.request);
			expect(events).toEqual(["replace:a", "focus:a", "render"]);

			const boom = new Error("clear boom");
			let threw = false;
			const originalReplace = host.replaceEditorSurface;
			host.replaceEditorSurface = (component?: Component) => {
				originalReplace(component);
				if (!threw && component === undefined) {
					threw = true;
					throw boom;
				}
			};

			// The cleanup error is contained: the settlement must not throw, and
			// the full cleanup sequence (clear, focus-null, render) still
			// completes synchronously in order.
			expect(() => ha.settle("a")).not.toThrow();
			expect(threw).toBe(true);
			expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);

			// A resolves its original value exactly once despite the clear throw;
			// the mounted component is disposed exactly once.
			expect(await ha.result).toBe("a");
			expect(a.component.dispose).toHaveBeenCalledTimes(1);

			// The queued successor still shows and settles on the handoff.
			await flush();
			expect(b.show).toHaveBeenCalledTimes(1);
			expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);
			hb.settle("b");
			expect(await hb.result).toBe("b");
			await flush();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it("a cleanup focus-null setter throw is contained: A resolves its value once, cleanup completes, and B shows/settles", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = syncRequest("app", "a");
			const b = syncRequest("app", "b");
			const ha = arbiter.present(a.request);
			const hb = arbiter.present(b.request);
			expect(events).toEqual(["replace:a", "focus:a", "render"]);

			// The focusable mounted component's `focused=false` setter throws once
			// while cleanup calls setFocus(null).
			const boom = new Error("focus-null boom");
			let threw = false;
			const originalFocus = host.setFocus;
			host.setFocus = (component: Component | null) => {
				originalFocus(component);
				if (!threw && component === null) {
					threw = true;
					throw boom;
				}
			};

			expect(() => ha.settle("a")).not.toThrow();
			expect(threw).toBe(true);
			expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);

			expect(await ha.result).toBe("a");
			expect(a.component.dispose).toHaveBeenCalledTimes(1);

			await flush();
			expect(b.show).toHaveBeenCalledTimes(1);
			expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);
			hb.settle("b");
			expect(await hb.result).toBe("b");
			await flush();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it("a cleanup render throw is contained: A resolves its value once, cleanup completes, and B shows/settles", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = syncRequest("app", "a");
			const b = syncRequest("app", "b");
			const ha = arbiter.present(a.request);
			const hb = arbiter.present(b.request);
			expect(events).toEqual(["replace:a", "focus:a", "render"]);

			// The cleanup render throws once on its first call after A's mount
			// render (the wrapper is installed after mount, so the cleanup render
			// is the first counted call); later mount/handoff/restore renders
			// must not throw or they would be swallowed by the contained cleanup
			// policy.
			const boom = new Error("render boom");
			let renderCalls = 0;
			let threw = false;
			const originalRender = host.requestRender;
			host.requestRender = () => {
				originalRender();
				renderCalls += 1;
				if (!threw && renderCalls === 1) {
					threw = true;
					throw boom;
				}
			};

			// The cleanup error is contained: the settlement must not throw, and
			// the full cleanup sequence (clear, focus-null, render) still
			// completes synchronously in order.
			expect(() => ha.settle("a")).not.toThrow();
			expect(threw).toBe(true);
			expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);

			// A resolves its original value exactly once despite the render throw;
			// the mounted component is disposed exactly once.
			expect(await ha.result).toBe("a");
			expect(a.component.dispose).toHaveBeenCalledTimes(1);

			// The queued successor still shows and settles on the handoff.
			await flush();
			expect(b.show).toHaveBeenCalledTimes(1);
			expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);
			hb.settle("b");
			expect(await hb.result).toBe("b");
			await flush();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it.each([
		{ name: "clear", throwIn: "replace" as const },
		{ name: "focus-null", throwIn: "focus" as const },
		{ name: "render", throwIn: "render" as const },
	])(
		"a one-shot host throw from the stale-clear %s is contained: A keeps its outcome, the remaining clear phases run, and B still constructs and settles on the same handoff",
		async ({ throwIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const unhandled: unknown[] = [];
			const handler = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", handler);
			try {
				const boom = new Error("a boom");
				const a = asyncRequest("app", "a");
				const b = syncRequest("app", "b");
				const ha = arbiter.present(a.request);
				const hb = arbiter.present(b.request);
				expect(events).toEqual([]);

				// Replace the current editor while A constructs so the preserved
				// editor is stale when the handoff decides to clear it.
				setCurrentEditor(makeComponent("replacement").component);

				// One-shot throw from the chosen stale-clear stage. The clear
				// replaces the surface with undefined and the focus-null stage
				// focuses null, so those arguments distinguish the stale-clear call
				// from the later restore/mount calls; the render stage throws on
				// its first call (the stale-clear render).
				let threw = false;
				const originalReplace = host.replaceEditorSurface;
				const originalFocus = host.setFocus;
				const originalRender = host.requestRender;
				if (throwIn === "replace") {
					host.replaceEditorSurface = (component?: Component) => {
						originalReplace(component);
						if (!threw && component === undefined) {
							threw = true;
							throw new Error("stale-clear replace boom");
						}
					};
				} else if (throwIn === "focus") {
					host.setFocus = (component: Component | null) => {
						originalFocus(component);
						if (!threw && component === null) {
							threw = true;
							throw new Error("stale-clear focus boom");
						}
					};
				} else {
					host.requestRender = () => {
						originalRender();
						if (!threw) {
							threw = true;
							throw new Error("stale-clear render boom");
						}
					};
				}

				// A's original error outcome is unchanged and no throw escapes the
				// handoff microtask.
				a.reject(boom);
				await expect(ha.result).rejects.toBe(boom);
				await flush();

				// The throw was contained: the full stale clear (clear, focus-null,
				// render) ran in order and B still constructed on the same handoff.
				expect(threw).toBe(true);
				expect(b.show).toHaveBeenCalledTimes(1);
				expect(events.slice(0, 3)).toEqual(["replace:clear", "focus:null", "render"]);
				expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);

				// B settles normally; the current editor is restored and the
				// arbiter idles (not wedged on handoffPending).
				hb.settle("b");
				expect(await hb.result).toBe("b");
				await flush();
				expect(events.slice(-3)).toEqual(["replace:replacement", "focus:replacement", "render"]);
				expect(arbiter.isBusy()).toBe(false);
				await flush();
				expect(unhandled).toEqual([]);
			} finally {
				process.removeListener("unhandledRejection", handler);
			}
		},
	);

	it.each([
		{ name: "replace", throwIn: "replace" as const },
		{ name: "focus", throwIn: "focus" as const },
		{ name: "render", throwIn: "render" as const },
	])(
		"a one-shot host throw from the no-successor restore %s is contained: A keeps its outcome, the remaining restore phases run, identity is re-read, and the arbiter idles",
		async ({ throwIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const unhandled: unknown[] = [];
			const handler = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", handler);
			try {
				const boom = new Error("a boom");
				const a = asyncRequest("app", "a");
				const ha = arbiter.present(a.request);
				expect(events).toEqual([]);

				// The current editor is replaced while A constructs, so the
				// no-successor handoff must run a restoration pass.
				const replacement = makeComponent("replacement").component;
				setCurrentEditor(replacement);

				// One-shot throw from the chosen restore stage. The restore targets
				// the replacement editor (never undefined/null), so defined-argument
				// conditions distinguish the restore call from any cleanup clear;
				// the render stage throws on its first call.
				let threw = false;
				const originalReplace = host.replaceEditorSurface;
				const originalFocus = host.setFocus;
				const originalRender = host.requestRender;
				if (throwIn === "replace") {
					host.replaceEditorSurface = (component?: Component) => {
						originalReplace(component);
						if (!threw && component !== undefined) {
							threw = true;
							throw new Error("restore replace boom");
						}
					};
				} else if (throwIn === "focus") {
					host.setFocus = (component: Component | null) => {
						originalFocus(component);
						if (!threw && component !== null) {
							threw = true;
							throw new Error("restore focus boom");
						}
					};
				} else {
					host.requestRender = () => {
						originalRender();
						if (!threw) {
							threw = true;
							throw new Error("restore render boom");
						}
					};
				}

				a.reject(boom);
				await expect(ha.result).rejects.toBe(boom);
				await flush();

				// The throw was contained and the remaining restore phases still
				// ran in order; the identity re-read after the callbacks converged,
				// so the arbiter idles rather than wedging handoffPending.
				expect(threw).toBe(true);
				expect(events).toEqual(["replace:replacement", "focus:replacement", "render"]);
				expect(arbiter.isBusy()).toBe(false);
				await flush();
				await flush();
				expect(events).toEqual(["replace:replacement", "focus:replacement", "render"]);
				expect(arbiter.isBusy()).toBe(false);
				expect(unhandled).toEqual([]);
			} finally {
				process.removeListener("unhandledRejection", handler);
			}
		},
	);

	it.each([
		{ name: "clear", throwIn: "replace" as const },
		{ name: "focus-null", throwIn: "focus" as const },
		{ name: "render", throwIn: "render" as const },
	])(
		"a failClosed %s host throw is contained: the arbiter still ends fail-closed busy with no further microtasks and disposeAll escapes",
		async ({ throwIn }) => {
			const { host, events, setCurrentEditor } = createHost();
			const arbiter = new DialogArbiter(host);
			const unhandled: unknown[] = [];
			const handler = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", handler);
			try {
				const boom = new Error("boom");
				const initial = asyncRequest("app", "a");
				const h = arbiter.present(initial.request);
				let outcome: unknown = "pending";
				void h.result.then(
					(value) => {
						outcome = value;
					},
					(error) => {
						outcome = error;
					},
				);
				setCurrentEditor(makeComponent("editor0").component);

				// Every replace pass changes the current editor so the restore
				// never converges; one-shot throws from the chosen failClosed stage.
				let pass = 0;
				let renderCalls = 0;
				let threw = false;
				const originalReplace = host.replaceEditorSurface;
				const originalFocus = host.setFocus;
				const originalRender = host.requestRender;
				host.replaceEditorSurface = (component?: Component) => {
					setCurrentEditor(makeComponent(`editor${++pass}`).component);
					originalReplace(component);
					if (!threw && throwIn === "replace" && component === undefined) {
						threw = true;
						throw new Error("failClosed replace boom");
					}
				};
				if (throwIn === "focus") {
					host.setFocus = (component: Component | null) => {
						originalFocus(component);
						if (!threw && component === null) {
							threw = true;
							throw new Error("failClosed focus boom");
						}
					};
				}
				if (throwIn === "render") {
					host.requestRender = () => {
						originalRender();
						renderCalls += 1;
						// The ninth render is the failClosed render: eight restore
						// passes each rendered once before fail closed ran.
						if (!threw && renderCalls === 9) {
							threw = true;
							throw new Error("failClosed render boom");
						}
					};
				}

				initial.reject(boom);
				await flush();
				await flush();

				expect(outcome).toBe(boom);
				// Exactly eight named restore passes, then one final
				// clear/null/render sequence that threw once at the chosen stage
				// but still completed under containment.
				expect(events.filter((e) => e.startsWith("replace:editor"))).toHaveLength(8);
				expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);
				expect(threw).toBe(true);

				// No event growth after additional turns; the arbiter stays busy.
				const settledCount = events.length;
				await flush();
				await flush();
				expect(events.length).toBe(settledCount);
				expect(arbiter.isBusy()).toBe(true);

				// Subsequent requests queue and never show.
				const successor = syncRequest("app", "succ");
				const hSucc = arbiter.present(successor.request);
				let succOutcome: unknown = "pending";
				let succSettlements = 0;
				void hSucc.result.then(
					(value) => {
						succOutcome = value;
						succSettlements += 1;
					},
					(error) => {
						succOutcome = error;
						succSettlements += 1;
					},
				);
				expect(successor.show).not.toHaveBeenCalled();
				await flush();
				expect(successor.show).not.toHaveBeenCalled();

				// The queued request remains pending: fail-closed queues rather
				// than immediately evicting or rejecting.
				expect(succOutcome).toBe("pending");
				expect(succSettlements).toBe(0);

				// disposeAll settles the queue with no post-dispose UI.
				const beforeDispose = events.length;
				arbiter.disposeAll();
				await expect(hSucc.result).rejects.toMatchObject({ name: "AbortError" });
				expect(succOutcome).toBeInstanceOf(Error);
				expect((succOutcome as Error).name).toBe("AbortError");
				expect(succSettlements).toBe(1);
				await flush();
				expect(events.length).toBe(beforeDispose);
				expect(successor.show).not.toHaveBeenCalled();
				expect(unhandled).toEqual([]);
			} finally {
				process.removeListener("unhandledRejection", handler);
			}
		},
	);

	it("a mount focus-setter throw rejects A with the exact error once, disposes the component once, and B progresses", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = asyncRequest("app", "a");
			const b = syncRequest("app", "b");
			const ha = arbiter.present(a.request);
			const hb = arbiter.present(b.request);
			expect(events).toEqual([]);

			const boom = new Error("unique mount focus boom");
			let threw = false;
			const originalFocus = host.setFocus;
			host.setFocus = (component: Component | null) => {
				originalFocus(component);
				if (!threw && component === a.component) {
					threw = true;
					throw boom;
				}
			};

			let outcome: unknown = "pending";
			void ha.result.then(
				(value) => {
					outcome = value;
				},
				(error) => {
					outcome = error;
				},
			);
			a.resolve({ component: a.component, focus: a.component });
			await flush();

			expect(threw).toBe(true);
			// A rejects with the exact mount error once, never orphaning the result.
			expect(outcome).toBe(boom);
			await expect(ha.result).rejects.toBe(boom);
			expect(a.component.dispose).toHaveBeenCalledTimes(1);
			// Normal mounted cleanup ran under the contained policy (clear, focus
			// null, render) before the handoff constructed B.
			expect(events).toContain("replace:clear");
			expect(events).toContain("focus:null");
			expect(events.indexOf("replace:clear")).toBeLessThan(events.indexOf("replace:b"));
			expect(events.indexOf("focus:null")).toBeLessThan(events.indexOf("replace:b"));

			// The queued successor progresses on the handoff and settles.
			expect(b.show).toHaveBeenCalledTimes(1);
			expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);
			hb.settle("b");
			expect(await hb.result).toBe("b");
			await flush();
			// Neither the mount error nor the .then continuation may produce an
			// unhandled rejection.
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it.each([
		{ name: "replace", throwIn: "replace" as const },
		{ name: "focus", throwIn: "focus" as const },
		{ name: "render", throwIn: "render" as const },
	])("a sync mount %s throw rejects A with the exact error and present never throws", async ({ throwIn }) => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = syncRequest("app", "a");
			const b = syncRequest("app", "b");
			const boom = new Error(`mount ${throwIn} boom`);
			const originalReplace = host.replaceEditorSurface;
			const originalFocus = host.setFocus;
			const originalRender = host.requestRender;
			if (throwIn === "replace") {
				host.replaceEditorSurface = (component?: Component) => {
					originalReplace(component);
					if (component === a.component) throw boom;
				};
			} else if (throwIn === "focus") {
				host.setFocus = (component: Component | null) => {
					originalFocus(component);
					if (component === a.component) throw boom;
				};
			} else {
				// The render throw happens only on A's mount render (the first
				// render call); later cleanup/handoff/restore renders must not
				// throw or they would hit the contained cleanup/restore policy
				// and be swallowed rather than rejecting A.
				let renderCalls = 0;
				host.requestRender = () => {
					originalRender();
					renderCalls += 1;
					if (renderCalls === 1) throw boom;
				};
			}

			const ha = arbiter.present(a.request);
			// The mount error settles A's result synchronously inside present
			// without the call itself throwing.
			await expect(ha.result).rejects.toBe(boom);
			expect(a.component.dispose).toHaveBeenCalledTimes(1);
			const hb = arbiter.present(b.request);

			await flush();
			expect(b.show).toHaveBeenCalledTimes(1);
			expect(events.slice(-3)).toEqual(["replace:b", "focus:b", "render"]);
			hb.settle("b");
			expect(await hb.result).toBe("b");
			await flush();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it("disposeAll with a cleanup focus-setter throw settles A and B once by cancel policy, B unshown, repeated dispose idempotent", async () => {
		const { host, events } = createHost();
		const arbiter = new DialogArbiter(host);
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			const a = syncRequest("app", "a", undefined, { cancel: () => "cancel-a" });
			const b = syncRequest("app", "b", undefined, { cancel: () => "cancel-b", onEvict: vi.fn() });
			const ha = arbiter.present(a.request);
			const hb = arbiter.present(b.request);
			expect(events).toEqual(["replace:a", "focus:a", "render"]);

			const boom = new Error("dispose focus boom");
			let threw = false;
			const originalFocus = host.setFocus;
			host.setFocus = (component: Component | null) => {
				originalFocus(component);
				if (!threw && component === null) {
					threw = true;
					throw boom;
				}
			};

			// The first external disposeAll must not throw and must finish the
			// mounted cleanup; repeated dispose is idempotent.
			expect(() => arbiter.disposeAll()).not.toThrow();
			expect(() => arbiter.disposeAll()).not.toThrow();
			expect(threw).toBe(true);

			expect(await ha.result).toBe("cancel-a");
			expect(a.component.dispose).toHaveBeenCalledTimes(1);
			expect(await hb.result).toBe("cancel-b");
			expect(b.show).not.toHaveBeenCalled();
			// Full best-effort cleanup phases completed: clear, focus-null, render.
			expect(events.slice(-3)).toEqual(["replace:clear", "focus:null", "render"]);
			// Renders: one for A's mount, one for the cleanup; none after dispose.
			expect(events).toEqual(["replace:a", "focus:a", "render", "replace:clear", "focus:null", "render"]);

			await flush();
			expect(unhandled).toEqual([]);
			// Terminal: no UI event growth on later turns.
			const settledCount = events.length;
			await flush();
			await flush();
			expect(events.length).toBe(settledCount);
			expect(arbiter.isBusy()).toBe(true);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	it("reports busy forever once disposed", () => {
		const { host } = createHost();
		const arbiter = new DialogArbiter(host);
		arbiter.disposeAll();

		expect(arbiter.isBusy()).toBe(true);
	});
});

describe("InteractiveMode.stop ordering harness", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	type StopContext = {
		order: string[];
		isInitialized: boolean;
		unregisterSignalHandlers: ReturnType<typeof vi.fn>;
		clearCtrlCExitHint: ReturnType<typeof vi.fn>;
		clearEscapeRepeat: ReturnType<typeof vi.fn>;
		settingsManager: { getShowTerminalProgress: () => boolean };
		ui: { terminal: { setProgress: ReturnType<typeof vi.fn> }; stop: ReturnType<typeof vi.fn> };
		stopWorkingLoader: ReturnType<typeof vi.fn>;
		endFeatureHintRun: ReturnType<typeof vi.fn>;
		stopWorkingPulse: ReturnType<typeof vi.fn>;
		stopGoalTrayTimer: ReturnType<typeof vi.fn>;
		closeHeartbeatManager: ReturnType<typeof vi.fn>;
		clearExtensionTerminalInputListeners: ReturnType<typeof vi.fn>;
		footer: { dispose: ReturnType<typeof vi.fn> };
		footerDataProvider: { dispose: ReturnType<typeof vi.fn> };
		unsubscribe?: ReturnType<typeof vi.fn>;
		dialogArbiter: { disposeAll: ReturnType<typeof vi.fn> };
	};

	function createStopContext(options: { isInitialized: boolean; preserveAltScreen?: boolean }): StopContext {
		const order: string[] = [];
		return {
			order,
			isInitialized: options.isInitialized,
			unregisterSignalHandlers: vi.fn(),
			clearCtrlCExitHint: vi.fn(),
			clearEscapeRepeat: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: {
				terminal: { setProgress: vi.fn(() => order.push("setProgress")) },
				stop: vi.fn(() => order.push("ui.stop")),
			},
			stopWorkingLoader: vi.fn(),
			endFeatureHintRun: vi.fn(),
			stopWorkingPulse: vi.fn(),
			stopGoalTrayTimer: vi.fn(),
			closeHeartbeatManager: vi.fn(),
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe: vi.fn(),
			dialogArbiter: {
				disposeAll: vi.fn(() => order.push("disposeAll")),
			},
		};
	}

	it("calls arbiter.disposeAll before ui.stop with isInitialized true and preserves stop options", () => {
		const context = createStopContext({ isInitialized: true });
		context.ui.stop = vi.fn((_options: unknown) => context.order.push("ui.stop"));

		Reflect.get(InteractiveMode.prototype, "stop").call(context, { preserveAltScreen: true });

		expect(context.dialogArbiter.disposeAll).toHaveBeenCalledTimes(1);
		expect(context.ui.stop).toHaveBeenCalledTimes(1);
		expect(context.ui.stop).toHaveBeenCalledWith({ preserveAltScreen: true, flushFullscreen: false });
		expect(context.isInitialized).toBe(false);
		expect(context.order.indexOf("disposeAll")).toBeLessThan(context.order.indexOf("ui.stop"));
	});

	it("still calls arbiter.disposeAll when not initialized but skips ui.stop", () => {
		const context = createStopContext({ isInitialized: false });

		Reflect.get(InteractiveMode.prototype, "stop").call(context, {});

		expect(context.dialogArbiter.disposeAll).toHaveBeenCalledTimes(1);
		expect(context.ui.stop).not.toHaveBeenCalled();
	});

	it("disposes the arbiter before footer and connection teardown complete in one pass", () => {
		const context = createStopContext({ isInitialized: true });

		Reflect.get(InteractiveMode.prototype, "stop").call(context, {});

		expect(context.footer.dispose).toHaveBeenCalledTimes(1);
		expect(context.footerDataProvider.dispose).toHaveBeenCalledTimes(1);
		expect(context.unsubscribe).toHaveBeenCalledTimes(1);
		expect(context.order.indexOf("disposeAll")).toBeLessThan(context.order.indexOf("ui.stop"));
	});
});
