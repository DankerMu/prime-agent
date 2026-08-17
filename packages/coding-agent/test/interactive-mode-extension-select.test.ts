import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type UIContextStub = {
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
};

// Typed access to the private createExtensionUIContext, exposing the select and confirm signatures.
const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as {
		createExtensionUIContext(this: unknown): UIContextStub;
	}
).createExtensionUIContext;

// Typed access to the private resetExtensionUI so the REAL reset runs against
// own-property stubs prepared by the test.
const resetExtensionUI = (
	InteractiveMode.prototype as unknown as {
		resetExtensionUI(this: unknown): void;
	}
).resetExtensionUI;

// Typed access to the private showExtensionSelector so the REAL implementation
// runs against a substituted dialogArbiter prepared by the test.
const showExtensionSelector = (
	InteractiveMode.prototype as unknown as {
		showExtensionSelector(
			this: unknown,
			title: string,
			options: string[],
			opts?: { signal?: AbortSignal; timeout?: number },
		): Promise<string | undefined>;
	}
).showExtensionSelector;

// Typed access to the private handleReloadCommand so the REAL reload runs
// against own-property stubs prepared by the test.
const handleReloadCommand = (
	InteractiveMode.prototype as unknown as {
		handleReloadCommand(this: unknown): Promise<void>;
	}
).handleReloadCommand;

interface Harness {
	target: InteractiveMode;
	arbiter: DialogArbiter;
	editor: Container;
	editorContainer: Container;
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
}

function makeHarness(rows = 24): Harness {
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const editor = new Container();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const ui = {
		setFocus,
		requestRender,
		terminal: { rows },
	};
	const arbiter = new DialogArbiter({
		replaceEditorSurface: (component) => {
			editorContainer.clear();
			if (component) editorContainer.addChild(component);
		},
		setFocus: (component) => setFocus(component),
		requestRender: () => requestRender(),
		getCurrentEditor: () => editor,
	});
	const target = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		editorContainer,
		editor,
		defaultEditor: editor,
		ui,
		dialogArbiter: arbiter,
	});
	return { target, arbiter, editor, editorContainer, setFocus, requestRender };
}

