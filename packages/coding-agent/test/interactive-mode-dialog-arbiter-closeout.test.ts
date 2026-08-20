import { readFileSync } from "node:fs";
import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// ---------------------------------------------------------------------------
// 10.1 source negative oracle: every `editorContainer.clear(` / `addChild(`
// write lives inside one of the whitelisted owners. This is a deterministic
// lexical scan (no parser dependency): comments, quoted string content and
// template quasi text are masked while offsets and newlines are preserved, but
// executable `${...}` template expressions are recursively retained (with their
// strings/comments/nested templates masked) so a bypass hidden inside a
// template expression is still scanned. Brace depth is counted on the masked
// text only, each exact unmasked match is mapped to the innermost owning
// class-level method/accessor/constructor (or the constructor's injected
// `replaceEditorSurface` arrow, identified by its property name), and the
// whitelist is occurrence-specific. Owner mapping is load-bearing: a bypass
// sneaked into any other method (for example a direct reset that clears the
// container) must fail with the method owner and the 1-based line printed.
// ---------------------------------------------------------------------------

// Class-level method/accessor/constructor declarations sit at brace depth 1
// (directly inside `export class InteractiveMode {` at line 832). A declaration
// line carries a name token before `(`, `=`, `:`, or `<`, and the opening paren
// (when present) must precede any `=`/`:` on the line so field initializers and
// typed fields are not mistaken for methods.
const DECL_LINE_RE =
	/^[ \t]{1,3}(?:(?:private|public|protected|static|readonly|override|async|get|set|declare)\s+)*(?:readonly\s+)*(?:(?:private|public|protected|static|override|async)\s+)*(?:readonly\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:[<(=:])/;

function isMethodDeclLine(line: string): boolean {
	const openParen = line.indexOf("(");
	if (openParen === -1) return false;
	const eq = line.indexOf("=");
	const colon = line.indexOf(":");
	const terminators = [eq, colon].filter((index) => index >= 0);
	return openParen < (terminators.length > 0 ? Math.min(...terminators) : line.length);
}

function countBraces(text: string): number {
	let count = 0;
	for (const char of text) {
		if (char === "{") count += 1;
		else if (char === "}") count -= 1;
	}
	return count;
}

// Single-pass masker preserving character offsets and newlines:
//  - comments (`//` and `/* ... */`) and quoted strings are blanked;
//  - template literals blank their quasi text (including the backticks) but
//    recursively retain every executable `${...}` expression body, masking the
//    strings/comments/nested-template quasi inside it, and keeping the `${`/`}`
//    delimiters so brace depth stays balanced;
//  - regex literals are blanked (content, character classes and escaped
//    delimiters) so their braces can never corrupt depth accounting; division
//    is distinguished by the preceding token. The retained expression bodies
//    stay scannable; the blanked quasi can never produce a pattern hit.
function maskLiterals(source: string): string {
	const masked = [...source];
	const length = source.length;
	const blankSpan = (start: number, end: number) => {
		for (let k = start; k < end; k++) {
			masked[k] = source[k] === "\n" ? "\n" : " ";
		}
	};
	// Mask the quasi text of one template literal starting at `start` (a
	// backtick). Returns the index just past the closing backtick.
	const maskTemplate = (start: number): number => {
		let end = start + 1;
		let quasiStart = start;
		while (end < length) {
			const ch = source[end]!;
			if (ch === "\\") {
				end += 2;
				continue;
			}
			if (ch === "`") {
				blankSpan(quasiStart, end + 1);
				return end + 1;
			}
			if (ch === "$" && source[end + 1] === "{") {
				blankSpan(quasiStart, end);
				end = maskExpressionBody(end + 1);
				quasiStart = end;
				continue;
			}
			end += 1;
		}
		blankSpan(quasiStart, length);
		return length;
	};
	// Mask one `${...}` expression body whose `{` sits at `braceIndex`: string
	// literals, comments and nested template quasi inside the body are blanked,
	// the code and the delimiting braces stay. Returns the index just past the
	// matching closing `}`.
	const maskExpressionBody = (braceIndex: number): number => {
		let depth = 1;
		let index = braceIndex + 1;
		while (index < length && depth > 0) {
			const ch = source[index]!;
			if (ch === '"' || ch === "'") {
				const quote = ch;
				let e = index + 1;
				while (e < length) {
					if (source[e] === "\\") {
						e += 2;
						continue;
					}
					if (source[e] === quote) break;
					e += 1;
				}
				const endInclusive = e < length ? e + 1 : e;
				blankSpan(index, endInclusive);
				index = endInclusive;
			} else if (ch === "/" && source[index + 1] === "/") {
				let e = source.indexOf("\n", index);
				if (e === -1) e = length;
				blankSpan(index, e);
				index = e;
			} else if (ch === "/" && source[index + 1] === "*") {
				let e = source.indexOf("*/", index + 2);
				if (e === -1) e = length;
				else e += 2;
				blankSpan(index, e);
				index = e;
			} else if (ch === "`") {
				index = maskTemplate(index);
			} else if (ch === "/") {
				if (isRegexStart(source, index)) {
					index = maskRegex(source, masked, index);
				} else {
					index += 1;
				}
			} else if (ch === "{") {
				depth += 1;
				index += 1;
			} else if (ch === "}") {
				depth -= 1;
				index += 1;
			} else {
				index += 1;
			}
		}
		return index;
	};
	let index = 0;
	while (index < length) {
		const ch = source[index]!;
		if (ch === "/" && source[index + 1] === "/") {
			let e = source.indexOf("\n", index);
			if (e === -1) e = length;
			blankSpan(index, e);
			index = e;
		} else if (ch === "/" && source[index + 1] === "*") {
			let e = source.indexOf("*/", index + 2);
			if (e === -1) e = length;
			else e += 2;
			blankSpan(index, e);
			index = e;
		} else if (ch === '"' || ch === "'") {
			const quote = ch;
			let e = index + 1;
			while (e < length) {
				if (source[e] === "\\") {
					e += 2;
					continue;
				}
				if (source[e] === quote) break;
				e += 1;
			}
			const endInclusive = e < length ? e + 1 : e;
			blankSpan(index, endInclusive);
			index = Math.max(endInclusive, index + 1);
		} else if (ch === "`") {
			index = maskTemplate(index);
		} else if (ch === "/") {
			if (isRegexStart(source, index)) {
				index = maskRegex(source, masked, index);
			} else {
				// Division operator: stays executable, never a regex body.
				index += 1;
			}
		} else {
			index += 1;
		}
	}
	return masked.join("");
}

// Regex bodies live inside `maskLiterals` below; these helpers only know the
// delimiters and the preceding-token rule, not regex syntax.
const REGEX_START_BEFORE = /[([{,;:=!?&|+\-*%<>~^]/;

// Is the `/` at `index` the start of a regex literal rather than a division
// operator? After blanking, the previous non-whitespace character decides:
// expression-start tokens begin a literal, an identifier/closing bracket means
// division. This is a narrow lexical rule, not a general parser.
function isRegexStart(source: string, index: number): boolean {
	let previous = index - 1;
	while (previous >= 0 && /\s/.test(source[previous]!)) {
		previous -= 1;
	}
	return previous < 0 || REGEX_START_BEFORE.test(source[previous]!);
}

// Mask one regex literal whose opening `/` sits at `start`: scan forward,
// treating `[...]` as a character class (so a `/` or `{` inside it is not a
// delimiter/quantifier) and `\` as escaping the next character. Returns the
// index just past the closing `/` or `start + 1` when the token is unterminated.
function maskRegex(source: string, masked: string[], start: number): number {
	const length = source.length;
	let index = start + 1;
	let inClass = false;
	while (index < length) {
		const ch = source[index]!;
		if (ch === "\\") {
			index += 2;
			continue;
		}
		if (ch === "[") {
			inClass = true;
			index += 1;
			continue;
		}
		if (ch === "]") {
			inClass = false;
			index += 1;
			continue;
		}
		if (ch === "/" && !inClass) {
			const endInclusive = index + 1;
			for (let k = start; k < endInclusive; k++) {
				masked[k] = source[k] === "\n" ? "\n" : " ";
			}
			return endInclusive;
		}
		if (ch === "\n") break;
		index += 1;
	}
	// Unterminated: mask only the opening delimiter so following code stays
	// scannable and the rest keeps its newlines.
	masked[start] = " ";
	return start + 1;
}

// 1-based inclusive line range: `start` is the declaration line, `end` is the
// last body line. Consumers compare directly against 1-based hit lines.
interface OwnerRange {
	start: number;
	end: number;
	name: string;
}

// Locate every class-level method/accessor/constructor body by scanning the
// masked source for depth-1 declaration lines and pairing each with the line
// where the depth drops back to 1 (its closing brace).
function findClassMethods(masked: string): OwnerRange[] {
	const lines = masked.split("\n");
	const depths: number[] = [];
	let depth = 0;
	for (const line of lines) {
		depths.push(depth);
		depth += countBraces(line);
	}
	const ranges: OwnerRange[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (depths[index] !== 1) continue;
		const match = DECL_LINE_RE.exec(line);
		if (!match || !isMethodDeclLine(line)) continue;
		const name = match[1]!;
		// Body opens on the first later line whose pre-depth is >= 2.
		let bodyOpen = -1;
		for (let j = index + 1; j < lines.length; j++) {
			if (depths[j]! >= 2) {
				bodyOpen = j;
				break;
			}
		}
		if (bodyOpen === -1) continue;
		let end = lines.length - 1;
		for (let j = bodyOpen + 1; j < lines.length; j++) {
			if (depths[j]! === 1) {
				end = j - 1;
				break;
			}
		}
		// Ranges are stored in 1-based line coordinates (declaration line through
		// the last body line inclusive), so every consumer compares against the
		// 1-based hit `line` directly without an off-by-one.
		ranges.push({ start: index + 1, end: end + 1, name });
	}
	return ranges;
}

// Arrow-opened blocks (e.g. the constructor's injected `replaceEditorSurface`
// closure) whose `{` opens at depth >= 2; used to distinguish the arrow body
// from its enclosing constructor body. Every `=>` token on a line is considered
// (character-offset level), so same-line nested block arrows and concise
// expression bodies each establish their own block. Each block carries the
// global character offset of its `=>` token (innermost selection for same-line
// arrows) and is labelled with the arrow's binding name when the arrow is a
// named property (`key: (arg) =>`) or a const/let declaration; otherwise it
// stays "arrow".
function findArrowBlocks(masked: string, source: string): Array<OwnerRange & { arrowOffset: number }> {
	const lines = masked.split("\n");
	const depths: number[] = [];
	let depth = 0;
	for (const line of lines) {
		depths.push(depth);
		depth += countBraces(line);
	}
	const lineStarts: number[] = [];
	let lineStart = 0;
	for (const line of lines) {
		lineStarts.push(lineStart);
		lineStart += line.length + 1;
	}
	const blocks: Array<OwnerRange & { arrowOffset: number }> = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const pre = depths[index]!;
		if (pre < 2) continue;
		let searchFrom = 0;
		let arrow = line.indexOf("=>", searchFrom);
		while (arrow !== -1) {
			searchFrom = arrow + 2;
			const brace = line.indexOf("{", arrow);
			const end =
				brace === -1
					? index + 1
					: (() => {
							let j = index + 1;
							while (j < lines.length && depths[j]! > pre) {
								j += 1;
							}
							return j;
						})();
			// 1-based coordinates, same convention as findClassMethods.
			blocks.push({
				start: index + 1,
				end,
				name: arrowBindingName(source, index, arrow),
				arrowOffset: lineStarts[index]! + arrow,
			});
			arrow = line.indexOf("=>", searchFrom);
		}
	}
	return blocks;
}

// The arrow body opens on the masked declaration line; find the owning arrow's
// name from the original source line: the token immediately before `:` (named
// property like `replaceEditorSurface: (component) =>`) or before `=`
// (const/let declaration like `const labelled = (...) =>`), anchored at this
// specific `=>` so multiple arrows on one line each resolve to their binding.
function arrowBindingName(source: string, lineIndex: number, arrowOffset: number): string {
	const line = source.split("\n")[lineIndex] ?? "";
	if (arrowOffset === -1) return "arrow";
	const before = line.slice(0, arrowOffset);
	const colon = before.lastIndexOf(":");
	const eq = before.lastIndexOf("=");
	const anchor = Math.max(colon, eq);
	if (anchor === -1) return "arrow";
	const nameMatch = before.slice(0, anchor).match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
	return nameMatch ? nameMatch[1]! : "arrow";
}

// The InteractiveMode class body (`export class InteractiveMode {` at line 832)
// runs to the end of the file. The lexical scan also finds earlier helper
// classes (e.g. ExpandableText) whose members must not be confused with the
// arbiter-owning InteractiveMode members.
function findInteractiveModeMethods(source: string, masked: string): OwnerRange[] {
	// The class declaration line is 1-based (findIndex + 1), matching the 1-based
	// method range convention; every member declaration line is >= this.
	const classStart = source.split("\n").findIndex((line) => line.trim() === "export class InteractiveMode {") + 1;
	return findClassMethods(masked).filter((method) => method.start >= classStart);
}

const PATTERNS = [
	{ label: "editorContainer.clear(", regex: /editorContainer\.clear\(/g },
	{ label: "editorContainer.addChild(", regex: /editorContainer\.addChild\(/g },
];

// Whitelist is occurrence-specific. Every hit must resolve to the innermost
// enclosing class method/accessor/constructor, and only these are allowed:
//  - the constructor's initial editor mount: a single exact
//    `editorContainer.addChild(this.editor as Component)` statement (the
//    semantic predicate tied to that exact initialization statement);
//  - the constructor's injected `replaceEditorSurface` arrow: clear plus
//    conditional addChild;
//  - `setCustomEditorComponent`: clear + addChild (arbiter-idle branch only;
//    guard correctness is inherited from the group 2 behavior tests).
interface OwnerHit {
	label: string;
	line: number;
	owner: string;
}

function scanEditorContainerOwners(source: string): OwnerHit[] {
	const masked = maskLiterals(source);
	const methods = findInteractiveModeMethods(source, masked);
	const arrows = findArrowBlocks(masked, source);

	const lineOf = (offset: number): number => source.slice(0, offset).split("\n").length;

	// The constructor's initial mount is the single exact
	// `this.editorContainer.addChild(this.editor as Component)` statement in the
	// constructor body (outside any arrow). The same exact statement legitimately
	// exists in setCustomEditorComponent's arbiter-idle branch, so the uniqueness
	// predicate is scoped to the constructor body only.
	const constructorMethod = methods.find((method) => method.name === "constructor");
	// Ranges are 1-based; an arrow's range starts at its declaration line, so a
	// hit on or after the declaration line and within the body is inside it.
	const inArrowRange = (line: number): boolean => arrows.some((block) => block.start <= line && line <= block.end);
	const isConstructorInitialMount = (offset: number, line: number): boolean => {
		if (!constructorMethod) return false;
		// Method/arrow ranges and hit lines are all 1-based.
		if (line < constructorMethod.start || line > constructorMethod.end) return false;
		if (inArrowRange(line)) return false;
		const occurrences = [...source.matchAll(/this\.editorContainer\.addChild\(this\.editor as Component\)/g)];
		const inConstructor = occurrences.filter((occurrence) => {
			const l = lineOf(occurrence.index);
			return l >= constructorMethod.start && l <= constructorMethod.end && !inArrowRange(l);
		});
		// The pattern offset is the `editorContainer.addChild(` match inside the
		// full `this.editorContainer.addChild(...)` statement span, so compare by
		// span containment, not exact offset equality.
		return (
			inConstructor.length === 1 &&
			offset >= inConstructor[0]!.index &&
			offset < inConstructor[0]!.index + inConstructor[0]![0].length
		);
	};

	const ownerOf = (offset: number, line: number): { owner: string; allowed: boolean } => {
		const method = resolveMethodOwner(methods, line);
		const methodLabel = method ? method.name : "<no enclosing class method>";

		// Innermost containing arrow: smallest range wins, then the `=>` token
		// whose global character offset is the last one at-or-before the hit, so
		// a nested callback declared inside the replaceEditorSurface arrow is
		// owned by the nested binding, never by the whitelisted arrow.
		const containing = arrows
			.filter((block) => block.start <= line && line <= block.end && block.arrowOffset <= offset)
			.sort((a, b) => a.end - a.start - (b.end - b.start) || b.arrowOffset - a.arrowOffset);
		const inArrow = containing[0];
		if (inArrow) {
			return {
				owner: `${methodLabel} > ${inArrow.name} (arrow)`,
				allowed: method?.name === "constructor" && inArrow.name === "replaceEditorSurface",
			};
		}
		if (method?.name === "constructor") {
			if (isConstructorInitialMount(offset, line)) {
				return { owner: "constructor (initial editor mount)", allowed: true };
			}
			return { owner: "constructor (body)", allowed: false };
		}
		if (method?.name === "setCustomEditorComponent") {
			return { owner: "setCustomEditorComponent", allowed: true };
		}
		return { owner: methodLabel, allowed: false };
	};

	const hits: OwnerHit[] = [];
	for (const pattern of PATTERNS) {
		pattern.regex.lastIndex = 0;
		let match = pattern.regex.exec(masked);
		while (match !== null) {
			const line = lineOf(match.index);
			const { owner, allowed } = ownerOf(match.index, line);
			if (!allowed) {
				hits.push({ label: pattern.label, line, owner });
			}
			match = pattern.regex.exec(masked);
		}
	}
	return hits;
}

// Innermost class-level method/accessor/constructor containing a 1-based line.
function resolveMethodOwner(methods: OwnerRange[], line: number): OwnerRange | undefined {
	const candidates = methods.filter((method) => method.start <= line && method.end >= line);
	candidates.sort((a, b) => a.end - a.start - (b.end - b.start));
	return candidates[0];
}

// Locate the teardownSessionUi method body on the real source (no fixed lines):
// returns its 1-based declaration/body range and the 1-based lines of the real
// `this.stop(...)` and `stopThemeWatcher()` calls within it, using only the
// lexical method-range machinery shared with the scanner.
function locateTeardownSessionUi(source: string): {
	range: OwnerRange;
	stopCallLine: number;
	stopThemeWatcherLine: number;
} {
	const masked = maskLiterals(source);
	const methods = findInteractiveModeMethods(source, masked);
	const teardown = methods.find((method) => method.name === "teardownSessionUi");
	expect(teardown).toBeDefined();
	const lines = source.split("\n");
	// Scope both call searches to the located method body (1-based lines in
	// [start, end]): `stopThemeWatcher();` also exists in other methods, so a
	// global scan would pick the wrong occurrence.
	let stopCallLine = -1;
	let stopThemeWatcherLine = -1;
	for (let i = teardown!.start; i <= teardown!.end; i++) {
		const line = lines[i - 1] ?? "";
		if (stopCallLine === -1 && /^\s*this\.stop\(/.test(line) && line.includes("preserveAltScreen")) {
			stopCallLine = i;
		}
		if (line.trim() === "stopThemeWatcher();") {
			stopThemeWatcherLine = i;
		}
	}
	expect(stopCallLine).toBeGreaterThan(0);
	expect(stopThemeWatcherLine).toBeGreaterThan(0);
	return { range: teardown!, stopCallLine, stopThemeWatcherLine };
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("handleAgentsBack");
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
		const clearFailure = hits.find((failure) => failure.label === "editorContainer.clear(");
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("constructor (body)");
		// The whitelisted initial mount itself is still allowed.
		expect(hits.filter((failure) => failure.label === "editorContainer.addChild(")).toEqual([]);
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).not.toBe("setCustomEditorComponent");
		// The whitelisted addChild/clear inside setCustomEditorComponent itself is
		// still allowed (only the injected field hit is reported).
		const setCustomHits = scanEditorContainerOwners(injected).filter(
			(failure) => failure.owner === "setCustomEditorComponent",
		);
		expect(setCustomHits).toEqual([]);
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
		const firstBodyHits = scanEditorContainerOwners(firstBody);
		expect(firstBodyHits.filter((failure) => failure.label === "editorContainer.clear(")).toEqual([]);
		// Inject a second clear before the method's closing brace by appending it
		// right before the LAST body line of the method (found via the scanner's
		// own range, so no fixed line). The declaration text is the anchor, and the
		// method's end is derived from the same 1-based range machinery.
		const masked = maskLiterals(original);
		const methods = findInteractiveModeMethods(original, masked);
		const setCustom = methods.find((method) => method.name === "setCustomEditorComponent");
		expect(setCustom).toBeDefined();
		const bodyLines = original.split("\n");
		const lastBodyIndex = setCustom!.end - 1; // 1-based end -> 0-based index
		bodyLines.splice(lastBodyIndex, 0, "\t\tthis.editorContainer.clear(); // last body line");
		const lastBody = bodyLines.join("\n");
		const lastBodyHits = scanEditorContainerOwners(lastBody);
		expect(lastBodyHits.filter((failure) => failure.label === "editorContainer.clear(")).toEqual([]);
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("onCopy");
	});

	test("oracle flags a template-literal executable bypass expression", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// An executable `${this.editorContainer.clear()}` inside a template in a
		// non-whitelisted method must be flagged (template expressions are
		// retained, not blanked).
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("handleAgentsBack");
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("nested");
		expect(clearFailure!.owner).not.toContain("replaceEditorSurface");
	});

	test("regex literal braces in a whitelisted method cannot extend its range to a later forbidden clear", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		// A regex whose `{` would, if treated as an executable brace, keep
		// setCustomEditorComponent's depth from closing, so a later raw clear in
		// handleAgentsBack would be swallowed by the whitelisted range.
		const setCustomMarker = "\tprivate setCustomEditorComponent(factory: EditorFactory | undefined): void {";
		const setCustomIndex = original.indexOf(setCustomMarker);
		expect(setCustomIndex).toBeGreaterThan(-1);
		const poisoned =
			original.slice(0, setCustomIndex) +
			setCustomMarker +
			"\n\t\tconst poison = /{/;" +
			original.slice(setCustomIndex + setCustomMarker.length);
		const backMarker = "private handleAgentsBack(): boolean {";
		const backIndex = poisoned.indexOf(backMarker);
		expect(backIndex).toBeGreaterThan(-1);
		const injectedClear = "\t\tthis.editorContainer.clear();";
		const injected =
			poisoned.slice(0, backIndex) +
			backMarker +
			"\n" +
			injectedClear +
			poisoned.slice(backIndex + backMarker.length);
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("handleAgentsBack");
		const expectedClearLine = injected.slice(0, backIndex).split("\n").length + 1;
		expect(clearFailure!.line).toBe(expectedClearLine);
	});

	test("regex character classes and escaped delimiters cannot corrupt depth or emit a literal-text hit", () => {
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
		const clearFailure = hits.find((failure) => failure.label === "editorContainer.clear(");
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("handleAgentsBack");
		const markerLine = injected.slice(0, markerIndex).split("\n").length;
		expect(clearFailure!.line).toBe(markerLine + 1 + regexLines.length);
		// The regex bodies are masked: none of their lines produce a pattern hit.
		const lines = injected.split("\n");
		for (const regexLine of regexLines) {
			const regexLineNumber = lines.indexOf(regexLine) + 1;
			expect(hits.some((failure) => failure.line === regexLineNumber)).toBe(false);
		}
	});

	test("division is not consumed as a regex literal and the later forbidden clear is still reported", () => {
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("handleAgentsBack");
		const markerLine = injected.slice(0, markerIndex).split("\n").length;
		expect(clearFailure!.line).toBe(markerLine + 2);
	});

	test("a same-line nested block arrow inside replaceEditorSurface is owned by the nested binding", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const original = readFileSync(filePath, "utf8");
		const marker = "\t\t\treplaceEditorSurface: (component) => {";
		const markerIndex = original.indexOf(marker);
		expect(markerIndex).toBeGreaterThan(-1);
		// The nested arrow and its clear sit on the same line as the whitelisted
		// arrow's opening brace; the scanner must not fold them into the parent.
		const injected =
			original.slice(0, markerIndex) +
			marker +
			" const nested = () => { this.editorContainer.clear(); };" +
			original.slice(markerIndex + marker.length);
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("nested");
		expect(clearFailure!.owner).not.toContain("replaceEditorSurface");
		expect(clearFailure!.line).toBe(injected.slice(0, markerIndex).split("\n").length);
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toContain("(arrow)");
		expect(clearFailure!.owner).not.toContain("replaceEditorSurface");
		expect(clearFailure!.line).toBe(injected.slice(0, markerIndex).split("\n").length + 1);
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
		const clearFailure = scanEditorContainerOwners(injected).find(
			(failure) => failure.label === "editorContainer.clear(",
		);
		expect(clearFailure).toBeDefined();
		expect(clearFailure!.owner).toBe("constructor > b (arrow)");
		expect(clearFailure!.owner).not.toContain("> a (arrow)");
		expect(clearFailure!.owner).not.toContain("replaceEditorSurface");
		expect(clearFailure!.line).toBe(injected.slice(0, markerIndex).split("\n").length);
	});

	test("teardownSessionUi body calls real this.stop before stopThemeWatcher without fixed lines", () => {
		initTheme("dark");
		const filePath = new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url).pathname;
		const source = readFileSync(filePath, "utf8");
		const { range, stopCallLine, stopThemeWatcherLine } = locateTeardownSessionUi(source);
		// The real body order is drainInput -> releasePromptStashSession ->
		// this.stop({ preserveAltScreen }) -> stopThemeWatcher(): the stop call
		// must precede the theme watcher teardown inside the same method body.
		expect(stopCallLine).toBeLessThan(stopThemeWatcherLine);
		// Both calls live inside the located method range (no fixed lines).
		expect(stopCallLine).toBeGreaterThanOrEqual(range.start);
		expect(stopThemeWatcherLine).toBeLessThanOrEqual(range.end);
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
