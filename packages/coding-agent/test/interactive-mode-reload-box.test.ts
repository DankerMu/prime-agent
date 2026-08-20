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

// Typed access to the private handleReloadCommand so the REAL reload runs
// against own-property stubs prepared by the test.
const handleReloadCommand = (
	InteractiveMode.prototype as unknown as {
		handleReloadCommand(this: unknown): Promise<void>;
	}
).handleReloadCommand;

// Typed access to the private createExtensionUIContext so a real extension
// select can be opened before the reload (spec "非交互占位同样排队").
const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as {
		createExtensionUIContext(this: unknown): UIContextStub;
	}
).createExtensionUIContext;

// Typed access to the private handleEffortCommand, the real caller that opens
// the thinking selector through the real showSelector.
const handleEffortCommand = (
	InteractiveMode.prototype as unknown as {
		handleEffortCommand(this: unknown, arg: string): void;
	}
).handleEffortCommand;

// Typed access to the private setCustomEditorComponent so the REAL replacement
// runs against the real busy-aware implementation.
type EditorFactoryLike = (ui: unknown, theme: unknown, keys: unknown) => unknown;
const setCustomEditorComponent = (
	InteractiveMode.prototype as unknown as {
		setCustomEditorComponent(this: unknown, factory: EditorFactoryLike | undefined): void;
	}
).setCustomEditorComponent;

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

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
	// Structural editor double: the real setCustomEditorComponent and the reload
	// success path call getText/getPaddingX/setAutocompleteProvider/actionHandlers
	// on the current and default editors.
	const editor = makeStructuralEditor("editor");
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
		requestRender: (force?: boolean) => requestRender(force),
		// The real host reads this.editor, which setCustomEditorComponent can
		// replace mid-dialog; mirror that so dynamic restore targets are live.
		getCurrentEditor: () => (target as unknown as { editor: Component }).editor,
	});
	(target as unknown as { dialogArbiter: DialogArbiter }).dialogArbiter = arbiter;
	return { target, arbiter, editor, editorContainer, setFocus, requestRender };
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// A structural editor double good enough for the REAL setCustomEditorComponent:
// snapshotPromptStashFrom reads getText/getPasteSnapshot/getExpandedText, the
// replacement path calls setText and (optionally) restorePasteSnapshot.
function makeStructuralEditor(name: string, initialText = ""): Container {
	let text = initialText;
	return {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		handleInput: vi.fn(),
		getPasteSnapshot: () => undefined,
		getExpandedText: () => text,
		addToHistory: vi.fn(),
		getHistory: () => [],
		clearHistory: vi.fn(),
		insertTextAtCursor: vi.fn(),
		borderColor: (s: string) => s,
		actionHandlers: new Map<string, () => void>(),
		setPaddingX: vi.fn(),
		setAutocompleteMaxVisible: vi.fn(),
		setAutocompleteProvider: vi.fn(),
		render: () => [],
		invalidate: vi.fn(),
		clear: vi.fn(),
		addChild: vi.fn(),
		removeChild: vi.fn(),
		children: [],
		onExtensionShortcut: undefined,
		getSelectionRegions: () => [],
		getPaddingX: () => 0,
		restorePasteSnapshot: vi.fn(),
		name,
	} as unknown as Container;
}

