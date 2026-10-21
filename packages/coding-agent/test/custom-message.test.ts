import { beforeAll, describe, expect, it } from "vitest";
import { createCustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("CustomMessageComponent", () => {
	beforeAll(() => initTheme(undefined, false));

	it("keeps the success label on compressed state summaries without full-card backgrounds", () => {
		const summary = createCustomMessage(
			"compress_context",
			"Retained objective",
			true,
			undefined,
			new Date().toISOString(),
		);
		const ordinary = createCustomMessage("note", "Retained objective", true, undefined, new Date().toISOString());
		const renderedSummary = new CustomMessageComponent(summary).render(80).join("\n");
		const renderedOrdinary = new CustomMessageComponent(ordinary).render(80).join("\n");

		expect(renderedSummary).toContain(theme.fg("success", "\x1b[1m[compress_context]\x1b[22m"));
		expect(renderedSummary).not.toMatch(/\x1b\[48;/);
		expect(renderedOrdinary).not.toMatch(/\x1b\[48;/);
		for (const rendered of [renderedSummary, renderedOrdinary]) {
			expect(rendered.split("\n").every((line) => !line.endsWith(" "))).toBe(true);
		}
		expect(renderedOrdinary).toContain(theme.fg("customMessageLabel", "\x1b[1m[note]\x1b[22m"));
	});
});
