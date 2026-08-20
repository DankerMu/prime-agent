import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Component, Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.js";
import { DialogArbiter } from "../src/modes/interactive/dialog-arbiter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// System-boundary mocks only: `gh` is never invoked, the export temp file
// lives in a test-owned directory, and the share command's spawn/spawnSync are
// fully controlled. No real gh, provider, credentials, network, or paid token
// is touched.
const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(cmd: string, args: string[], options?: { encoding?: string }) => { status: number | null }>(),
	spawn: vi.fn<(cmd: string, args: string[], options?: unknown) => MockProc>(),
	exportToHtml: vi.fn<(outputPath?: string) => Promise<string>>(),
	unlinkCalls: [] as string[],
	testRoot: undefined as string | undefined,
	realTmpdir: undefined as (() => string) | undefined,
}));

interface MockProc {
	stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
	stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown };
	on(event: "close" | "error", listener: (arg: number | null | Error) => void): unknown;
	kill(): boolean;
}

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawn: mocks.spawn, spawnSync: mocks.spawnSync };
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	mocks.realTmpdir = actual.tmpdir;
	return { ...actual, tmpdir: () => mocks.testRoot ?? mocks.realTmpdir?.() };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		unlinkSync: (p: string) => {
			mocks.unlinkCalls.push(p);
			actual.unlinkSync(p);
		},
	};
});

// Typed access to the private handleShareCommand so the REAL share command runs
// against own-property stubs prepared by the test.
const handleShareCommand = (
	InteractiveMode.prototype as unknown as {
		handleShareCommand(this: unknown): Promise<void>;
	}
).handleShareCommand;

// The host lifecycle flag that gates UI writes while an export is pending.
function setHostInitialized(target: InteractiveMode, value: boolean): void {
	(target as unknown as { isInitialized: boolean }).isInitialized = value;
}

// Structural host contract the arbiter constructor requires; the test passes a
// default host or a throwing override for the mount-failure scenario.
interface TestDialogArbiterHost {
	replaceEditorSurface(component?: Component): void;
	setFocus(component: Component | null): void;
	requestRender(force?: boolean): void;
	getCurrentEditor(): Component;
}

interface Harness {
	target: InteractiveMode;
	arbiter: DialogArbiter;
	editor: Container;
	editorContainer: Container;
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
}

function makeHarness(hostOverride?: TestDialogArbiterHost): Harness {
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const editor = new Container();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const ui = { setFocus, requestRender, terminal: { rows: 24 } };
	const arbiter = new DialogArbiter(
		hostOverride ?? {
			replaceEditorSurface: (component) => {
				editorContainer.clear();
				if (component) editorContainer.addChild(component);
			},
			setFocus: (component) => setFocus(component),
			requestRender: (force?: boolean) => requestRender(force),
			getCurrentEditor: () => editor,
		},
	);
	const target = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		editorContainer,
		editor,
		defaultEditor: editor,
		ui,
		dialogArbiter: arbiter,
		agentConnection: { exportToHtml: mocks.exportToHtml },
		showStatus,
		showError,
		isInitialized: true,
	});
	return { target, arbiter, editor, editorContainer, setFocus, requestRender, showStatus, showError };
}

// A controllable child-process double: stdout/stderr deliver synchronously and
// close()/error() fire the corresponding listeners on demand. An error listener
// must be attached for `error` to fire (like a real EventEmitter child).
function makeProc() {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const proc = new EventEmitter() as EventEmitter & MockProc;
	proc.stdout = stdout as unknown as MockProc["stdout"];
	proc.stderr = stderr as unknown as MockProc["stderr"];
	proc.kill = vi.fn(() => true);
	return {
		proc,
		kill: proc.kill,
		writeStdout: (chunk: string) => stdout.emit("data", chunk),
		writeStderr: (chunk: string) => stderr.emit("data", chunk),
		close: (code: number | null) => proc.emit("close", code),
		// Emitting "error" on a real EventEmitter child with no listener throws,
		// so this also proves the implementation attached an error listener.
		error: (err: Error) => proc.emit("error", err),
		emitEvent: (event: string, arg: unknown) => proc.emit(event, arg),
	};
}

// An app-kind blocker occupying the shared arbiter (like a visible selector).
function presentBlocker(arbiter: DialogArbiter) {
	const blocker = new Container();
	let doneBlocker!: (value: string) => void;
	arbiter.present<string>({
		kind: "app",
		show: (done) => {
			doneBlocker = done;
			return { component: blocker, focus: blocker };
		},
	});
	return { blocker, done: (value: string) => doneBlocker(value) };
}

