import type { Component } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

interface StructuralEditor extends Component {
	getText(): string;
	setText(text: string): void;
	handleInput(data: string): void;
	onSubmit?: ((text: string) => Promise<void>) | undefined;
	onChange?: ((text: string) => void) | undefined;
	getPaddingX?(): number;
	setPaddingX?(padding: number): void;
	borderColor?: (str: string) => string;
	actionHandlers: Map<string, () => void>;
}

function makeEditor(initialText: string): StructuralEditor {
	let text = initialText;
	return {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		handleInput: vi.fn(),
		render: () => [],
		invalidate: vi.fn(),
		getPaddingX: () => 2,
		setPaddingX: vi.fn(),
		borderColor: (str: string) => str,
		actionHandlers: new Map(),
	};
}

type CustomEditorFactory = (ui: unknown, theme: unknown, keys: unknown) => unknown;
const setCustomEditorComponent = (
	InteractiveMode.prototype as unknown as {
		setCustomEditorComponent(this: unknown, factory: CustomEditorFactory | undefined): void;
	}
).setCustomEditorComponent;

function callSetCustomEditorComponent(target: unknown, factory: CustomEditorFactory | undefined): void {
	setCustomEditorComponent.call(target, factory);
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeHarness(options: { initialEditor?: StructuralEditor; initialFactory?: CustomEditorFactory } = {}) {
	const editorContainer = new Container();
	const initialEditor = options.initialEditor ?? makeEditor("draft");
	editorContainer.addChild(initialEditor);
	// The real DialogArbiter host and fakeThis.ui share the same focus/render
	// spies, mirroring production where the host delegates to this.ui.
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const defaultEditor = makeEditor("default");
	const fakeThis = {
		editorContainer,
		ui: { setFocus, requestRender },
		keybindings: {},
		autocompleteProvider: undefined,
		defaultEditor,
		editor: initialEditor,
		latestEditorPromptStash: undefined as unknown,
		editorComponentFactory: options.initialFactory,
		dialogArbiter: null as unknown as DialogArbiter,
		snapshotPromptStashFrom: () => ({ text: "draft" }),
	};
	const hostReplaceEditorSurface = vi.fn((component?: Component) => {
		editorContainer.clear();
		if (component) {
			editorContainer.addChild(component);
		}
	});
	const arbiter = new DialogArbiter({
		replaceEditorSurface: hostReplaceEditorSurface,
		setFocus: (component) => setFocus(component),
		requestRender: () => requestRender(),
		getCurrentEditor: () => fakeThis.editor,
	});
	fakeThis.dialogArbiter = arbiter;
	return {
		fakeThis,
		arbiter,
		editorContainer,
		defaultEditor,
		setFocus,
		requestRender,
		hostReplaceEditorSurface,
	};
}

function presentAppDialog(arbiter: DialogArbiter): {
	dialogComponent: StructuralEditor;
	capturedDone: ((value: string) => void) | undefined;
	handle: { result: Promise<string> };
} {
	const dialogComponent = makeEditor("dialog");
	let capturedDone: ((value: string) => void) | undefined;
	const handle = arbiter.present<string>({
		kind: "app",
		show: (done) => {
			capturedDone = done;
			return { component: dialogComponent, focus: dialogComponent };
		},
	});
	return { dialogComponent, capturedDone, handle };
}

describe("setCustomEditorComponent", () => {
	test("factory while an app dialog owns the surface leaves the dialog mounted; done restores the custom editor", async () => {
		initTheme("dark");
		const h = makeHarness();
		const { dialogComponent, capturedDone, handle } = presentAppDialog(h.arbiter);
		expect(h.editorContainer.children).toEqual([dialogComponent]);
		expect(h.setFocus).toHaveBeenCalledTimes(1);
		expect(h.requestRender).toHaveBeenCalledTimes(1);

		const customEditor = makeEditor("");
		const factory = vi.fn(() => customEditor);
		callSetCustomEditorComponent(h.fakeThis, factory);

		expect(h.fakeThis.editorComponentFactory).toBe(factory);
		expect(h.editorContainer.children).toEqual([dialogComponent]);
		expect(h.setFocus).toHaveBeenCalledTimes(1);
		expect(h.requestRender).toHaveBeenCalledTimes(1);

		capturedDone?.("ok");
		await expect(handle.result).resolves.toBe("ok");
		await flush();

		expect(h.fakeThis.editor).toBe(customEditor);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(customEditor.getText()).toBe("draft");
		expect(h.fakeThis.latestEditorPromptStash).toEqual({ text: "draft" });
		expect(h.editorContainer.children).toEqual([customEditor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(customEditor);
		expect(h.setFocus).toHaveBeenCalledTimes(3);
		expect(h.requestRender).toHaveBeenCalledTimes(3);
	});

	test("undefined factory while a dialog owns the surface leaves it mounted; done restores the default editor", async () => {
		initTheme("dark");
		const h = makeHarness({
			initialEditor: makeEditor("custom-current"),
			initialFactory: vi.fn(() => makeEditor("custom-current")),
		});
		const { dialogComponent, capturedDone, handle } = presentAppDialog(h.arbiter);
		expect(h.editorContainer.children).toEqual([dialogComponent]);
		expect(h.setFocus).toHaveBeenCalledTimes(1);
		expect(h.requestRender).toHaveBeenCalledTimes(1);

		callSetCustomEditorComponent(h.fakeThis, undefined);

		expect(h.fakeThis.editorComponentFactory).toBeUndefined();
		expect(h.editorContainer.children).toEqual([dialogComponent]);
		expect(h.setFocus).toHaveBeenCalledTimes(1);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		expect(h.fakeThis.editor).toBe(h.defaultEditor);
		expect(h.defaultEditor.getText()).toBe("draft");
		expect(h.fakeThis.latestEditorPromptStash).toEqual({ text: "draft" });

		capturedDone?.("ok");
		await handle.result;
		await flush();

		expect(h.editorContainer.children).toEqual([h.defaultEditor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.defaultEditor);
		expect(h.setFocus).toHaveBeenCalledTimes(3);
		expect(h.requestRender).toHaveBeenCalledTimes(3);
	});

	test("factory while idle replaces the editor surface immediately", () => {
		initTheme("dark");
		const h = makeHarness();
		const customEditor = makeEditor("");
		const factory = vi.fn(() => customEditor);

		callSetCustomEditorComponent(h.fakeThis, factory);

		expect(h.fakeThis.editorComponentFactory).toBe(factory);
		expect(h.editorContainer.children).toEqual([customEditor]);
		expect(h.setFocus).toHaveBeenCalledTimes(1);
		expect(h.setFocus).toHaveBeenCalledWith(customEditor);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		expect(h.fakeThis.editor).toBe(customEditor);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(customEditor.getText()).toBe("draft");
		expect(h.fakeThis.latestEditorPromptStash).toEqual({ text: "draft" });
	});

	test("factory that presents a dialog synchronously keeps the dialog mounted (busy sampled after factory)", async () => {
		initTheme("dark");
		const h = makeHarness();
		const newEditor = makeEditor("");
		const dialogComponent = makeEditor("dialog");
		let capturedDone: ((value: string) => void) | undefined;
		let handle: { result: Promise<string> } | undefined;
		const factory = vi.fn(() => {
			handle = h.arbiter.present<string>({
				kind: "app",
				show: (done) => {
					capturedDone = done;
					return { component: dialogComponent, focus: dialogComponent };
				},
			});
			return newEditor;
		});

		callSetCustomEditorComponent(h.fakeThis, factory);

		expect(h.fakeThis.editorComponentFactory).toBe(factory);
		expect(h.editorContainer.children).toEqual([dialogComponent]);
		expect(h.setFocus).toHaveBeenCalledTimes(1);
		expect(h.setFocus).toHaveBeenCalledWith(dialogComponent);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		expect(h.fakeThis.editor).toBe(newEditor);

		capturedDone?.("ok");
		await handle!.result;
		await flush();

		expect(h.editorContainer.children).toEqual([newEditor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(newEditor);
		expect(h.setFocus).toHaveBeenCalledTimes(3);
		expect(h.requestRender).toHaveBeenCalledTimes(3);
	});
});
