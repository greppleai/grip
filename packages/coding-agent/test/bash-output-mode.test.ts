import type { ToolResultMessage } from "@greppleai/grip-ai";
import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../src/core/compaction/compaction.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { createHarness } from "./suite/harness.ts";

type Mode = "always" | "on_fail" | "never";

function resultText(message: ToolResultMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function projectBashResult(mode: Mode | undefined, isError: boolean, output: string) {
	const toolCall = fauxToolCall("bash", { command: "check", ...(mode ? { output_mode: mode } : {}) });
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: "bash",
		content: [{ type: "text", text: output }],
		details: { marker: "retained for the UI" },
		isError,
		timestamp: Date.now(),
	};
	const projected = convertToLlm([
		fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
		result,
	])[1] as ToolResultMessage;
	return { result, projected };
}

describe("bash output_mode", () => {
	it("recommends on_fail for checks while keeping always as the runtime default", () => {
		const definition = createBashToolDefinition(new LocalToolOperations(process.cwd()));
		expect(definition.promptGuidelines?.[0]).toContain("explicitly set output_mode: on_fail");
		expect(JSON.stringify(definition.parameters.properties.output_mode)).toContain("always (runtime default)");
	});

	it("preserves the previous output behavior by default and for always", () => {
		for (const mode of [undefined, "always"] as const) {
			const { result, projected } = projectBashResult(mode, false, "IMPORTANT: complete output");
			expect(projected).toBe(result);
			expect(resultText(projected)).toBe("IMPORTANT: complete output");
		}
	});

	it("on_fail hides successful stdout/stderr but retains failing output", () => {
		const { result, projected } = projectBashResult("on_fail", false, "warning or secret from success");
		expect(resultText(projected)).toBe("Bash command succeeded; output omitted (output_mode: on_fail).");
		expect(resultText(result)).toBe("warning or secret from success");
		expect(projected.details).toEqual(result.details);
		expect(projected.isError).toBe(false);

		const failure = projectBashResult("on_fail", true, "failure details\n\nCommand exited with code 3");
		expect(failure.projected).toBe(failure.result);
		expect(resultText(failure.projected)).toContain("failure details");
	});

	it("never hides output even on failure while reporting the exit status when available", () => {
		const success = projectBashResult("never", false, "not needed");
		expect(resultText(success.projected)).toBe("Bash command succeeded; output omitted (output_mode: never).");
		const failure = projectBashResult("never", true, "private stderr\n\nCommand exited with code 42");
		expect(resultText(failure.projected)).toBe(
			"Bash command exited with code 42; output omitted (output_mode: never).",
		);
		expect(resultText(failure.result)).toContain("private stderr");
		const timeout = projectBashResult("never", true, "Command timed out after 5 seconds");
		expect(resultText(timeout.projected)).toBe("Bash command failed; output omitted (output_mode: never).");
	});

	it("matches results by tool-call id and never masks other tools", () => {
		const suppressedCall = fauxToolCall("bash", { command: "check", output_mode: "never" });
		const normalCall = fauxToolCall("bash", { command: "show" });
		const readCall = fauxToolCall("read", { path: "test.txt", output_mode: "never" });
		const calls = [suppressedCall, normalCall, readCall];
		const results: ToolResultMessage[] = calls.map((call) => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: `raw ${call.name} ${call.id}` }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		}));
		const converted = convertToLlm([fauxAssistantMessage(calls, { stopReason: "toolUse" }), ...results]);
		expect(resultText(converted[1] as ToolResultMessage)).toContain("output omitted (output_mode: never)");
		expect(converted[2]).toBe(results[1]);
		expect(converted[3]).toBe(results[2]);
	});

	it("estimates only the model-visible summary, not hidden output", () => {
		const makeContext = (mode: Mode) => {
			const call = fauxToolCall("bash", { command: "check", output_mode: mode });
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: "bash",
				content: [{ type: "text", text: "large-output".repeat(1000) }],
				isError: false,
				timestamp: Date.now(),
			};
			return [fauxAssistantMessage(call, { stopReason: "toolUse" }), result];
		};
		expect(estimateContextTokens(makeContext("on_fail")).tokens).toBeLessThan(200);
		expect(estimateContextTokens(makeContext("always")).tokens).toBeGreaterThan(2500);
	});

	it("suppresses only the provider payload while keeping the session result intact", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'actual-stdout'", output_mode: "on_fail" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					const modelResult = context.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "bash",
					) as ToolResultMessage;
					expect(resultText(modelResult)).toBe("Bash command succeeded; output omitted (output_mode: on_fail).");
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("Check the command");
			const storedResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "bash",
			) as ToolResultMessage;
			expect(resultText(storedResult)).toBe("actual-stdout");
		} finally {
			harness.cleanup();
		}
	});

	it("retains actual Bash output and errors for UI and session history", async () => {
		const tool = createBashTool(new LocalToolOperations(process.cwd()));
		for (const mode of ["always", "on_fail", "never"] as const) {
			const result = await tool.execute("bash-ok", { command: "printf 'visible-output'", output_mode: mode });
			expect(result.content).toEqual([{ type: "text", text: "visible-output" }]);
		}
		const updates: string[] = [];
		await tool.execute(
			"bash-stream",
			{ command: "printf 'stream-visible'", output_mode: "never" },
			undefined,
			(update) =>
				updates.push(
					update.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				),
		);
		expect(updates).toContain("stream-visible");
		await expect(
			tool.execute("bash-fail", { command: "printf 'failure-output'; exit 4", output_mode: "never" }),
		).rejects.toThrow(/failure-output[\s\S]*Command exited with code 4/);
	});
});
