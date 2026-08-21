import { readFileSync } from "node:fs";
import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import {
	type CallExpression,
	type ClassDeclaration,
	type FunctionLikeDeclaration,
	isArrowFunction,
	isBinaryExpression,
	isCallExpression,
	isClassDeclaration,
	isConstructorDeclaration,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isIdentifier,
	isMethodDeclaration,
	isNewExpression,
	isObjectLiteralExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isSetAccessorDeclaration,
	isVariableDeclaration,
	type MethodDeclaration,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// ---------------------------------------------------------------------------
// 10.1 source negative oracle. `scanEditorContainerOwners` parses each source
// with the TypeScript 7 virtual AST snapshot API (`typescript/unstable/*`) and
// maps every executable `editorContainer.clear(` / `editorContainer.addChild(`
// CallExpression inside `InteractiveMode` to its true innermost function-like
// owner via real parent links. Only three structurally identified occurrences
// may pass: the constructor's single initial mount, the unique
// `replaceEditorSurface` PropertyAssignment arrow inside the constructor's
// `new DialogArbiter({...})` object literal, and the unique
// `setCustomEditorComponent` method. Names are diagnostics only; node identity
// and ancestor relations decide ownership. Every scanned source must first pass
// syntactic diagnostics or the scan throws a diagnostic error.
//
// One API instance and one in-memory virtual source/config are shared by all
// scans (lazily initialized), and `afterAll` disposes the snapshot and closes
// the API exactly once, leaving no tsgo process.
// ---------------------------------------------------------------------------

const VIRTUAL_DIR = "/__dialog-arbiter-closeout-oracle__";
const VIRTUAL_TS = `${VIRTUAL_DIR}/interactive-mode.ts`;
const VIRTUAL_TSCONFIG = `${VIRTUAL_DIR}/tsconfig.json`;

const TS_CONFIG = JSON.stringify({
	compilerOptions: {
		module: "esnext",
		target: "esnext",
		moduleResolution: "bundler",
		strict: true,
		noEmit: true,
	},
	include: ["*.ts"],
});

let oracleApi: API | undefined;
let oracleFs: ReturnType<typeof createVirtualFileSystem> | undefined;
let oracleSnapshot: ReturnType<API["updateSnapshot"]> | undefined;

// The virtual FS write callback is optional on the FileSystem type but always
// present on the value created by createVirtualFileSystem.
function virtualWrite(fs: ReturnType<typeof createVirtualFileSystem>, path: string, content: string): void {
	fs.writeFile!(path, content);
}

// Lazily initialize the shared virtual filesystem/API/config/source exactly
// once and reuse it for every scan. The virtual FS falls back to the real FS
// for unspecified paths; the oracle source/config themselves never touch disk.
// The project and source file are opened on the first snapshot so later
// `fileChanges.changed` updates can locate the project for the changed file.
function initOracle(): void {
	if (oracleApi !== undefined) return;
	const virtualFs = createVirtualFileSystem({});
	virtualWrite(virtualFs, VIRTUAL_TSCONFIG, TS_CONFIG);
	virtualWrite(virtualFs, VIRTUAL_TS, "");
	oracleFs = virtualFs;
	oracleApi = new API({ cwd: VIRTUAL_DIR, fs: virtualFs });
	oracleSnapshot = oracleApi.updateSnapshot({
		openProjects: [VIRTUAL_TSCONFIG],
		openFiles: [VIRTUAL_TS],
	});
}

// Create the successor snapshot before disposing the prior one; AST nodes must
// never be retained across updates.
function parseSource(source: string): SourceFile {
	initOracle();
	virtualWrite(oracleFs!, VIRTUAL_TS, source);
	const next = oracleApi!.updateSnapshot({ fileChanges: { changed: [VIRTUAL_TS] } });
	if (oracleSnapshot !== undefined) oracleSnapshot.dispose();
	oracleSnapshot = next;
	const project = oracleSnapshot.getDefaultProjectForFile(VIRTUAL_TS);
	if (project === undefined) {
		throw new Error(`no configured project for ${VIRTUAL_TS}`);
	}
	const sourceFile = project.program.getSourceFile(VIRTUAL_TS);
	if (sourceFile === undefined) {
		throw new Error(`program has no source file for ${VIRTUAL_TS}`);
	}
	const diagnostics = project.program.getSyntacticDiagnostics(VIRTUAL_TS);
	if (diagnostics.length > 0) {
		const detail = diagnostics
			.map((diagnostic) => {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.pos);
				return `TS${diagnostic.code} ${diagnostic.text} at ${line + 1}:${character + 1}`;
			})
			.join("; ");
		throw new Error(`syntactic diagnostic in mutation source: ${detail}`);
	}
	return sourceFile;
}

function isFunctionLikeDeclaration(node: Node): node is FunctionLikeDeclaration {
	return (
		isArrowFunction(node) ||
		isFunctionExpression(node) ||
		isFunctionDeclaration(node) ||
		isMethodDeclaration(node) ||
		isConstructorDeclaration(node) ||
		isGetAccessorDeclaration(node) ||
		isSetAccessorDeclaration(node)
	);
}

// Innermost function-like ancestor of `node` (real parent links), or undefined
// for a class-field or top-level write.
function innermostFunction(node: Node): FunctionLikeDeclaration | undefined {
	let current: Node | undefined = node.parent;
	while (current !== undefined) {
		if (isFunctionLikeDeclaration(current)) return current;
		current = current.parent;
	}
	return undefined;
}

// Short label for one function-like node: named method/accessor, `constructor`,
// or the actual binding name of a nested arrow/function (PropertyAssignment,
// VariableDeclaration, assignment LHS, function name); unnamed ones fall back
// to `arrow` / `function`.
function nodeLabel(fn: FunctionLikeDeclaration): string {
	if (isConstructorDeclaration(fn)) return "constructor";
	if (isMethodDeclaration(fn)) return fn.name.getText(fn.getSourceFile());
	if (isGetAccessorDeclaration(fn)) return `get ${fn.name.getText(fn.getSourceFile())}`;
	if (isSetAccessorDeclaration(fn)) return `set ${fn.name.getText(fn.getSourceFile())}`;
	if (isFunctionDeclaration(fn)) return fn.name?.getText(fn.getSourceFile()) ?? "function";
	if (isArrowFunction(fn) || isFunctionExpression(fn)) {
		const parent = fn.parent;
		if (isPropertyAssignment(parent)) return parent.name.getText(fn.getSourceFile());
		if (isVariableDeclaration(parent) && isIdentifier(parent.name)) {
			return parent.name.getText(fn.getSourceFile());
		}
		if (isPropertyAccessExpression(parent)) return parent.name.text;
		if (isFunctionExpression(fn) && fn.name !== undefined) return fn.name.getText(fn.getSourceFile());
		if (isBinaryExpression(parent)) {
			// Assignment like `this.ui.onCopy = (text) => ...`: the arrow's label
			// is the assignment target's property name.
			const lhs = parent.left;
			if (isPropertyAccessExpression(lhs)) return lhs.name.text;
			if (isIdentifier(lhs)) return lhs.getText(fn.getSourceFile());
		}
	}
	return isArrowFunction(fn) ? "arrow" : "function";
}

// Stable diagnostic owner label: the full function-like ancestor chain from the
// class level down to the innermost owner, e.g.
// `constructor > replaceEditorSurface (arrow) > nested (arrow)`.
function functionLabel(fn: FunctionLikeDeclaration): string {
	const chain: FunctionLikeDeclaration[] = [];
	let current: Node | undefined = fn;
	while (current !== undefined) {
		if (isFunctionLikeDeclaration(current)) chain.unshift(current);
		current = current.parent;
	}
	return chain
		.map((node) => {
			if (
				isMethodDeclaration(node) ||
				isConstructorDeclaration(node) ||
				isGetAccessorDeclaration(node) ||
				isSetAccessorDeclaration(node)
			) {
				return nodeLabel(node);
			}
			return `${nodeLabel(node)} (${isArrowFunction(node) ? "arrow" : "function"})`;
		})
		.join(" > ");
}

function findInteractiveMode(sourceFile: SourceFile): ClassDeclaration {
	const matches = sourceFile.statements
		.filter(isClassDeclaration)
		.filter((statement) => statement.name?.text === "InteractiveMode");
	if (matches.length !== 1) {
		throw new Error(`expected exactly one InteractiveMode class, found ${matches.length}`);
	}
	return matches[0]!;
}

// Unique body-bearing method on InteractiveMode by name; absence or ambiguity
// fails explicitly.
function findMethod(interactiveMode: ClassDeclaration, name: string): MethodDeclaration {
	const matches = interactiveMode.members
		.filter(isMethodDeclaration)
		.filter((member) => member.name.getText(interactiveMode.getSourceFile()) === name && member.body !== undefined);
	if (matches.length !== 1) {
		throw new Error(`expected exactly one ${name} method, found ${matches.length}`);
	}
	return matches[0]!;
}

// The receiver's FINAL identifier: the `.name` of a PropertyAccessExpression
// receiver (`this.editorContainer` -> `editorContainer`,
// `editorContainerProxy.editorContainer` -> the inner `editorContainer`) or the
// bare Identifier receiver itself (`editorContainer.clear()`).
function finalReceiverIdentifier(receiver: Node): Node | undefined {
	if (isPropertyAccessExpression(receiver)) return receiver.name;
	if (isIdentifier(receiver)) return receiver;
	return undefined;
}

