import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	test("keeps user message height and OSC zones with a one-cell stripe and no trailing padding", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		const marker = theme.bgFromFg("accent", " ");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(OSC133_ZONE_START + marker);
		expect(lines[1]).toContain("hello");
		expect(lines[1].startsWith(`${marker} `)).toBe(true);
		expect(lines[2]).toBe(OSC133_ZONE_END + OSC133_ZONE_FINAL + marker);
		expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
		expect(lines.every((line) => line.split("\x1b[48;").length === 2)).toBe(true);
		const narrow = new UserMessageComponent("hello").render(2);
		expect(narrow[0]).toBe(OSC133_ZONE_START + marker);
		expect(narrow.slice(1, -1).every((line) => line === marker)).toBe(true);
		expect(narrow.at(-1)).toBe(OSC133_ZONE_END + OSC133_ZONE_FINAL + marker);
	});
});