// Stub the unrelated reload/reset dependencies so the REAL reset and reload run
// against own-property stubs (agentConnection.reload controlled by the test),
// while the REAL arbiter, dialogArbiter, and handleReloadCommand stay in charge.
function prepareReloadTarget(h: Harness, reload: () => Promise<unknown>): void {
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
		setShowHardwareCursor: vi.fn(),
		setClearOnShrink: vi.fn(),
	};
	(h.target as unknown as { ui: typeof uiWithOverlay }).ui = uiWithOverlay;

	const state = {
		cwd: "/test",
		sessionId: "test-session",
		thinkingLevel: "off" as const,
		availableThinkingLevels: [] as ThinkingLevel[],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all" as const,
		followUpMode: "all" as const,
		leafId: null,
		autoCompactionEnabled: false,
		messageCount: 0,
		compactionCount: 0,
		scopedModels: [],
		activeToolNames: [],
		contextUsage: { tokens: 0, contextWindow: 0, percent: 0 },
	};
	Object.assign(h.target as unknown as Record<string, unknown>, {
		connectionState: { isStreaming: false, isCompacting: false },
		options: { verbose: false },
		activeConnectionExtensionUiRequests: new Map<string, { cancelLocal: () => void }>(),
		agentConnection: {
			respondToExtensionUiRequest: vi.fn(async () => undefined),
			reload,
			getState: vi.fn(async () => state),
			getCommands: vi.fn(async () => []),
			getModelCatalog: vi.fn(async () => ({ models: [], configuredProviders: [] })),
			getResourceSnapshot: vi.fn(async () => undefined),
			getSessionContext: vi.fn(async () => ({
				messages: [],
				thinkingLevel: "off",
				serviceTier: null,
				model: null,
			})),
			setThinkingLevel: vi.fn(async () => {}),
		},
		closeHeartbeatManager: vi.fn(),
		showError: vi.fn(),
		clearExtensionTerminalInputListeners: vi.fn(),
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		footer: { invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
		autocompleteProviderWrappers: [],
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		defaultEditor: h.editor,
		editor: h.editor,
		updateTerminalTitle: vi.fn(),
		workingMessage: undefined,
		workingVisible: true,
		setWorkingIndicator: vi.fn(),
		loadingAnimation: undefined,
		setHiddenThinkingLabel: vi.fn(),
		toolDefinitionCache: new Map(),
		keybindings: { reload: vi.fn(), getEffectiveConfig: () => ({}) },
		uiServices: {
			getThemes: vi.fn(() => []),
			getInitialCwd: vi.fn(() => "/test"),
			settingsManager: {
				getHideThinkingBlock: vi.fn(() => false),
				getTheme: vi.fn(() => ""),
				getEditorPaddingX: vi.fn(() => 0),
				getAutocompleteMaxVisible: vi.fn(() => 0),
				getShowHardwareCursor: vi.fn(() => false),
				getClearOnShrink: vi.fn(() => false),
			},
			modelRegistry: { getError: vi.fn(() => undefined) },
		},
		heartbeatCatalog: [],
		heartbeats: [],
		subagentSnapshots: new Map(),
		pulseTimer: undefined,
		connectionModelsRefreshVersion: 0,
		connectionModelsRefreshInFlight: undefined,
		connectionModelCatalog: [],
		connectionConfiguredProviders: new Set(),
		connectionModels: [],
		connectionModelsFetchedAt: 0,
		connectionResourceSnapshot: undefined,
		connectionCommands: [],
		bindLocalSessionExtensions: false,
		customHeader: undefined,
		builtInHeader: undefined,
		hideThinkingBlock: false,
		toolOutputExpanded: false,
		pendingTools: new Map(),
		pendingToolCreations: new Set(),
		startedToolCalls: new Set(),
		pendingToolGeneration: 0,
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		chatContainer: new Container(),
		promptStashStore: undefined,
		promptStashSessionId: undefined,
		sessionRecap: undefined,
		recapContainer: undefined,
		featureHintComponent: undefined,
		agentRunFileChanges: new Map(),
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
	});
}

