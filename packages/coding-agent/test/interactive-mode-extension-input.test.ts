import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type InputContextStub = {
	input(
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
};

// Typed access to the private createExtensionUIContext, exposing the input signature.
const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as {
		createExtensionUIContext(this: unknown): InputContextStub;
	}
).createExtensionUIContext;

// Typed access to the private resetExtensionUI so the REAL reset runs against
// own-property stubs prepared by the test.
const resetExtensionUI = (
	InteractiveMode.prototype as unknown as {
		resetExtensionUI(this: unknown): void;
	}
).resetExtensionUI;

// Typed access to the private showExtensionInput so the REAL implementation
// runs against a substituted dialogArbiter prepared by the test.
const showExtensionInput = (
	InteractiveMode.prototype as unknown as {
		showExtensionInput(
			this: unknown,
			title: string,
			placeholder?: string,
			opts?: { signal?: AbortSignal; timeout?: number },
		): Promise<string | undefined>;
	}
).showExtensionInput;

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

// Stub the unrelated reset responsibilities so the REAL reset runs against a
// held-in-flight set of extension input requests. Keeps the real
// cancelActiveConnectionExtensionUiRequests (empty map => no-op) and the real
// dialogArbiter.
function prepareResetTarget(h: Harness): void {
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
	});
}

interface FakeInterval {
	fn: () => void;
	ms: number;
}

function installIntervalSpies(): {
	intervals: Map<number, FakeInterval>;
	setIntervalSpy: ReturnType<typeof vi.fn>;
	clearIntervalSpy: ReturnType<typeof vi.fn>;
	restore: () => void;
} {
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
	return {
		intervals,
		setIntervalSpy,
		clearIntervalSpy,
		restore: () => {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		},
	};
}

