import { OFFICIAL_REPOSITORY } from "./official-catalog.ts";

export class OfficialExtensionError extends Error {
	readonly code: string;
	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OfficialExtensionError";
		this.code = code;
	}
}

export interface OfficialRequestOptions {
	signal: AbortSignal | null;
	timeoutMs: number;
}

/** Enforces cancellation even for an injected transport that ignores its signal. */
export async function officialAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void promise.catch(() => {});
		signal.throwIfAborted();
	}
	let abort = () => {};
	const canceled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([promise, canceled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DELIVERY_HOSTS = new Set([
	"release-assets.githubusercontent.com",
	"objects.githubusercontent.com",
	"github-releases.githubusercontent.com",
]);

function checkDownloadUrl(value: string, initial: boolean): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
		throw new OfficialExtensionError("origin", "Untrusted official download origin");
	const repositoryAsset =
		url.hostname === "github.com" && url.pathname.startsWith(`/${OFFICIAL_REPOSITORY}/releases/download/`);
	if (initial ? !repositoryAsset || !!url.search : !repositoryAsset && !DELIVERY_HOSTS.has(url.hostname))
		throw new OfficialExtensionError("origin", "Untrusted official download redirect");
	return url;
}

async function readResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
	if (!response.ok) {
		await officialAbortable(response.body?.cancel() ?? Promise.resolve(), signal);
		throw new OfficialExtensionError("http", `Official download returned HTTP ${response.status}`);
	}
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
		await officialAbortable(response.body?.cancel() ?? Promise.resolve(), signal);
		throw new OfficialExtensionError("size", "Official download exceeds byte limit");
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await officialAbortable(reader.read(), signal);
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxBytes) throw new OfficialExtensionError("size", "Official download exceeds byte limit");
			chunks.push(Buffer.from(part.value));
		}
		return Buffer.concat(chunks, size);
	} finally {
		void reader.cancel().catch(() => {});
	}
}

export class OfficialTransport {
	private readonly fetcher: typeof fetch;
	constructor(fetcher: typeof fetch = fetch) {
		this.fetcher = fetcher;
	}

	private async request(url: string, signal: AbortSignal): Promise<Response> {
		let current = checkDownloadUrl(url, true);
		for (let redirects = 0; redirects <= 5; redirects++) {
			signal.throwIfAborted();
			const response = await officialAbortable(
				this.fetcher(current.href, { redirect: "manual", signal, headers: { Accept: "application/octet-stream" } }),
				signal,
			);
			if (response.redirected || (response.url && response.url !== current.href))
				throw new OfficialExtensionError("origin", "Transport followed an unchecked official redirect");
			if (!REDIRECT_STATUSES.has(response.status)) return response;
			await officialAbortable(response.body?.cancel() ?? Promise.resolve(), signal);
			const location = response.headers.get("location");
			if (!location || redirects === 5)
				throw new OfficialExtensionError("origin", "Too many or invalid official redirects");
			current = checkDownloadUrl(new URL(location, current).href, false);
		}
		throw new OfficialExtensionError("origin", "Too many official redirects");
	}

	async download(url: string, maxBytes: number, options: OfficialRequestOptions): Promise<Buffer> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid official download limit");
		if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000)
			throw new Error("Invalid official request timeout");
		const signals = [AbortSignal.timeout(options.timeoutMs)];
		if (options.signal) signals.push(options.signal);
		const signal = AbortSignal.any(signals);
		try {
			return await readResponse(await this.request(url, signal), maxBytes, signal);
		} catch (error) {
			if (error instanceof OfficialExtensionError) throw error;
			throw new OfficialExtensionError(
				signal.aborted ? "canceled" : "network",
				signal.aborted ? "Official download canceled or timed out" : "Official download failed",
				{ cause: error },
			);
		}
	}
}
