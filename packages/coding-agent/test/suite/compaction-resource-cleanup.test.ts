import { fauxAssistantMessage, registerSessionResourceCleanup } from "@greppleai/grip-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

interface AutoCompactionSession {
	_runAutoCompaction(reason: string, willRetry: boolean): Promise<boolean>;
}

const harnesses: Harness[] = [];
const unregisterCallbacks: (() => void)[] = [];

beforeEach(() => {
	vi.stubEnv("GRIP_CONTEXT_COMPRESSION", undefined);
	vi.stubEnv("GRIP_CONTEXT_COMPRESSION_DETECTION", undefined);
});
afterEach(async () => {
	for (const unregister of unregisterCallbacks.splice(0)) unregister();
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.cleanup();
	}
	vi.unstubAllEnvs();
});

describe("compaction provider resource cleanup", () => {
	it.each([false, true])("releases provider request caches after successful compaction (auto=%s)", async (auto) => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("old response"), fauxAssistantMessage("recent response")]);
		await harness.session.prompt("old request");
		await harness.session.prompt("recent request");
		const cleanup = vi.fn();
		unregisterCallbacks.push(registerSessionResourceCleanup(cleanup));
		if (auto) {
			const session = harness.session as unknown as AutoCompactionSession;
			await session._runAutoCompaction("threshold", false);
		} else await harness.session.compact();
		expect(cleanup).toHaveBeenCalledExactlyOnceWith(harness.session.sessionId);
		expect(harness.session.messages[0].role).toBe("compactionSummary");
	});

	it("does not release live provider resources when compaction is cancelled", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("response")]);
		await harness.session.prompt("request");
		const cleanup = vi.fn();
		unregisterCallbacks.push(registerSessionResourceCleanup(cleanup));
		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("releases provider request caches before continuing after range compression", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.session.setContextCompressionEnabled(true);
		harness.setResponses([fauxAssistantMessage("old response")]);
		await harness.session.prompt("old request");
		const start = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!start) throw new Error("Missing compression start");
		const cleanup = vi.fn();
		unregisterCallbacks.push(registerSessionResourceCleanup(cleanup));
		const compression = fauxAssistantMessage("");
		compression.stopReason = "toolUse";
		compression.content = [
			{
				type: "toolCall",
				id: "compress",
				name: "compress_context",
				arguments: { startEntryId: start.id, summary: "old summary" },
			},
		];
		harness.setResponses([
			compression,
			() => {
				expect(cleanup).toHaveBeenCalledExactlyOnceWith(harness.session.sessionId);
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("new request");
		expect(harness.eventsOfType("state_compressed")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});
});
