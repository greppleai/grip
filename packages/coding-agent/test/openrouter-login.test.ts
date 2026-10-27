import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

const REDIRECT_URI = "http://localhost:54549/callback";

describe("OpenRouter browser login storage", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("stores a minted key as a durable API key, not as a refreshable OAuth token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ key: "sk-or-v1-minted" }), { status: 200 })),
		);
		const dir = mkdtempSync(join(tmpdir(), "grip-openrouter-login-"));
		const authPath = join(dir, "auth.json");
		try {
			const auth = AuthStorage.create(authPath);
			await auth.login("openrouter", {
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => `${REDIRECT_URI}?code=approved`,
			});
			expect(auth.get("openrouter")).toEqual({ type: "api_key", key: "sk-or-v1-minted", obtainedVia: "oauth" });
			await expect(auth.getApiKey("openrouter")).resolves.toBe("sk-or-v1-minted");
			expect(JSON.parse(readFileSync(authPath, "utf8")).openrouter).toEqual({
				type: "api_key",
				key: "sk-or-v1-minted",
				obtainedVia: "oauth",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not replace a previous key if the exchange fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("denied", { status: 403 })),
		);
		const auth = AuthStorage.inMemory();
		auth.set("openrouter", { type: "api_key", key: "previous-key" });
		await expect(
			auth.login("openrouter", {
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => `${REDIRECT_URI}?code=denied`,
			}),
		).rejects.toThrow("OpenRouter key exchange failed (403)");
		expect(auth.get("openrouter")).toEqual({ type: "api_key", key: "previous-key" });
	});
});
