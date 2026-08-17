import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { type KeybindingsConfig, KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import * as themeModule from "../src/modes/interactive/theme/theme.js";

type UIContextStub = {
	editor(title: string, prefill?: string): Promise<string | undefined>;
};

const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as {
		createExtensionUIContext(this: unknown): UIContextStub;
	}
).createExtensionUIContext;

const resetExtensionUI = (
	InteractiveMode.prototype as unknown as {
		resetExtensionUI(this: unknown): void;
	}
).resetExtensionUI;

const showExtensionEditor = (
	InteractiveMode.prototype as unknown as {
		showExtensionEditor(this: unknown, title: string, prefill?: string): Promise<string | undefined>;
	}
).showExtensionEditor;

interface Harness {
	target: InteractiveMode;
	arbiter: DialogArbiter;
	editor: Container;
	editorContainer: Container;
	surfaceChanges: Array<Component | undefined>;
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	keybindings: KeybindingsManager;
}

function makeHarness(rows = 24, userBindings: KeybindingsConfig = {}): Harness {
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const editor = new Container();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const surfaceChanges: Array<Component | undefined> = [];
	const ui = {
		setFocus,
		requestRender,
		terminal: { rows },
	};
	const keybindings = new KeybindingsManager(userBindings);
	const arbiter = new DialogArbiter({
		replaceEditorSurface: (component) => {
			surfaceChanges.push(component);
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
		keybindings,
	});
	return { target, arbiter, editor, editorContainer, surfaceChanges, setFocus, requestRender, keybindings };
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

describe("interactive mode extension editor ownership", () => {
	test("queues behind the shared app blocker and submits the prefilled multiline text after release", async () => {
		themeModule.initTheme("dark");
		const h = makeHarness();
		setKeybindings(h.keybindings);
		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);
		const blockerSurface = h.editorContainer.children;
		const surfaceChangesBefore = [...h.surfaceChanges];
		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;
		const prefill = "prefilled first\nprefilled second\n";

		const promise = createExtensionUIContext.call(h.target).editor("Blocked editor title", prefill);

		expect(h.editorContainer.children).toBe(blockerSurface);
		expect(h.editorContainer.children).toEqual([blockerComponent]);
		expect(h.surfaceChanges).toEqual(surfaceChangesBefore);
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);
		expect(prefill.endsWith("\n")).toBe(true);

		blocker.done("released");
		await expect(blocker.handle.result).resolves.toBe("released");
		await flush();

		const mounted = h.editorContainer.children[0];
		expect(mounted).toBeInstanceOf(ExtensionEditorComponent);
		expect(h.surfaceChanges).toEqual([...surfaceChangesBefore, undefined, mounted]);
		expect(h.setFocus).toHaveBeenLastCalledWith(mounted);
		const rendered = stripAnsi((mounted as ExtensionEditorComponent).render(80).join("\n"));
		expect(rendered).toContain("Blocked editor title");
		expect(rendered).toContain("prefilled first");
		expect(rendered).toContain("prefilled second");

		(mounted as ExtensionEditorComponent).handleInput("typed first");
		(mounted as ExtensionEditorComponent).handleInput("\n");
		(mounted as ExtensionEditorComponent).handleInput("typed second");
		(mounted as ExtensionEditorComponent).handleInput("\r");

		await expect(promise).resolves.toBe("prefilled first\nprefilled second\ntyped first\ntyped second");
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("configured cancel key resolves undefined, restores editor focus, and becomes idle", async () => {
		themeModule.initTheme("dark");
		const h = makeHarness(24, { "tui.select.cancel": "x" });
		setKeybindings(h.keybindings);

		const promise = createExtensionUIContext.call(h.target).editor("Cancel visible");
		const mounted = h.editorContainer.children[0];
		expect(mounted).toBeInstanceOf(ExtensionEditorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(mounted);

		(mounted as ExtensionEditorComponent).handleInput("x");

		await expect(promise).resolves.toBeUndefined();
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("reset settles the visible and queued editors once as undefined without flashing the queued editor", async () => {
		themeModule.initTheme("dark");
		const getEditorThemeSpy = vi.spyOn(themeModule, "getEditorTheme");
		try {
			const h = makeHarness();
			setKeybindings(h.keybindings);
			const ctx = createExtensionUIContext.call(h.target);

			const first = ctx.editor("First reset");
			const firstMounted = h.editorContainer.children[0];
			expect(firstMounted).toBeInstanceOf(ExtensionEditorComponent);
			const getEditorThemeCallsAfterFirst = getEditorThemeSpy.mock.calls.length;
			expect(getEditorThemeCallsAfterFirst).toBeGreaterThan(0);
			const focusBeforeSecond = h.setFocus.mock.calls.length;
			const renderBeforeSecond = h.requestRender.mock.calls.length;
			let firstSettlementCallbacks = 0;
			let secondSettlementCallbacks = 0;
			let firstValue: string | undefined;
			let secondValue: string | undefined;
			void first.then((value) => {
				firstSettlementCallbacks += 1;
				firstValue = value;
			});

			const second = ctx.editor("Second reset");
			void second.then((value) => {
				secondSettlementCallbacks += 1;
				secondValue = value;
			});

			expect(getEditorThemeSpy.mock.calls.length).toBe(getEditorThemeCallsAfterFirst);
			expect(h.editorContainer.children[0]).toBe(firstMounted);
			expect(h.surfaceChanges).toEqual([firstMounted]);
			expect(h.setFocus.mock.calls.length).toBe(focusBeforeSecond);
			expect(h.requestRender.mock.calls.length).toBe(renderBeforeSecond);

			prepareResetTarget(h);
			resetExtensionUI.call(h.target);

			await expect(first).resolves.toBeUndefined();
			await expect(second).resolves.toBeUndefined();
			await flush();

			expect(getEditorThemeSpy.mock.calls.length).toBe(getEditorThemeCallsAfterFirst);
			expect(firstSettlementCallbacks).toBe(1);
			expect(secondSettlementCallbacks).toBe(1);
			expect(firstValue).toBeUndefined();
			expect(secondValue).toBeUndefined();
			expect(h.surfaceChanges).toEqual([firstMounted, undefined, h.editor]);
			expect(h.setFocus.mock.calls.map(([component]) => component)).toEqual([firstMounted, null, h.editor]);
			expect(h.requestRender).toHaveBeenCalledTimes(3);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			getEditorThemeSpy.mockRestore();
		}
	});

	test.each([
		{ label: "ordinary error", error: new Error("editor construction failed") },
		{
			label: "same-named AbortError",
			error: Object.assign(new Error("aborted"), { name: "AbortError" }),
		},
	])("propagates the $label from the arbiter without touching UI", async ({ error }) => {
		themeModule.initTheme("dark");
		const h = makeHarness();
		setKeybindings(h.keybindings);
		const present = vi.fn((_request: unknown) => ({
			result: Promise.reject(error),
			settle: vi.fn(),
		}));
		(h.target as unknown as { dialogArbiter: { present: typeof present } }).dialogArbiter = { present };

		const promise = showExtensionEditor.call(h.target, "Title", "prefill");

		await expect(promise).rejects.toBe(error);
		expect(present).toHaveBeenCalledTimes(1);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).not.toHaveBeenCalled();
		expect(h.requestRender).not.toHaveBeenCalled();
	});

	test("propagates the real theme construction error by identity without touching UI", async () => {
		themeModule.initTheme("dark");
		const h = makeHarness();
		setKeybindings(h.keybindings);
		const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
		const previousTheme = (globalThis as Record<symbol, unknown>)[themeKey];
		let rejection: unknown;

		(globalThis as Record<symbol, unknown>)[themeKey] = undefined;
		try {
			const promise = createExtensionUIContext.call(h.target).editor("Fail title", "fail prefill");
			rejection = await promise.then(
				() => Symbol("resolved"),
				(error) => error,
			);
		} finally {
			(globalThis as Record<symbol, unknown>)[themeKey] = previousTheme;
		}

		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Theme not initialized. Call initTheme() first.");
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).not.toHaveBeenCalled();
		expect(h.requestRender).not.toHaveBeenCalled();
		expect(h.arbiter.isBusy()).toBe(false);
	});
});
