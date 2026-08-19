import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.js";
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

// Typed access to the private createExtensionUIContext, exposing the select signature.
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

// Typed access to the private showSelector so the REAL helper runs with a
// test-only create factory (used only for the duplicate-done scenario).
const showSelector = (
	InteractiveMode.prototype as unknown as {
		showSelector(this: unknown, create: (done: () => void) => { component: Component; focus: Component }): void;
	}
).showSelector;

// Typed access to the private showThinkingSelector so the REAL thinking path
// runs against the real helper and the real arbiter.
const showThinkingSelector = (
	InteractiveMode.prototype as unknown as {
		showThinkingSelector(this: unknown, levels?: ThinkingLevel[]): void;
	}
).showThinkingSelector;

// Typed access to the private handleEffortCommand, the real caller that opens
// the thinking selector through the real showSelector.
const handleEffortCommand = (
	InteractiveMode.prototype as unknown as {
		handleEffortCommand(this: unknown, arg: string): void;
	}
).handleEffortCommand;

// The REAL applyThinkingLevel implementation, invoked by the thin own-property
// wrapper so the select callback runs the genuine level-application path.
const applyThinkingLevelImpl = (
	InteractiveMode.prototype as unknown as {
		applyThinkingLevel(this: unknown, level: ThinkingLevel): void;
	}
).applyThinkingLevel;

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

interface Harness {
	target: InteractiveMode;
	arbiter: DialogArbiter;
	editor: Container;
	editorContainer: Container;
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	applyThinkingLevel: ReturnType<typeof vi.fn>;
}

function makeHarness(rows = 24): Harness {
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const editor = new Container();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const ui = { setFocus, requestRender, terminal: { rows } };
	const target = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		editorContainer,
		editor,
		defaultEditor: editor,
		ui,
		connectionState: {
			thinkingLevel: "medium" as ThinkingLevel,
			availableThinkingLevels: THINKING_LEVELS,
		},
		agentConnection: { setThinkingLevel: vi.fn(async () => {}) },
		footer: { invalidate: vi.fn() },
		patchConnectionState: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	});
	let focusedComponent: Component | undefined;
	const arbiter = new DialogArbiter({
		replaceEditorSurface: (component) => {
			editorContainer.clear();
			if (component) editorContainer.addChild(component);
		},
		// Faithfully mirror the real TUI setFocus: track the focused component
		// and toggle the `focused` flag on components that carry it.
		setFocus: (component) => {
			if (focusedComponent && "focused" in focusedComponent) {
				(focusedComponent as Component & { focused?: boolean }).focused = false;
			}
			focusedComponent = component ?? undefined;
			if (component && "focused" in component) {
				(component as Component & { focused?: boolean }).focused = true;
			}
			setFocus(component);
		},
		requestRender: () => requestRender(),
		getCurrentEditor: () => editor,
	});
	(target as unknown as { dialogArbiter: DialogArbiter }).dialogArbiter = arbiter;
	// Thin wrapper over the REAL applyThinkingLevel: the real select callback
	// path runs the genuine implementation while the test can assert the call.
	const applyThinkingLevel = vi.fn((level: ThinkingLevel) => {
		applyThinkingLevelImpl.call(target, level);
	});
	(target as unknown as { applyThinkingLevel: (level: ThinkingLevel) => void }).applyThinkingLevel =
		applyThinkingLevel;
	return { target, arbiter, editor, editorContainer, setFocus, requestRender, applyThinkingLevel };
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Stub the unrelated reset responsibilities so the REAL reset runs against the
// real arbiter; keeps the real cancelActiveConnectionExtensionUiRequests
// (empty map => no-op) and the real dialogArbiter.
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
			// Kept so the app selector can still apply a level after the reset.
			setThinkingLevel: vi.fn(async () => {}),
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

