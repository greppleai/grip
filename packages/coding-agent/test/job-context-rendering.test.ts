import { fauxAssistantMessage } from "@greppleai/grip-ai";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolRenderContext } from "../src/core/extensions/types.ts";
import { createJobToolDefinition, type JobDetails, type JobResult, type JobStatus } from "../src/core/tools/job.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const definition = createJobToolDefinition();

function job(status: JobStatus, contextTokens: number, step?: number): JobResult {
	return {
		status,
		task: "Inspect a large project",
		exitCode: status === "completed" ? 0 : -1,
		messages: [],
		stderr: "",
		usage: {
			input: 91_000,
			output: 6_400,
			cacheRead: 1_700_000,
			cacheWrite: 0,
			cost: 0.589,
			contextTokens,
			turns: 30,
		},
		model: "openai-codex/gpt-6-sol",
		step,
	};
}

function render(details: JobDetails, expanded = false, width = 160): string[] {
	const component = definition.renderResult!(
		{ content: [], details },
		{ expanded, isPartial: false },
		theme,
		{} as ToolRenderContext,
	);
	return component.render(width).map(stripAnsi);
}

beforeAll(() => initTheme("dark"));

describe("job context usage placement", () => {
	it.each([false, true])("keeps full single-job usage beside status (expanded=%s)", (expanded) => {
		const lines = render({ mode: "single", results: [job("completed", 89_000)] }, expanded);
		expect(lines[0]).toContain("[done] Job [openai-codex/gpt-6-sol] ctx:89k 30 turns in:91k out:6.4k R1.7M $0.5890");
		expect(lines.filter((line) => line.includes("30 turns"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("ctx:"))).toHaveLength(1);
	});

	it("keeps wrapped usage above job output on narrow terminals", () => {
		const lines = render({ mode: "single", results: [job("completed", 89_000)] }, false, 60);
		expect(lines[0]).toContain("ctx:89k");
		expect(lines.findIndex((line) => line.includes("30 turns"))).toBeLessThan(
			lines.findIndex((line) => line.includes("(no output)")),
		);
		expect(lines.every((line) => line.length <= 60)).toBe(true);
	});

	it("shows pending context before the first job turn and refreshes it during the run", () => {
		const result = job("running", 0);
		result.usage.turns = 0;
		const details: JobDetails = { mode: "single", results: [result] };
		expect(render(details)[0]).toContain("[running] Job [openai-codex/gpt-6-sol] ctx:?");
		result.usage.contextTokens = 89_000;
		expect(render(details)[0]).toContain("[running] Job [openai-codex/gpt-6-sol] ctx:89k");
	});

	it("renders child context updates while the runner is still active", async () => {
		const headings: string[] = [];
		const tool = createJobToolDefinition({
			runner: async (request) => {
				const message = fauxAssistantMessage("checking");
				request.onMessage({
					...message,
					usage: {
						...message.usage,
						input: 15_000,
						output: 1_300,
						cacheRead: 62_000,
						cost: { ...message.usage.cost, total: 0.0028 },
						totalTokens: 89_000,
					},
				});
				return { exitCode: 0, stderr: "" };
			},
		});
		const cwd = process.cwd();
		const result = await tool.execute(
			"job-usage",
			{ task: "inspect" },
			undefined,
			(update) => headings.push(render(update.details)[0]),
			{ cwd, toolOperations: new LocalToolOperations(cwd) } as unknown as ExtensionContext,
		);
		expect(headings[0]).toContain("ctx:?");
		expect(headings.at(-1)).toContain("ctx:89k 1 turn in:15k out:1.3k R62k $0.0028");
		expect(render(result.details)[0]).toContain("ctx:89k 1 turn in:15k out:1.3k R62k $0.0028");
	});
	it.each(["chain", "parallel"] as const)("shows per-task context above output in %s", (mode) => {
		const results = [job("completed", 89_000, 1), job("running", 0, 2)];
		for (const expanded of [false, true]) {
			const lines = render({ mode, results }, expanded);
			expect(lines[0]).toContain("Total: 60 turns in:182k out:13k R3.4M $1.1780");
			expect(lines.filter((line) => line.includes("Total:"))).toHaveLength(1);
			expect(lines.filter((line) => line.includes("ctx:89k"))).toHaveLength(1);
			expect(lines.filter((line) => line.includes("ctx:?"))).toHaveLength(1);
			expect(lines.find((line) => line.includes("ctx:89k"))).toContain("30 turns in:91k out:6.4k R1.7M $0.5890");
			expect(lines.findIndex((line) => line.includes("ctx:89k"))).toBeLessThan(
				lines.findIndex((line) => line.includes("Task:") || line.includes("(no output)")),
			);
		}
	});
	it("keeps each context in the expanded parallel job heading", () => {
		const lines = render({ mode: "parallel", results: [job("completed", 89_000), job("completed", 42_000)] }, true);
		expect(lines.filter((line) => line.includes("ctx:89k"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("ctx:42k"))).toHaveLength(1);
		expect(lines[0]).toContain("Total: 60 turns in:182k out:13k R3.4M $1.1780");
		expect(lines.filter((line) => line.includes("Total:"))).toHaveLength(1);
		expect(lines[0]).not.toContain("ctx:");
	});
});
