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
