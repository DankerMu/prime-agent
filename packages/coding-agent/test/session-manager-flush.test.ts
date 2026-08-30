import {
	appendFileSync,
	chmodSync,
	type chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	type renameSync,
	rmSync,
	statSync,
	symlinkSync,
	type writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ChmodSync = typeof chmodSync;
type ChownSync = typeof chownSync;
type RenameSync = typeof renameSync;
type WriteFileSync = typeof writeFileSync;

const fsMocks = vi.hoisted(() => ({
	actualWriteFileSync: undefined as WriteFileSync | undefined,
	chmodSync: vi.fn<ChmodSync>(),
	chownSync: vi.fn<ChownSync>(),
	renameSync: vi.fn<RenameSync>(),
	writeFileSync: vi.fn<WriteFileSync>(),
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.actualWriteFileSync = actual.writeFileSync;
	fsMocks.chmodSync.mockImplementation(actual.chmodSync);
	fsMocks.chownSync.mockImplementation(actual.chownSync);
	fsMocks.renameSync.mockImplementation(actual.renameSync);
	fsMocks.writeFileSync.mockImplementation(actual.writeFileSync);
	return {
		...actual,
		chmodSync: fsMocks.chmodSync,
		chownSync: fsMocks.chownSync,
		renameSync: fsMocks.renameSync,
		writeFileSync: fsMocks.writeFileSync,
	};
});

import { appendSessionMessageWithCommitHook, SessionManager } from "../src/core/session-manager.js";
import { assistantMsg, userMsg } from "./utilities.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-flush-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("SessionManager.flushNow", () => {
	it("writes the session file with all in-memory entries before any assistant message", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);

		// Append a custom entry (goal state) — normally suppressed by _persist
		// because no assistant message exists yet.
		mgr.appendCustomEntry("thread_goal_state", { active: true, status: "active" });

		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(false);

		// flushNow forces a write despite the no-assistant guard
		mgr.flushNow();
		expect(existsSync(file)).toBe(true);

		const content = readFileSync(file, "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2); // header + custom entry

		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");

		const custom = JSON.parse(lines[1]!);
		expect(custom.type).toBe("custom");
		expect(custom.customType).toBe("thread_goal_state");
		expect(custom.data).toEqual({ active: true, status: "active" });
	});

	it("preserves live bytes and cleans up the temp file when a rewrite fails", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendCustomEntry("before_failure");
		mgr.flushNow();
		const file = mgr.getSessionFile()!;
		const before = readFileSync(file);
		const tempPrefix = `.${basename(file)}.`;

		mgr.appendMessage({ role: "user", content: "pending", timestamp: Date.now() });
		fsMocks.writeFileSync.mockImplementationOnce((path, data, options) => {
			fsMocks.actualWriteFileSync!(path, Buffer.from(String(data)).subarray(0, 12), options);
			throw new Error("disk full");
		});

		expect(() => mgr.flushNow()).toThrow("disk full");
		expect(readFileSync(file)).toEqual(before);
		expect(readdirSync(dirname(file)).filter((name) => name.startsWith(tempPrefix) && name.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	it("preserves live-file metadata before atomically replacing it", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendCustomEntry("before_metadata_check");
		mgr.flushNow();
		const file = mgr.getSessionFile()!;
		chmodSync(file, 0o660);
		const before = statSync(file);
		fsMocks.chownSync.mockClear();
		fsMocks.chownSync.mockImplementationOnce(() => undefined);
		fsMocks.chmodSync.mockClear();
		fsMocks.renameSync.mockClear();

		mgr.appendMessage({ role: "user", content: "pending", timestamp: Date.now() });
		mgr.flushNow();

		const tempPath = fsMocks.chownSync.mock.calls[0]?.[0];
		expect(tempPath).toEqual(expect.any(String));
		expect(fsMocks.chownSync).toHaveBeenCalledWith(tempPath, before.uid, before.gid);
		expect(fsMocks.chmodSync).toHaveBeenCalledWith(tempPath, before.mode & 0o777);
		expect(fsMocks.renameSync).toHaveBeenCalledWith(tempPath, join(dirname(tempPath as string), basename(file)));
		expect(fsMocks.chownSync.mock.invocationCallOrder[0]!).toBeLessThan(
			fsMocks.chmodSync.mock.invocationCallOrder[0]!,
		);
		expect(fsMocks.chmodSync.mock.invocationCallOrder[0]!).toBeLessThan(
			fsMocks.renameSync.mock.invocationCallOrder[0]!,
		);
		const after = statSync(file);
		expect({ mode: after.mode & 0o777, uid: after.uid, gid: after.gid }).toEqual({
			mode: before.mode & 0o777,
			uid: before.uid,
			gid: before.gid,
		});
	});

	it("preserves live bytes and cleans the temp file when restoring ownership fails", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendCustomEntry("before_ownership_failure");
		mgr.flushNow();
		const file = mgr.getSessionFile()!;
		const before = readFileSync(file);
		const tempPrefix = `.${basename(file)}.`;
		const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		fsMocks.chownSync.mockImplementationOnce(() => {
			throw permissionError;
		});
		fsMocks.renameSync.mockClear();

		mgr.appendMessage({ role: "user", content: "pending", timestamp: Date.now() });

		expect(() => mgr.flushNow()).toThrow(permissionError);
		expect(fsMocks.renameSync).not.toHaveBeenCalled();
		expect(readFileSync(file)).toEqual(before);
		expect(readdirSync(dirname(file)).filter((name) => name.startsWith(tempPrefix) && name.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	it("rewrites a cross-directory symlink target without replacing the alias", () => {
		const dir = createTempDir();
		const targetDir = join(dir, "targets");
		const aliasDir = join(dir, "aliases");
		mkdirSync(targetDir);
		mkdirSync(aliasDir);
		const target = join(targetDir, "session.jsonl");
		const alias = join(aliasDir, "session.jsonl");
		fsMocks.actualWriteFileSync!(
			target,
			`${JSON.stringify({
				type: "session",
				version: 2,
				id: "symlink-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: dir,
			})}\n`,
		);
		chmodSync(target, 0o640);
		symlinkSync(target, alias);

		const mgr = SessionManager.open(alias);

		expect(mgr.getSessionFile()).toBe(alias);
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8")).version).toBe(3);
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});

	it("is a no-op for in-memory (non-persisted) sessions", () => {
		const mgr = SessionManager.inMemory("/tmp");
		mgr.appendCustomEntry("thread_goal_state", { active: true });
		// Should not throw
		mgr.flushNow();
		expect(mgr.getSessionFile()).toBeUndefined();
	});

	it("preserves subsequent rewrite behavior after flush with user then assistant", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);

		mgr.appendCustomEntry("thread_goal_state", { active: true, status: "active" });
		mgr.flushNow();

		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(true);

		// Append a USER message first — this sets flushed=false because
		// no assistant exists yet, exercising the pending full-rewrite path.
		mgr.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		// Then append an ASSISTANT message — this triggers the full rewrite
		// (not appendFileSync) because flushed is false.
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// File should contain exactly: header, custom(goal), user, assistant
		const content = readFileSync(file, "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(4);

		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");

		const custom = JSON.parse(lines[1]!);
		expect(custom.type).toBe("custom");
		expect(custom.customType).toBe("thread_goal_state");

		const userMsg = JSON.parse(lines[2]!);
		expect(userMsg.type).toBe("message");
		expect(userMsg.message.role).toBe("user");

		const assistantMsg = JSON.parse(lines[3]!);
		expect(assistantMsg.type).toBe("message");
		expect(assistantMsg.message.role).toBe("assistant");

		// Verify valid parent chain: custom(null) -> user(custom) -> assistant(user)
		// (session header is not part of the entry parent chain)
		expect(custom.parentId).toBeNull();
		expect(userMsg.parentId).toBe(custom.id);
		expect(assistantMsg.parentId).toBe(userMsg.id);
	});

	it("does not rewrite an already-flushed session after an appended entry", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);

		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ready" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const rewriteFile = vi.spyOn(mgr as unknown as { _rewriteFile(): void }, "_rewriteFile");

		mgr.appendCustomEntry("thread_goal_state", { active: true, status: "active" });
		mgr.flushNow();

		expect(rewriteFile).not.toHaveBeenCalled();
		const entries = readFileSync(mgr.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(entries.at(-1)).toMatchObject({
			type: "custom",
			customType: "thread_goal_state",
			data: { active: true, status: "active" },
		});
	});
});

function createPersistedSessionForRollbackTest(): { mgr: SessionManager; file: string; before: Buffer } {
	const dir = createTempDir();
	const mgr = SessionManager.create(dir, join(dir, "sessions"));
	mgr.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
	mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const file = mgr.getSessionFile()!;
	return { mgr, file, before: readFileSync(file) };
}

function failNextOutcomeAppend(mgr: SessionManager, file: string): void {
	const internals = mgr as unknown as { _persist(entry: unknown): void };
	internals._persist = () => {
		appendFileSync(file, '{"type":"custom_message","truncat');
		throw new Error("append failed");
	};
}

const failAfterPartialTempWrite: WriteFileSync = (path, data, options) => {
	fsMocks.actualWriteFileSync!(path, Buffer.from(String(data)).subarray(0, 12), options);
	throw new Error("repair failed");
};

describe("SessionManager.appendCustomMessageEntryWithRollback", () => {
	it("flushes rollback-aware value entries immediately", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));

		mgr.appendCustomEntryWithRollback("rlm_max_depth_state", { maxDepth: 2 });

		expect(readFileSync(mgr.getSessionFile()!, "utf8")).toContain(
			'"customType":"rlm_max_depth_state","data":{"maxDepth":2}',
		);
	});

	it("flushes rollback-aware custom messages before the first assistant response", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);

		mgr.appendCustomMessageEntryWithRollback("compaction_outcome", "failed early", true);

		const persisted = readFileSync(mgr.getSessionFile()!, "utf8");
		expect(persisted).toContain('"customType":"compaction_outcome"');
	});

	it("repairs the session file immediately after a torn append", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);
		mgr.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const file = mgr.getSessionFile()!;
		const before = readFileSync(file, "utf8");

		// Simulate a partial append: the fs write tears the file, then throws.
		const internals = mgr as unknown as { _persist(entry: unknown): void };
		const originalPersist = internals._persist.bind(mgr);
		internals._persist = () => {
			appendFileSync(file, '{"type":"custom_message","truncat');
			throw new Error("disk full");
		};
		expect(() => mgr.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).toThrow("disk full");
		internals._persist = originalPersist;

		// The rollback rewrites the file from the restored in-memory entries, so the
		// durable session has no torn tail even if the process exits right after.
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("preserves old history when rollback repair fails", () => {
		const { mgr, file, before } = createPersistedSessionForRollbackTest();
		failNextOutcomeAppend(mgr, file);
		fsMocks.writeFileSync.mockImplementationOnce(failAfterPartialTempWrite);

		expect(() => mgr.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).toThrow("append failed");
		expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
	});

	it("repairs a torn tail on the next successful retry", () => {
		const { mgr, file, before } = createPersistedSessionForRollbackTest();
		failNextOutcomeAppend(mgr, file);
		fsMocks.writeFileSync.mockImplementationOnce(failAfterPartialTempWrite);
		expect(() => mgr.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).toThrow();

		mgr.flushNow();
		expect(readFileSync(file)).toEqual(before);
	});
});

