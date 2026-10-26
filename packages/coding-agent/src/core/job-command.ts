/** Parsing and completion for the global job-model slash command. */
export const JOB_COMMAND_USAGE =
	"Usage: /job model show | /job model set --model <provider/model-id> | /job model clear";

export type JobCommand =
	| { action: "show" }
	| { action: "set"; model: string }
	| { action: "clear" }
	| { action: "invalid" };

function parseTokens(argument: string): string[] {
	return argument.trim().split(/\s+/).filter(Boolean);
}

export function parseJobCommand(argument: string): JobCommand {
	const tokens = parseTokens(argument);
	if (tokens.length === 2 && tokens[0] === "model" && tokens[1] === "show") return { action: "show" };
	if (tokens.length === 2 && tokens[0] === "model" && tokens[1] === "clear") return { action: "clear" };
	if (tokens.length === 4 && tokens[0] === "model" && tokens[1] === "set" && tokens[2] === "--model" && tokens[3]) {
		return { action: "set", model: tokens[3] };
	}
	return { action: "invalid" };
}

export interface JobCommandCompletion {
	value: string;
	label: string;
}

export function completeJobCommand(prefix: string, models: readonly string[]): JobCommandCompletion[] {
	const parts = prefix.trim().split(/\s+/).filter(Boolean);
	if (!prefix.includes(" ")) return "model".startsWith(prefix) ? [{ value: "model ", label: "model" }] : [];
	if (parts.length === 1) {
		return ["show", "set", "clear"].map((value) => ({
			value: `model ${value}${value === "set" ? " --model " : ""}`,
			label: value,
		}));
	}
	if (parts[0] !== "model") return [];
	const action = parts[1] ?? "";
	if (parts.length === 2 && !prefix.endsWith(" ")) {
		return ["show", "set", "clear"]
			.filter((value) => value.startsWith(action))
			.map((value) => ({ value: `model ${value}${value === "set" ? " --model " : ""}`, label: value }));
	}
	if (action !== "set") return [];
	if (parts.length === 2) return [{ value: "model set --model ", label: "--model" }];
	if (parts[2] !== "--model") {
		return "--model".startsWith(parts[2]!) ? [{ value: "model set --model ", label: "--model" }] : [];
	}
	const query = prefix.endsWith(" ") ? "" : (parts.at(-1) ?? "");
	return models
		.filter((model) => model.toLowerCase().includes(query.toLowerCase()))
		.map((model) => ({ value: `model set --model ${model}`, label: model }));
}
