import type { AgentScope } from "./tools/subagent-agents.ts";

export const SYSTEM_PROMPT_COMMAND_USAGE =
	"Usage: /system-prompt [--subagent <name> [--agent-scope user|project|both]] (quote names containing spaces)";

export type SystemPromptCommand =
	| { action: "main" }
	| { action: "subagent"; name: string; agentScope: AgentScope }
	| { action: "invalid" };

export function parseSystemPromptCommand(argument: string): SystemPromptCommand {
	const text = argument.trim();
	if (!text) return { action: "main" };
	const match = /^--subagent\s+(?:"([^"]+)"|([^\s"]+))(?:\s+--agent-scope\s+(user|project|both))?$/.exec(text);
	if (!match) return { action: "invalid" };
	return {
		action: "subagent",
		name: match[1] ?? match[2],
		agentScope: (match[3] as AgentScope | undefined) ?? "user",
	};
}