function persistedFileEntries(file: string): unknown[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown);
}

describe("SessionManager append commit hook", () => {
	it("keeps public no-hook appendMessage return id, tree/file counts, and listener order", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		const userId = mgr.appendMessage(userMsg("hello"));
		const order: string[] = [];
		const unsubscribe = mgr.onPersist(() => {
			order.push("listener");
		});

		expect(mgr.appendMessage.length).toBe(1);
		expect((mgr as unknown as { _persist(entry: unknown): void })._persist.length).toBe(1);
		const assistantId = mgr.appendMessage(assistantMsg("world"));
		expect(assistantId).toEqual(expect.any(String));
		expect(assistantId).not.toBe(userId);
		expect(mgr.getEntries().map((entry) => entry.id)).toEqual([userId, assistantId]);
		expect(mgr.getEntry(assistantId)?.type).toBe("message");
		const fileEntries = persistedFileEntries(mgr.getSessionFile()!);
		expect(fileEntries).toHaveLength(3);
		expect(fileEntries.at(-1)).toMatchObject({ id: assistantId, type: "message" });
		expect(order).toEqual(["listener"]);
		unsubscribe();
	});

	it("runs the internal callback after a successful file write and before persist listeners", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendMessage(userMsg("hello"));
		const file = mgr.getSessionFile()!;
		const order: string[] = [];
		const unsubscribe = mgr.onPersist(() => {
			order.push("listener");
		});

		const id = appendSessionMessageWithCommitHook(mgr, assistantMsg("hooked"), (entryId) => {
			expect(entryId).toBe(mgr.getLeafId());
			expect(mgr.getEntry(entryId)?.type).toBe("message");
			expect(existsSync(file)).toBe(true);
			expect(persistedFileEntries(file).at(-1)).toMatchObject({ id: entryId, type: "message" });
			expect(order).toEqual([]);
			order.push("callback");
		});

		expect(id).toBe(mgr.getLeafId());
		expect(mgr.getEntries()).toHaveLength(2);
		expect(persistedFileEntries(file)).toHaveLength(3);
		expect(order).toEqual(["callback", "listener"]);
		unsubscribe();
	});

	it("does not call the callback or persist listeners when file write/rename throws", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendMessage(userMsg("hello"));
		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(false);
		const memoryBefore = mgr.getEntries().length;
		const fileBefore = existsSync(file) ? readFileSync(file) : undefined;
		const callback = vi.fn();
		const listener = vi.fn();
		const unsubscribe = mgr.onPersist(listener);
		fsMocks.writeFileSync.mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		expect(() => appendSessionMessageWithCommitHook(mgr, assistantMsg("lost"), callback)).toThrow("disk full");
		expect(callback).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
		expect(mgr.getEntries()).toHaveLength(memoryBefore + 1);
		expect(mgr.getLeafId()).toBe(mgr.getEntries().at(-1)?.id);
		if (fileBefore === undefined) {
			expect(existsSync(file)).toBe(false);
		} else {
			expect(readFileSync(file)).toEqual(fileBefore);
		}
		unsubscribe();

		const renameDir = createTempDir();
		const renameMgr = SessionManager.create(renameDir, join(renameDir, "sessions"));
		renameMgr.appendMessage(userMsg("hello"));
		const renameCallback = vi.fn();
		const renameListener = vi.fn();
		const unsubscribeRename = renameMgr.onPersist(renameListener);
		const renameMemoryBefore = renameMgr.getEntries().length;
		fsMocks.renameSync.mockImplementationOnce(() => {
			throw new Error("rename failed");
		});
		expect(() => appendSessionMessageWithCommitHook(renameMgr, assistantMsg("lost-rename"), renameCallback)).toThrow(
			"rename failed",
		);
		expect(renameCallback).not.toHaveBeenCalled();
		expect(renameListener).not.toHaveBeenCalled();
		expect(renameMgr.getEntries()).toHaveLength(renameMemoryBefore + 1);
		unsubscribeRename();
	});

	it("isolates a throwing callback and still writes once, notifies once, and returns a stable id", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendMessage(userMsg("hello"));
		const file = mgr.getSessionFile()!;
		const listener = vi.fn();
		const unsubscribe = mgr.onPersist(listener);
		const callback = vi.fn(() => {
			throw new Error("observer exploded");
		});

		const id = appendSessionMessageWithCommitHook(mgr, assistantMsg("kept"), callback);
		expect(id).toBe(mgr.getLeafId());
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(id);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(mgr.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(
			persistedFileEntries(file).filter((entry) => (entry as { type?: string }).type === "message"),
		).toHaveLength(2);
		unsubscribe();
	});

	it("isolates a throwing persist listener after the callback runs once", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendMessage(userMsg("hello"));
		const file = mgr.getSessionFile()!;
		const callback = vi.fn();
		const unsubscribe = mgr.onPersist(() => {
			throw new Error("listener exploded");
		});

		const id = appendSessionMessageWithCommitHook(mgr, assistantMsg("notified"), callback);
		expect(id).toBe(mgr.getLeafId());
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(id);
		expect(mgr.getEntries()).toHaveLength(2);
		expect(persistedFileEntries(file)).toHaveLength(3);
		unsubscribe();
	});

	it("runs the in-memory commit hook immediately after installing the entry", () => {
		const mgr = SessionManager.inMemory();
		const userId = mgr.appendMessage(userMsg("hello"));
		const order: string[] = [];
		const unsubscribe = mgr.onPersist(() => {
			order.push("listener");
		});
		const id = appendSessionMessageWithCommitHook(mgr, assistantMsg("memory"), (entryId) => {
			expect(mgr.getEntry(entryId)?.id).toBe(entryId);
			expect(mgr.getEntries().map((entry) => entry.id)).toEqual([userId, entryId]);
			order.push("callback");
		});
		expect(id).toBe(mgr.getLeafId());
		expect(order).toEqual(["callback"]);
		expect(mgr.getSessionFile()).toBeUndefined();
		unsubscribe();
	});
});
