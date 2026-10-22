import type { AssistantContent, AssistantMessage } from "@greppleai/grip-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
		expect(rendered).not.toMatch(/\x1b\[48;/);
	});

	test("stripes completed final answers but not streaming or tool-call messages", () => {
		initTheme("dark");
		const message = createAssistantMessage([{ type: "text", text: "hello" }]);
		const component = new AssistantMessageComponent();
		component.updateContent(message, true);
		expect(component.render(40).join("\n")).not.toMatch(/\x1b\[48;/);

		component.updateContent(message, false);
		const lines = component.render(40);
		expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
		expect(lines.every((line) => stripAnsi(line).length < 40)).toBe(true);
		expect(lines.join("\n")).toMatch(/\x1b\[48;[^m]+m \x1b\[49m/);
		expect(stripAnsi(lines[1])).toContain("  hello");
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1]).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);

		component.updateContent({ ...message, stopReason: "toolUse" }, false);
		expect(component.render(40).join("\n")).not.toMatch(/\x1b\[48;/);
		component.updateContent({ ...message, stopReason: "aborted" }, false);
		expect(component.render(40).join("\n")).not.toMatch(/\x1b\[48;/);
	});
});
