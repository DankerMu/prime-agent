import {
	type Component,
	Container,
	type EditorComponent,
	type OverlayHandle,
	type OverlayOptions,
	setKeybindings,
} from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

interface StructuralEditor extends EditorComponent {
	actionHandlers: Map<string, () => void>;
	getPaddingX?(): number;
	setPaddingX?(padding: number): void;
}

function makeEditor(initialText: string): StructuralEditor {
	let text = initialText;
	return {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		handleInput: () => undefined,
		render: () => [],
		invalidate: () => undefined,
		getExpandedText: () => text,
		onSubmit: undefined,
		onChange: undefined,
		borderColor: (str: string) => str,
		getPaddingX: () => 2,
		setPaddingX: () => undefined,
		actionHandlers: new Map(),
	};
}

class TestCustomComponent extends Container {
	dispose = vi.fn();
}

function makeCustomComponent(): TestCustomComponent {
	return new TestCustomComponent();
}

type CustomComponentResult = Component & { dispose?(): void };

type CustomFactory<T> = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: T) => void,
) => CustomComponentResult | Promise<CustomComponentResult>;

type CustomOptions = {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
};

type CustomContextStub = {
	custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T>;
};

type EditorReplacementFactory = (tui: unknown, theme: unknown, keybindings: unknown) => StructuralEditor;

// Typed access to the private createExtensionUIContext so the REAL context runs
// against the real prototype showExtensionCustom and the real arbiter.
const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as {
		createExtensionUIContext(this: unknown): CustomContextStub;
	}
).createExtensionUIContext;

// Typed access to the private resetExtensionUI so the REAL reset runs against
// own-property stubs prepared by the test.
const resetExtensionUI = (
	InteractiveMode.prototype as unknown as {
		resetExtensionUI(this: unknown): void;
	}
).resetExtensionUI;

// Typed access to the private setCustomEditorComponent so editor replacement
// goes through the real production path, not direct field mutation.
const setCustomEditorComponent = (
	InteractiveMode.prototype as unknown as {
		setCustomEditorComponent(this: unknown, factory: EditorReplacementFactory | undefined): void;
	}
).setCustomEditorComponent;

interface Harness {
	target: InteractiveMode;
	arbiter: DialogArbiter;
	editor: StructuralEditor;
	defaultEditor: StructuralEditor;
	editorContainer: Container;
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	showOverlay: ReturnType<typeof vi.fn>;
	hideOverlay: ReturnType<typeof vi.fn>;
	overlayHandle: OverlayHandle;
	keybindings: KeybindingsManager;
}

function makeHarness(): Harness {
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const overlayHandle: OverlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => false,
	};
	const showOverlay = vi.fn(() => overlayHandle);
	const hideOverlay = vi.fn();
	const defaultEditor = makeEditor("default-editor");
	const editor = makeEditor("initial-editor");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const ui = { setFocus, requestRender, showOverlay, hideOverlay };
	const keybindings = new KeybindingsManager();
	const target = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		editorContainer,
		editor,
		defaultEditor,
		ui,
		keybindings,
		editorComponentFactory: undefined,
		autocompleteProvider: undefined,
		latestEditorPromptStash: undefined,
		pastedImages: new Map(),
		dialogArbiter: null as unknown as DialogArbiter,
	});
	let focusedComponent: Component | undefined;
	const arbiter = new DialogArbiter({
		replaceEditorSurface: (component) => {
			editorContainer.clear();
			if (component) editorContainer.addChild(component);
		},
		// Faithfully mirror the real TUI setFocus: clear the old component's
		// `focused` flag whenever it has one (regardless of identity), track the
		// focused component always, and set `focused` on the new component only
		// when it already has the property (never add it to arbitrary components).
		// A focusable editor's synchronous `focused` setter can then reenter on
		// focus.
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
		getCurrentEditor: () => currentEditor(target),
	});
	(target as unknown as { dialogArbiter: DialogArbiter }).dialogArbiter = arbiter;
	return {
		target,
		arbiter,
		editor,
		defaultEditor,
		editorContainer,
		setFocus,
		requestRender,
		showOverlay,
		hideOverlay,
		overlayHandle,
		keybindings,
	};
}