// The real exportToHtml mock: writes the owned temp file (like a real export)
// and resolves with the path.
function exportWritesFile(): void {
	mocks.exportToHtml.mockImplementation(async (filePath?: string) => {
		fs.writeFileSync(filePath!, "<html>session</html>");
		return filePath!;
	});
}

// The path the invocation is expected to own: whatever exportToHtml was asked
// to produce (each invocation gets its own unique path).
function tmpFile(): string {
	const calls = mocks.exportToHtml.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][0]!;
}

// A deferred export producer: resolves with the path without writing anything.
function deferredExport(): { path: () => string; resolve: () => void; reject: (error: unknown) => void } {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	mocks.exportToHtml.mockImplementation(
		async (filePath?: string) =>
			new Promise<string>((res, rej) => {
				resolve = () => res(filePath!);
				reject = rej;
			}),
	);
	return {
		path: () => mocks.exportToHtml.mock.calls[mocks.exportToHtml.mock.calls.length - 1][0]!,
		resolve: () => resolve(),
		reject: (error: unknown) => reject(error),
	};
}

function exportPaths(): string[] {
	return mocks.exportToHtml.mock.calls.map((call) => call[0]!);
}

function flush(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Cancellation/disposal must win WITHOUT awaiting a late close. This bounds the
// wait so the pre-migration red run fails fast instead of hanging on the old
// code that awaited the process completion forever.
async function settleWithin(share: Promise<void>): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const winner = await Promise.race([
		share.then(() => "resolved" as const),
		new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), 500);
		}),
	]);
	clearTimeout(timer);
	expect(winner).toBe("resolved");
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	mocks.testRoot = fs.mkdtempSync(path.join(mocks.realTmpdir!(), "share-loader-test-"));
	mocks.unlinkCalls.length = 0;
	mocks.spawnSync.mockReset();
	mocks.spawn.mockReset();
	mocks.exportToHtml.mockReset();
	vi.stubEnv("PI_SHARE_VIEWER_URL", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	if (mocks.testRoot) {
		fs.rmSync(mocks.testRoot, { recursive: true, force: true });
	}
});