function presentAppBlocker(
	arbiter: DialogArbiter,
	component: Component,
): {
	done: (value: string) => void;
	handle: { result: Promise<string>; settle(value: string): void };
} {
	let capturedDone: ((value: string) => void) | undefined;
	const handle = arbiter.present<string>({
		kind: "app",
		show: (done) => {
			capturedDone = done;
			return { component, focus: component };
		},
	});
	return {
		done: (value) => capturedDone?.(value),
		handle,
	};
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Stub the unrelated reload/reset dependencies so the REAL reset and reload run
// against a held-in-flight agentConnection.reload.
function prepareReloadTarget(h: Harness, reloadPending: Promise<never>): void {
	const ownUi = (
		h.target as unknown as {
			ui: { setFocus: unknown; requestRender: unknown; terminal: unknown };
		}
	).ui;
	const uiWithOverlay = {
		setFocus: ownUi.setFocus,
		requestRender: ownUi.requestRender,
		terminal: ownUi.terminal,
		hideOverlay: vi.fn(),
	};
	(h.target as unknown as { ui: typeof uiWithOverlay }).ui = uiWithOverlay;
	Object.assign(h.target as unknown as Record<string, unknown>, {
		connectionState: { isStreaming: false, isCompacting: false },
		activeConnectionExtensionUiRequests: new Map<string, { cancelLocal: () => void }>(),
		agentConnection: {
			respondToExtensionUiRequest: vi.fn(async () => undefined),
			reload: vi.fn(() => reloadPending),
		},
		closeHeartbeatManager: vi.fn(),
		showError: vi.fn(),
		clearExtensionTerminalInputListeners: vi.fn(),
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		footer: { invalidate: vi.fn() },
		autocompleteProviderWrappers: [],
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		defaultEditor: h.editor,
		updateTerminalTitle: vi.fn(),
		workingMessage: undefined,
		workingVisible: true,
		setWorkingIndicator: vi.fn(),
		loadingAnimation: undefined,
		setHiddenThinkingLabel: vi.fn(),
		extensionInput: undefined,
		extensionEditor: undefined,
	});
}

interface FakeInterval {
	fn: () => void;
	ms: number;
}

describe("interactive mode extension select ownership", () => {
	test("idle select with timeout mounts real selector; expiry resolves undefined and restores editor/focus", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// Fake only setInterval/clearInterval so queueMicrotask stays real.
		const intervals = new Map<number, FakeInterval>();
		let nextId = 1;
		const setIntervalSpy = vi.fn((fn: () => void, ms: number): number => {
			const id = nextId++;
			intervals.set(id, { fn, ms });
			return id;
		});
		const clearIntervalSpy = vi.fn((id: number) => {
			intervals.delete(id);
		});
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		globalThis.setInterval = setIntervalSpy as unknown as typeof globalThis.setInterval;
		globalThis.clearInterval = clearIntervalSpy as unknown as typeof globalThis.clearInterval;
		try {
			const select = createExtensionUIContext.call(h.target).select;
			const promise = select("Pick an option", ["Alpha", "Beta"], { timeout: 2500 });

			expect(h.editorContainer.children).toHaveLength(1);
			expect(h.editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent);
			expect(intervals.size).toBe(1);

			// The countdown ticks every second, so a 2500ms timeout must stay unsettled
			// through the first two ticks and only expire on the final one: a hardcoded
			// one-second expiry cannot satisfy the oracle.
			const [timer] = [...intervals.values()];
			expect(timer).toBeDefined();
			expect(timer!.ms).toBe(1000);
			let settled = false;
			void promise.then(() => {
				settled = true;
			});
			timer!.fn();
			expect(settled).toBe(false);
			timer!.fn();
			expect(settled).toBe(false);
			timer!.fn();

			await expect(promise).resolves.toBeUndefined();

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.requestRender).toHaveBeenCalled();
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	test("shared arbiter: select queues behind an app blocker that owns the surface", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		expect(h.editorContainer.children).toEqual([blockerComponent]);

		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;

		const select = createExtensionUIContext.call(h.target).select;
		const queued = select("Pick an option", ["Alpha", "Beta"]);

		expect(h.editorContainer.children).toEqual([blockerComponent]);
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);

		blocker.done("ok");
		await expect(blocker.handle.result).resolves.toBe("ok");
		await flush();
		const mounted = h.editorContainer.children[0];
		expect(mounted).toBeInstanceOf(ExtensionSelectorComponent);

		(mounted as ExtensionSelectorComponent).handleInput("\n");
		await expect(queued).resolves.toBe("Alpha");
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("pre-aborted context select resolves undefined without touching arbiter or UI", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const editorChild = h.editorContainer.children;
		const focusCount = h.setFocus.mock.calls.length;
		const renderCount = h.requestRender.mock.calls.length;
		expect(h.arbiter.isBusy()).toBe(false);

		const controller = new AbortController();
		controller.abort();

		const select = createExtensionUIContext.call(h.target).select;
		const result = await select("Never show", ["Alpha"], { signal: controller.signal });

		expect(result).toBeUndefined();
		expect(h.editorContainer.children).toBe(editorChild);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.editorContainer.children[0]).not.toBeInstanceOf(ExtensionSelectorComponent);
		expect(h.setFocus.mock.calls.length).toBe(focusCount);
		expect(h.requestRender.mock.calls.length).toBe(renderCount);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("queued select abort resolves undefined without flashing or disturbing blocker", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		expect(h.editorContainer.children).toEqual([blockerComponent]);

		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;

		const select = createExtensionUIContext.call(h.target).select;
		const controller = new AbortController();
		const promise = select("Abort queued", ["Alpha"], { signal: controller.signal });
		controller.abort();
		await expect(promise).resolves.toBeUndefined();

		expect(h.editorContainer.children).toEqual([blockerComponent]);
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);

		blocker.done("ok");
		await expect(blocker.handle.result).resolves.toBe("ok");
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("visible select abort resolves undefined, disposes the selector, and restores editor/focus", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select;
		const controller = new AbortController();
		const promise = select("Abort visible", ["Alpha"], { signal: controller.signal });

		const mounted = h.editorContainer.children[0];
		expect(mounted).toBeInstanceOf(ExtensionSelectorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(mounted);
		const disposeSpy = vi.spyOn(mounted as ExtensionSelectorComponent, "dispose");

		controller.abort();
		await expect(promise).resolves.toBeUndefined();
		await flush();

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("synchronous AbortError construction failure outranks a same-tick signal abort", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// The constructor reads tui.terminal.rows synchronously (updateList ->
		// getMenuListLayout -> getViewportRows), so a throwing getter makes the real
		// show callback throw the exact construction error before present returns.
		const constructionError = Object.assign(new Error("selector construction failed"), { name: "AbortError" });
		const ownUi = (h.target as unknown as { ui: { setFocus: unknown; requestRender: unknown } }).ui;
		(h.target as unknown as { ui: { setFocus: unknown; requestRender: unknown; terminal: unknown } }).ui = {
			setFocus: ownUi.setFocus,
			requestRender: ownUi.requestRender,
			get terminal(): unknown {
				throw constructionError;
			},
		};

		// The arbiter rejects with the construction error first; the signal abort in
		// the same tick must not remap it to undefined.
		const controller = new AbortController();
		const select = createExtensionUIContext.call(h.target).select;
		const promise = select("Construction failure", ["Alpha"], { signal: controller.signal });
		controller.abort();

		await expect(promise).rejects.toBe(constructionError);
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).not.toHaveBeenCalled();
		expect(h.requestRender).not.toHaveBeenCalled();
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("two extension context selects use the shared arbiter FIFO and keep results paired", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select;

		const first = select("First", ["Alpha", "Beta"]);
		const firstMounted = h.editorContainer.children[0];
		expect(firstMounted).toBeInstanceOf(ExtensionSelectorComponent);

		let firstSettled = false;
		let secondSettled = false;
		void first.then(() => {
			firstSettled = true;
		});

		const second = select("Second", ["Gamma", "Delta"]);
		void second.then(() => {
			secondSettled = true;
		});

		expect(h.editorContainer.children[0]).toBe(firstMounted);
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);

		(firstMounted as ExtensionSelectorComponent).handleInput("\n");
		await first;
		await flush();

		const secondMounted = h.editorContainer.children[0];
		expect(secondMounted).toBeInstanceOf(ExtensionSelectorComponent);
		expect(secondMounted).not.toBe(firstMounted);

		(secondMounted as ExtensionSelectorComponent).handleInput("j");
		(secondMounted as ExtensionSelectorComponent).handleInput("\n");
		await second;
		await flush();

		const firstResult = await first;
		const secondResult = await second;

		expect(firstResult).toBe("Alpha");
		expect(secondResult).toBe("Delta");
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("queued selector creates no timer until displayed and then gets the full timeout", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		expect(h.editorContainer.children).toEqual([blockerComponent]);

		// Fake only setInterval/clearInterval so queueMicrotask stays real.
		const intervals = new Map<number, FakeInterval>();
		let nextId = 1;
		const setIntervalSpy = vi.fn((fn: () => void, ms: number): number => {
			const id = nextId++;
			intervals.set(id, { fn, ms });
			return id;
		});
		const clearIntervalSpy = vi.fn((id: number) => {
			intervals.delete(id);
		});
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		globalThis.setInterval = setIntervalSpy as unknown as typeof globalThis.setInterval;
		globalThis.clearInterval = clearIntervalSpy as unknown as typeof globalThis.clearInterval;
		try {
			const focusBefore = h.setFocus.mock.calls.length;
			const renderBefore = h.requestRender.mock.calls.length;

			const select = createExtensionUIContext.call(h.target).select;
			let settled = false;
			const promise = select("Timed queued", ["Alpha"], { timeout: 1000 });
			void promise.then(() => {
				settled = true;
			});

			expect(h.editorContainer.children).toEqual([blockerComponent]);
			expect(intervals.size).toBe(0);
			expect(h.setFocus.mock.calls.length).toBe(focusBefore);
			expect(h.requestRender.mock.calls.length).toBe(renderBefore);

			await Promise.resolve();
			await Promise.resolve();
			expect(intervals.size).toBe(0);
			expect(settled).toBe(false);

			blocker.done("ok");
			await expect(blocker.handle.result).resolves.toBe("ok");
			await flush();
			expect(h.editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent);
			expect(intervals.size).toBe(1);
			const displayedTimer = [...intervals.values()][0];
			expect(displayedTimer).toBeDefined();
			expect(displayedTimer!.ms).toBe(1000);

			displayedTimer!.fn();
			await expect(promise).resolves.toBeUndefined();
			await flush();

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	test("extension confirm waits behind the shared blocker and returns a boolean", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		expect(h.editorContainer.children).toEqual([blockerComponent]);

		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;

		const confirm = createExtensionUIContext.call(h.target).confirm;
		const promise = confirm("Proceed", "Continue?");
		let settled = false;
		void promise.then(() => {
			settled = true;
		});

		expect(h.editorContainer.children).toEqual([blockerComponent]);
		expect(settled).toBe(false);
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);

		blocker.done("ok");
		await expect(blocker.handle.result).resolves.toBe("ok");
		await flush();
		const displayed = h.editorContainer.children[0];
		expect(displayed).toBeInstanceOf(ExtensionSelectorComponent);

		(displayed as ExtensionSelectorComponent).handleInput("\n");
		await expect(promise).resolves.toBe(true);
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("reset settles visible and queued extension selects as undefined without showing the queued selector", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// Fake only setInterval/clearInterval so queueMicrotask stays real. The queued
		// selector carries a timeout, so its CountdownTimer would create an interval
		// the moment the component was constructed.
		const intervals = new Map<number, FakeInterval>();
		let nextId = 1;
		const setIntervalSpy = vi.fn((fn: () => void, ms: number): number => {
			const id = nextId++;
			intervals.set(id, { fn, ms });
			return id;
		});
		const clearIntervalSpy = vi.fn((id: number) => {
			intervals.delete(id);
		});
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		globalThis.setInterval = setIntervalSpy as unknown as typeof globalThis.setInterval;
		globalThis.clearInterval = clearIntervalSpy as unknown as typeof globalThis.clearInterval;
		try {
			const ctx = createExtensionUIContext.call(h.target);

			const first = ctx.select("First reset", ["Alpha"], { timeout: 1000 });
			const firstMounted = h.editorContainer.children[0];
			expect(firstMounted).toBeInstanceOf(ExtensionSelectorComponent);
			expect(intervals.size).toBe(1);

			let firstSettled = false;
			let firstValue: string | undefined;
			void first.then((value) => {
				firstSettled = true;
				firstValue = value;
			});

			const second = ctx.select("Second reset", ["Gamma"], { timeout: 1000 });
			expect(h.editorContainer.children[0]).toBe(firstMounted);
			expect(intervals.size).toBe(1);

			let secondSettled = false;
			let secondValue: string | undefined;
			void second.then((value) => {
				secondSettled = true;
				secondValue = value;
			});

			// Prepare the target so the REAL reset can run; stub only unrelated
			// responsibilities. Keep the real cancelActiveConnectionExtensionUiRequests
			// (empty map => no-op) and the real arbiter.
			const ownUi = (
				h.target as unknown as {
					ui: { setFocus: unknown; requestRender: unknown; terminal: unknown };
				}
			).ui;
			const uiWithOverlay = {
				setFocus: ownUi.setFocus,
				requestRender: ownUi.requestRender,
				terminal: ownUi.terminal,
				hideOverlay: vi.fn(),
			};
			(h.target as unknown as { ui: typeof uiWithOverlay }).ui = uiWithOverlay;
			Object.assign(h.target as unknown as Record<string, unknown>, {
				activeConnectionExtensionUiRequests: new Map<string, { cancelLocal: () => void }>(),
				agentConnection: {
					respondToExtensionUiRequest: vi.fn(async () => undefined),
				},
				closeHeartbeatManager: vi.fn(),
				showError: vi.fn(),
				clearExtensionTerminalInputListeners: vi.fn(),
				setExtensionFooter: vi.fn(),
				setExtensionHeader: vi.fn(),
				clearExtensionWidgets: vi.fn(),
				footerDataProvider: { clearExtensionStatuses: vi.fn() },
				footer: { invalidate: vi.fn() },
				autocompleteProviderWrappers: [],
				setCustomEditorComponent: vi.fn(),
				setupAutocompleteProvider: vi.fn(),
				defaultEditor: h.editor,
				updateTerminalTitle: vi.fn(),
				workingMessage: undefined,
				workingVisible: true,
				setWorkingIndicator: vi.fn(),
				loadingAnimation: undefined,
				setHiddenThinkingLabel: vi.fn(),
				extensionInput: undefined,
				extensionEditor: undefined,
			});

			resetExtensionUI.call(h.target);
			await Promise.all([first, second]);
			await flush();

			// Only the visible selector's timeout ran: setInterval exactly once proves the
			// queued selector factory never ran, and an empty interval map proves the
			// visible selector's timer was cleared on dispose.
			expect(firstSettled).toBe(true);
			expect(secondSettled).toBe(true);
			expect(firstValue).toBeUndefined();
			expect(secondValue).toBeUndefined();
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(intervals.size).toBe(0);

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	test("reset cancels active transport requests before cancelling extension dialogs", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const events: string[] = [];

		// Wrap the real cancelKind so ordering is observable; target.dialogArbiter is
		// the same object as h.arbiter, so the real reset sees the wrapped method.
		const realCancelKind = h.arbiter.cancelKind.bind(h.arbiter);
		const wrappedCancelKind = vi.fn((kind: "extension" | "app" | "placeholder") => {
			events.push(`cancel-kind:${kind}`);
			realCancelKind(kind);
		});
		h.arbiter.cancelKind = wrappedCancelKind;

		const cancelLocal = vi.fn(() => events.push("transport-cancel"));
		const respond = vi.fn(async () => {
			events.push("transport-response");
		});
		const ownUi = (
			h.target as unknown as {
				ui: { setFocus: unknown; requestRender: unknown; terminal: unknown };
			}
		).ui;
		const uiWithOverlay = {
			setFocus: ownUi.setFocus,
			requestRender: ownUi.requestRender,
			terminal: ownUi.terminal,
			hideOverlay: vi.fn(),
		};
		(h.target as unknown as { ui: typeof uiWithOverlay }).ui = uiWithOverlay;
		Object.assign(h.target as unknown as Record<string, unknown>, {
			activeConnectionExtensionUiRequests: new Map<string, { cancelLocal: () => void }>([
				["req-1", { cancelLocal }],
			]),
			agentConnection: { respondToExtensionUiRequest: respond },
			closeHeartbeatManager: vi.fn(),
			showError: vi.fn(),
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			autocompleteProviderWrappers: [],
			setCustomEditorComponent: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			defaultEditor: h.editor,
			updateTerminalTitle: vi.fn(),
			workingMessage: undefined,
			workingVisible: true,
			setWorkingIndicator: vi.fn(),
			loadingAnimation: undefined,
			setHiddenThinkingLabel: vi.fn(),
			extensionInput: undefined,
			extensionEditor: undefined,
		});

		resetExtensionUI.call(h.target);
		await Promise.resolve();
		await Promise.resolve();

		expect([
			...(
				h.target as unknown as {
					activeConnectionExtensionUiRequests: Map<string, unknown>;
				}
			).activeConnectionExtensionUiRequests.keys(),
		]).toEqual([]);
		expect(cancelLocal).toHaveBeenCalledTimes(1);
		expect(respond).toHaveBeenCalledTimes(1);
		expect(respond).toHaveBeenCalledWith("req-1", { cancelled: true });

		expect(wrappedCancelKind).toHaveBeenCalledTimes(1);
		expect(wrappedCancelKind).toHaveBeenCalledWith("extension");
		expect(events.indexOf("transport-cancel")).toBeLessThan(events.indexOf("cancel-kind:extension"));
		expect(events.indexOf("transport-response")).toBeLessThan(events.indexOf("cancel-kind:extension"));
	});

	test.each([
		{ label: "ordinary error", error: new Error("selector construction failed") },
		{
			label: "AbortError with no aborted signal",
			error: Object.assign(new Error("aborted"), { name: "AbortError" }),
		},
	])("selector mapping propagates $label unchanged", async ({ error }) => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// Only dialogArbiter is substituted: the mapped path presents the extension
		// selector request through the arbiter and must surface its result unchanged.
		const present = vi.fn(() => ({
			result: Promise.reject(error),
			settle: vi.fn(),
		}));
		(h.target as unknown as { dialogArbiter: { present: typeof present } }).dialogArbiter = {
			present,
		};

		const promise = showExtensionSelector.call(h.target, "Pick an option", ["Alpha", "Beta"]);
		// Attach an immediate observer so the stub's rejection is never unhandled.
		void promise.catch(() => {});

		await expect(promise).rejects.toBe(error);
		expect(present).toHaveBeenCalledTimes(1);

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).not.toHaveBeenCalled();
		expect(h.requestRender).not.toHaveBeenCalled();
	});

	test("reload after a visible selector: reset's arbiter handoff finishes before the reload box mounts", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select;
		const selectPromise = select("Reload race", ["Alpha"]);
		const selector = h.editorContainer.children[0];
		expect(selector).toBeInstanceOf(ExtensionSelectorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(selector);

		// Hold the reload in flight so the box stays mounted while the arbiter's
		// queued restore microtask and the reload continuation race to completion.
		let rejectReload!: (error: Error) => void;
		const reloadPending = new Promise<never>((_, reject) => {
			rejectReload = reject;
		});
		prepareReloadTarget(h, reloadPending);

		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});

		// One turn lets the reset arbiter handoff settle; the reload box must then
		// own the surface, so the selector's stale restore must not have run.
		await flush();
		const reloadBox = h.editorContainer.children[0];
		expect(reloadBox).not.toBe(h.editor);
		expect(reloadBox).not.toBe(selector);
		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);

		// Further microtask and process.nextTick turns must not displace the reload
		// box either; it stays the sole owner and focus until reload settles.
		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		expect(reloadDone).toBe(false);

		rejectReload(new Error("reload failed"));
		await expect(reload).resolves.toBeUndefined();
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(await selectPromise).toBeUndefined();
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("idle reload mounts its box synchronously before the returned promise is awaited", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		let rejectReload!: (error: Error) => void;
		const reloadPending = new Promise<never>((_, reject) => {
			rejectReload = reject;
		});
		prepareReloadTarget(h, reloadPending);

		// An idle arbiter must not defer the mount: the box owns the surface and
		// focus immediately on return, before the handler's promise is awaited.
		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});
		const reloadBox = h.editorContainer.children[0];
		expect(reloadBox).not.toBe(h.editor);
		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		expect(h.requestRender).toHaveBeenLastCalledWith(true);

		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		expect(reloadDone).toBe(false);

		rejectReload(new Error("reload failed"));
		await expect(reload).resolves.toBeUndefined();
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});
});