function currentEditor(target: InteractiveMode): StructuralEditor {
	return (target as unknown as { editor: StructuralEditor }).editor;
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
// held-in-flight set of extension custom requests. Keeps the real
// cancelActiveConnectionExtensionUiRequests (empty map => no-op) and the real
// dialogArbiter.
function prepareResetTarget(h: Harness): void {
	const ownUi = (
		h.target as unknown as {
			ui: { setFocus: unknown; requestRender: unknown };
		}
	).ui;
	const uiWithOverlay = {
		setFocus: ownUi.setFocus,
		requestRender: ownUi.requestRender,
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
		defaultEditor: h.defaultEditor,
		updateTerminalTitle: vi.fn(),
		workingMessage: undefined,
		workingVisible: true,
		setWorkingIndicator: vi.fn(),
		loadingAnimation: undefined,
		setHiddenThinkingLabel: vi.fn(),
	});
}

describe("interactive mode extension custom ownership", () => {
	test("non-overlay custom queues behind the shared blocker, snapshots at display, and restores the display-time text", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();
		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		const requestTimeText = "request-time-text";
		const displayTimeText = "display-time-text";
		const visibleTimeText = "visible-time-text";
		h.editor.setText(requestTimeText);

		let capturedDone: ((result: string) => void) | undefined;
		let resolveComponent!: (component: Component) => void;
		const customComponent = makeCustomComponent();
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			return new Promise<CustomComponentResult>((resolve) => {
				resolveComponent = resolve;
			});
		});
		const custom = createExtensionUIContext.call(h.target).custom(factory);

		try {
			// The blocker owns the surface from creation on.
			expect(h.editorContainer.children).toEqual([blockerComponent]);

			const surfaceBefore = h.editorContainer.children;
			const focusBefore = h.setFocus.mock.calls.length;
			const renderBefore = h.requestRender.mock.calls.length;

			// FIFO: while the blocker owns the surface the factory is never invoked
			// and no surface/focus/render change happens.
			expect(factory).not.toHaveBeenCalled();
			expect(h.editorContainer.children).toBe(surfaceBefore);
			expect(h.editorContainer.children).toEqual([blockerComponent]);
			expect(h.setFocus.mock.calls.length).toBe(focusBefore);
			expect(h.requestRender.mock.calls.length).toBe(renderBefore);

			// The editor text at display (after release) is the snapshot oracle.
			h.editor.setText(displayTimeText);

			blocker.done("ok");
			await expect(blocker.handle.result).resolves.toBe("ok");
			await flush();

			// The factory is only invoked once, at display time.
			expect(factory).toHaveBeenCalledTimes(1);
			resolveComponent(customComponent);
			await flush();

			const mounted = h.editorContainer.children[0];
			expect(mounted).toBe(customComponent);
			expect(h.setFocus).toHaveBeenLastCalledWith(mounted);
			expect(factory).toHaveBeenCalledTimes(1);

			// Mutate the same editor while the custom is visible, then close it.
			h.editor.setText(visibleTimeText);
			capturedDone!("distinctive-result");

			await expect(custom).resolves.toBe("distinctive-result");
			await flush();

			expect(customComponent.dispose).toHaveBeenCalledTimes(1);
			// Restored to the display-time snapshot, not the request-time or the
			// visible-period text, and the editor/surface/focus are restored.
			expect(h.editor.getText()).toBe(displayTimeText);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle the blocker and the queued custom if an assertion failed
			// before the body settled them. Releasing the surface lets the custom
			// factory run; resolving it and closing the custom settles every live
			// handle. Settled-once guards make these no-ops on the normal path.
			blocker.done("cleanup");
			await flush();
			resolveComponent?.(customComponent);
			await flush();
			capturedDone?.("cleanup");
			await Promise.allSettled([blocker.handle.result, custom]);
		}
	});

	test("editor replacement while a non-overlay custom is visible keeps the custom mounted and restores the new editor", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const displaySnapshot = "display-snapshot-text";
		h.editor.setText(displaySnapshot);

		let capturedDone: ((result: string) => void) | undefined;
		const customComponent = makeCustomComponent();
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			return customComponent;
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);

		try {
			await flush();

			const mounted = h.editorContainer.children[0];
			expect(mounted).toBe(customComponent);
			expect(h.setFocus).toHaveBeenLastCalledWith(mounted);

			// While the custom is visible, mutate the current editor text.
			h.editor.setText("visible-mutated-text");

			// Replace the editor through the real setCustomEditorComponent while the
			// arbiter is busy: the custom must stay mounted and focused.
			const newEditor = makeEditor("");
			const replacementFactory = vi.fn(() => newEditor);
			setCustomEditorComponent.call(h.target, replacementFactory);

			expect(currentEditor(h.target)).toBe(newEditor);
			expect(newEditor.getText()).toBe("visible-mutated-text");
			expect(h.editorContainer.children).toEqual([mounted]);
			expect(h.setFocus).toHaveBeenLastCalledWith(mounted);

			capturedDone!("replaced-editor-result");
			await expect(custom).resolves.toBe("replaced-editor-result");
			await flush();

			// done does not write the old custom snapshot into the new editor: the
			// prompt-stash handoff owns its text, and the arbiter restores the new editor.
			expect(newEditor.getText()).toBe("visible-mutated-text");
			expect(h.editorContainer.children).toEqual([newEditor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(newEditor);
			expect(customComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any handles still pending after a failed assertion.
			capturedDone?.("cleanup");
			await Promise.allSettled([custom]);
		}
	});

	test("editor replacement while a non-overlay custom is queued snapshots the replacement editor at display", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		h.editor.setText("old-editor-request-text");

		let capturedDone: ((result: string) => void) | undefined;
		let resolveComponent!: (component: Component) => void;
		const customComponent = makeCustomComponent();
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			return new Promise<CustomComponentResult>((resolve) => {
				resolveComponent = resolve;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);

		try {
			expect(h.editorContainer.children).toEqual([blockerComponent]);
			expect(factory).not.toHaveBeenCalled();

			// Replace the editor while the custom request is still queued.
			const newEditor = makeEditor("");
			const replacementFactory = vi.fn(() => newEditor);
			setCustomEditorComponent.call(h.target, replacementFactory);
			expect(currentEditor(h.target)).toBe(newEditor);

			// The replacement editor's text at display is the snapshot oracle.
			newEditor.setText("replacement-display-text");

			blocker.done("ok");
			await expect(blocker.handle.result).resolves.toBe("ok");
			await flush();

			expect(factory).toHaveBeenCalledTimes(1);
			resolveComponent(customComponent);
			await flush();

			const mounted = h.editorContainer.children[0];
			expect(mounted).toBe(customComponent);
			expect(h.setFocus).toHaveBeenLastCalledWith(mounted);

			newEditor.setText("replacement-visible-text");
			capturedDone!("queued-replacement-result");
			await expect(custom).resolves.toBe("queued-replacement-result");
			await flush();

			// Same-instance write-back: the replacement editor gets the display-time
			// text, not the request-time or visible-period value.
			expect(newEditor.getText()).toBe("replacement-display-text");
			expect(h.editorContainer.children).toEqual([newEditor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(newEditor);
			expect(customComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any handles still pending after a failed assertion. The
			// queued factory only runs after the blocker releases the surface;
			// resolving the factory promise alone never settles `custom`.
			blocker.done("cleanup");
			await flush();
			resolveComponent?.(customComponent);
			await flush();
			capturedDone?.("cleanup");
			await Promise.allSettled([blocker.handle.result, custom]);
		}
	});

	test("async factory rejection rejects with the same error, restores editor/focus, and lets a queued sibling progress", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		h.editor.setText("preserved-editor-text");

		const uniqueError = new Error("unique-factory-failure");
		let rejectFactory!: (error: unknown) => void;
		const rejectingFactory = vi.fn(
			(_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
				return new Promise<CustomComponentResult>((_resolve, reject) => {
					rejectFactory = reject;
				});
			},
		);

		const first = createExtensionUIContext.call(h.target).custom(rejectingFactory);

		// Attach the rejection observer before any action that can reject `first`.
		let firstOutcome: unknown = "pending";
		void first.then(
			(value) => {
				firstOutcome = value;
			},
			(error) => {
				firstOutcome = error;
			},
		);

		let siblingDone: ((result: string) => void) | undefined;
		const siblingComponent = makeCustomComponent();
		const siblingFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			siblingDone = done;
			return siblingComponent;
		});

		const second = createExtensionUIContext.call(h.target).custom(siblingFactory);

		try {
			// Initial async construction keeps the editor mounted and focused.
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(siblingFactory).not.toHaveBeenCalled();

			rejectFactory(uniqueError);
			await expect(first).rejects.toBe(uniqueError);

			// The caller rejected with the exact factory error and the editor surface
			// was restored: its text is untouched and no custom ever mounted.
			expect(firstOutcome).toBe(uniqueError);
			expect(h.editor.getText()).toBe("preserved-editor-text");

			await flush();

			// The queued sibling progresses after the rejection.
			expect(siblingFactory).toHaveBeenCalledTimes(1);
			const mounted = h.editorContainer.children[0];
			expect(mounted).toBe(siblingComponent);
			expect(h.setFocus).toHaveBeenLastCalledWith(mounted);

			siblingDone!("sibling-result");
			await expect(second).resolves.toBe("sibling-result");
			await flush();

			expect(siblingComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any handles still pending after a failed assertion. Rejecting
			// the first request also releases the arbiter so the queued sibling can
			// progress; only then is closing the sibling meaningful. When the
			// factory never ran, these calls are safe no-ops.
			rejectFactory?.(uniqueError);
			await flush();
			siblingDone?.("cleanup");
			await flush();
			await Promise.allSettled([first, second]);
		}
	});

	test("real reset rejects visible and queued non-overlay customs with AbortError once; the queued factory never runs", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const ctx = createExtensionUIContext.call(h.target);

		const firstComponent = makeCustomComponent();
		const firstFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return firstComponent;
		});
		const first = ctx.custom(firstFactory);

		// Attach the rejection observer before any action that can reject, so the
		// test never creates an unhandled rejection.
		let firstOutcome: unknown = "pending";
		void first.then(
			(value) => {
				firstOutcome = value;
			},
			(error) => {
				firstOutcome = error;
			},
		);

		const secondFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return makeCustomComponent();
		});
		let second: Promise<string> | undefined;
		let secondOutcome: unknown = "pending";

		try {
			// The first request mounts its component.
			await flush();
			expect(h.editorContainer.children[0]).toBe(firstComponent);

			second = ctx.custom(secondFactory);
			// Attach the second request's rejection observer before reset rejects it.
			void second.then(
				(value) => {
					secondOutcome = value;
				},
				(error) => {
					secondOutcome = error;
				},
			);
			expect(secondFactory).not.toHaveBeenCalled();
			expect(h.editorContainer.children[0]).toBe(firstComponent);

			prepareResetTarget(h);
			resetExtensionUI.call(h.target);
			await flush();

			expect(firstOutcome).toBeInstanceOf(Error);
			expect((firstOutcome as Error).name).toBe("AbortError");
			expect(secondOutcome).toBeInstanceOf(Error);
			expect((secondOutcome as Error).name).toBe("AbortError");
			expect(secondFactory).not.toHaveBeenCalled();
			expect(firstComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Both requests are arbiter-owned, so cancelKind settles them if an
			// assertion failed before the body's reset did. It is a no-op for any
			// request the reset already settled.
			h.arbiter.cancelKind("extension");
			await flush();
			await Promise.allSettled([first, second]);
		}
	});

	test("real reset during async construction after a text mutation restores the display-time text, paints it and stays surface/idle; the late component never mounts and disposes once", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const displayTimeText = "display-time-constructing-reset-text";
		h.editor.setText(displayTimeText);

		let resolveComponent: ((component: Component) => void) | undefined;
		let capturedDone: ((result: string) => void) | undefined;
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			return new Promise<CustomComponentResult>((resolve) => {
				resolveComponent = resolve;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);

		// Attach the rejection observer before any action that can reject.
		const lateComponent = makeCustomComponent();
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			// Constructing keeps the editor mounted.
			expect(h.editorContainer.children).toEqual([h.editor]);

			// Mutate the still-mounted editor while constructing: the never-mounted
			// reset restore must write the display-time snapshot back and paint it.
			h.editor.setText("mutated-before-constructing-reset-text");
			const renderBeforeReset = h.requestRender.mock.calls.length;

			prepareResetTarget(h);
			resetExtensionUI.call(h.target);
			await flush();

			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).name).toBe("AbortError");
			expect(h.editor.getText()).toBe(displayTimeText);
			expect(h.requestRender.mock.calls.length).toBeGreaterThan(renderBeforeReset);

			// Resolve the factory later: the late component never mounts or focuses
			// and is disposed exactly once, with no second settlement.
			resolveComponent!(lateComponent);
			await flush();
			await flush();

			expect(lateComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).not.toHaveBeenCalled();
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any request still pending after a failed assertion.
			capturedDone?.("cleanup");
			await Promise.allSettled([custom]);
		}
	});

	test("real reset during async construction after a real editor replacement restores the default editor as sole surface", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		let resolveComponent: ((component: Component) => void) | undefined;
		let capturedDone: ((result: string) => void) | undefined;
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			return new Promise<CustomComponentResult>((resolve) => {
				resolveComponent = resolve;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);
		const lateComponent = makeCustomComponent();
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			// Constructing keeps the current editor mounted.
			expect(h.editorContainer.children).toEqual([h.editor]);

			// The editor is replaced while the request constructs with no mounted
			// component. The real setter updates the editor reference but cannot
			// touch the surface while the arbiter is busy.
			const newEditor = makeEditor("");
			const replacementFactory = vi.fn(() => newEditor);
			setCustomEditorComponent.call(h.target, replacementFactory);
			expect(currentEditor(h.target)).toBe(newEditor);
			expect(h.editorContainer.children).toEqual([h.editor]);

			// Prepare the reset harness, then un-stub the editor setter so the REAL
			// reset restores the default editor through the real replacement path.
			prepareResetTarget(h);
			delete (h.target as unknown as Record<string, unknown>).setCustomEditorComponent;
			resetExtensionUI.call(h.target);
			await flush();

			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).name).toBe("AbortError");
			expect(currentEditor(h.target)).toBe(h.defaultEditor);

			// The default editor is the sole surface child and focus target; the
			// old editor is never remounted and the interim replacement is gone.
			expect(h.editorContainer.children).toEqual([h.defaultEditor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.defaultEditor);
			expect(h.editorContainer.children).not.toContain(h.editor);

			// The late component resolves: it never mounts and is disposed once.
			resolveComponent!(lateComponent);
			await flush();
			expect(lateComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.editorContainer.children).toEqual([h.defaultEditor]);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any request still pending after a failed assertion.
			h.arbiter.cancelKind("extension");
			capturedDone?.("cleanup");
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("real reset during async construction after a factory rejection restores the replacement editor and focus", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const uniqueError = new Error("unique-replacement-factory-failure");
		let rejectFactory!: (error: unknown) => void;
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return new Promise<CustomComponentResult>((_resolve, reject) => {
				rejectFactory = reject;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			expect(h.editorContainer.children).toEqual([h.editor]);

			// Replace the editor while constructing; the real setter keeps the old
			// surface mounted.
			const newEditor = makeEditor("");
			const replacementFactory = vi.fn(() => newEditor);
			setCustomEditorComponent.call(h.target, replacementFactory);
			expect(currentEditor(h.target)).toBe(newEditor);
			expect(h.editorContainer.children).toEqual([h.editor]);

			// The factory rejects with its exact error: the replacement editor must
			// become the sole surface child and focus target, and the old editor is
			// never restored.
			rejectFactory(uniqueError);
			await expect(custom).rejects.toBe(uniqueError);
			await flush();

			expect(outcome).toBe(uniqueError);
			expect(h.editorContainer.children).toEqual([newEditor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(newEditor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			rejectFactory?.(uniqueError);
			h.arbiter.cancelKind("extension");
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("synchronous first done restores a replacement editor replaced during handoff and disposes the late component once", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		let resolveComponent!: (component: Component) => void;
		const customComponent = makeCustomComponent();
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			done("first");
			return new Promise<CustomComponentResult>((resolve) => {
				resolveComponent = resolve;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);

		try {
			// The sync done settles the result before the component promise resolves,
			// leaving the arbiter busy with the handoff still scheduled.
			expect(h.arbiter.isBusy()).toBe(true);

			// Replace the editor through the real setter while the arbiter is still
			// busy: the setter updates the reference but must not touch the surface.
			const newEditor = makeEditor("");
			const replacementFactory = vi.fn(() => newEditor);
			setCustomEditorComponent.call(h.target, replacementFactory);
			expect(currentEditor(h.target)).toBe(newEditor);
			expect(h.editorContainer.children).toEqual([h.editor]);

			// The handoff runs and must dynamically restore the replacement editor.
			await expect(custom).resolves.toBe("first");
			await flush();
			expect(h.editorContainer.children).toEqual([newEditor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(newEditor);
			expect(h.arbiter.isBusy()).toBe(false);

			// The late component is disposed exactly once and never mounts.
			resolveComponent(customComponent);
			await flush();
			expect(customComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.editorContainer.children).toEqual([newEditor]);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any request still pending after a failed assertion.
			h.arbiter.cancelKind("extension");
			resolveComponent?.(customComponent);
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("sync factory throw preserves the exact error, restores the display-time text and stays surface/idle", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const displayTimeText = "display-time-sync-throw-text";
		h.editor.setText(displayTimeText);

		const uniqueError = new Error("unique-sync-factory-throw");
		const factory = vi.fn(() => {
			throw uniqueError;
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			// Sync factory throw rejects with the exact error identity.
			await expect(custom).rejects.toBe(uniqueError);
			expect(outcome).toBe(uniqueError);
			expect(factory).toHaveBeenCalledTimes(1);

			// The display-time text is restored; the editor never left the surface.
			// When the snapshot already equals the current text a paint is not
			// required, so no render assertion is made here (zero-or-more).
			expect(h.editor.getText()).toBe(displayTimeText);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).not.toHaveBeenCalled();
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle any request still pending after a failed assertion.
			h.arbiter.cancelKind("extension");
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("async factory rejection after post-display editor mutation restores the display-time text, paints it and stays surface/idle", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const displayTimeText = "display-time-async-reject-text";
		h.editor.setText(displayTimeText);

		const uniqueError = new Error("unique-async-reject-after-mutation");
		let rejectFactory!: (error: unknown) => void;
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return new Promise<CustomComponentResult>((_resolve, reject) => {
				rejectFactory = reject;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			// Mutate the editor text while the factory is constructing: the editor
			// stays mounted, so the never-mounted restore must paint the snapshot.
			h.editor.setText("mutated-during-constructing-text");
			const renderBeforeReject = h.requestRender.mock.calls.length;

			rejectFactory(uniqueError);
			await expect(custom).rejects.toBe(uniqueError);
			await flush();

			expect(outcome).toBe(uniqueError);
			// The display-time text is restored, not the mutation. The editor never
			// left the surface so no surface/focus events are emitted, but the
			// restore wrote the snapshot into the still-mounted editor, which must
			// request a render to paint it.
			expect(h.editor.getText()).toBe(displayTimeText);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).not.toHaveBeenCalled();
			expect(h.requestRender.mock.calls.length).toBeGreaterThan(renderBeforeReject);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			rejectFactory?.(uniqueError);
			h.arbiter.cancelKind("extension");
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("cancel after post-display editor mutation rejects with AbortError and restores the display-time text, surface, focus and idle state", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const displayTimeText = "display-time-cancel-text";
		h.editor.setText(displayTimeText);

		let capturedDone: ((result: string) => void) | undefined;
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			return makeCustomComponent();
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			// The custom mounts, then the editor text mutates while it is visible.
			await flush();
			expect(h.editorContainer.children[0]).not.toBe(h.editor);
			h.editor.setText("mutated-while-visible-text");

			prepareResetTarget(h);
			resetExtensionUI.call(h.target);
			await flush();

			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).name).toBe("AbortError");
			expect(h.editor.getText()).toBe(displayTimeText);
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			capturedDone?.("cleanup");
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("an ignored public custom rejection after a real reset never emits unhandledRejection while an awaited request still sees AbortError", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const ctx = createExtensionUIContext.call(h.target);

		// A fire-and-forget non-overlay request whose result is deliberately
		// ignored, exactly as a documented extension usage would.
		let ignoredDone: ((result: string) => void) | undefined;
		const ignoredFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			ignoredDone = done;
			return makeCustomComponent();
		});
		void ctx.custom(ignoredFactory);

		// A comparable request that is explicitly awaited and must observe the
		// original AbortError rejection.
		let awaitedDone: ((result: string) => void) | undefined;
		const awaitedFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			awaitedDone = done;
			return makeCustomComponent();
		});
		const awaited = ctx.custom(awaitedFactory);

		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);

		try {
			await flush();

			prepareResetTarget(h);
			resetExtensionUI.call(h.target);

			// Drain every microtask and a macrotask turn so any leaked rejection
			// would surface under the listener.
			await flush();
			await flush();

			expect(unhandled).toEqual([]);

			// The awaited request still observes the exact AbortError.
			await expect(awaited).rejects.toMatchObject({ name: "AbortError" });
			await flush();

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			process.removeListener("unhandledRejection", handler);
			// Settle any request still pending after a failed assertion so no
			// deferred promise is left unobserved.
			ignoredDone?.("cleanup");
			awaitedDone?.("cleanup");
			await flush();
			await Promise.allSettled([awaited]);
		}
	});

	test("a synchronous first done is first-wins: duplicate done and a late factory rejection preserve post-settlement editor text", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// The editor text at display is the snapshot oracle for caller-owned
		// write-back. The factory settles its result synchronously (the real
		// examples/extensions/interactive-shell.ts pattern) and returns a still
		// pending component promise, so both late paths below run after the first
		// terminal outcome.
		const displaySnapshot = "display-snapshot-text";
		h.editor.setText(displaySnapshot);

		let capturedDone: ((result: string) => void) | undefined;
		const uniqueError = new Error("unique-late-factory-failure");
		let rejectFactory!: (error: unknown) => void;
		let factoryOutcome: unknown = "pending";
		const factoryPromise = new Promise<CustomComponentResult>((_resolve, reject) => {
			rejectFactory = (error: unknown) => reject(error);
		});
		// Observe the pending factory promise so its late rejection is never an
		// unhandled rejection from the test's perspective.
		void factoryPromise.then(
			(value) => {
				factoryOutcome = value;
			},
			(error) => {
				factoryOutcome = error;
			},
		);
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			capturedDone = done;
			done("first");
			return factoryPromise;
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);

		// Observe every caller-result settlement so a second callback or
		// rejection would be counted.
		let resultSettlements = 0;
		let resultOutcome: unknown = "pending";
		void custom.then(
			(value) => {
				resultSettlements += 1;
				resultOutcome = value;
			},
			(error) => {
				resultSettlements += 1;
				resultOutcome = error;
			},
		);

		try {
			// The synchronous first done settles the result before the async
			// component promise; the caller receives the first value and the
			// arbiter is idle with the editor mounted.
			await expect(custom).resolves.toBe("first");
			await flush();
			expect(factory).toHaveBeenCalledTimes(1);
			expect(resultSettlements).toBe(1);
			expect(resultOutcome).toBe("first");
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.arbiter.isBusy()).toBe(false);

			// The user enters new editor text after settlement.
			const postSettlementText = "post-settlement-text";
			h.editor.setText(postSettlementText);

			// A duplicate done must not rewrite the post-settlement text with the
			// display snapshot and must not settle the result a second time.
			capturedDone!("second");
			await flush();
			expect(h.editor.getText()).toBe(postSettlementText);
			expect(resultSettlements).toBe(1);
			expect(resultOutcome).toBe("first");

			// A late rejection of the still-pending factory must likewise preserve
			// the post-settlement text, never mount a component, and not re-settle
			// the result.
			rejectFactory(uniqueError);
			await flush();
			await flush();

			expect(factoryOutcome).toBe(uniqueError);
			expect(h.editor.getText()).toBe(postSettlementText);
			expect(resultSettlements).toBe(1);
			expect(resultOutcome).toBe("first");
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// If an assertion failed before the body rejected the factory promise,
			// reject it here so no deferred work or unhandled rejection remains.
			// Rejecting an already-rejected promise is a no-op.
			rejectFactory?.(uniqueError);
			await flush();
			await Promise.allSettled([custom, factoryPromise]);
		}
	});

	test("a focusable replacement editor reenters a second real replacement during stale restore and converges to the second editor", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const uniqueError = new Error("unique-focusable-factory-failure");
		let rejectFactory!: (error: unknown) => void;
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return new Promise<CustomComponentResult>((_resolve, reject) => {
				rejectFactory = reject;
			});
		});

		const custom = createExtensionUIContext.call(h.target).custom(factory);
		let outcome: unknown = "pending";
		void custom.then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);

		try {
			// Editor C is a plain editor. Editor B carries a synchronous focusable
			// `focused` setter that, when focused, reenters the REAL public editor
			// setter once to install C.
			const cEditor = makeEditor("c-text");
			let bFocused = false;
			const bEditor = makeEditor("b-text") as StructuralEditor & { focused?: boolean };
			Object.defineProperty(bEditor, "focused", {
				configurable: true,
				enumerable: true,
				get: () => bFocused,
				set: (value: boolean) => {
					if (value && !bFocused) {
						bFocused = true;
						setCustomEditorComponent.call(h.target, () => cEditor);
					} else if (!value && bFocused) {
						bFocused = false;
					}
				},
			});

			// Replace the editor while the custom constructs with no mounted
			// component: the real setter updates the reference only while busy.
			setCustomEditorComponent.call(h.target, () => bEditor);
			expect(currentEditor(h.target)).toBe(bEditor);
			expect(h.editorContainer.children).toEqual([h.editor]);

			// The factory rejection triggers the stale no-successor restoration of
			// B. Focusing B synchronously reenters the real setter to C.
			rejectFactory(uniqueError);
			await expect(custom).rejects.toBe(uniqueError);
			await flush();

			// The exact factory error is preserved and the arbiter converges to C
			// as the sole surface child and focus target; B is never final.
			expect(outcome).toBe(uniqueError);
			expect(currentEditor(h.target)).toBe(cEditor);
			expect(h.editorContainer.children).toEqual([cEditor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(cEditor);
			expect(h.editorContainer.children).not.toContain(bEditor);
			expect(bFocused).toBe(false);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			rejectFactory?.(uniqueError);
			h.arbiter.cancelKind("extension");
			await flush();
			await Promise.allSettled([custom]);
		}
	});

	test("overlay custom runs immediately despite a busy arbiter and keeps its static-options contract", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		let overlayDone: ((result: string) => void) | undefined;
		const overlayComponent = makeCustomComponent();
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			overlayDone = done;
			return overlayComponent;
		});
		const onHandle = vi.fn();

		const promise = createExtensionUIContext.call(h.target).custom(factory, {
			overlay: true,
			overlayOptions: { width: 10 },
			onHandle,
		});

		try {
			expect(h.editorContainer.children).toEqual([blockerComponent]);

			// The factory runs immediately despite the busy arbiter.
			expect(factory).toHaveBeenCalledTimes(1);
			await flush();

			expect(h.showOverlay).toHaveBeenCalledTimes(1);
			expect(h.showOverlay).toHaveBeenCalledWith(overlayComponent, { width: 10 });
			expect(onHandle).toHaveBeenCalledTimes(1);
			expect(onHandle).toHaveBeenCalledWith(h.overlayHandle);
			// The arbiter's editor surface/focus are untouched by the overlay.
			expect(h.editorContainer.children).toEqual([blockerComponent]);

			overlayDone!("overlay-result");
			await expect(promise).resolves.toBe("overlay-result");
			await flush();

			expect(h.hideOverlay).toHaveBeenCalledTimes(1);
			expect(overlayComponent.dispose).toHaveBeenCalledTimes(1);
			expect(h.editorContainer.children).toEqual([blockerComponent]);

			// The blocker remains mounted and settles normally afterwards.
			blocker.done("ok");
			await expect(blocker.handle.result).resolves.toBe("ok");
			await flush();

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle the blocker and the overlay request if an assertion failed
			// before the body settled them. Settled-once guards make these no-ops
			// on the normal path, and both are safe when the factory never ran.
			blocker.done("cleanup");
			overlayDone?.("cleanup");
			await Promise.allSettled([blocker.handle.result, promise]);
		}
	});

	test("overlay custom with function-valued overlay options resolves them at the showOverlay boundary", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const blockerComponent = new Container();
		const blocker = presentAppBlocker(h.arbiter, blockerComponent);

		let overlayDone: ((result: string) => void) | undefined;
		const overlayComponent = makeCustomComponent();
		const optionsFactory = vi.fn(() => ({ anchor: "top-left" as const }));
		const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			overlayDone = done;
			return overlayComponent;
		});
		const onHandle = vi.fn();

		const promise = createExtensionUIContext.call(h.target).custom(factory, {
			overlay: true,
			overlayOptions: optionsFactory,
			onHandle,
		});

		try {
			expect(factory).toHaveBeenCalledTimes(1);
			await flush();

			expect(optionsFactory).toHaveBeenCalledTimes(1);
			expect(h.showOverlay).toHaveBeenCalledTimes(1);
			expect(h.showOverlay).toHaveBeenCalledWith(overlayComponent, { anchor: "top-left" });
			expect(onHandle).toHaveBeenCalledTimes(1);
			expect(onHandle).toHaveBeenCalledWith(h.overlayHandle);
			expect(h.editorContainer.children).toEqual([blockerComponent]);

			overlayDone!("overlay-dynamic-result");
			await expect(promise).resolves.toBe("overlay-dynamic-result");
			await flush();

			expect(h.hideOverlay).toHaveBeenCalledTimes(1);
			expect(overlayComponent.dispose).toHaveBeenCalledTimes(1);

			blocker.done("ok");
			await expect(blocker.handle.result).resolves.toBe("ok");
			await flush();

			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
			expect(h.arbiter.isBusy()).toBe(false);
		} finally {
			// Settle the blocker and the overlay request if an assertion failed
			// before the body settled them. Settled-once guards make these no-ops
			// on the normal path, and both are safe when the factory never ran.
			blocker.done("cleanup");
			overlayDone?.("cleanup");
			await Promise.allSettled([blocker.handle.result, promise]);
		}
	});
});
