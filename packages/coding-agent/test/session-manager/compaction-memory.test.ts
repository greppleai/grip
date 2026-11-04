import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@greppleai/grip-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { annotateContextMetadata } from "../../src/core/session/context-metadata.ts";
import { InMemorySession } from "../../src/core/session/in-memory-session.ts";
import { LocalSession } from "../../src/core/session/local-session.ts";
import type { Session } from "../../src/core/session/session.ts";
import { archiveSessionEntry, isArchivedSessionEntry } from "../../src/core/session/stores/archived-entry.ts";
import {
	JsonlSessionStore,
	publishJsonlAtomically,
	validateCurrentSessionEntries,
} from "../../src/core/session/stores/jsonl-session-store.ts";
import type { FileEntry, SessionMessageEntry } from "../../src/core/session/types.ts";
import { readUsageLedger } from "../../src/core/session/usage-ledger.ts";

interface ContentMessageEntry extends SessionMessageEntry {
	message: Message;
}

const directories: string[] = [];

function tempDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "grip-compaction-memory-"));
	directories.push(dir);
	return dir;
}

function assistant(text = "answer"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function populate(session: Session) {
	const oldId = session.appendMessage({ role: "user", content: "old 🦊 history ".repeat(10000), timestamp: 1 });
	const assistantId = session.appendMessage(assistant());
	const jobId = session.appendMessage({
		role: "toolResult",
		toolCallId: "job-call",
		toolName: "job",
		isError: false,
		timestamp: 3,
		content: [{ type: "text", text: "job output" }],
		details: {
			results: [
				{ messages: [assistant("large job transcript ".repeat(10000))], usage: { input: 20, output: 4, turns: 1 } },
			],
		},
	});
	const keptId = session.appendMessage({ role: "user", content: "recent request", timestamp: 4 });
	return { oldId, assistantId, jobId, keptId };
}

function messageEntry(session: Session, id: string): ContentMessageEntry {
	const entry = session.getEntry(id);
	if (entry?.type !== "message") throw new Error(`Missing message ${id}`);
	const { role } = entry.message;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") throw new Error(`Unexpected message ${role}`);
	return entry as ContentMessageEntry;
}

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("disk-backed compacted history", () => {
	it("evicts old payloads and job transcripts while preserving active context and exact history", () => {
		const dir = tempDirectory();
		const session = new LocalSession(dir, dir, undefined);
		const { oldId, jobId, keptId } = populate(session);
		const original = JSON.stringify(session.getEntries());
		const oldMessage = messageEntry(session, oldId).message;
		const keptMessage = messageEntry(session, keptId).message;
		session.appendCompaction("summary", keptId, 1000);
		const diskBefore = readFileSync(session.getSessionReference()!, "utf8");
		const context = session.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(context.messages[1]).toBe(keptMessage);
		const archived = messageEntry(session, oldId);
		expect(isArchivedSessionEntry(archived)).toBe(true);
		expect(archived.message).not.toBe(oldMessage);
		expect(Object.getOwnPropertyDescriptor(archived.message, "content")?.value).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(archived.message, "content")?.get).toBeTypeOf("function");
		expect(Object.getOwnPropertyDescriptor(messageEntry(session, jobId).message, "details")?.get).toBeTypeOf(
			"function",
		);
		expect(JSON.stringify(session.getEntries().slice(0, -1))).toBe(original);
		expect(structuredClone(archived).message).toEqual(oldMessage);
		expect(readFileSync(session.getSessionReference()!, "utf8")).toBe(diskBefore);
		// Explicit history reads do not populate a permanent payload cache.
		expect(Object.getOwnPropertyDescriptor(archived.message, "content")?.get).toBeTypeOf("function");
		expect(readUsageLedger(session.getEntries()).jobs).toMatchObject({ input: 20, output: 4, requests: 1 });
		session.appendMessage(assistant("after compaction"));
		expect(isArchivedSessionEntry(session.getEntry(oldId)!)).toBe(true);
	});

	it("evicts on resume and hydrates old branches when they become active", () => {
		const dir = tempDirectory();
		const original = new LocalSession(dir, dir, undefined);
		const { oldId, keptId } = populate(original);
		const compactionId = original.appendCompaction("summary", keptId, 1000);
		const session = new LocalSession(dir, dir, original.getSessionReference());
		session.buildSessionContext();
		expect(isArchivedSessionEntry(session.getEntry(oldId)!)).toBe(true);
		session.branch(oldId);
		const oldContext = session.buildSessionContext();
		expect(oldContext.messages).toHaveLength(1);
		expect(Object.getOwnPropertyDescriptor(oldContext.messages[0], "content")?.get).toBeUndefined();
		expect(isArchivedSessionEntry(session.getEntry(oldId)!)).toBe(false);
		session.branch(compactionId);
		session.buildSessionContext();
		expect(isArchivedSessionEntry(session.getEntry(oldId)!)).toBe(true);
		const newerId = session.appendMessage({ role: "user", content: "newer", timestamp: 5 });
		session.appendCompaction("second summary", newerId, 1000);
		session.buildSessionContext();
		expect(isArchivedSessionEntry(session.getEntry(keptId)!)).toBe(true);
		expect(isArchivedSessionEntry(session.getEntry(compactionId)!)).toBe(true);
	});

	it("keeps cloned history independent of the original file", () => {
		const dir = tempDirectory();
		const session = new LocalSession(dir, dir, undefined);
		const { oldId, keptId } = populate(session);
		const compactionId = session.appendCompaction("summary", keptId, 1000);
		session.buildSessionContext();
		const originalPath = session.getSessionReference()!;
		const originalContent = messageEntry(session, oldId).message.content;
		const forkPath = session.createBranchedSession(compactionId)!;
		session.buildSessionContext();
		rmSync(originalPath);
		expect(messageEntry(session, oldId).message.content).toEqual(originalContent);
		const resumed = new LocalSession(dir, dir, forkPath);
		expect(resumed.buildSessionContext().messages).toHaveLength(2);
		expect(messageEntry(resumed, oldId).message.content).toEqual(originalContent);
	});

	it("refreshes byte locations after rewriting CRLF, blank lines, and multibyte history", () => {
		const dir = tempDirectory();
		const session = new LocalSession(dir, dir, undefined);
		const { oldId, keptId } = populate(session);
		session.appendCompaction("summary", keptId, 1000);
		const path = session.getSessionReference()!;
		writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n\r\n"));
		const store = new JsonlSessionStore();
		store.setSessionReference(path);
		store.setEntries(store.load(path));
		store.retainContextEntries(new Set([keptId]));
		const archived = store.getEntry(oldId)!;
		if (archived.type !== "message" || archived.message.role !== "user") throw new Error("Missing archived message");
		const content = archived.message.content;
		store.saveSnapshot();
		expect(archived.message.content).toEqual(content);
		expect(isArchivedSessionEntry(store.getEntry(oldId)!)).toBe(true);
		store.appendEntry({
			type: "message",
			id: "after-rewrite",
			parentId: store.getLeafId(),
			timestamp: new Date().toISOString(),
			message: assistant(),
		});
		expect(store.getEntry("after-rewrite")).toBeDefined();
	});

	it("does not hydrate archived payloads for context metadata, append validation, or repeated usage reads", () => {
		const timestamp = new Date().toISOString();
		const old: SessionMessageEntry = { type: "message", id: "old", parentId: null, timestamp, message: assistant() };
		const read = vi.fn(() => old);
		const archived = archiveSessionEntry(old, read);
		const kept: SessionMessageEntry = {
			type: "message",
			id: "kept",
			parentId: "old",
			timestamp,
			message: { role: "user", content: "recent", timestamp: 4 },
		};
		const compaction = {
			type: "compaction" as const,
			id: "compact",
			parentId: "kept",
			timestamp,
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 1000,
		};
		const header = { type: "session" as const, id: "session", version: 3, timestamp, cwd: "/tmp" };
		validateCurrentSessionEntries([header, archived, kept, compaction]);
		annotateContextMetadata([kept.message], [archived, kept, compaction]);
		readUsageLedger([archived, kept, compaction]);
		expect(read).not.toHaveBeenCalled();

		const job: SessionMessageEntry = {
			...old,
			id: "job",
			message: {
				role: "toolResult",
				toolName: "job",
				toolCallId: "call",
				timestamp: 3,
				isError: false,
				content: [],
				details: { results: [{ usage: { input: 7 } }] },
			},
		};
		const readJob = vi.fn(() => job);
		const archivedJob = archiveSessionEntry(job, readJob);
		expect(readUsageLedger([archivedJob]).jobs.input).toBe(7);
		expect(readUsageLedger([archivedJob]).jobs.input).toBe(7);
		expect(readJob).toHaveBeenCalledTimes(1);
	});

	it("evicts range-compressed messages and obsolete custom summaries without changing the projected context", () => {
		const dir = tempDirectory();
		const session = new LocalSession(dir, dir, undefined);
		const { oldId, jobId, keptId } = populate(session);
		const summaryId = session.appendCustomMessageEntry("compress_context", "range summary", true, {
			replacementVersion: 1,
			startEntryId: oldId,
			endEntryId: jobId,
		});
		const context = session.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual(["custom", "user"]);
		expect(isArchivedSessionEntry(session.getEntry(oldId)!)).toBe(true);
		expect(isArchivedSessionEntry(session.getEntry(jobId)!)).toBe(true);
		expect(isArchivedSessionEntry(session.getEntry(keptId)!)).toBe(false);
		const newerId = session.appendMessage({ role: "user", content: "new request", timestamp: 5 });
		session.appendCompaction("full summary", newerId, 1000);
		session.buildSessionContext();
		const summary = session.getEntry(summaryId)!;
		expect(isArchivedSessionEntry(summary)).toBe(true);
		if (summary.type !== "custom_message") throw new Error("Missing summary");
		expect(Object.getOwnPropertyDescriptor(summary, "content")?.get).toBeTypeOf("function");
		expect(summary.content).toBe("range summary");
		expect(new LocalSession(dir, dir, session.getSessionReference()).buildSessionContext().messages).toHaveLength(2);
	});

	it("preserves in-memory-only sessions and unpersisted entries", () => {
		const session = new InMemorySession();
		const { oldId, keptId } = populate(session);
		const original = session.getEntry(oldId);
		session.appendCompaction("summary", keptId, 1000);
		session.buildSessionContext();
		expect(session.getEntry(oldId)).toBe(original);
		expect(isArchivedSessionEntry(original!)).toBe(false);
		const store = new JsonlSessionStore();
		const timestamp = new Date().toISOString();
		const entries: FileEntry[] = [
			{ type: "session", id: "session", version: 3, timestamp, cwd: "/tmp" },
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp,
				message: { role: "user", content: "not persisted", timestamp: 1 },
			},
		];
		store.setEntries(entries);
		store.retainContextEntries(new Set());
		expect(store.getEntry("old")).toBe(entries[1]);
	});

	it("does not evict or advance history after a failed compaction write", () => {
		const dir = tempDirectory();
		const path = join(dir, "session.jsonl");
		const timestamp = new Date().toISOString();
		const entries: FileEntry[] = [
			{ type: "session", id: "session", version: 3, timestamp, cwd: dir },
			{ type: "message", id: "old", parentId: null, timestamp, message: assistant() },
		];
		publishJsonlAtomically(path, entries);
		const store = new JsonlSessionStore(undefined, {
			append: () => {
				throw new Error("write failed");
			},
			publish: publishJsonlAtomically,
		});
		store.setSessionReference(path);
		store.setEntries(store.load(path));
		expect(() =>
			store.appendEntry({
				type: "compaction",
				id: "compact",
				parentId: "old",
				timestamp,
				summary: "summary",
				firstKeptEntryId: "old",
				tokensBefore: 1000,
			}),
		).toThrow();
		store.retainContextEntries(new Set());
		expect(isArchivedSessionEntry(store.getEntry("old")!)).toBe(false);
		expect(store.getLeafId()).toBe("old");
	});

	it("fails explicitly if an archived record is lost or replaced", () => {
		const dir = tempDirectory();
		const session = new LocalSession(dir, dir, undefined);
		const { oldId, keptId } = populate(session);
		session.appendCompaction("summary", keptId, 1000);
		session.buildSessionContext();
		const archived = messageEntry(session, oldId);
		writeFileSync(session.getSessionReference()!, "");
		expect(() => archived.message.content).toThrow("truncated");
	});
});