// The raw source slice starting at `editorContainer` through the call open
// paren must be exactly `editorContainer.clear(` / `editorContainer.addChild(`.
// The slice is anchored at the receiver's final identifier node and the callee
// expression's end/open-paren character, never by substring search;
// spaced/computed/optional variants stay excluded.
function matchesPattern(call: CallExpression, sourceFile: SourceFile): "clear" | "addChild" | undefined {
	const expression = call.expression;
	if (!isPropertyAccessExpression(expression)) return undefined;
	const operation = expression.name.text;
	if (operation !== "clear" && operation !== "addChild") return undefined;
	const receiverIdentifier = finalReceiverIdentifier(expression.expression);
	if (receiverIdentifier === undefined || receiverIdentifier.getText(sourceFile) !== "editorContainer") {
		return undefined;
	}
	const markerStart = receiverIdentifier.getStart(sourceFile);
	const openParen = call.expression.end;
	const parenChar = sourceFile.text[openParen];
	if (parenChar !== "(") return undefined;
	return sourceFile.text.slice(markerStart, openParen + 1) === `editorContainer.${operation}(` ? operation : undefined;
}

interface OracleHit {
	label: string;
	line: number;
	owner: string;
}

// Structural whitelist: constructor initial mount (unique direct-constructor
// call with the exact initial-mount text), the unique `replaceEditorSurface`
// property arrow inside the constructor's `new DialogArbiter({...})` object
// literal, and the unique `setCustomEditorComponent` method. Multiple
// structural candidates authorize none.
interface Whitelist {
	initialMount: CallExpression;
	replaceEditorSurface: FunctionLikeDeclaration;
	setCustomEditorComponent: MethodDeclaration;
}

function buildWhitelist(interactiveMode: ClassDeclaration, sourceFile: SourceFile): Whitelist {
	const constructorMatches = interactiveMode.members.filter(isConstructorDeclaration);
	if (constructorMatches.length !== 1) {
		throw new Error(`expected exactly one constructor, found ${constructorMatches.length}`);
	}
	const constructorNode = constructorMatches[0]!;

	// Exactly one direct-constructor call whose text is the initial mount.
	const initialMountText = "this.editorContainer.addChild(this.editor as Component)";
	let initialMount: CallExpression | undefined;
	const scanConstructor = (node: Node): void => {
		if (isCallExpression(node)) {
			if (node.getText(sourceFile) === initialMountText && innermostFunction(node) === constructorNode) {
				if (initialMount !== undefined) {
					throw new Error("multiple constructor initial-mount calls found");
				}
				initialMount = node;
			}
		}
		node.forEachChild(scanConstructor);
	};
	scanConstructor(constructorNode);
	if (initialMount === undefined) {
		throw new Error("constructor initial mount not found");
	}

	// Exactly one `new DialogArbiter({...})` directly owned by the constructor
	// whose object-literal argument holds exactly one `replaceEditorSurface`
	// PropertyAssignment whose initializer is an ArrowFunction. Candidates are
	// counted globally across every direct-constructor NewExpression; a second
	// host anywhere (another NewExpression or a duplicate property) fails closed.
	const hostCandidates: FunctionLikeDeclaration[] = [];
	const scanNewArbiter = (node: Node): void => {
		if (isNewExpression(node)) {
			if (innermostFunction(node) !== constructorNode) return;
			if (node.expression.getText(sourceFile) === "DialogArbiter" && node.arguments !== undefined) {
				for (const argument of node.arguments) {
					if (!isObjectLiteralExpression(argument)) continue;
					const propertyCandidates = argument.properties
						.filter(isPropertyAssignment)
						.filter((property) => property.name.getText(sourceFile) === "replaceEditorSurface");
					if (propertyCandidates.length !== 1 || !isArrowFunction(propertyCandidates[0]!.initializer)) {
						throw new Error(
							`expected exactly one replaceEditorSurface arrow property in new DialogArbiter, found ${propertyCandidates.length}`,
						);
					}
					hostCandidates.push(propertyCandidates[0]!.initializer);
				}
			}
		}
		node.forEachChild(scanNewArbiter);
	};
	scanNewArbiter(constructorNode);
	if (hostCandidates.length !== 1) {
		throw new Error(`expected exactly one DialogArbiter host arrow in constructor, found ${hostCandidates.length}`);
	}
	const arbiterHost = hostCandidates[0]!;

	return {
		initialMount,
		replaceEditorSurface: arbiterHost,
		setCustomEditorComponent: findMethod(interactiveMode, "setCustomEditorComponent"),
	};
}

function scanEditorContainerOwners(source: string): OracleHit[] {
	const sourceFile = parseSource(source);
	const interactiveMode = findInteractiveMode(sourceFile);
	const whitelist = buildWhitelist(interactiveMode, sourceFile);

	const hits: OracleHit[] = [];
	const walk = (node: Node): void => {
		if (isCallExpression(node)) {
			const pattern = matchesPattern(node, sourceFile);
			if (pattern !== undefined) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				const owner = innermostFunction(node);
				const allowed =
					node === whitelist.initialMount ||
					(owner !== undefined && owner === whitelist.replaceEditorSurface) ||
					(owner !== undefined && owner === whitelist.setCustomEditorComponent);
				if (!allowed) {
					hits.push({
						label: `editorContainer.${pattern}(`,
						line: line + 1,
						owner: owner === undefined ? "<no enclosing function>" : functionLabel(owner),
					});
				}
			}
		}
		node.forEachChild(walk);
	};
	walk(interactiveMode);
	return hits;
}

// ---------------------------------------------------------------------------
// AST teardown locator: unique body-bearing teardownSessionUi method, real
// `this.stop(...)` and `stopThemeWatcher()` CallExpressions inside it, both
// unique and ordered by node position (this.stop before the watcher).
// ---------------------------------------------------------------------------
interface TeardownLocation {
	methodStartLine: number;
	methodEndLine: number;
	stopCallLine: number;
	stopThemeWatcherLine: number;
}

function locateTeardownSessionUi(source: string): TeardownLocation {
	const sourceFile = parseSource(source);
	const interactiveMode = findInteractiveMode(sourceFile);
	const teardown = findMethod(interactiveMode, "teardownSessionUi");
	const body = teardown.body;
	if (body === undefined) throw new Error("teardownSessionUi has no body");

	const lineOf = (node: Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
	const stops: number[] = [];
	const watchers: number[] = [];
	const walk = (node: Node): void => {
		if (isCallExpression(node)) {
			const expression = node.expression;
			if (
				isPropertyAccessExpression(expression) &&
				expression.name.text === "stop" &&
				expression.expression.getText(sourceFile) === "this"
			) {
				stops.push(node.getStart(sourceFile));
			}
			if (expression.getText(sourceFile) === "stopThemeWatcher") {
				watchers.push(node.getStart(sourceFile));
			}
		}
		node.forEachChild(walk);
	};
	walk(body);

	const methodStart = lineOf(teardown);
	const methodEnd = sourceFile.getLineAndCharacterOfPosition(teardown.getEnd()).line + 1;
	if (stops.length !== 1)
		throw new Error(`expected exactly one this.stop call in teardownSessionUi, found ${stops.length}`);
	if (watchers.length !== 1) {
		throw new Error(`expected exactly one stopThemeWatcher call in teardownSessionUi, found ${watchers.length}`);
	}
	const stopOffset = stops[0]!;
	const watcherOffset = watchers[0]!;
	if (stopOffset >= watcherOffset) {
		throw new Error("this.stop must precede stopThemeWatcher by node position");
	}
	return {
		methodStartLine: methodStart,
		methodEndLine: methodEnd,
		stopCallLine: lineOf(findCallAt(teardown, stopOffset, sourceFile)),
		stopThemeWatcherLine: lineOf(findCallAt(teardown, watcherOffset, sourceFile)),
	};
}

// The call node whose start offset equals `offset` inside `teardown`'s body.
function findCallAt(teardown: MethodDeclaration, offset: number, sourceFile: SourceFile): Node {
	let found: Node | undefined;
	const walk = (node: Node): void => {
		if (node.getStart(sourceFile) === offset) {
			found = node;
		}
		node.forEachChild(walk);
	};
	walk(teardown);
	if (found === undefined) throw new Error("call not found at offset");
	return found;
}

// 1-based line range of a unique body-bearing InteractiveMode method (no fixed
// product lines); used by mutation tests to place statements at method edges.
function locateMethodRange(source: string, name: string): { start: number; end: number } {
	const sourceFile = parseSource(source);
	const interactiveMode = findInteractiveMode(sourceFile);
	const method = findMethod(interactiveMode, name);
	return {
		start: sourceFile.getLineAndCharacterOfPosition(method.getStart(sourceFile)).line + 1,
		end: sourceFile.getLineAndCharacterOfPosition(method.getEnd()).line + 1,
	};
}

// ---------------------------------------------------------------------------
// Shared real-entrypoint harness. All four scenarios drive the REAL prototype
// methods (createExtensionUIContext, handleReloadCommand, subscribeToAgent,
// teardownSessionUi, stop, setExtensionFooter, resetExtensionUI, showSelector)
// against a REAL DialogArbiter wired to a faithful editor/surface/focus
// harness. Only unrelated system boundaries are stubbed.
// ---------------------------------------------------------------------------

type UIContextStub = {
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	input(
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	custom<T>(
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
	): Promise<T>;
	setFooter(
		factory: ((tui: unknown, theme: unknown, footerData: unknown) => Component & { dispose?(): void }) | undefined,
	): void;
};

const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as {
		createExtensionUIContext(this: unknown): UIContextStub;
	}
).createExtensionUIContext;

const handleReloadCommand = (
	InteractiveMode.prototype as unknown as {
		handleReloadCommand(this: unknown): Promise<void>;
	}
).handleReloadCommand;

const subscribeToAgent = (
	InteractiveMode.prototype as unknown as {
		subscribeToAgent(this: unknown): void;
	}
).subscribeToAgent;

const teardownSessionUi = (
	InteractiveMode.prototype as unknown as {
		teardownSessionUi(this: unknown, options?: { preserveAltScreen?: boolean }): Promise<void>;
	}
).teardownSessionUi;

const showSelector = (
	InteractiveMode.prototype as unknown as {
		showSelector(this: unknown, create: (done: () => void) => { component: Component; focus: Component }): void;
	}
).showSelector;

interface SurfaceObserver {
	replacements: Array<Component | undefined>;
	focuses: Array<Component | null>;
	renders: number[];
	setFocusCalls: Array<Component | null>;
}

function makeEditor(): Container & {
	getText(): string;
	setText(text: string): void;
	getExpandedText(): string;
	handleInput(data: string): void;
	setPaddingX?(): void;
	setAutocompleteMaxVisible?(): void;
	setAutocompleteProvider?(): void;
	addToHistory?(): void;
} {
	let text = "";
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		getExpandedText: () => text,
		handleInput: vi.fn(),
		render: () => [],
		invalidate: () => undefined,
		setPaddingX: vi.fn(),
		setAutocompleteMaxVisible: vi.fn(),
		setAutocompleteProvider: vi.fn(),
		addToHistory: vi.fn(),
		children: [] as Component[],
	} as unknown as Container & {
		getText(): string;
		setText(text: string): void;
		getExpandedText(): string;
		handleInput(data: string): void;
	};
	return editor;
}

