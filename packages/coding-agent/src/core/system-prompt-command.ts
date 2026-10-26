export const SYSTEM_PROMPT_COMMAND_USAGE = "Usage: /system-prompt";

export type SystemPromptCommand = { action: "main" } | { action: "invalid" };

export function parseSystemPromptCommand(argument: string): SystemPromptCommand {
	return argument.trim() ? { action: "invalid" } : { action: "main" };
}