describe("interactive mode showSelector arbiter migration", () => {
	test("real thinking path: preselects current level, focuses the select list, settles and restores editor", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		handleEffortCommand.call(h.target, "");

		const surface = h.editorContainer.children[0];
		expect(surface).toBeInstanceOf(ThinkingSelectorComponent);
		expect(h.editorContainer.children).toEqual([surface]);
		expect(h.editorContainer.children).not.toContain(h.editor);
		const selector = surface as ThinkingSelectorComponent;
		// The arbiter owns the surface while the app selector is visible.
		expect(h.arbiter.isBusy()).toBe(true);
		expect(h.setFocus).toHaveBeenLastCalledWith(selector.getSelectList());
		expect(selector.getSelectList().getSelectedItem()?.value).toBe("medium");

		const list = selector.getSelectList();
		list.setSelectedIndex(3);
		list.onSelect?.(list.getSelectedItem()!);

		expect(h.applyThinkingLevel).toHaveBeenCalledTimes(1);
		expect(h.applyThinkingLevel).toHaveBeenCalledWith("high");

		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("second done is a no-op: first restores editor, second does not clear/replace surface or steal focus", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		let capturedDone: (() => void) | undefined;
		const component = new Container();
		const focusTarget = new Container();
		showSelector.call(h.target, (done) => {
			capturedDone = done;
			return { component, focus: focusTarget };
		});

		expect(h.editorContainer.children).toEqual([component]);
		expect(h.setFocus).toHaveBeenLastCalledWith(focusTarget);
		expect(h.arbiter.isBusy()).toBe(true);

		capturedDone!();
		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);

		const focusCalls = h.setFocus.mock.calls.length;
		const renderCalls = h.requestRender.mock.calls.length;

		capturedDone!();
		await flush();

		expect(h.setFocus.mock.calls.length).toBe(focusCalls);
		expect(h.requestRender.mock.calls.length).toBe(renderCalls);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("order A then B: extension select visible, thinking showSelector queued and mounts only after select settles", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select("Pick", ["Alpha", "Beta"]);
		const selectSurface = h.editorContainer.children[0];
		expect(selectSurface).toBeInstanceOf(ExtensionSelectorComponent);

		showThinkingSelector.call(h.target, THINKING_LEVELS);

		// The thinking factory must not have run while the select owns the surface.
		expect(h.editorContainer.children).toEqual([selectSurface]);
		expect(h.editorContainer.children[0]).not.toBeInstanceOf(ThinkingSelectorComponent);
		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);

		(selectSurface as ExtensionSelectorComponent).handleInput("\n");
		await expect(select).resolves.toBe("Alpha");
		await flush();

		const thinkingSurface = h.editorContainer.children[0];
		expect(thinkingSurface).toBeInstanceOf(ThinkingSelectorComponent);
		const thinking = thinkingSurface as ThinkingSelectorComponent;
		expect(h.setFocus).toHaveBeenLastCalledWith(thinking.getSelectList());

		const list = thinking.getSelectList();
		list.setSelectedIndex(1);
		list.onSelect?.(list.getSelectedItem()!);
		expect(h.applyThinkingLevel).toHaveBeenCalledTimes(1);
		expect(h.applyThinkingLevel).toHaveBeenCalledWith("low");

		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("order B then A: thinking visible, extension select queued does not steal surface; both settle once", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		handleEffortCommand.call(h.target, "");
		const thinkingSurface = h.editorContainer.children[0];
		expect(thinkingSurface).toBeInstanceOf(ThinkingSelectorComponent);
		const thinking = thinkingSurface as ThinkingSelectorComponent;
		expect(h.setFocus).toHaveBeenLastCalledWith(thinking.getSelectList());
		expect(h.arbiter.isBusy()).toBe(true);

		const select = createExtensionUIContext.call(h.target).select("Pick", ["Alpha", "Beta"]);

		// The queued select must not steal the surface or focus.
		expect(h.editorContainer.children).toEqual([thinkingSurface]);
		expect(h.editorContainer.children[0]).toBeInstanceOf(ThinkingSelectorComponent);
		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);

		const list = thinking.getSelectList();
		list.setSelectedIndex(0);
		list.onSelect?.(list.getSelectedItem()!);
		expect(h.applyThinkingLevel).toHaveBeenCalledTimes(1);
		expect(h.applyThinkingLevel).toHaveBeenCalledWith("off");

		await flush();
		const selectSurface = h.editorContainer.children[0];
		expect(selectSurface).toBeInstanceOf(ExtensionSelectorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(selectSurface);

		(selectSurface as ExtensionSelectorComponent).handleInput("\n");
		await expect(select).resolves.toBe("Alpha");
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("reset keeps the queued app selector: extension select settles undefined, thinking then shows and restores editor only after it settles", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select("Pick", ["Alpha", "Beta"]);
		const selectSurface = h.editorContainer.children[0];
		expect(selectSurface).toBeInstanceOf(ExtensionSelectorComponent);

		handleEffortCommand.call(h.target, "");
		// The app selector queues behind the extension select.
		expect(h.editorContainer.children).toEqual([selectSurface]);
		expect(h.arbiter.isBusy()).toBe(true);

		prepareResetTarget(h);
		resetExtensionUI.call(h.target);

		// The extension select settles with its cancel contract (undefined);
		// the app selector survives and now becomes visible.
		await expect(select).resolves.toBeUndefined();
		await flush();

		const thinkingSurface = h.editorContainer.children[0];
		expect(thinkingSurface).toBeInstanceOf(ThinkingSelectorComponent);
		expect(h.editorContainer.children).not.toContain(h.editor);
		expect(h.arbiter.isBusy()).toBe(true);

		// The app selector can still settle via its done; the editor restores only then.
		const thinking = thinkingSurface as ThinkingSelectorComponent;
		const list = thinking.getSelectList();
		list.setSelectedIndex(3);
		list.onSelect?.(list.getSelectedItem()!);
		expect(h.applyThinkingLevel).toHaveBeenCalledTimes(1);
		expect(h.applyThinkingLevel).toHaveBeenCalledWith("high");

		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});
});
