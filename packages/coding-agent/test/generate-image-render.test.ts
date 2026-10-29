import type { TUI } from "@greppleai/grip-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createGenerateImageToolDefinition } from "../src/core/tools/generate-image.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("generate_image rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("retains the full prompt and supplied parameters while running and after success or error", () => {
		const args = {
			prompt: `${"long prompt ".repeat(30)}END\nsecond line`,
			outputPath: "images/cat.png",
			size: "1536x1024",
			quality: "high",
		};
		const tool = createGenerateImageToolDefinition(
			() => new LocalToolOperations(process.cwd()),
			async () => undefined,
		);
		const component = new ToolExecutionComponent(
			"generate_image",
			"id",
			args,
			{},
			tool,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.markExecutionStarted();
		for (const state of ["running", "success", "error"] as const) {
			if (state !== "running")
				component.updateResult(
					{
						content: [{ type: "text", text: state === "success" ? "saved image" : "failed image" }],
						isError: state === "error",
					},
					false,
				);
			const lines = component.render(120);
			const output = stripAnsi(lines.join("\n"));
			expect(output).toContain("generate_image");
			expect(output).toContain("END");
			expect(output).toContain("second line");
			expect(output).toContain("outputPath: images/cat.png");
			expect(output).toContain("size: 1536x1024");
			expect(output).toContain("quality: high");
			expect(output).toContain({ running: "generate_image", success: "saved image", error: "failed image" }[state]);
		}
	});

	it("handles partial arguments without inventing optional parameters", () => {
		const tool = createGenerateImageToolDefinition(
			() => new LocalToolOperations(process.cwd()),
			async () => undefined,
		);
		const component = new ToolExecutionComponent(
			"generate_image",
			"id",
			{},
			{},
			tool,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("generate_image");
		expect(output).not.toContain("quality:");
		expect(output).not.toContain("outputPath:");
	});
});
