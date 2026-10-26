import { describe, expect, it } from "vitest";
import { HIDDEN_BUILTIN_SLASH_COMMAND_NAMES } from "../src/core/slash-commands.ts";
import { parseSystemPromptCommand, SYSTEM_PROMPT_COMMAND_USAGE } from "../src/core/system-prompt-command.ts";

describe("/system-prompt", () => {
	it("shows the main prompt only and rejects arguments", () => {
		expect(parseSystemPromptCommand("")).toEqual({ action: "main" });
		for (const argument of ["--job worker", "--job", "anything"]) {
			expect(parseSystemPromptCommand(argument)).toEqual({ action: "invalid" });
		}
		expect(SYSTEM_PROMPT_COMMAND_USAGE).toBe("Usage: /system-prompt");
		expect(HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has("system-prompt")).toBe(true);
	});
});