describe("interactive mode share gist loader arbiter migration", () => {
	test("1. idle success: loader mounts through the arbiter; settle/dispose/delete/restore/share URL exactly once", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const share = handleShareCommand.call(h.target);

		// Preflight ran and, once the export completes, the idle arbiter mounts
		// the loader synchronously (before any process completion).
		await flush();
		const loader = h.editorContainer.children[0] as BorderedLoader;
		expect(loader).toBeInstanceOf(BorderedLoader);
		expect(h.editorContainer.children).toEqual([loader]);
		expect(h.setFocus).toHaveBeenLastCalledWith(loader);
		expect(h.arbiter.isBusy()).toBe(true);
		expect(mocks.spawnSync).toHaveBeenCalledWith("gh", ["auth", "status"], { encoding: "utf-8" });

		// The gist process completes: external settle, component dispose, temp
		// delete, editor/focus restore and the share URL status all happen once.
		proc.writeStdout("https://gist.github.com/octocat/abc123\n");
		proc.close(0);
		await share;
		await flush();

		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith(
			"Share URL: https://pi.dev/session/#abc123\nGist: https://gist.github.com/octocat/abc123",
		);
		expect(h.showError).not.toHaveBeenCalled();

		// Verified gh arguments: a private gist created from the owned temp file.
		expect(mocks.spawn).toHaveBeenCalledWith("gh", ["gist", "create", "--public=false", tmpFile()]);

		// A late close is a no-op: no second cleanup, status, or UI.
		proc.close(0);
		await flush();
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
	});

	test("2. app blocker + fast gist completion: settle before show; loader never mounts; onEvict/delete once", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const blocker = presentBlocker(h.arbiter);
		expect(h.editorContainer.children).toEqual([blocker.blocker]);
		expect(h.arbiter.isBusy()).toBe(true);

		const share = handleShareCommand.call(h.target);
		await flush();

		// The gist process completes while the loader is still queued.
		proc.writeStdout("https://gist.github.com/octocat/xyz789\n");
		proc.close(0);
		await share;
		await flush();

		// The placeholder settled before it could ever be shown: the blocker
		// still owns the surface and the loader was never constructed/mounted.
		expect(h.editorContainer.children).toEqual([blocker.blocker]);
		expect(h.setFocus).toHaveBeenLastCalledWith(blocker.blocker);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith(expect.stringContaining("https://pi.dev/session/#xyz789"));
		expect(h.showError).not.toHaveBeenCalled();

		// Settling the blocker restores the current editor.
		blocker.done("ok");
		await flush();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("3. queued loader + pending child + repeated disposeAll: kill/cancel/onEvict/delete once; late close is inert", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const blocker = presentBlocker(h.arbiter);
		const share = handleShareCommand.call(h.target);
		await flush();

		// The loader is queued behind the blocker and was never mounted.
		expect(h.editorContainer.children).toEqual([blocker.blocker]);

		// Repeated teardown: the queued request cancels once (killing the owned
		// child process) and onEvict deletes the temp file once.
		h.arbiter.disposeAll();
		h.arbiter.disposeAll();
		await settleWithin(share);
		await flush();

		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.showError).not.toHaveBeenCalled();
		expect(h.editorContainer.children).not.toContain(h.editor);

		// Late close produces no status/error, cleanup, or UI.
		const uiCallsAfter = h.setFocus.mock.calls.length + h.requestRender.mock.calls.length;
		proc.writeStderr("late\n");
		proc.close(0);
		await flush();
		expect(h.setFocus.mock.calls.length + h.requestRender.mock.calls.length).toBe(uiCallsAfter);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.showError).not.toHaveBeenCalled();
	});

	test("4. visible loader + pending child + repeated disposeAll + UI stop: kill/dispose/delete once; editor not restored; late close inert", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const share = handleShareCommand.call(h.target);
		await flush();
		const loader = h.editorContainer.children[0] as BorderedLoader;
		expect(loader).toBeInstanceOf(BorderedLoader);

		// Repeated terminal teardown (production order: disposeAll before
		// ui.stop()): the child is killed, the mounted loader is disposed (which
		// deletes the temp file once) and the surface is cleared. The editor is
		// never restored.
		h.arbiter.disposeAll();
		h.arbiter.disposeAll();
		await settleWithin(share);
		await flush();

		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.editorContainer.children).toEqual([]);
		expect(h.setFocus).toHaveBeenLastCalledWith(null);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.showError).not.toHaveBeenCalled();

		// UI stop: after teardown no further UI call is allowed; the late close
		// stays inert.
		const uiCallsAfter = h.setFocus.mock.calls.length + h.requestRender.mock.calls.length;
		proc.writeStderr("late\n");
		proc.close(0);
		await flush();
		expect(h.setFocus.mock.calls.length + h.requestRender.mock.calls.length).toBe(uiCallsAfter);
		expect(h.editorContainer.children).toEqual([]);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.showError).not.toHaveBeenCalled();
	});

	test("5. visible loader user cancel: kill/done/dispose/delete/cancel feedback/restore once; late close is a no-op", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const share = handleShareCommand.call(h.target);
		await flush();
		const loader = h.editorContainer.children[0] as BorderedLoader;
		expect(loader).toBeInstanceOf(BorderedLoader);

		// Real user cancel through the loader's Escape binding.
		loader.handleInput("\x1b");

		// Cancellation wins without awaiting the late close.
		await settleWithin(share);
		await flush();

		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Share cancelled");
		expect(h.showError).not.toHaveBeenCalled();
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);

		// Late close is a no-op: no second outcome.
		proc.close(0);
		await flush();
		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showError).not.toHaveBeenCalled();
		expect(h.editorContainer.children).toEqual([h.editor]);
	});

	test("6. exportToHtml writes a partial owned file then rejects: delete once; no loader/request/status; one export error", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		mocks.exportToHtml.mockImplementation(async (filePath?: string) => {
			fs.writeFileSync(filePath!, "<html>partial</html>");
			throw new Error("export boom");
		});

		const share = handleShareCommand.call(h.target);
		await share;
		await flush();

		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith("Failed to export session: export boom");
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.arbiter.isBusy()).toBe(false);
		expect(h.editorContainer.children).toEqual([h.editor]);
	});

	test("7a. spawn synchronous throw: settle, mounted dispose, delete, restore, one 'Failed to create gist' error", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		mocks.spawn.mockImplementation(() => {
			throw new Error("spawn boom");
		});

		const share = handleShareCommand.call(h.target);
		await share;
		await flush();

		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith("Failed to create gist: spawn boom");
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("7b. nonzero child exit: settle, dispose, delete, restore, one 'Failed to create gist' error; no second outcome", async () => {
		const h = makeHarness();
		exportWritesFile();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const share = handleShareCommand.call(h.target);
		await flush();
		const loader = h.editorContainer.children[0] as BorderedLoader;
		expect(loader).toBeInstanceOf(BorderedLoader);

		proc.writeStderr("gist create failed: not authenticated\n");
		proc.close(2);
		await share;
		await flush();

		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith("Failed to create gist: gist create failed: not authenticated");
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);

		// A late close cannot produce a second outcome.
		proc.close(0);
		await flush();
		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
	});

	test("9. two concurrent shares own distinct temp paths; B completes first without touching A's file", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		exportWritesFile();
		const procs: ReturnType<typeof makeProc>[] = [];
		mocks.spawn.mockImplementation(() => {
			const p = makeProc();
			procs.push(p);
			return p.proc;
		});

		const shareA = handleShareCommand.call(h.target);
		const shareB = handleShareCommand.call(h.target);
		await flush();

		// Both exports ran before any spawn, each with its own unique path.
		const paths = exportPaths();
		expect(paths).toHaveLength(2);
		expect(paths[0]).not.toBe(paths[1]);
		expect(fs.existsSync(paths[0])).toBe(true);
		expect(fs.existsSync(paths[1])).toBe(true);

		// Both child processes were spawned, each against its own path.
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(mocks.spawn.mock.calls[0][1][3]).toBe(paths[0]);
		expect(mocks.spawn.mock.calls[1][1][3]).toBe(paths[1]);
		expect(procs).toHaveLength(2);

		// B completes first: B's cleanup deletes only B's path while A's file and
		// its child remain in use.
		procs[1].writeStdout("https://gist.github.com/octocat/bbbb\n");
		procs[1].close(0);
		await shareB;
		await flush();
		expect(fs.existsSync(paths[1])).toBe(false);
		expect(fs.existsSync(paths[0])).toBe(true);
		expect(mocks.unlinkCalls).toEqual([paths[1]]);

		// A then completes independently and reports its own URL.
		procs[0].writeStdout("https://gist.github.com/octocat/aaaa\n");
		procs[0].close(0);
		await shareA;
		await flush();
		expect(fs.existsSync(paths[0])).toBe(false);
		expect(mocks.unlinkCalls).toEqual([paths[1], paths[0]]);
		expect(h.showStatus).toHaveBeenCalledWith(
			"Share URL: https://pi.dev/session/#aaaa\nGist: https://gist.github.com/octocat/aaaa",
		);
		expect(h.showStatus).toHaveBeenCalledWith(
			"Share URL: https://pi.dev/session/#bbbb\nGist: https://gist.github.com/octocat/bbbb",
		);
		expect(h.showError).not.toHaveBeenCalled();
	});

	test("9b. concurrent shares: cancelling one does not kill/delete/settle the other", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		exportWritesFile();
		const procs: ReturnType<typeof makeProc>[] = [];
		mocks.spawn.mockImplementation(() => {
			const p = makeProc();
			procs.push(p);
			return p.proc;
		});

		const shareA = handleShareCommand.call(h.target);
		const shareB = handleShareCommand.call(h.target);
		await flush();
		const paths = exportPaths();
		expect(paths).toHaveLength(2);
		// A's loader is the visible one (first present); B's stays queued.
		const loaderA = h.editorContainer.children[0] as BorderedLoader;
		expect(loaderA).toBeInstanceOf(BorderedLoader);

		// Cancel A through its real loader: A's process is killed and A's path
		// deleted; B's process is untouched, B's file remains, and B settles
		// independently later.
		loaderA.handleInput("\x1b");
		await shareA;
		await flush();
		expect(procs[0].kill).toHaveBeenCalledTimes(1);
		expect(procs[1].kill).not.toHaveBeenCalled();
		expect(fs.existsSync(paths[0])).toBe(false);
		expect(fs.existsSync(paths[1])).toBe(true);

		// B still owns its process and file and completes with its own outcome.
		procs[1].writeStdout("https://gist.github.com/octocat/bbbb\n");
		procs[1].close(0);
		await shareB;
		await flush();
		expect(fs.existsSync(paths[1])).toBe(false);
		expect(mocks.unlinkCalls).toEqual([paths[0], paths[1]]);
		expect(h.showStatus).toHaveBeenCalledWith("Share cancelled");
		expect(h.showStatus).toHaveBeenCalledWith(
			"Share URL: https://pi.dev/session/#bbbb\nGist: https://gist.github.com/octocat/bbbb",
		);
		expect(h.showError).not.toHaveBeenCalled();
	});

	test("10m. idle sync mount throw (replaceEditorSurface): rejection during present, cleanup once, zero spawn, no gist outcome, no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const handler = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", handler);
		try {
			// Only the mount throw drives this scenario; no process double is
			// prepared, so any spawn attempt fails the zero-spawn assertions. The
			// throwing host is wired into the arbiter at harness construction so
			// the command's own `this.dialogArbiter` is used. The preserved-editor
			// identity is stable so the arbiter restores to idle after the mount
			// failure.
			const stableEditor = new Container();
			const h = makeHarness({
				replaceEditorSurface: () => {
					throw new Error("mount boom");
				},
				setFocus: () => {},
				requestRender: () => {},
				getCurrentEditor: () => stableEditor,
			});
			mocks.spawnSync.mockReturnValue({ status: 0 });
			exportWritesFile();

			const share = handleShareCommand.call(h.target);
			// The request rejection is observed during present, before any child
			// process could be spawned.
			await flush();
			await flush();

			expect(mocks.spawn).not.toHaveBeenCalled();
			// Cleanup once: the never-mounted request's onEvict deletes the owned
			// temp file (the loader was never constructed, so dispose never ran).
			expect(mocks.unlinkCalls).toEqual([tmpFile()]);
			expect(fs.existsSync(tmpFile())).toBe(false);
			// No gist status/error: the mount failure is a dialog-side terminal.
			expect(h.showStatus).not.toHaveBeenCalled();
			expect(h.showError).not.toHaveBeenCalled();
			// The outcome settled as a dialog terminal, so the command returned.
			await settleWithin(share);
			expect(h.arbiter.isBusy()).toBe(false);
			await flush();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});

	test("10s. visible cancel with a synchronous close from kill(): cancel edge wins, one 'Share cancelled', kill once, cleanup/restore once", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		exportWritesFile();
		const proc = makeProc();
		// The owned process synchronously emits close(0) with valid stdout from
		// inside kill(): the already-entered cancel edge must remain the winner
		// even though the process outcome resolves before dialogTerminal does.
		// mockImplementation keeps the very spy the command calls (same reference
		// as proc.proc.kill) so the kill count below proves the real kill ran.
		(proc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
			proc.writeStdout("https://gist.github.com/octocat/boom\n");
			proc.close(0);
			return true;
		});
		mocks.spawn.mockReturnValue(proc.proc);

		const share = handleShareCommand.call(h.target);
		await flush();
		const loader = h.editorContainer.children[0] as BorderedLoader;
		expect(loader).toBeInstanceOf(BorderedLoader);

		loader.handleInput("\x1b");

		await settleWithin(share);
		await flush();

		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Share cancelled");
		expect(h.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Share URL:"));
		expect(h.showError).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("10. same-turn symmetric race: close-first + loader cancel reports only process outcome; reverse reports only cancel", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		exportWritesFile();

		// Order 1: child close fires first, then the real loader cancel in the
		// same turn (no microtask boundary between them). The first terminal edge
		// is the process completion: the outcome must be the process result, not
		// "Share cancelled".
		const proc1 = makeProc();
		mocks.spawn.mockReturnValueOnce(proc1.proc);
		const share1 = handleShareCommand.call(h.target);
		await flush();
		const loader1 = h.editorContainer.children[0] as BorderedLoader;
		expect(loader1).toBeInstanceOf(BorderedLoader);
		proc1.writeStdout("https://gist.github.com/octocat/cc\n");
		proc1.close(0);
		loader1.handleInput("\x1b");
		await share1;
		await flush();
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith(
			"Share URL: https://pi.dev/session/#cc\nGist: https://gist.github.com/octocat/cc",
		);
		expect(h.showStatus).not.toHaveBeenCalledWith("Share cancelled");
		expect(proc1.kill).toHaveBeenCalledTimes(0);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);

		// Order 2: loader cancel fires first, then the child close in the same
		// turn. The first terminal edge is the cancel: only "Share cancelled".
		h.showStatus.mockClear();
		h.showError.mockClear();
		mocks.unlinkCalls.length = 0;
		mocks.spawn.mockReset();
		const proc2 = makeProc();
		mocks.spawn.mockReturnValueOnce(proc2.proc);
		const share2 = handleShareCommand.call(h.target);
		await flush();
		const loader2 = h.editorContainer.children[0] as BorderedLoader;
		expect(loader2).toBeInstanceOf(BorderedLoader);
		loader2.handleInput("\x1b");
		proc2.writeStdout("https://gist.github.com/octocat/dd\n");
		proc2.close(0);
		await share2;
		await flush();
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Share cancelled");
		expect(h.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Share URL:"));
		expect(proc2.kill).toHaveBeenCalledTimes(1);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("11. async child error settles exactly once with a 'Failed to create gist' error; late close is inert", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		exportWritesFile();
		const proc = makeProc();
		mocks.spawn.mockReturnValue(proc.proc);

		const share = handleShareCommand.call(h.target);
		await flush();
		const loader = h.editorContainer.children[0] as BorderedLoader;
		expect(loader).toBeInstanceOf(BorderedLoader);

		proc.writeStderr("spawn ENOENT\n");
		// Without an implementation error listener this emit throws (the EventEmitter
		// child has no other "error" handler), failing the test red.
		expect(() => proc.error(new Error("spawn ENOENT"))).not.toThrow();
		await share;
		await flush();

		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith("Failed to create gist: spawn ENOENT");
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(fs.existsSync(tmpFile())).toBe(false);
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(h.arbiter.isBusy()).toBe(false);
		expect(proc.kill).toHaveBeenCalledTimes(0);

		// A late close is inert: no second settlement, cleanup, or error.
		proc.close(1);
		await flush();
		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(mocks.unlinkCalls).toEqual([tmpFile()]);
		expect(h.editorContainer.children).toEqual([h.editor]);
	});

	test("12. export pending + terminal teardown then resolve: unique path cleaned once, no child, no post-stop status", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const deferred = deferredExport();

		const share = handleShareCommand.call(h.target);
		await flush();
		const ownedPath = deferred.path();
		expect(fs.existsSync(ownedPath)).toBe(false);
		expect(mocks.spawn).not.toHaveBeenCalled();

		// Production-equivalent teardown: disposeAll, then the lifecycle stops.
		h.arbiter.disposeAll();
		h.arbiter.disposeAll();
		setHostInitialized(h.target, false);

		deferred.resolve();
		await share;
		await flush();

		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([ownedPath]);
		expect(fs.existsSync(ownedPath)).toBe(false);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.showError).not.toHaveBeenCalled();
		// The loader was never mounted, so the editor surface was never touched.
		expect(h.editorContainer.children).toEqual([h.editor]);
	});

	test("13. export pending + terminal teardown then reject: unique path cleaned once, no child, no post-stop error", async () => {
		const h = makeHarness();
		mocks.spawnSync.mockReturnValue({ status: 0 });
		const deferred = deferredExport();

		const share = handleShareCommand.call(h.target);
		await flush();
		const ownedPath = deferred.path();

		h.arbiter.disposeAll();
		setHostInitialized(h.target, false);

		deferred.reject(new Error("export boom"));
		await share;
		await flush();

		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([ownedPath]);
		expect(fs.existsSync(ownedPath)).toBe(false);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.showError).not.toHaveBeenCalled();
		// The loader was never mounted, so the editor surface was never touched.
		expect(h.editorContainer.children).toEqual([h.editor]);
	});

	test("8. auth preflight failure with a pre-existing foreign same-name file: no export, no present, file remains, only the auth error", async () => {
		const h = makeHarness();
		const foreignFile = path.join(mocks.testRoot!, "session.html");
		fs.writeFileSync(foreignFile, "foreign content");
		mocks.spawnSync.mockReturnValue({ status: 1 });

		const share = handleShareCommand.call(h.target);
		await share;
		await flush();

		expect(mocks.exportToHtml).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([]);
		expect(fs.existsSync(foreignFile)).toBe(true);
		expect(fs.readFileSync(foreignFile, "utf-8")).toBe("foreign content");
		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith("GitHub CLI is not logged in. Run 'gh auth login' first.");
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.arbiter.isBusy()).toBe(false);
	});

	test("gh missing: spawnSync throws; only the install guidance error is shown and the foreign file stays", async () => {
		const h = makeHarness();
		const foreignFile = path.join(mocks.testRoot!, "session.html");
		fs.writeFileSync(foreignFile, "foreign content");
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync ENOENT");
		});

		const share = handleShareCommand.call(h.target);
		await share;
		await flush();

		expect(mocks.exportToHtml).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.unlinkCalls).toEqual([]);
		expect(fs.existsSync(foreignFile)).toBe(true);
		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith(
			"GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		);
		expect(h.arbiter.isBusy()).toBe(false);
	});
});