// A custom non-overlay dialog component with an observable synchronous dispose,
// faithful to the real extension-custom component ownership contract.
class TestCustomComponent extends Container {
	dispose = vi.fn();
}

function makeCustomComponent(): TestCustomComponent {
	return new TestCustomComponent();
}

function makeHarness(options: { rows?: number } = {}): {
	target: InteractiveMode;
	arbiter: DialogArbiter;
	editor: ReturnType<typeof makeEditor>;
	defaultEditor: ReturnType<typeof makeEditor>;
	editorContainer: Container;
	footerSlot: Container;
	surface: SurfaceObserver;
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	ui: {
		setFocus: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		showOverlay: ReturnType<typeof vi.fn>;
		hideOverlay: ReturnType<typeof vi.fn>;
		setShowHardwareCursor: ReturnType<typeof vi.fn>;
		setClearOnShrink: ReturnType<typeof vi.fn>;
		terminal: {
			rows: number;
			setTitle: ReturnType<typeof vi.fn>;
			drainInput: ReturnType<typeof vi.fn>;
			setProgress: ReturnType<typeof vi.fn>;
		};
		stop: ReturnType<typeof vi.fn>;
		addChild: ReturnType<typeof vi.fn>;
	};
	keybindings: KeybindingsManager;
	overlayHandle: {
		hide: ReturnType<typeof vi.fn>;
		setHidden: ReturnType<typeof vi.fn>;
		focus: ReturnType<typeof vi.fn>;
		unfocus: ReturnType<typeof vi.fn>;
	};
} {
	const rows = options.rows ?? 24;
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const showOverlay = vi.fn(() => overlayHandle);
	const hideOverlay = vi.fn();
	const setShowHardwareCursor = vi.fn();
	const setClearOnShrink = vi.fn();
	const setTitle = vi.fn();
	const drainInput = vi.fn(async () => undefined);
	const setProgress = vi.fn();
	const stop = vi.fn();
	const addChild = vi.fn();
	const overlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		focus: vi.fn(),
		unfocus: vi.fn(),
	};
	const editor = makeEditor();
	const defaultEditor = makeEditor();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const footerSlot = new Container();
	const ui = {
		setFocus,
		requestRender,
		showOverlay,
		hideOverlay,
		setShowHardwareCursor,
		setClearOnShrink,
		terminal: { rows, setTitle, drainInput, setProgress },
		stop,
		addChild,
	};
	const keybindings = new KeybindingsManager();
	const surface: SurfaceObserver = {
		replacements: [],
		focuses: [],
		renders: [],
		setFocusCalls: [],
	};
	const target = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		editorContainer,
		editor,
		defaultEditor,
		ui,
		keybindings,
		editorComponentFactory: undefined,
		autocompleteProvider: undefined,
		latestEditorPromptStash: undefined,
		promptStashState: {},
		promptStashSessionId: undefined,
		promptStashStore: undefined,
		pastedImages: new Map(),
		footerSlot,
		footer: { dispose: vi.fn(), invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
		footerDataProvider: {
			dispose: vi.fn(),
			invalidate: vi.fn(),
			setCwd: vi.fn(),
			setExtensionStatus: vi.fn(),
			clearExtensionStatuses: vi.fn(),
			setAvailableProviderCount: vi.fn(),
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 0,
			onBranchChange: () => () => undefined,
		},
		isInitialized: false,
		unsubscribe: undefined,
		signalCleanupHandlers: [],
		shutdownRequested: false,
	});
	let focusedComponent: Component | undefined;
	const arbiter = new DialogArbiter({
		replaceEditorSurface: (component) => {
			surface.replacements.push(component);
			editorContainer.clear();
			if (component) editorContainer.addChild(component);
		},
		// Faithfully mirror the real TUI setFocus: track focus and toggle the
		// `focused` flag on components that carry it.
		setFocus: (component) => {
			if (focusedComponent && "focused" in focusedComponent) {
				(focusedComponent as Component & { focused?: boolean }).focused = false;
			}
			focusedComponent = component ?? undefined;
			if (component && "focused" in component) {
				(component as Component & { focused?: boolean }).focused = true;
			}
			surface.focuses.push(component);
			surface.setFocusCalls.push(component);
			setFocus(component);
		},
		requestRender: (force?: boolean) => {
			surface.renders.push(force ? 1 : 0);
			requestRender(force);
		},
		getCurrentEditor: () => (target as unknown as { editor: Component }).editor,
	});
	(target as unknown as { dialogArbiter: DialogArbiter }).dialogArbiter = arbiter;
	return {
		target,
		arbiter,
		editor,
		defaultEditor,
		editorContainer,
		footerSlot,
		surface,
		setFocus,
		requestRender,
		ui,
		keybindings,
		overlayHandle,
	};
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Stub the unrelated reload/reset dependencies so the REAL handleReloadCommand
// runs against own-property stubs (agentConnection.reload controlled by the
// test), while the REAL arbiter/dialogArbiter/handleReloadCommand stay in
// charge.
function prepareReloadTarget(
	h: {
		target: InteractiveMode;
		editor: ReturnType<typeof makeEditor>;
		ui: ReturnType<typeof makeHarness>["ui"];
	},
	reload: () => Promise<unknown>,
): void {
	const state = {
		cwd: "/test",
		sessionId: "test-session",
		thinkingLevel: "off" as const,
		availableThinkingLevels: [],
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
		contextUsage: undefined,
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
		footerDataProvider: {
			clearExtensionStatuses: vi.fn(),
			setCwd: vi.fn(),
			setExtensionStatus: vi.fn(),
			setAvailableProviderCount: vi.fn(),
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 0,
			onBranchChange: () => () => undefined,
		},
		footer: { invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
		autocompleteProviderWrappers: [],
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
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
				getCompactionEnabled: vi.fn(() => false),
				getEnableSkillCommands: vi.fn(() => false),
				getQuietStartup: vi.fn(() => true),
			},
			modelRegistry: { getError: vi.fn(() => undefined) },
		},
		heartbeatCatalog: [],
		heartbeats: [],
		subagentSnapshots: new Map(),
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
		sessionRecap: undefined,
		recapContainer: undefined,
		featureHintComponent: undefined,
		agentRunFileChanges: new Map(),
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		promptStashStore: undefined,
		promptStashSessionId: undefined,
		sessionEventQueue: Promise.resolve(),
		sessionEventGeneration: 0,
	});
}

