import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@greppleai/grip-ai";
import { afterEach, describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { LocalSessionManager } from "../src/core/session/local-session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";

interface ExportedSessionEntry {
	type: string;
	message?: AssistantMessage;
}

interface BinaryAssetPackageScripts {
	"build:binary"?: string;
}

const tempDirs: string[] = [];
const richSource = "$\\frac{1}{2}$\n\n```mermaid\nflowchart LR\nA --> B\n```";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rich Markdown non-interactive boundaries", () => {
	it("preserves source in JSON and RPC wire events", () => {
		const message = assistantMessage(richSource);
		const event = { type: "message_end" as const, message };

		const wireEvent = toJsonEvent(event);

		expect(wireEvent).toBe(event);
		expect(JSON.stringify(wireEvent)).toContain(JSON.stringify(richSource));
		expect(message.content[0]).toEqual({ type: "text", text: richSource });
	});

	it("preserves source in session JSONL and browser HTML export data", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "pi-rich-markdown-export-"));
		tempDirs.push(dir);
		const session = new LocalSessionManager({ cwd: dir, sessionDir: dir }).create();
		session.appendMessage({ role: "user", content: "render this", timestamp: 1 });
		session.appendMessage(assistantMessage(richSource));
		const sessionPath = session.getSessionReference();
		expect(sessionPath).toBeDefined();
		expect(readFileSync(sessionPath!, "utf8")).toContain(JSON.stringify(richSource));

		const outputPath = join(dir, "session.html");
		await exportSessionToHtml(session, undefined, { outputPath });
		const html = readFileSync(outputPath, "utf8");
		const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
		expect(encoded).toBeDefined();
		const exported = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
			entries: ExportedSessionEntry[];
		};
		const exportedAssistant = exported.entries.find((entry) => entry.message?.role === "assistant")?.message;
		expect(exportedAssistant?.content[0]).toEqual({ type: "text", text: richSource });
		expect(exportedAssistant?.content[0]).toEqual(assistantMessage(richSource).content[0]);
	});

	it("includes every browser export asset in Bun binary packages", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			scripts?: BinaryAssetPackageScripts;
		};
		expect(packageJson.scripts?.["build:binary"]).toContain("scripts/prepare-binary-assets.mjs");

		const assetScript = readFileSync(new URL("../../../scripts/prepare-binary-assets.mjs", import.meta.url), "utf8");
		expect(assetScript).toContain('add(join(agent, "src/core/export-html"), "export-html")');
		expect(assetScript).toContain("for (const name of readdirSync(source).sort()) add(");
		for (const asset of ["template.html", "template.css", "template.js"]) {
			expect(readFileSync(new URL(`../src/core/export-html/${asset}`, import.meta.url)).length).toBeGreaterThan(0);
		}
	});
});
