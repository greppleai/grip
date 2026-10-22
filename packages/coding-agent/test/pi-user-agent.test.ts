import { describe, expect, it } from "vitest";
import { getGripUserAgent } from "../src/utils/grip-user-agent.ts";

describe("getGripUserAgent", () => {
	it("identifies Grip in its user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getGripUserAgent("1.2.3");
		expect(userAgent).toBe(`grip/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^grip\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