describe("dialog arbiter closeout: source negative oracle", () => {
	test("every editorContainer clear/addChild belongs to the whitelisted owners", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const source = readFileSync(filePath, "utf8");
		expect(scanEditorContainerOwners(source)).toEqual([]);
	});

	test("oracle flags a bypass inserted into a non-whitelisted method", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// `handleAgentsBack` is a private method with a tiny body; the injected
		// clear must land inside it to prove method ownership.
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tthis.editorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, markerIndex).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("oracle flags an extra clear in the constructor body", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// Inject an extra clear directly into the constructor body (after the
		// initial mount) so it must fail as constructor-body, not whitelisted.
		const mountLine = original
			.split("\n")
			.findIndex((line) => line.trim() === "this.editorContainer.addChild(this.editor as Component);");
		expect(mountLine).toBeGreaterThan(-1);
		const lines = original.split("\n");
		lines.splice(mountLine + 1, 0, "\t\tthis.editorContainer.clear();");
		const injected = lines.join("\n");
		const hits = scanEditorContainerOwners(injected);
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: mountLine + 2,
				owner: "constructor",
			},
		]);
	});

	test("oracle does not attribute a class-field bypass on the line before setCustomEditorComponent to that whitelisted method", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A one-line class member initializer inserted immediately before the
		// setCustomEditorComponent declaration sits on the 1-based line one below
		// the method's 0-based declaration index. It must NOT be whitelisted as
		// setCustomEditorComponent (the off-by-one would have attributed it).
		const marker = "\tprivate setCustomEditorComponent(factory: EditorFactory | undefined): void {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			"\tprivate editorContainerBypass = this.editorContainer.clear();\n" +
			original.slice(markerIndex);
		const hits = scanEditorContainerOwners(injected);
		// The class field has no enclosing function: it must never borrow the
		// adjacent whitelisted method. Its line is derived from the injected
		// field's own offset in the mutation source.
		const fieldOffset = injected.indexOf("private editorContainerBypass");
		expect(fieldOffset).toBeGreaterThan(-1);
		const fieldLine = injected.slice(0, fieldOffset).split("\n").length;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: fieldLine,
				owner: "<no enclosing function>",
			},
		]);
	});

	test("oracle method boundaries hold on the first and last body lines of setCustomEditorComponent", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\tprivate setCustomEditorComponent(factory: EditorFactory | undefined): void {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		// Inject a clear on the FIRST body line (immediately after the declaration
		// opening brace) — inside the method, so it must be whitelisted.
		const firstBody =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tthis.editorContainer.clear(); // first body line" +
			original.slice(markerIndex + marker.length);
		expect(scanEditorContainerOwners(firstBody)).toEqual([]);
		// Inject a clear just before the method's closing brace: locate the last
		// body line via the parsed method range (no fixed line).
		const setCustomRange = locateMethodRange(original, "setCustomEditorComponent");
		const bodyLines = original.split("\n");
		const lastBodyIndex = setCustomRange.end - 1; // 1-based end -> 0-based index
		bodyLines.splice(lastBodyIndex, 0, "\t\tthis.editorContainer.clear(); // last body line");
		const lastBody = bodyLines.join("\n");
		expect(scanEditorContainerOwners(lastBody)).toEqual([]);
	});

	test("oracle flags an unrelated constructor arrow containing clear and names that arrow", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// `this.ui.onCopy = (text) => {` is an unrelated arrow inside the
		// constructor body; a clear injected there must fail and name the arrow.
		const marker = "this.ui.onCopy = (text) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t\tthis.editorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, markerIndex).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "constructor > onCopy (arrow)",
			},
		]);
		expect(hits[0]!.owner).not.toBe("constructor > arrow (arrow)");
	});

	test("oracle attributes a raw clear inside the get promptStash accessor to that accessor", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// `get promptStash` is a real accessor; a raw clear injected into its body
		// must be owned by the accessor, never `<no enclosing function>` or an
		// adjacent method.
		const marker = "private get promptStash(): PromptStash | undefined {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tthis.editorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		// The injected clear's line is derived from the mutation source offset
		// after the marker (the first textual clear in the file is the real
		// constructor/replaceEditorSurface write, not the injected one).
		const injectedClearOffset = injected.indexOf("\n\t\tthis.editorContainer.clear();", markerIndex);
		expect(injectedClearOffset).toBeGreaterThan(-1);
		const clearLine = injected.slice(0, injectedClearOffset).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: clearLine,
				owner: "get promptStash",
			},
		]);
	});

	test("oracle flags a template-literal executable bypass expression", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// An executable `${this.editorContainer.clear()}` inside a template in a
		// non-whitelisted method must be flagged (template expressions are real
		// CallExpressions to the parser).
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		// Build the injected template-literal bypass from parts so the literal
		// `${...}` never appears verbatim in this source file (the scanner under
		// test must find it only inside the injected source string).
		const templateBypass = "void `bypass " + "${" + "this.editorContainer.clear()" + "}" + " done`;";
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t" +
			templateBypass +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, markerIndex).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("the same text inside a comment, string, or template quasi is ignored", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t// this.editorContainer.clear();\n" +
			'\t\tconst a = "this.editorContainer.addChild(x);";\n' +
			"\t\tconst b = `this.editorContainer.clear();`;" +
			original.slice(markerIndex + marker.length);
		expect(scanEditorContainerOwners(injected)).toEqual([]);
	});

	test("oracle flags a nested arrow inside replaceEditorSurface and names the nested binding", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A multi-line nested callback declared inside the real
		// replaceEditorSurface arrow must be owned by the nested binding, NOT by
		// the whitelisted replaceEditorSurface arrow. The nested arrow is the
		// innermost containing arrow and must not inherit the whitelist.
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t\t\t\tconst nested = () => {" +
			"\n\t\t\t\t\t\tthis.editorContainer.clear();" +
			"\n\t\t\t\t\t};" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, markerIndex).split("\n").length + 2;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "constructor > replaceEditorSurface (arrow) > nested (arrow)",
			},
		]);
	});

	test("regex literals are not executable and cannot emit a hit or poison a method", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const regexLines = [
			"\t\tconst classBraces = /[{}\\/\\\\]/g;",
			"\t\tconst quantifier = /a{2,3}/;",
			"\t\tconst literalText = /editorContainer.clear()/;",
		];
		const injectedClear = "\t\tthis.editorContainer.clear();";
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n" +
			regexLines.join("\n") +
			"\n" +
			injectedClear +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const markerLine = injected.slice(0, markerIndex).split("\n").length;
		// Regex bodies produce no hits; the later clear is the only rejected hit.
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: markerLine + 1 + regexLines.length,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("division stays executable and cannot swallow the later forbidden clear", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const division = "\t\tconst ratio = numerator / denominator;";
		const injectedClear = "\t\tthis.editorContainer.clear();";
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n" +
			division +
			"\n" +
			injectedClear +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const markerLine = injected.slice(0, markerIndex).split("\n").length;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: markerLine + 2,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("a same-line nested block arrow inside replaceEditorSurface is owned by the nested binding", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		// The nested arrow and its clear sit on the same line as the whitelisted
		// arrow's opening brace; the parser must not fold them into the parent.
		const injected =
			original.slice(0, markerIndex) +
			marker +
			" const nested = () => { this.editorContainer.clear(); };" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injected.slice(0, markerIndex).split("\n").length,
				owner: "constructor > replaceEditorSurface (arrow) > nested (arrow)",
			},
		]);
	});

	test("a concise arrow inside replaceEditorSurface is owned by the innermost arrow, not the whitelisted parent", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t\t\tqueueMicrotask(() => this.editorContainer.clear());" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injected.slice(0, markerIndex).split("\n").length + 1,
				owner: "constructor > replaceEditorSurface (arrow) > arrow (arrow)",
			},
		]);
	});

	test("with multiple arrows on one line the hit resolves to the innermost arrow, never the first", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		// Two concise arrows on the whitelisted arrow's own line: only the second's
		// body contains the raw clear, so the hit must resolve to that binding.
		const injected =
			original.slice(0, markerIndex) +
			marker +
			" const a = () => 1; const b = () => this.editorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injected.slice(0, markerIndex).split("\n").length,
				owner: "constructor > replaceEditorSurface (arrow) > b (arrow)",
			},
		]);
	});

	test("a nested callback deliberately named replaceEditorSurface does not inherit the whitelist", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t\t\tconst replaceEditorSurface = () => this.editorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, markerIndex).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "constructor > replaceEditorSurface (arrow) > replaceEditorSurface (arrow)",
			},
		]);
	});

	test("a same-named local arrow before the real replaceEditorSurface property is rejected while the real property stays allowed", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// Inject a valid same-named local declaration BEFORE the real
		// `replaceEditorSurface:` object property in the constructor. The unique
		// whitelisted identity is the property arrow itself, so the earlier local
		// arrow must be rejected at its own line while the real property's original
		// clear/addChild stay allowed.
		// Insert the local declaration at a valid constructor statement location
		// (immediately before the `this.dialogArbiter = new DialogArbiter({`
		// statement), so it is a statement in the constructor body, never inside
		// the object literal.
		const arbiterMarker = "\t\tthis.dialogArbiter = new DialogArbiter({";
		const arbiterIndex = original.indexOf(arbiterMarker);
		expect(arbiterIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, arbiterIndex) +
			"\t\tconst replaceEditorSurface = () => this.editorContainer.clear();\n" +
			original.slice(arbiterIndex);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, arbiterIndex).split("\n").length;
		// Exactly the injected local write is rejected; the real property's
		// original clear and conditional addChild are still allowed.
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "constructor > replaceEditorSurface (arrow)",
			},
		]);
	});

	test("a valid local/nested function named replaceEditorSurface in a constructor statement is rejected", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A local function declaration placed at a valid constructor statement
		// location (immediately before the `this.dialogArbiter = new
		// DialogArbiter({` statement) cannot inherit the whitelist.
		const arbiterMarker = "\t\tthis.dialogArbiter = new DialogArbiter({";
		const arbiterIndex = original.indexOf(arbiterMarker);
		expect(arbiterIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, arbiterIndex) +
			"\t\tfunction replaceEditorSurface() {\n\t\t\tthis.editorContainer.clear();\n\t\t}\n" +
			original.slice(arbiterIndex);
		const hits = scanEditorContainerOwners(injected);
		const injectedLine = injected.slice(0, arbiterIndex).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injectedLine,
				owner: "constructor > replaceEditorSurface (function)",
			},
		]);
	});

	test("multiline parenthesized, object, ternary and nested-function bodies own the raw write, later parent write stays allowed", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const arrowBodies = [
			"\n\t\t\t\tconst fn = () => (\n\t\t\t\t\tthis.editorContainer.clear()\n\t\t\t\t);\n\t\t\t\tthis.editorContainer.addChild(component);",
			"\n\t\t\t\tconst fn = () => ({\n\t\t\t\t\tx: this.editorContainer.clear(),\n\t\t\t\t});\n\t\t\t\tthis.editorContainer.addChild(component);",
			"\n\t\t\t\tconst fn = () => this.editorContainer.clear()\n\t\t\t\t\t? 1\n\t\t\t\t\t: 2;\n\t\t\t\tthis.editorContainer.addChild(component);",
		];
		for (const body of arrowBodies) {
			const injected = original.slice(0, markerIndex) + marker + body + original.slice(markerIndex + marker.length);
			const hits = scanEditorContainerOwners(injected);
			const clearLine = injected.slice(0, injected.indexOf("this.editorContainer.clear()")).split("\n").length;
			expect(hits).toEqual([
				{
					label: "editorContainer.clear(",
					line: clearLine,
					owner: "constructor > replaceEditorSurface (arrow) > fn (arrow)",
				},
			]);
		}
		// An ordinary nested function binding owns its raw write as a function.
		const functionBody =
			"\n\t\t\t\tfunction fn() {\n\t\t\t\t\tthis.editorContainer.clear();\n\t\t\t\t}\n\t\t\t\tthis.editorContainer.addChild(component);";
		const functionInjected =
			original.slice(0, markerIndex) + marker + functionBody + original.slice(markerIndex + marker.length);
		const functionHits = scanEditorContainerOwners(functionInjected);
		const functionClearLine = functionInjected
			.slice(0, functionInjected.indexOf("this.editorContainer.clear()"))
			.split("\n").length;
		expect(functionHits).toEqual([
			{
				label: "editorContainer.clear(",
				line: functionClearLine,
				owner: "constructor > replaceEditorSurface (arrow) > fn (function)",
			},
		]);
	});

	test("nested arrow and nested function raw writes inside setCustomEditorComponent are rejected with complete hit sets", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A nested arrow raw clear and a nested ordinary function raw addChild
		// inside the whitelisted setCustomEditorComponent must each be rejected
		// with their exact ancestor chains and computed lines. The method's own
		// original direct clear/addChild remain allowed and must not appear in
		// the hit set.
		const marker = "\tprivate setCustomEditorComponent(factory: EditorFactory | undefined): void {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tconst nestedArrow = () => this.editorContainer.clear();" +
			"\n\t\tfunction nestedFunction() {\n\t\t\tthis.editorContainer.addChild(this.editor);\n\t\t}" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		// Anchor both injected lines on the mutation offsets (the first textual
		// clear/addChild in the file belong to the real product source).
		const arrowClearOffset = injected.indexOf("\n\t\tconst nestedArrow = () => this.editorContainer.clear();");
		expect(arrowClearOffset).toBeGreaterThan(-1);
		const arrowClearLine = injected.slice(0, arrowClearOffset).split("\n").length + 1;
		const functionAddChildOffset = injected.indexOf("\t\t\tthis.editorContainer.addChild(this.editor);");
		expect(functionAddChildOffset).toBeGreaterThan(-1);
		const functionAddChildLine = injected.slice(0, functionAddChildOffset).split("\n").length;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: arrowClearLine,
				owner: "setCustomEditorComponent > nestedArrow (arrow)",
			},
			{
				label: "editorContainer.addChild(",
				line: functionAddChildLine,
				owner: "setCustomEditorComponent > nestedFunction (function)",
			},
		]);
	});

	test("a raw write before an arrow token is not retroactively owned by that arrow", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// The raw write precedes the `=>` token on the same line, so it must not be
		// claimed by that arrow's body span; the write is owned by the enclosing
		// method and still reported.
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tthis.editorContainer.clear(); const later = () => 1;" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: injected.slice(0, markerIndex).split("\n").length + 1,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("a duplicate replaceEditorSurface structural property fails closed", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A second `replaceEditorSurface: (component) => ...` property inside the
		// real `new DialogArbiter({...})` object literal must fail closed: no
		// same-name candidate is authorized and the scan throws an explicit
		// structural invariant error.
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\t\t\tthis.editorContainer.clear();\n\t\t\t},\n\t\t\treplaceEditorSurface: (component) => {" +
			original.slice(markerIndex + marker.length);
		expect(() => scanEditorContainerOwners(injected)).toThrow(/replaceEditorSurface/);
	});

	test("a second direct-constructor new DialogArbiter host fails closed as ambiguous", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A syntactically valid second `new DialogArbiter({ replaceEditorSurface:
		// ... })` statement directly in the constructor body makes the host
		// ambiguous: the scan must fail closed explicitly, authorizing neither.
		const marker = "\t\tthis.dialogArbiter = new DialogArbiter({";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const second =
			"\t\tconst secondArbiter = new DialogArbiter({\n" +
			"\t\t\treplaceEditorSurface: (component) => {\n" +
			"\t\t\t\tthis.editorContainer.clear();\n" +
			"\t\t\t},\n" +
			"\t\t});\n" +
			"\t\tvoid secondArbiter;\n";
		const injected = original.slice(0, markerIndex) + second + original.slice(markerIndex);
		expect(() => scanEditorContainerOwners(injected)).toThrow(
			/expected exactly one DialogArbiter host arrow in constructor, found 2/,
		);
	});

	test("exact-pattern scope stays narrow: spaced/computed/optional variants are not counted", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tthis.editorContainer .clear();\n" +
			"\t\tthis.editorContainer?.clear();\n" +
			"\t\tthis.editorContainer[" +
			'"clear"' +
			"]();" +
			original.slice(markerIndex + marker.length);
		// The spaced/computed/optional variants are outside task 10.1's exact
		// pattern scope; no hit is produced.
		expect(scanEditorContainerOwners(injected)).toEqual([]);
	});

	test("a bare local editorContainer alias still matches the exact executable pattern", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// `const editorContainer = this.editorContainer; editorContainer.clear();`
		// is an exact executable `editorContainer.clear(` even though the receiver
		// is a bare identifier, not a dotted `this.editorContainer`.
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\tconst editorContainer = this.editorContainer;\n\t\teditorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		// The injected clear sits after the alias declaration; anchor the line on
		// the injected call text, not the first textual occurrence in the file.
		const injectedClearOffset = injected.indexOf("\n\t\teditorContainer.clear();");
		expect(injectedClearOffset).toBeGreaterThan(-1);
		const clearLine = injected.slice(0, injectedClearOffset).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: clearLine,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("a proxied editorContainerProxy.editorContainer receiver still matches the exact executable pattern", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// `editorContainerProxy.editorContainer.clear()` contains the exact
		// executable `editorContainer.clear(` at the receiver's final identifier;
		// the scanner must not anchor at the `editorContainerProxy` prefix.
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected =
			original.slice(0, markerIndex) +
			marker +
			"\n\t\teditorContainerProxy.editorContainer.clear();" +
			original.slice(markerIndex + marker.length);
		const hits = scanEditorContainerOwners(injected);
		// The injected call's line is derived from its own offset in the mutation
		// source (the first textual `editorContainer.clear(` in the file belongs
		// to the real product source, not the injected call).
		const injectedClearOffset = injected.indexOf("\n\t\teditorContainerProxy.editorContainer.clear();");
		expect(injectedClearOffset).toBeGreaterThan(-1);
		const clearLine = injected.slice(0, injectedClearOffset).split("\n").length + 1;
		expect(hits).toEqual([
			{
				label: "editorContainer.clear(",
				line: clearLine,
				owner: "handleAgentsBack",
			},
		]);
	});

	test("syntactically invalid mutation source is rejected with a diagnostic code and computed line/column", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// Inject a statement that is not valid TypeScript at its location: the
		// scanner must never turn invalid source into oracle evidence.
		const marker = "private handleAgentsBack(): boolean {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		const injected = `${original.slice(0, markerIndex) + marker}\n\t\tconst x = ;${original.slice(markerIndex + marker.length)}`;
		const expectedLine = injected.slice(0, markerIndex).split("\n").length + 1;
		expect(() => scanEditorContainerOwners(injected)).toThrow(
			new RegExp(`TS1109 Expression expected\\.? at ${expectedLine}:13`),
		);
	});

	test("teardownSessionUi body calls real this.stop before stopThemeWatcher without fixed lines", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const source = readFileSync(filePath, "utf8");
		const { methodStartLine, methodEndLine, stopCallLine, stopThemeWatcherLine } = locateTeardownSessionUi(source);
		// The real body order is drainInput -> releasePromptStashSession ->
		// this.stop({ preserveAltScreen }) -> stopThemeWatcher(): the stop call
		// must precede the theme watcher teardown inside the same method body.
		expect(stopCallLine).toBeLessThan(stopThemeWatcherLine);
		// Both calls live inside the located method range (no fixed lines).
		expect(stopCallLine).toBeGreaterThanOrEqual(methodStartLine);
		expect(stopThemeWatcherLine).toBeLessThanOrEqual(methodEndLine);
	});
});

