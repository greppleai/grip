import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebsearchTool, parseWebsearchToolOptions } from "../src/core/tools/websearch.ts";

const websearchEnv = [
	"GRIP_WEBSEARCH_PROVIDER",
	"GRIP_WEBSEARCH_BRAVE_API_KEY",
	"BRAVE_SEARCH_API_KEY",
	"GRIP_WEBSEARCH_FIRECRAWL_API_KEY",
	"FIRECRAWL_API_KEY",
	"GRIP_WEBSEARCH_TAVILY_API_KEY",
	"TAVILY_API_KEY",
	"GRIP_WEBSEARCH_TAVILY_BASE_URL",
];

beforeEach(() => {
	for (const name of websearchEnv) vi.stubEnv(name, undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Tavily websearch", () => {
	it("accepts Tavily configuration", () => {
		expect(parseWebsearchToolOptions({ provider: "tavily" })).toEqual({ provider: "tavily" });
	});

	it("uses keyless full web search by default and normalizes results", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				results: [
					null,
					{ title: "Missing URL" },
					{ title: "<b>Python</b>", url: " https://docs.python.org/3 ", content: "<p>Official docs</p>" },
					{ title: "Duplicate", url: "https://docs.python.org/3" },
					{ title: "Python.org", url: "https://python.org", content: null },
					{ title: "Over limit", url: "https://example.org" },
				],
			}),
		);
		const result = await createWebsearchTool().execute("search", { query: " Python docs ", limit: 2 });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://api.tavily.com/search");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({ "X-Tavily-Access-Mode": "keyless" });
		expect(init?.headers).not.toHaveProperty("authorization");
		expect(JSON.parse(String(init?.body))).toEqual({
			query: "Python docs",
			max_results: 2,
			search_depth: "basic",
			include_answer: false,
		});
		expect(result.details).toEqual({
			query: "Python docs",
			source: "tavily-search",
			results: [
				{ title: "Python", url: "https://docs.python.org/3", snippet: "Official docs" },
				{ title: "Python.org", url: "https://python.org" },
			],
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: "1. Python\n   https://docs.python.org/3\n   Official docs\n\n2. Python.org\n   https://python.org",
			},
		]);
	});

	it.each([undefined, 0, -1, Number.NaN, 100, 2.9])("bounds result limit %s", async (limit) => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		await createWebsearchTool().execute("search", { query: "example", limit });
		const expected = limit === 100 ? 20 : limit === 2.9 ? 2 : 8;
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).max_results).toBe(expected);
	});

	it.each(["GRIP_WEBSEARCH_TAVILY_API_KEY", "TAVILY_API_KEY"])("supports %s", async (name) => {
		vi.stubEnv(name, " env-key ");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		await createWebsearchTool().execute("search", { query: "example" });
		const headers = fetchMock.mock.calls[0][1]?.headers;
		expect(headers).toMatchObject({ authorization: "Bearer env-key" });
		expect(headers).not.toHaveProperty("X-Tavily-Access-Mode");
	});

	it("prefers explicit key and URL over environment configuration", async () => {
		vi.stubEnv("TAVILY_API_KEY", "environment-key");
		vi.stubEnv("GRIP_WEBSEARCH_TAVILY_BASE_URL", "https://env.example/search");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		await createWebsearchTool({
			provider: "tavily",
			apiKey: "explicit-key",
			baseUrl: "https://proxy.example/search",
		}).execute("search", { query: "example" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://proxy.example/search");
		expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer explicit-key" });
	});

	it("supports provider and endpoint environment configuration", async () => {
		vi.stubEnv("GRIP_WEBSEARCH_PROVIDER", "tavily");
		vi.stubEnv("GRIP_WEBSEARCH_TAVILY_BASE_URL", "https://env.example/search");
		vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-key");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		await createWebsearchTool().execute("search", { query: "example" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://env.example/search");
	});

	it("keeps explicit Tavily selection ahead of other provider credentials", async () => {
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");
		vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-key");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		await createWebsearchTool({ provider: "tavily" }).execute("search", { query: "example" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.tavily.com/search");
	});

	it.each([
		["FIRECRAWL_API_KEY", "firecrawl-search", "authorization"],
		["BRAVE_SEARCH_API_KEY", "brave-search", "x-subscription-token"],
	])("preserves automatic provider selection from %s", async (name, source, header) => {
		vi.stubEnv(name, "existing-key");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ web: { results: [] }, data: { web: [] } }));
		const result = await createWebsearchTool().execute("search", { query: "example" });
		expect(result.details?.source).toBe(source);
		expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty(header);
	});

	it.each([401, 403, 429, 500])("reports HTTP %s as an error without silently falling back", async (status) => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider failure", { status }));
		await expect(createWebsearchTool().execute("search", { query: "example" })).rejects.toThrow(
			`Tavily Search request failed: ${status}`,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("explains how to recover when keyless access is rate limited", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("limited", { status: 429 }));
		await expect(createWebsearchTool().execute("search", { query: "example" })).rejects.toThrow(
			"configure a Tavily API key",
		);
	});

	it.each([null, {}, { results: null }, { results: {} }, { error: "Unavailable" }])(
		"rejects malformed payload %j instead of treating it as no matches",
		async (payload) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
			await expect(createWebsearchTool().execute("search", { query: "example" })).rejects.toThrow(
				"invalid response",
			);
		},
	);

	it("reports a successful empty search separately", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
		const result = await createWebsearchTool().execute("search", { query: "example" });
		expect(result.content).toEqual([{ type: "text", text: "No Tavily links found for: example" }]);
	});

	it("retains explicit DuckDuckGo and explains its limited coverage", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ RelatedTopics: [] }));
		const result = await createWebsearchTool({ provider: "duckduckgo" }).execute("search", { query: "example" });
		expect(String(fetchMock.mock.calls[0][0])).toContain("api.duckduckgo.com");
		expect(result.details?.source).toBe("duckduckgo-instant-answer");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not full web search") });
	});

	it("forwards cancellation to the provider request", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			controller.abort();
			expect(init?.signal?.aborted).toBe(true);
			throw new DOMException("Aborted", "AbortError");
		});
		await expect(createWebsearchTool().execute("search", { query: "example" }, controller.signal)).rejects.toThrow(
			"Aborted",
		);
	});
});
