import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { WEBSEARCH_AUTH_PROVIDER_IDS } from "../src/core/tools/websearch.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./test-harness.ts";

interface TestSettings {
	manager: SettingsManager;
	path: string;
}

interface WebsearchCommandMode {
	handleBuiltInEditorCommand(text: string): Promise<boolean>;
	showWebsearchApiKeyDialog(provider: "brave", name: string): Promise<void>;
	showWebsearchLoginSelector(): void;
}

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testSettings(): TestSettings {
	const dir = mkdtempSync(join(tmpdir(), "websearch-login-"));
	dirs.push(dir);
	return { manager: SettingsManager.create(dir, dir), path: join(dir, "settings.json") };
}

describe("/websearch login", () => {
	it("saves only the chosen provider and preserves other tool settings", async () => {
		const { path } = testSettings();
		writeFileSync(
			path,
			JSON.stringify({
				tools: {
					grep: { limit: 10 },
					websearch: { provider: "brave", apiKey: "old-key", baseUrl: "https://old.example" },
				},
			}),
		);
		const manager = SettingsManager.create(join(path, ".."), join(path, ".."));
		manager.setWebsearchProvider("firecrawl");
		await manager.flush();
		expect(JSON.parse(readFileSync(path, "utf8")).tools).toEqual({
			grep: { limit: 10 },
			websearch: { provider: "firecrawl" },
		});
		manager.setWebsearchProvider("duckduckgo");
		await manager.flush();
		expect(manager.getToolSettings("websearch")).toEqual({ provider: "duckduckgo" });
	});

	it("switches engines and uses per-provider saved keys without reloading the session", async () => {
		const harness = createHarness();
		const storage = harness.session.modelRegistry.authStorage;
		storage.set(WEBSEARCH_AUTH_PROVIDER_IDS.brave, { type: "api_key", key: "brave-secret" });
		storage.set(WEBSEARCH_AUTH_PROVIDER_IDS.firecrawl, { type: "api_key", key: "firecrawl-secret" });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			if (String(url).includes("brave.com")) {
				expect(init?.headers).toMatchObject({ "x-subscription-token": "brave-secret" });
				return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
			}
			if (String(url).includes("firecrawl.dev")) {
				expect(init?.headers).toMatchObject({ authorization: "Bearer firecrawl-secret" });
				return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
			}
			expect(String(url)).toContain("duckduckgo.com");
			expect(init?.headers).not.toHaveProperty("authorization");
			return new Response(JSON.stringify({ RelatedTopics: [] }), { status: 200 });
		});
		try {
			const tool = harness.session.getToolDefinition("websearch")!;
			for (const provider of ["brave", "firecrawl", "duckduckgo"] as const) {
				harness.settingsManager.setWebsearchProvider(provider);
				await tool.execute("call", { query: "example" }, undefined, undefined, undefined as never);
			}
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			harness.cleanup();
		}
	});

	it("dispatches only /websearch login and handles an empty key without selecting the engine", async () => {
		const { manager, path } = testSettings();
		initTheme("dark");
		const showError = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const authStorage = AuthStorage.inMemory();
		const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
			runtimeHost: {
				session: {
					settingsManager: manager,
					modelRegistry: { authStorage },
				},
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editor: { setText: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			showError,
			showStatus,
			showWarning,
		});
		const command = (text: string) => (mode as unknown as WebsearchCommandMode).handleBuiltInEditorCommand(text);
		const selector = vi
			.spyOn(mode as unknown as WebsearchCommandMode, "showWebsearchLoginSelector")
			.mockImplementation(() => {});
		await command("/websearch login");
		expect(selector).toHaveBeenCalledOnce();
		await command("/websearch login extra");
		expect(selector).toHaveBeenCalledOnce();
		expect(showWarning).toHaveBeenCalledWith("Usage: /websearch login");
		const keyPrompt = vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("");
		await (mode as unknown as WebsearchCommandMode).showWebsearchApiKeyDialog("brave", "Brave Search");
		expect(showError).toHaveBeenCalledWith("Failed to configure Brave Search: Brave Search requires an API key");
		expect(showStatus).not.toHaveBeenCalled();
		expect(manager.getToolSettings("websearch")).toBeUndefined();

		keyPrompt.mockResolvedValue("saved-brave-key");
		await (mode as unknown as WebsearchCommandMode).showWebsearchApiKeyDialog("brave", "Brave Search");
		expect(showStatus).toHaveBeenCalledWith("Web search engine: Brave Search");
		expect(authStorage.get(WEBSEARCH_AUTH_PROVIDER_IDS.brave)).toEqual({ type: "api_key", key: "saved-brave-key" });
		expect(JSON.parse(readFileSync(path, "utf8")).tools.websearch).toEqual({ provider: "brave" });
		expect(readFileSync(path, "utf8")).not.toContain("saved-brave-key");

		keyPrompt.mockResolvedValue("");
		await (mode as unknown as WebsearchCommandMode).showWebsearchApiKeyDialog("brave", "Brave Search");
		expect(authStorage.get(WEBSEARCH_AUTH_PROVIDER_IDS.brave)).toEqual({ type: "api_key", key: "saved-brave-key" });
		keyPrompt.mockRejectedValueOnce(new Error("Login cancelled"));
		await (mode as unknown as WebsearchCommandMode).showWebsearchApiKeyDialog("brave", "Brave Search");
		expect(showError).toHaveBeenCalledTimes(1);
	});
});