describe("dialog arbiter closeout: real reload after extension editor", () => {
	test("editor cancels once through real reset/reload, reload box mounts and dismisses, late done is inert", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const editorPromise = createExtensionUIContext.call(h.target).editor("Closeout title", "prefill text");
		let editorSettlements = 0;
		let editorValue: string | undefined;
		void editorPromise.then((value) => {
			editorSettlements += 1;
			editorValue = value;
		});
		const mountedEditor = h.editorContainer.children[0];
		expect(mountedEditor).toBeInstanceOf(ExtensionEditorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(mountedEditor);

		// Hold the reload in flight so the placeholder stays mounted and the
		// extension editor's cancel can be observed before/while it mounts.
		let resolveReload!: (value: unknown) => void;
		const reloadPending = new Promise((resolve) => {
			resolveReload = resolve;
		});
		prepareReloadTarget(h, () => reloadPending);

		const reload = handleReloadCommand.call(h.target);
		let reloadDone = false;
		void reload.finally(() => {
			reloadDone = true;
		});

		// The real resetExtensionUI cancels the extension editor exactly once with
		// its cancel contract (undefined); the placeholder queues behind the
		// reset's arbiter handoff and then mounts.
		await expect(editorPromise).resolves.toBeUndefined();
		await flush();

		const reloadBox = h.editorContainer.children[0];
		expect(reloadBox).toBeDefined();
		expect(reloadBox).not.toBe(h.editor);
		expect(reloadBox).not.toBe(mountedEditor);
		expect(h.editorContainer.children).toEqual([reloadBox]);
		expect(h.setFocus).toHaveBeenLastCalledWith(reloadBox);
		// The force render flag is threaded through the placeholder mount.
		expect(h.requestRender).toHaveBeenLastCalledWith(true);
		// While the reload is in flight the surface/focus sequence has already
		// reached the placeholder: editor component -> clear/null -> reload box
		// (force render). The editor component itself is only ever mounted once
		// (the initial mount), never re-mounted.
		expect(h.surface.replacements).toEqual([mountedEditor, undefined, reloadBox]);
		expect(h.surface.focuses).toEqual([mountedEditor, null, reloadBox]);
		expect(reloadDone).toBe(false);

		// Complete the reload: the placeholder dismisses, the current editor is
		// restored (dynamic restore), the reload promise completes, the arbiter
		// idles.
		resolveReload(undefined);
		await reload;
		await flush();

		expect(reloadDone).toBe(true);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		// Full sequence closed: editor component -> clear/null -> reload box
		// (force render) -> placeholder cleanup clear/null -> dynamic editor
		// restore. The editor component itself is only ever mounted once (the
		// initial mount), never re-mounted.
		expect(h.surface.replacements).toEqual([mountedEditor, undefined, reloadBox, undefined, h.editor]);
		expect(h.surface.focuses).toEqual([mountedEditor, null, reloadBox, null, h.editor]);
		expect(h.arbiter.isBusy()).toBe(false);
		expect(editorSettlements).toBe(1);
		expect(editorValue).toBeUndefined();

		// Late editor done/input cannot settle again or touch the UI.
		const focusCalls = h.setFocus.mock.calls.length;
		const renderCalls = h.requestRender.mock.calls.length;
		(mountedEditor as ExtensionEditorComponent).handleInput("\r");
		await flush();
		expect(editorSettlements).toBe(1);
		expect(h.setFocus.mock.calls.length).toBe(focusCalls);
		expect(h.requestRender.mock.calls.length).toBe(renderCalls);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.arbiter.isBusy()).toBe(false);
	});
});

