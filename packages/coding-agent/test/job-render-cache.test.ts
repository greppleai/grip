import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { type Component, visibleWidth } from "@greppleai/grip-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import {
	createJobToolDefinition,
	type JobDetails,
	type JobResult,
	type JobStatus,
	type JobToolInput,
} from "../src/core/tools/job.ts";
import { initTheme, setTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const definition = createJobToolDefinition();

function job(status: JobStatus = "completed"): JobResult {
	return {
		status,
		task: "Inspect the project",
		exitCode: status === "completed" ? 0 : -1,
		messages: [fauxAssistantMessage("First progress update"), fauxAssistantMessage("Final **answer**")],
		stderr: "",
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 120, turns: 2 },
		model: "faux/test",
	};
}

function render(details: JobDetails, lastComponent?: Component, expanded = false, isPartial = false): Component {
	const context: ToolRenderContext<Record<string, unknown>, JobToolInput> = {
		args: { task: "Inspect" },
		toolCallId: "job-1",
		cwd: process.cwd(),
		state: {},
		lastComponent,
		invalidate: () => {},
		executionStarted: true,
		argsComplete: true,
		expanded,
		isPartial,
		showImages: false,
		isError: false,
	};
	return definition.renderResult!({ content: [], details }, { expanded, isPartial }, theme, context);
}

function text(component: Component, width = 100): string {
	return component.render(width).map(stripAnsi).join("\n");
}

beforeEach(() => initTheme("dark"));

describe("job row display cache", () => {
	it.each(["completed", "failed"] as const)(
		"snapshots %s output once across refresh, expansion, resize, and theme changes",
		(status) => {
			const result = job(status);
			if (status === "failed") {
				result.errorMessage = "Job failed";
				result.stopReason = "error";
			}
			const messages = result.messages;
			const reads = vi.fn(() => messages);
			Object.defineProperty(result, "messages", { enumerable: true, configurable: true, get: reads });
			const details: JobDetails = { mode: "single", results: [result] };
			const component = render(details);
			const initial = text(component);
			expect(component.render(100)).toBe(component.render(100));
			expect(reads).toHaveBeenCalledTimes(1);
			expect(text(component)).toBe(initial);
			expect(render(details, component)).toBe(component);
			const expanded = render(details, component, true);
			expect(expanded).toBe(component);
			expect(text(expanded)).toContain("Final answer");
			expect(expanded.render(35).every((line) => visibleWidth(line) <= 35)).toBe(true);
			const oldTheme = expanded.render(100).join("\n");
			expect(setTheme("light").success).toBe(true);
			expanded.invalidate();
			render(details, expanded, true);
			expect(expanded.render(100).join("\n")).not.toBe(oldTheme);
			expect(text(expanded)).toContain("Final answer");
			render(details, component, false);
			expect(reads).toHaveBeenCalledTimes(1);
			if (status === "failed") expect(text(component)).toContain("Job failed");
		},
	);

	it("caches completed tasks while other parallel jobs keep updating", () => {
		const done = job();
		const messages = done.messages;
		const reads = vi.fn(() => messages);
		Object.defineProperty(done, "messages", { enumerable: true, get: reads });
		const running = job("running");
		let details: JobDetails = { mode: "parallel", results: [done, running] };
		const component = render(details, undefined, true, true);
		expect(text(component)).toContain("1/2 done, 1 running");
		running.messages = [fauxAssistantMessage("New progress\nline two\nline three\nline four")];
		running.usage.output = 40;
		details = { mode: "parallel", results: [done, running] };
		expect(render(details, component, true, true)).toBe(component);
		expect(text(component)).toContain("line four");
		expect(text(component)).toContain("out:60");
		expect(reads).toHaveBeenCalledTimes(1);
		running.status = "completed";
		details = { mode: "parallel", results: [done, running] };
		render(details, component, true);
		expect(text(component)).toContain("2/2 tasks");
		expect(text(component)).toContain("New progress");
		expect(reads).toHaveBeenCalledTimes(1);
	});

	it("renders ongoing updates without treating a partial result as immutable", () => {
		const result = job("running");
		const details: JobDetails = { mode: "single", results: [result] };
		const component = render(details, undefined, false, true);
		expect(text(component)).toContain("First progress update");
		result.messages = [fauxAssistantMessage("Fresh progress")];
		result.usage.contextTokens = 200;
		render(details, component, false, true);
		expect(text(component)).toContain("Fresh progress");
		expect(text(component)).toContain("ctx:200");
		result.status = "completed";
		render(details, component, true);
		expect(text(component)).toContain("[done]");
		expect(text(component)).toContain("Fresh progress");
	});

	it("snapshots tool-call previews without retaining or rereading their large arguments", () => {
		const result = job();
		const args = { path: "/tmp/output.ts", content: "large source content\n".repeat(2000) };
		result.messages = [fauxAssistantMessage(fauxToolCall("write", args)), fauxAssistantMessage("Wrote output")];
		const details: JobDetails = { mode: "single", results: [result] };
		const component = render(details, undefined, true);
		const initial = text(component);
		expect(initial).toContain("write /tmp/output.ts (2001 lines)");
		Object.defineProperty(args, "content", {
			get: () => {
				throw new Error("Raw write args were reread");
			},
		});
		result.messages.length = 0;
		component.invalidate();
		render(details, component, true);
		expect(text(component)).toBe(initial);
	});

	it.each(["chain", "parallel"] as const)("keeps every %s task output and failure metadata", (mode) => {
		const done = { ...job(), step: 1 };
		const failed = {
			...job("failed"),
			step: 2,
			errorMessage: "failed second task",
			stopReason: "error",
			messages: [fauxAssistantMessage("Second output")],
		};
		const details: JobDetails = { mode, results: [done, failed] };
		const component = render(details, undefined, true);
		const initial = text(component);
		done.messages.length = 0;
		failed.messages.length = 0;
		component.invalidate();
		render(details, component, true);
		expect(text(component)).toBe(initial);
		expect(initial).toContain("Final answer");
		expect(initial).toContain("Second output");
		expect(initial).toContain("[failed]");
	});

	it("copies only display fields without changing or retaining the original result", () => {
		const result = job();
		const original = JSON.stringify(result);
		Object.defineProperty(result, "privateSession", {
			configurable: true,
			enumerable: true,
			get: () => {
				throw new Error("Non-display state was accessed");
			},
		});
		const component = render({ mode: "single", results: [result] }, undefined, true);
		expect(text(component)).toContain("Final answer");
		Object.defineProperty(result, "privateSession", { enumerable: false });
		expect(JSON.stringify(result)).toBe(original);
	});

	it("replaces the snapshot when the row receives a different completed result", () => {
		const result = job();
		const component = render({ mode: "single", results: [result] });
		const replacement = { ...job(), messages: [fauxAssistantMessage("Replacement output")] };
		render({ mode: "single", results: [replacement] }, component);
		expect(text(component)).toContain("Replacement output");
		expect(text(component)).not.toContain("First progress update");
	});
});
