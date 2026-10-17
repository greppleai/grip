import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML identity", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("uses grip names for injected metadata and sidebar storage without old-name fallbacks", () => {
		expect(templateJs).toContain('meta[name="grip-url-params"]');
		expect(templateJs).toContain('meta[name="grip-share-base-url"]');
		expect(templateJs).toContain("'grip-share:v1:sidebar-width'");
		expect(templateJs).not.toMatch(/pi-(?:url-params|share-base-url)|pi-share:v1:sidebar-width/);
	});
});