describe("dialog arbiter closeout: real session_replaced cancels extension select, app survives", () => {
	test("select cancels via the real subscriber; queued app factory runs only after, replacement order executes", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const select = createExtensionUIContext.call(h.target).select("Pick", ["Alpha", "Beta"]);
		const selectSurface = h.editorContainer.children[0];
		expect(selectSurface).toBeInstanceOf(ExtensionSelectorComponent);
		expect(h.setFocus).toHaveBeenLastCalledWith(selectSurface);
		let selectSettlements = 0;
		let selectValue: string | undefined;
		void select.then((value) => {
			selectSettlements += 1;
			selectValue = value;
		});

		// Queue an app selector through the REAL private showSelector with a
		// factory spy and the RAW real done captured; the factory must not run
		// while the select is visible. The app component carries an observable
		// dispose, so the real arbiter settle-once oracle can be asserted after
		// the app becomes visible (dispose exactly once, second done inert).
		let appDone: (() => void) | undefined;
		let appFactoryRuns = 0;
		const appComponent = new TestCustomComponent();
		const appFocus = new Container();
		showSelector.call(h.target, (done) => {
			appFactoryRuns += 1;
			appDone = done;
			return { component: appComponent, focus: appFocus };
		});
		expect(appFactoryRuns).toBe(0);
		expect(h.editorContainer.children).toEqual([selectSurface]);
		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);

		// Capture the real agentConnection subscriber, then send session_replaced
		// through it. Do NOT call reset directly.
		let listener:
			| ((event: { type: "session_replaced"; state: Record<string, unknown>; messages: [] }) => Promise<void> | void)
			| undefined;
		const unsubscribe = vi.fn();
		(h.target as unknown as { agentConnection: { subscribe: unknown } }).agentConnection = {
			subscribe: vi.fn((callback) => {
				listener = callback as typeof listener;
				return unsubscribe;
			}),
		};
		subscribeToAgent.call(h.target);

		// Prepare the downstream reset/rebind/render stubs: resetExtensionUI must
		// run REAL (it owns the arbiter cancel), everything downstream is stubbed.
		const order: string[] = [];
		const replacementState = { sessionId: "replacement-session", cwd: "/test" };
		const ownUi = (h.target as unknown as { ui: Record<string, unknown> }).ui;
		Object.assign(h.target as unknown as Record<string, unknown>, {
			activeConnectionExtensionUiRequests: new Map<string, { cancelLocal: () => void }>(),
			agentConnection: {
				respondToExtensionUiRequest: vi.fn(async () => undefined),
			},
			closeHeartbeatManager: vi.fn(),
			showError: vi.fn(),
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(() => order.push("setExtensionFooter")),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			autocompleteProviderWrappers: [],
			setCustomEditorComponent: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			updateTerminalTitle: vi.fn(),
			workingMessage: undefined,
			workingVisible: true,
			setWorkingIndicator: vi.fn(),
			loadingAnimation: undefined,
			setHiddenThinkingLabel: vi.fn(),
			sideQuestionContainer: new Container(),
			sideQuestionEvent: undefined,
			sideQuestionTurns: [],
			sideQuestionComponent: undefined,
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			resetSideQuestion: vi.fn(() => order.push("resetSideQuestion")),
			resetCurrentSessionRenderState: vi.fn(() => order.push("resetCurrentSessionRenderState")),
			rebindCurrentSession: vi.fn(async () => {
				order.push("rebindCurrentSession");
			}),
			renderInitialMessages: vi.fn(async () => {
				order.push("renderInitialMessages");
			}),
			applyConnectionStateSnapshot: vi.fn((state: unknown) => {
				order.push("applyConnectionStateSnapshot");
				void state;
			}),
		});
		(h.target as unknown as { ui: { requestRender: unknown } }).ui = {
			...ownUi,
			requestRender: vi.fn(() => order.push("ui.requestRender")),
		};

		await listener!({
			type: "session_replaced",
			state: replacementState as unknown as Record<string, unknown>,
			messages: [],
		});

		// The extension select settles exactly once with its cancel contract; the
		// app factory runs only after the reset/handoff and its surface appears.
		// The app was never cancelled by the reset: its request survived
		// cancelKind("extension") and only the factory run proves it.
		expect(selectSettlements).toBe(1);
		expect(selectValue).toBeUndefined();
		expect(appFactoryRuns).toBe(1);
		expect(appComponent.dispose).not.toHaveBeenCalled();
		expect(h.editorContainer.children).toEqual([appComponent]);
		expect(h.setFocus).toHaveBeenLastCalledWith(appFocus);
		expect(order).toEqual([
			"resetSideQuestion",
			"setExtensionFooter",
			"applyConnectionStateSnapshot",
			"resetCurrentSessionRenderState",
			"rebindCurrentSession",
			"renderInitialMessages",
			"ui.requestRender",
		]);
		// The real resetExtensionUI ran its arbiter cancel between resetSideQuestion
		// and the snapshot: the cancel was NOT direct and the select settled through
		// the arbiter before the app factory ran.
		expect(order.indexOf("applyConnectionStateSnapshot")).toBeGreaterThan(0);

		// The app selector's real done settles once, restores editor/focus, idles.
		// App selectors are never cancelled by reset: the factory ran (proving the
		// request survived cancelKind("extension")) and the app settles with its
		// own raw real done.
		appDone!();
		await flush();
		// The real arbiter settle-once oracle part 1: the app component is
		// disposed exactly once on its own settlement.
		expect(appComponent.dispose).toHaveBeenCalledTimes(1);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
		// Part 2: a second raw done is a no-op — no additional surface/focus/
		// render and no second disposal.
		const focusCalls = h.setFocus.mock.calls.length;
		const renderCalls = h.requestRender.mock.calls.length;
		appDone!();
		await flush();
		expect(appComponent.dispose).toHaveBeenCalledTimes(1);
		expect(h.setFocus.mock.calls.length).toBe(focusCalls);
		expect(h.requestRender.mock.calls.length).toBe(renderCalls);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.arbiter.isBusy()).toBe(false);
	});
});

