import { beforeAll, describe, expect, it } from "vitest";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../src/core/messages.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("summary and skill message cards", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps labels and expanded content without full-width backgrounds or trailing padding", () => {
		const timestamp = new Date().toISOString();
		const cards = [
			{
				component: new CompactionSummaryMessageComponent(
					createCompactionSummaryMessage("Compacted summary", 1234, timestamp),
				),
				label: "[compaction]",
				content: "Compacted summary",
			},
			{
				component: new BranchSummaryMessageComponent(
					createBranchSummaryMessage("Branch summary text", "entry-1", timestamp),
				),
				label: "[branch]",
				content: "Branch summary text",
			},
			{
				component: new SkillInvocationMessageComponent({
					name: "review",
					location: "/tmp/review",
					content: "Skill instructions",
					userMessage: undefined,
				}),
				label: "[skill]",
				content: "Skill instructions",
			},
		];
		for (const { component, label, content } of cards) {
			const collapsedLines = component.render(80);
			const collapsed = collapsedLines.join("\n");
			expect(stripAnsi(collapsed)).toContain(label);
			expect(collapsedLines.every((line) => !line.endsWith(" "))).toBe(true);
			if (label === "[compaction]") {
				expect(collapsedLines.every((line) => stripAnsi(line).startsWith(" "))).toBe(true);
				expect(collapsedLines.every((line) => stripAnsi(line).length < 80)).toBe(true);
				expect(collapsed).toMatch(/\x1b\[48;[^m]+m \x1b\[49m/);
			} else {
				expect(collapsed).not.toMatch(/\x1b\[48;/);
			}
			component.setExpanded(true);
			const expandedLines = component.render(80);
			const expanded = expandedLines.join("\n");
			expect(stripAnsi(expanded)).toContain(label);
			expect(stripAnsi(expanded)).toContain(content);
			expect(expandedLines.every((line) => !line.endsWith(" "))).toBe(true);
			if (label === "[compaction]") {
				expect(expandedLines.every((line) => stripAnsi(line).startsWith(" "))).toBe(true);
				expect(expandedLines.every((line) => stripAnsi(line).length < 80)).toBe(true);
			} else {
				expect(expanded).not.toMatch(/\x1b\[48;/);
			}
		}
	});
});
