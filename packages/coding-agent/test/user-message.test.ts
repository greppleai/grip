import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	test("keeps user message height and OSC zones without full-width backgrounds or trailing padding", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(OSC133_ZONE_START);
		expect(lines[0]).not.toContain("\x1b[48;");
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2]).toBe(OSC133_ZONE_END + OSC133_ZONE_FINAL);
		expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
		expect(lines.join("\n")).not.toContain("\x1b[48;");
	});
});