describe("dialog arbiter closeout: busy queue, overlay and footer are immediate", () => {
	test("overlay factory/showOverlay/onHandle and footer factory/footerSlot apply immediately, FIFO later", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		// One visible extension select + one queued app selector through real
		// entrypoints; the app factory spy proves the queued item never runs while
		// the overlay/footer are applied.
		const select = createExtensionUIContext.call(h.target).select("Busy select", ["Alpha"]);
		const selectSurface = h.editorContainer.children[0];
		expect(selectSurface).toBeInstanceOf(ExtensionSelectorComponent);

		let appDone: (() => void) | undefined;
		let appFactoryRuns = 0;
		const appComponent = new TestCustomComponent();
		const appFocus = new Container();
		showSelector.call(h.target, (done) => {
			appFactoryRuns += 1;
			appDone = done;
			return { component: appComponent, focus: appFocus };
		});
		expect(appFactoryRuns).toBe(0);
		expect(h.editorContainer.children).toEqual([selectSurface]);
		expect(h.arbiter.isBusy()).toBe(true);

		const surfaceBefore = h.editorContainer.children;
		const focusBefore = h.setFocus.mock.calls.length;
		const renderBefore = h.requestRender.mock.calls.length;

		// Overlay custom through the REAL context: immediate, non-blocking. The
		// overlay renders through ui.showOverlay (not the editor surface), so the
		// editor-surface render/focus and the arbiter queue are untouched.
		let overlayDone: ((result: string) => void) | undefined;
		// The overlay component carries an observable dispose (like the real
		// extension-custom overlay contract): proven to run exactly once on close.
		const overlayComponent = new TestCustomComponent();
		const overlayFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			overlayDone = done;
			return overlayComponent;
		});
		const onHandle = vi.fn();
		const overlay = createExtensionUIContext.call(h.target).custom(overlayFactory, {
			overlay: true,
			overlayOptions: { width: 10 },
			onHandle,
		});
		expect(overlayFactory).toHaveBeenCalledTimes(1);
		await flush();
		expect(h.ui.showOverlay).toHaveBeenCalledTimes(1);
		expect(h.ui.showOverlay).toHaveBeenCalledWith(overlayComponent, { width: 10 });
		expect(onHandle).toHaveBeenCalledTimes(1);
		expect(onHandle).toHaveBeenCalledWith(h.overlayHandle);
		// The overlay is excluded from the arbiter queue: editor surface/focus and
		// the queued app factory are unchanged.
		expect(h.editorContainer.children).toBe(surfaceBefore);
		expect(h.editorContainer.children).toEqual([selectSurface]);
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore);
		expect(appFactoryRuns).toBe(0);
		expect(h.editorContainer.children).not.toContain(h.editor);
		expect(h.arbiter.isBusy()).toBe(true);

		// Footer through the real context + real setExtensionFooter: immediate,
		// non-blocking, outside the arbiter. The real footer setter ends with one
		// render of its own. The footer component carries a dispose spy so it can
		// be proven installed but never disposed by the arbiter.
		const footerComponent = new TestCustomComponent();
		const footerFactory = vi.fn(() => footerComponent);
		createExtensionUIContext.call(h.target).setFooter(footerFactory);
		expect(footerFactory).toHaveBeenCalledTimes(1);
		expect(h.footerSlot.children).toContain(footerComponent);
		expect(h.requestRender.mock.calls.length).toBe(renderBefore + 1);
		// The footer did not touch the arbiter queue or the editor surface/focus.
		expect(h.editorContainer.children).toBe(surfaceBefore);
		expect(h.editorContainer.children).toEqual([selectSurface]);
		expect(h.setFocus.mock.calls.length).toBe(focusBefore);
		expect(appFactoryRuns).toBe(0);
		expect(h.arbiter.isBusy()).toBe(true);

		// Close the overlay via its real done: result/dispose once, repeated done
		// inert.
		let overlaySettlements = 0;
		let overlayValue: string | undefined;
		void overlay.then((value) => {
			overlaySettlements += 1;
			overlayValue = value;
		});
		overlayDone!("overlay-result");
		overlayDone!("overlay-result-again");
		await expect(overlay).resolves.toBe("overlay-result");
		await flush();
		expect(h.ui.hideOverlay).toHaveBeenCalledTimes(1);
		expect(overlayComponent.dispose).toHaveBeenCalledTimes(1);
		expect(overlaySettlements).toBe(1);
		expect(overlayValue).toBe("overlay-result");
		expect(h.editorContainer.children).toEqual([selectSurface]);

		// Settle the visible select; the queued app factory runs exactly once and
		// its surface appears, then the app settles and restores the editor. The
		// footer remains outside the arbiter.
		(selectSurface as ExtensionSelectorComponent).handleInput("\n");
		await expect(select).resolves.toBe("Alpha");
		await flush();

		expect(appFactoryRuns).toBe(1);
		expect(h.editorContainer.children).toEqual([appComponent]);
		expect(h.setFocus).toHaveBeenLastCalledWith(appFocus);

		// The app settles through its raw real done exactly once: dispose once,
		// editor/focus restored, arbiter idle. A second raw done is inert.
		appDone!();
		await flush();
		expect(appComponent.dispose).toHaveBeenCalledTimes(1);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
		const appFocusCalls = h.setFocus.mock.calls.length;
		const appRenderCalls = h.requestRender.mock.calls.length;
		appDone!();
		await flush();
		expect(appComponent.dispose).toHaveBeenCalledTimes(1);
		expect(h.setFocus.mock.calls.length).toBe(appFocusCalls);
		expect(h.requestRender.mock.calls.length).toBe(appRenderCalls);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.arbiter.isBusy()).toBe(false);
		// The custom footer still owns the footerSlot after the FIFO drained and
		// was never disposed by the arbiter (outside the queue).
		expect(h.footerSlot.children).toContain(footerComponent);
		expect(footerComponent.dispose).not.toHaveBeenCalled();
	});
});

