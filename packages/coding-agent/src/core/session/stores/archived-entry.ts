import type { AgentMessage } from "@greppleai/grip-agent-core";
import type { FileEntry, SessionEntry } from "../types.ts";

// Readers retain only a file location, never the original entry or message payload.
const archivedReaders = new WeakMap<SessionEntry, () => SessionEntry>();
const messageMetadata = new Set([
	"role",
	"timestamp",
	"api",
	"provider",
	"model",
	"usage",
	"stopReason",
	"toolCallId",
	"toolName",
	"isError",
]);
const deferredEntryFields = new Set(["content", "summary", "details"]);

function deferredProperty(read: () => object, key: string): PropertyDescriptor {
	return {
		enumerable: true,
		get: () => Reflect.get(read(), key),
	};
}

function archivedMessage(message: AgentMessage, read: () => SessionEntry): AgentMessage {
	const result: Record<string, unknown> = {};
	const readMessage = messageReader(read);
	for (const key of Object.keys(message)) {
		if (messageMetadata.has(key)) result[key] = Reflect.get(message, key);
		else Object.defineProperty(result, key, deferredProperty(readMessage, key));
	}
	return Object.freeze(result) as unknown as AgentMessage;
}

function messageReader(read: () => SessionEntry): () => AgentMessage {
	return () => {
		const entry = read();
		if (entry.type !== "message") throw new Error("Archived entry is not a message");
		return entry.message;
	};
}

/** Replace large immutable payloads with uncached, on-demand disk reads. */
export function archiveSessionEntry(entry: SessionEntry, read: () => SessionEntry): SessionEntry {
	if (
		entry.type !== "message" &&
		entry.type !== "custom_message" &&
		entry.type !== "compaction" &&
		entry.type !== "branch_summary"
	)
		return entry;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(entry)) {
		if (key === "message" && entry.type === "message") result[key] = archivedMessage(entry.message, read);
		else if (
			deferredEntryFields.has(key) &&
			!(key === "details" && entry.type === "custom_message" && entry.customType === "compress_context")
		) {
			Object.defineProperty(result, key, deferredProperty(read, key));
		} else result[key] = Reflect.get(entry, key);
	}
	const archived = Object.freeze(result) as unknown as SessionEntry;
	archivedReaders.set(archived, read);
	return archived;
}

export function isArchivedSessionEntry(entry: FileEntry): boolean {
	return entry.type !== "session" && archivedReaders.has(entry);
}

/** Hydrate once for active context or snapshot publication, without caching in the archive. */
export function materializeSessionEntry<T extends FileEntry>(entry: T): T {
	return (entry.type === "session" ? entry : (archivedReaders.get(entry)?.() ?? entry)) as T;
}