describe("interactive mode extension input ownership", () => {
	test("input queues behind the shared app blocker; on release it mounts and three one-second ticks prove full 2500ms timeout passthrough", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const { intervals, restore } = installIntervalSpies();
		try {
			const blockerComponent = new Container();
			const blocker = presentAppBlocker(h.arbiter, blockerComponent);

			expect(h.editorContainer.children).toEqual([blockerComponent]);

			const focusBefore = h.setFocus.mock.calls.length;
			const renderBefore = h.requestRender.mock.calls.length;

			const input = createExtensionUIContext.call(h.target).input;
			let settled = false;
			const promise = input("Pick a title", "hint", { timeout: 2500 });
			void promise.then(() => {
				settled = true;
			});

			// While blocked the input stays unconstructed and timerless and never
			// touches the surface, focus, or render. (Placeholder has no observable
			// behavior on the component; it is verified later by callsite audit.)
			expect(h.editorContainer.children).toEqual([blockerComponent]);
			expect(intervals.size).toBe(0);
			expect(h.setFocus.mock.calls.length).toBe(focusBefore);
			expect(h.requestRender.mock.calls.length).toBe(renderBefore);
			expect(settled).toBe(false);

			blocker.done("ok");
			await expect(blocker.handle.result).resolves.toBe("ok");
			await flush();

			const mounted = h.editorContainer.children[0];
			expect(mounted).toBeInstanceOf(ExtensionInputComponent);
			expect(stripAnsi((mounted as ExtensionInputComponent).render(80).join("\n"))).toContain("Pick a title");
			const disposeSpy = vi.spyOn(mounted as ExtensionInputComponent, "dispose");
			expect(intervals.size).toBe(1);

			// The countdown ticks every second, so a 2500ms timeout must stay
			// unsettled through the first two ticks and only expire on the final one:
			// a hardcoded one-second expiry cannot satisfy the oracle.
			const [timer] = [...intervals.values()];
			expect(timer).toBeDefined();
			expect(timer!.ms).toBe(1000);
			timer!.fn();
			expect(settled).toBe(false);
			timer!.fn();
			expect(settled).toBe(false);
			timer!.fn();

			await expect(promise).resolves.toBeUndefined();
			await flush();

			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(intervals.size).toBe(0);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			restore();
		}
	});

	test("idle input submit returns the exact typed string, restores editor/focus, and becomes idle", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const input = createExtensionUIContext.call(h.target).input;
		const promise = input("Label", "hint");
		const mounted = h.editorContainer.children[0];
		expect(mounted).toBeInstanceOf(ExtensionInputComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(mounted);

		(mounted as ExtensionInputComponent).handleInput("hello world");
		(mounted as ExtensionInputComponent).handleInput("\n");

		await expect(promise).resolves.toBe("hello world");
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("pre-aborted input context resolves undefined without touching container, focus, render, or arbiter", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const editorChild = h.editorContainer.children;
		const focusCount = h.setFocus.mock.calls.length;
		const renderCount = h.requestRender.mock.calls.length;
		expect(h.arbiter.isBusy()).toBe(false);

		const controller = new AbortController();
		controller.abort();

		const input = createExtensionUIContext.call(h.target).input;
		const result = await input("Never show", "hint", { signal: controller.signal });

		expect(result).toBeUndefined();
		expect(h.editorContainer.children).toBe(editorChild);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.editorContainer.children[0]).not.toBeInstanceOf(ExtensionInputComponent);
		expect(h.setFocus.mock.calls.length).toBe(focusCount);
		expect(h.requestRender.mock.calls.length).toBe(renderCount);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("visible input abort resolves undefined, disposes the mounted component exactly once, and restores editor/focus", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const input = createExtensionUIContext.call(h.target).input;
		const controller = new AbortController();
		const promise = input("Abort visible", "hint", { signal: controller.signal });

		const mounted = h.editorContainer.children[0];
		expect(mounted).toBeInstanceOf(ExtensionInputComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(mounted);
		const disposeSpy = vi.spyOn(mounted as ExtensionInputComponent, "dispose");

		controller.abort();
		await expect(promise).resolves.toBeUndefined();
		await flush();

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("real reset settles visible and queued inputs; the queued input never constructs, only one timer ever runs, and it is cleared", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const { intervals, setIntervalSpy, restore } = installIntervalSpies();
		try {
			const ctx = createExtensionUIContext.call(h.target);

			const first = ctx.input("First reset", "hint", { timeout: 1000 });
			const firstMounted = h.editorContainer.children[0];
			expect(firstMounted).toBeInstanceOf(ExtensionInputComponent);
			const disposeSpy = vi.spyOn(firstMounted as ExtensionInputComponent, "dispose");
			expect(intervals.size).toBe(1);

			let firstValue: string | undefined;
			void first.then((value) => {
				firstValue = value;
			});

			const second = ctx.input("Second reset", "hint", { timeout: 1000 });
			expect(h.editorContainer.children[0]).toBe(firstMounted);
			expect(intervals.size).toBe(1);

			let secondValue: string | undefined;
			void second.then((value) => {
				secondValue = value;
			});

			// Prepare the target so the REAL reset can run; stub only unrelated
			// responsibilities. Keep the real cancelActiveConnectionExtensionUiRequests
			// (empty map => no-op) and the real arbiter.
			prepareResetTarget(h);
			resetExtensionUI.call(h.target);

			await Promise.all([first, second]);
			await flush();

			// Only the visible input's timeout ran: setInterval exactly once proves
			// the queued input factory never ran, and an empty interval map proves the
			// visible input's timer was cleared on dispose. The arbiter disposed the
			// visible component exactly once.
			expect(firstValue).toBeUndefined();
			expect(secondValue).toBeUndefined();
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(intervals.size).toBe(0);

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			restore();
		}
	});

	test.each([
		{ label: "ordinary error", error: new Error("input construction failed") },
		{
			label: "AbortError with no aborted signal",
			error: Object.assign(new Error("aborted"), { name: "AbortError" }),
		},
	])("input mapping propagates $label unchanged", async ({ error }) => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// Only dialogArbiter is substituted: the mapped path presents the extension
		// input request through the arbiter and must surface its result unchanged.
		const present = vi.fn(() => ({
			result: Promise.reject(error),
			settle: vi.fn(),
		}));
		(h.target as unknown as { dialogArbiter: { present: typeof present } }).dialogArbiter = {
			present,
		};

		const promise = showExtensionInput.call(h.target, "Title", "hint");

		await expect(promise).rejects.toBe(error);
		expect(present).toHaveBeenCalledTimes(1);

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).not.toHaveBeenCalled();
		expect(h.requestRender).not.toHaveBeenCalled();
	});

	test("synchronous AbortError construction failure outranks a same-tick signal abort", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// The real ExtensionInputComponent builds its CountdownTimer inside show when
		// a timeout is present, and CountdownTimer starts its interval in its own
		// constructor. Replacing the real global setInterval with a throwing function
		// makes the real show callback fail synchronously with the exact construction
		// error before present returns; the arbiter rejects with that error first, so
		// a same-tick signal abort must not remap it to undefined.
		const constructionError = Object.assign(new Error("input construction failed"), { name: "AbortError" });
		const originalSetInterval = globalThis.setInterval;
		globalThis.setInterval = (() => {
			throw constructionError;
		}) as unknown as typeof globalThis.setInterval;
		try {
			const controller = new AbortController();
			const input = createExtensionUIContext.call(h.target).input;
			const promise = input("Construction failure", "hint", { signal: controller.signal, timeout: 1000 });
			controller.abort();

			await expect(promise).rejects.toBe(constructionError);
			await flush();

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).not.toHaveBeenCalled();
			expect(h.requestRender).not.toHaveBeenCalled();
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			globalThis.setInterval = originalSetInterval;
		}
	});
});