describe("dialog arbiter closeout: real teardownSessionUi -> real stop -> disposeAll -> ui.stop", () => {
	test("mounted + queued requests settle synchronously before ui.stop; late done and repeat teardown are inert", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const h = makeHarness();

		const ctx = createExtensionUIContext.call(h.target);

		// One mounted request + two queued requests through the real extension
		// context. The mounted request is a real custom non-overlay component with
		// a dispose spy and a captured done; the queued requests carry observable
		// factories/outcomes.
		const mountedComponent = makeCustomComponent();
		let mountedDone: ((result: string) => void) | undefined;
		const mountedFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, done: (result: string) => void) => {
			mountedDone = done;
			return mountedComponent;
		});
		const first = ctx.custom(mountedFactory);
		// The real showExtensionCustom maps the factory result through a Promise,
		// so the mount happens on the next microtask; flush to let it mount.
		await flush();
		const mounted = h.editorContainer.children[0];
		expect(mounted).toBe(mountedComponent);
		expect(mountedFactory).toHaveBeenCalledTimes(1);
		let firstSettlements = 0;
		let firstSettled: "value" | "error" | undefined;
		let firstErrorName: string | undefined;
		void first.then(
			() => {
				firstSettlements += 1;
				firstSettled = "value";
			},
			(error: unknown) => {
				firstSettlements += 1;
				firstSettled = "error";
				firstErrorName = error instanceof Error ? error.name : String(error);
			},
		);
		const surfaceReplacementsBefore = [...h.surface.replacements];

		// Two queued requests through the same real extension context, each with
		// a DISTINCT spy factory. All three requests (mounted custom + queued
		// custom + queued custom) go through the real showExtensionCustom and
		// cancel with the real AbortError default; both queued factories must stay
		// at 0 (never shown).
		const secondComponent = new TestCustomComponent();
		const secondFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return secondComponent;
		});
		const second = ctx.custom(secondFactory);
		let secondSettlements = 0;
		let secondSettled: "value" | "error" | undefined;
		let secondErrorName: string | undefined;
		void second.then(
			() => {
				secondSettlements += 1;
				secondSettled = "value";
			},
			(error: unknown) => {
				secondSettlements += 1;
				secondSettled = "error";
				secondErrorName = error instanceof Error ? error.name : String(error);
			},
		);

		const thirdComponent = new TestCustomComponent();
		const thirdFactory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, _done: (result: string) => void) => {
			return thirdComponent;
		});
		const third = ctx.custom(thirdFactory);
		let thirdSettlements = 0;
		let thirdSettled: "value" | "error" | undefined;
		let thirdErrorName: string | undefined;
		void third.then(
			() => {
				thirdSettlements += 1;
				thirdSettled = "value";
			},
			(error: unknown) => {
				thirdSettlements += 1;
				thirdSettled = "error";
				thirdErrorName = error instanceof Error ? error.name : String(error);
			},
		);

		// Set isInitialized=true and every field the real stop() reads. The
		// settingsManager getter delegates to uiServices, so the terminal-progress
		// knob is provided there.
		const target = h.target as unknown as Record<string, unknown>;
		target.isInitialized = true;
		target.uiServices = {
			settingsManager: { getShowTerminalProgress: () => true },
			modelRegistry: { getError: vi.fn(() => undefined) },
			getInitialCwd: vi.fn(() => "/test"),
			getThemes: vi.fn(() => []),
		};
		target.unregisterSignalHandlers = vi.fn();
		target.clearCtrlCExitHint = vi.fn();
		target.clearEscapeRepeat = vi.fn();
		target.stopWorkingLoader = vi.fn();
		target.endFeatureHintRun = vi.fn();
		target.stopWorkingPulse = vi.fn();
		target.stopGoalTrayTimer = vi.fn();
		target.closeHeartbeatManager = vi.fn();
		target.clearExtensionTerminalInputListeners = vi.fn();
		target.footer = { dispose: vi.fn() };
		target.footerDataProvider = { dispose: vi.fn(), clearExtensionStatuses: vi.fn() };
		target.unsubscribe = vi.fn();
		h.ui.terminal.setProgress = vi.fn();

		// terminal drain + releasePromptStashSession + theme watcher boundaries.
		target.releasePromptStashSession = vi.fn();
		target.promptStashStore = undefined;
		target.promptStashSessionId = undefined;
		// The production stop() threads the default (no preserveAltScreen) and
		// sets flushFullscreen: undefined when not preserving the alt screen.
		const stopOptions = { preserveAltScreen: undefined, flushFullscreen: undefined };
		const teardownUiStop = vi.fn();
		h.ui.stop = teardownUiStop;

		// Assert synchronously inside the ui.stop callback: the mounted component
		// is already disposed, the surface was cleared, focus is null, a render
		// occurred, and the arbiter's real runtime state is terminal (disposed,
		// no current, empty queue, nothing mounted, no in-flight mounted cleanup).
		// This directly proves all three terminal outcomes were selected
		// synchronously before ui.stop. Do not rely on Promise .then reactions
		// (microtasks) for the terminal-state evidence. The internal-field
		// inspection is a narrow test-only structural cast of the REAL arbiter
		// instance wired into the harness (it observes, never replaces).
		const arbiterState = () =>
			h.arbiter as unknown as {
				disposed: boolean;
				current: unknown;
				queue: unknown[];
				mounted: unknown;
				mountedCleanup: unknown;
			};
		let syncState:
			| {
					surfaceChildren: Component[];
					lastFocus: Component | null;
					rendersAfter: number;
					mountedDisposeCalls: number;
					arbiterBusy: boolean;
					mountedStillInSurface: boolean;
					arbiterDisposed: boolean;
					arbiterCurrent: unknown;
					arbiterQueueLength: number;
					arbiterMounted: unknown;
					arbiterMountedCleanup: unknown;
			  }
			| undefined;
		h.ui.stop = vi.fn((options: unknown) => {
			const internal = arbiterState();
			syncState = {
				surfaceChildren: [...h.editorContainer.children],
				lastFocus: h.surface.focuses.at(-1) ?? null,
				rendersAfter: h.surface.renders.length,
				mountedDisposeCalls: mountedComponent.dispose.mock.calls.length,
				arbiterBusy: h.arbiter.isBusy(),
				mountedStillInSurface: h.editorContainer.children.includes(mountedComponent),
				arbiterDisposed: internal.disposed,
				arbiterCurrent: internal.current,
				arbiterQueueLength: internal.queue.length,
				arbiterMounted: internal.mounted,
				arbiterMountedCleanup: internal.mountedCleanup,
			};
			teardownUiStop(options);
		});

		await teardownSessionUi.call(target);

		// The teardown called the real stop -> real disposeAll -> real ui.stop.
		expect(teardownUiStop).toHaveBeenCalledTimes(1);
		expect(teardownUiStop).toHaveBeenCalledWith(stopOptions);
		expect(target.isInitialized).toBe(false);
		expect(target.releasePromptStashSession).toHaveBeenCalledTimes(1);
		expect(h.ui.terminal.setProgress).toHaveBeenCalledTimes(1);
		expect(target.unsubscribe).toHaveBeenCalledTimes(1);

		// Synchronous terminal-state evidence captured inside the ui.stop callback:
		// the mounted component was already disposed exactly once, the surface was
		// cleared, focus was nulled, a render occurred, and the arbiter is in its
		// permanent terminal state: disposed=true, no current request, empty
		// queue, nothing mounted, and no in-flight mounted cleanup — all three
		// requests selected their terminal outcomes before ui.stop.
		expect(syncState).toBeDefined();
		expect(syncState!.mountedDisposeCalls).toBe(1);
		expect(syncState!.surfaceChildren).toEqual([]);
		expect(syncState!.mountedStillInSurface).toBe(false);
		expect(syncState!.lastFocus).toBeNull();
		expect(syncState!.rendersAfter as number).toBeGreaterThan(0);
		expect(syncState!.arbiterBusy).toBe(true);
		expect(syncState!.arbiterDisposed).toBe(true);
		expect(syncState!.arbiterCurrent).toBeUndefined();
		expect(syncState!.arbiterQueueLength).toBe(0);
		expect(syncState!.arbiterMounted).toBeUndefined();
		expect(syncState!.arbiterMountedCleanup).toBeUndefined();

		// All three result Promises are already settled by native microtasks
		// before any timer flush: probe with a queueMicrotask marker after the
		// same call stack that returned from teardownSessionUi.
		let microtaskProbe: "pending" | "settled" = "pending";
		queueMicrotask(() => {
			microtaskProbe =
				firstSettlements >= 1 && secondSettlements >= 1 && thirdSettlements >= 1 ? "settled" : "pending";
		});
		await flush();
		expect(microtaskProbe).toBe("settled");
		expect(firstSettlements).toBe(1);
		expect(firstSettled).toBe("error");
		expect(firstErrorName).toBe("AbortError");
		expect(secondSettlements).toBe(1);
		expect(secondSettled).toBe("error");
		expect(secondErrorName).toBe("AbortError");
		expect(thirdSettlements).toBe(1);
		expect(thirdSettled).toBe("error");
		expect(thirdErrorName).toBe("AbortError");
		// All three requests were settled by real disposeAll via the real
		// showExtensionCustom default cancel (AbortError); each settlement
		// observer ran exactly once.
		expect(firstSettlements).toBe(1);
		expect(secondSettlements).toBe(1);
		expect(thirdSettlements).toBe(1);
		// The queued requests never mounted: the only replacement after the
		// initial mount is the terminal clear (undefined), never a queued
		// component, and both queued custom's real spy factories were never
		// invoked (disposeAll settles queued items without calling show).
		const mountedReplacements = h.surface.replacements.slice(surfaceReplacementsBefore.length);
		expect(mountedReplacements.filter((replacement) => replacement !== undefined)).toEqual([]);
		expect(h.surface.replacements.at(-1)).toBeUndefined();
		expect(secondFactory).not.toHaveBeenCalled();
		expect(thirdFactory).not.toHaveBeenCalled();
		// The mounted custom's done was captured but the request settled through
		// disposeAll; a late done cannot re-settle or re-dispose.
		expect(mountedDone).toBeDefined();
		expect(h.arbiter.isBusy()).toBe(true);

		// Post-stop: record UI call counts, invoke the captured late done, and call
		// teardownSessionUi again. No new surface/focus/render, no second
		// settlement, no second dispose, no second ui.stop. Repeated drain/release
		// calls follow the real idempotency contract (they may recur).
		const focusCalls = h.setFocus.mock.calls.length;
		const renderCalls = h.requestRender.mock.calls.length;
		mountedDone!("late-value");
		await flush();
		expect(firstSettlements).toBe(1);
		expect(mountedComponent.dispose).toHaveBeenCalledTimes(1);
		expect(h.setFocus.mock.calls.length).toBe(focusCalls);
		expect(h.requestRender.mock.calls.length).toBe(renderCalls);
		expect(h.editorContainer.children).toEqual([]);

		await teardownSessionUi.call(target);
		expect(h.ui.stop).toHaveBeenCalledTimes(1);
		expect(h.setFocus.mock.calls.length).toBe(focusCalls);
		expect(h.requestRender.mock.calls.length).toBe(renderCalls);
		expect(h.editorContainer.children).toEqual([]);
		expect(firstSettlements).toBe(1);
		expect(secondSettlements).toBe(1);
		expect(thirdSettlements).toBe(1);
		expect(mountedComponent.dispose).toHaveBeenCalledTimes(1);
		// Repeated drain/release boundaries follow the real idempotency contract:
		// drainInput and releasePromptStashSession run on every teardownSessionUi
		// invocation; the theme watcher teardown (stopThemeWatcher) is an ESM
		// binding that is not spyable here and is verified as a safe no-op through
		// the source (themeWatcher/themeReloadTimer are module-locals cleared by
		// it; the tests never start a real watcher via initTheme("dark")).
		expect(h.ui.terminal.drainInput).toHaveBeenCalledTimes(2);
		expect(target.releasePromptStashSession).toHaveBeenCalledTimes(2);
	});
});

afterAll(() => {
	if (oracleSnapshot !== undefined && !oracleSnapshot.isDisposed()) {
		oracleSnapshot.dispose();
		oracleSnapshot = undefined;
	}
	if (oracleApi !== undefined) {
		oracleApi.close();
		oracleApi = undefined;
	}
});