describe("interactive mode reload box arbiter migration", () => {
	test("idle sync mount: box owns surface/focus before the returned promise is awaited; reject restores current editor", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		let rejectReload!: (error: Error) => void;
		const reloadPending = new Promise<never>((_, reject) => {
			rejectReload = reject;
		});
		prepareReloadTarget(h, () => reloadPending);

		// An idle arbiter must not defer the mount: the box owns the surface and
		// focus immediately on return, before the handler's promise is awaited.
		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});

		const reloadBox = h.editorContainer.children[0];
		expect(reloadBox).toBeDefined();
		expect(reloadBox).not.toBe(h.editor);
		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		// The placeholder mount force-paints; the editor restore does not.
		expect(h.requestRender).toHaveBeenLastCalledWith(true);
		expect(reloadDone).toBe(false);

		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		expect(reloadDone).toBe(false);

		rejectReload(new Error("reload failed"));
		await expect(reload).resolves.toBeUndefined();
		await flush();

		// Failure restores the current editor (the harness editor) dynamically.
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("failure restore is dynamic: editor replaced mid-reload is restored, not the initial one", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const editorA = h.editor;
		let rejectReload!: (error: Error) => void;
		const reloadPending = new Promise<never>((_, reject) => {
			rejectReload = reject;
		});
		prepareReloadTarget(h, () => reloadPending);

		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});
		const reloadBox = h.editorContainer.children[0];
		expect(reloadBox).toBeDefined();
		expect(reloadBox).not.toBe(editorA);

		// Replace the current editor while the box is up via the REAL
		// setCustomEditorComponent; busy means it must not steal the surface.
		const editorB = makeStructuralEditor("editorB", "draft-b");
		// Prepare the real replacement dependencies (prompt stash, factory, autocomplete).
		const targetRecord = h.target as unknown as Record<string, unknown>;
		targetRecord.editorComponentFactory = undefined;
		targetRecord.latestEditorPromptStash = undefined;
		targetRecord.pastedImages = new Map();
		targetRecord.getPromptStashImages = () => [];
		targetRecord.snapshotPromptStashFrom = () => ({ text: "draft-b" });
		targetRecord.autocompleteProvider = undefined;
		targetRecord.keybindings = { reload: vi.fn(), getEffectiveConfig: () => ({}) };

		setCustomEditorComponent.call(h.target, () => editorB);

		// The box must stay mounted; the editor reference must point at B now.
		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		expect((h.target as unknown as { editor: Component }).editor).toBe(editorB);

		rejectReload(new Error("reload failed"));
		await expect(reload).resolves.toBeUndefined();
		await flush();

		// Failure restore is dynamic: B, not the initial editor A.
		expect(h.editorContainer.children).toEqual([editorB]);
		expect(h.setFocus).toHaveBeenLastCalledWith(editorB);
		expect(h.arbiter.isBusy()).toBe(false);
		expect(reloadDone).toBe(true);
	});

	test("settle before show: reload completes while the thinking selector is visible; the box is never mounted", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// Open the real thinking selector; it owns the surface and the arbiter.
		handleEffortCommand.call(h.target, "");
		const thinkingSurface = h.editorContainer.children[0];
		expect(thinkingSurface).toBeInstanceOf(ThinkingSelectorComponent);
		expect(h.arbiter.isBusy()).toBe(true);

		// The reload resolves immediately; the placeholder is queued behind the
		// thinking selector and settles before it can ever be shown.
		prepareReloadTarget(h, async () => undefined);
		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});
		await reload;
		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		// The reload command completed without waiting for the thinking selector,
		// and the placeholder box was never mounted: thinking still owns the surface.
		expect(reloadDone).toBe(true);
		expect(h.editorContainer.children).toEqual([thinkingSurface]);
		expect(h.editorContainer.children[0]).toBeInstanceOf(ThinkingSelectorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith((thinkingSurface as ThinkingSelectorComponent).getSelectList());

		// The arbiter is not wedged: settling the thinking selector restores the editor.
		const list = (thinkingSurface as ThinkingSelectorComponent).getSelectList();
		list.setSelectedIndex(3);
		list.onSelect?.(list.getSelectedItem()!);
		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("visible thinking selector queues the box: reload work completes while thinking stays; box mounts only after thinking settles", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		handleEffortCommand.call(h.target, "");
		const thinkingSurface = h.editorContainer.children[0];
		expect(thinkingSurface).toBeInstanceOf(ThinkingSelectorComponent);
		expect(h.arbiter.isBusy()).toBe(true);

		// Hold the reload in flight: while it is pending the thinking selector must
		// keep the surface and the box must not mount.
		let rejectReload!: (error: Error) => void;
		const reloadPending = new Promise<never>((_, reject) => {
			rejectReload = reject;
		});
		prepareReloadTarget(h, () => reloadPending);
		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});

		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		expect(h.editorContainer.children).toEqual([thinkingSurface]);
		expect(h.editorContainer.children[0]).toBeInstanceOf(ThinkingSelectorComponent);
		expect(h.arbiter.isBusy()).toBe(true);
		expect(reloadDone).toBe(false);

		// Settle the placeholder while the thinking selector is still up: the box
		// is removed from the queue and never shown.
		rejectReload(new Error("reload failed"));
		await expect(reload).resolves.toBeUndefined();
		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		expect(reloadDone).toBe(true);
		expect(h.editorContainer.children).toEqual([thinkingSurface]);
		expect(h.editorContainer.children[0]).toBeInstanceOf(ThinkingSelectorComponent);

		// Settle thinking: editor restores (placeholder already settled).
		const list = (thinkingSurface as ThinkingSelectorComponent).getSelectList();
		list.setSelectedIndex(3);
		list.onSelect?.(list.getSelectedItem()!);
		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("visible extension select is settled by reset then the box may show (强制关闭与占位框共存)", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select("Reload race", ["Alpha"]);
		const selector = h.editorContainer.children[0];
		expect(selector).toBeInstanceOf(ExtensionSelectorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(selector);

		// Hold the reload in flight so the box stays mounted after the reset.
		let rejectReload!: (error: Error) => void;
		const reloadPending = new Promise<never>((_, reject) => {
			rejectReload = reject;
		});
		prepareReloadTarget(h, () => reloadPending);

		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});

		// The reset cancels the visible extension select with its cancel contract
		// (undefined); the placeholder is queued behind the reset's arbiter handoff.
		await expect(select).resolves.toBeUndefined();
		await flush();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await flush();

		// With the reload still in flight the placeholder box owns the surface.
		const reloadBox = h.editorContainer.children[0];
		expect(reloadBox).not.toBe(h.editor);
		expect(reloadBox).not.toBe(selector);
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
