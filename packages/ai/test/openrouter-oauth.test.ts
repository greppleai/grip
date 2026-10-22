import { createServer, get as httpGet } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import { loginOpenRouter } from "../src/utils/oauth/openrouter.ts";

const REDIRECT_URI = "http://localhost:54549/callback";

function completeCallback(code: string): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		httpGet(`http://127.0.0.1:54549/callback?code=${encodeURIComponent(code)}`, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode));
		}).once("error", reject);
	});
}

describe.sequential("OpenRouter browser sign-in", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("registers browser sign-in as a durable key without refresh tokens", () => {
		const provider = getOAuthProvider("openrouter");
		expect(provider?.storeAsApiKey).toBe(true);
		expect(provider?.usesCallbackServer).toBe(true);
	});

	it("binds the authorization challenge to the verifier in the key exchange", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, string>;
			expect(init?.method).toBe("POST");
			expect(body.code).toBe("manual-code");
			expect(body.code_challenge_method).toBe("S256");
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
			expect(new URL(authUrl).searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
			return new Response(JSON.stringify({ key: "sk-or-v1-minted" }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const creds = await loginOpenRouter({
			onAuth: ({ url }) => {
				authUrl = url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `${REDIRECT_URI}?code=manual-code`,
		});
		expect(new URL(authUrl).origin + new URL(authUrl).pathname).toBe("https://openrouter.ai/auth");
		expect(new URL(authUrl).searchParams.get("callback_url")).toBe(REDIRECT_URI);
		expect(new URL(authUrl).searchParams.has("state")).toBe(false); // OpenRouter does not echo state.
		expect(creds).toMatchObject({ access: "sk-or-v1-minted", refresh: "", expires: Number.MAX_SAFE_INTEGER });
		expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/auth/keys", expect.any(Object));
	});

	it("accepts a local browser callback and rejects failed exchanges", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("no", { status: 403 })),
		);
		let resolveCallback!: (status: number | undefined) => void;
		let rejectCallback!: (error: unknown) => void;
		const callback = new Promise<number | undefined>((resolve, reject) => {
			resolveCallback = resolve;
			rejectCallback = reject;
		});
		const promise = loginOpenRouter({
			onAuth: () => {
				void completeCallback("browser-code").then(resolveCallback, rejectCallback);
			},
			onPrompt: async () => "",
		});
		const failure = expect(promise).rejects.toThrow("OpenRouter key exchange failed (403)");
		expect(await callback).toBe(200);
		await failure;
	});

	it("rejects unrelated pasted callback URLs without exchanging a code", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			loginOpenRouter({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "https://attacker.example/callback?code=other",
			}),
		).rejects.toThrow("Unexpected OpenRouter callback URL");
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("falls back to pasted code when the callback port is already occupied", async () => {
		const occupied = createServer((_request, response) => response.end("busy"));
		await new Promise<void>((resolve) => occupied.listen(54549, "127.0.0.1", resolve));
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(JSON.stringify({ key: "sk-or-v1-fallback" }))),
			);
			let authUrl = "";
			const credentials = await loginOpenRouter({
				onAuth: ({ url }) => {
					authUrl = url;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => "fallback-code",
			});
			expect(new URL(authUrl).searchParams.get("callback_url")).toBe(REDIRECT_URI);
			expect(credentials.access).toBe("sk-or-v1-fallback");
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()));
		}
	});
});
