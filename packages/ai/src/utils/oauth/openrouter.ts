/** OpenRouter PKCE browser sign-in mints a durable, credit-billed API key; it has no refresh token. */
import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const CALLBACK_PORT = 54549;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const AUTHORIZE_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

type CallbackServer = {
	server: Server;
	waitForCode: Promise<string | null>;
	cancel: () => void;
};

function parseCode(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	if (value.includes("://")) {
		const url = new URL(value);
		if (url.origin !== `http://localhost:${CALLBACK_PORT}` || url.pathname !== CALLBACK_PATH) {
			throw new Error("Unexpected OpenRouter callback URL");
		}
		return url.searchParams.get("code") ?? undefined;
	}
	if (value.startsWith("code=")) return new URLSearchParams(value).get("code") ?? undefined;
	return value;
}

async function startCallbackServer(): Promise<CallbackServer> {
	if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
		throw new Error("OpenRouter browser sign-in requires Node.js or Bun");
	}
	const { createServer } = await import("node:http");
	let settle: (code: string | null) => void = () => {};
	const waitForCode = new Promise<string | null>((resolve) => {
		settle = resolve;
	});
	const server = createServer((request, response) => {
		try {
			const url = new URL(request.url ?? "", REDIRECT_URI);
			if (url.pathname !== CALLBACK_PATH) {
				response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				response.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				response.end(oauthErrorHtml("OpenRouter did not provide an authorization code."));
				return;
			}
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(oauthSuccessHtml("OpenRouter sign-in completed. You can close this window."));
			settle(code);
		} catch {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Invalid callback");
		}
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(CALLBACK_PORT, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		server.close();
		throw error;
	}
	return { server, waitForCode, cancel: () => settle(null) };
}

async function exchangeCode(code: string, verifier: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(EXCHANGE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
		signal,
	});
	if (!response.ok) throw new Error(`OpenRouter key exchange failed (${response.status})`);
	const data: unknown = await response.json();
	const key = typeof data === "object" && data !== null && "key" in data ? data.key : undefined;
	if (typeof key !== "string" || !key.startsWith("sk-or-")) throw new Error("OpenRouter returned an invalid API key");
	return key;
}

export async function loginOpenRouter(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.signal?.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	let server: CallbackServer | undefined;
	try {
		server = await startCallbackServer();
	} catch (error) {
		// A second login or another process may own the fixed redirect port.
		// The browser redirect can still be pasted without accepting an untrusted listener.
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
	}
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("callback_url", REDIRECT_URI);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	try {
		callbacks.onAuth({
			url: url.toString(),
			instructions: server
				? "Sign in to OpenRouter in your browser. This creates a key billed to your OpenRouter credits, not a subscription token. If the callback cannot reach this machine, paste its redirect URL."
				: "Sign in to OpenRouter in your browser, then paste the redirect URL here (the local callback port is busy). This creates a key billed to your OpenRouter credits, not a subscription token.",
		});
		const onAbort = () => server?.cancel();
		callbacks.signal?.addEventListener("abort", onAbort, { once: true });
		callbacks.signal?.throwIfAborted();
		try {
			const manual = callbacks.onManualCodeInput?.().then(parseCode);
			const code = server
				? await Promise.race([server.waitForCode, manual].filter((p) => p !== undefined))
				: await (manual ??
						callbacks.onPrompt({ message: "Paste the OpenRouter redirect URL or code:" }).then(parseCode));
			callbacks.signal?.throwIfAborted();
			if (!code) throw new Error("OpenRouter authorization cancelled or missing code");
			callbacks.onProgress?.("Exchanging OpenRouter authorization code for a key...");
			return {
				access: await exchangeCode(code, verifier, callbacks.signal),
				refresh: "",
				expires: Number.MAX_SAFE_INTEGER,
			};
		} finally {
			callbacks.signal?.removeEventListener("abort", onAbort);
		}
	} finally {
		server?.server.close();
	}
}

export const openrouterOAuthProvider: OAuthProviderInterface = {
	id: "openrouter",
	name: "OpenRouter (browser sign-in; billed to credits)",
	usesCallbackServer: true,
	storeAsApiKey: true,
	login: loginOpenRouter,
	// OpenRouter issues a durable key, not access/refresh tokens. Revoked keys require a new login.
	async refreshToken(credentials) {
		return credentials;
	},
	getApiKey(credentials) {
		return credentials.access;
	},
};
