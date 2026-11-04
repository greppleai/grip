/** Parsing and completion for the job-model slash command. */
export const JOB_COMMAND_USAGE =
	"Usage: /job model show | /job model set --model <provider/model-id> | /job model clear | /job model add <model> <description...> | /job model remove <model>";
export type JobModelCatalogCommand =
	| { action: "add"; model: string; description: string }
	| { action: "remove"; model: string };
export type JobCommand =
	| { action: "show" }
	| { action: "set"; model: string }
	| { action: "clear" }
	| JobModelCatalogCommand
	| { action: "invalid" };
interface QuotedToken {
	text: string;
	end: number;
}

function readQuotedToken(argument: string, start: number): QuotedToken | undefined {
	const quote = argument[start];
	let text = "";
	for (let i = start + 1; i < argument.length; i++) {
		const char = argument[i]!;
		if (char === quote) return { text, end: i };
		if (char === "\\" && (argument[i + 1] === quote || argument[i + 1] === "\\")) {
			text += argument[++i];
		} else {
			text += char;
		}
	}
	return undefined;
}

function parseTokens(argument: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let started = false;
	for (let i = 0; i < argument.length; i++) {
		const char = argument[i]!;
		if (char === '"' || (char === "'" && !started)) {
			const quoted = readQuotedToken(argument, i);
			if (!quoted) return undefined;
			token += quoted.text;
			i = quoted.end;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (started) tokens.push(token);
	return tokens;
}
export function parseJobCommand(argument: string): JobCommand {
	const tokens = parseTokens(argument);
	if (!tokens) return { action: "invalid" };
	if (tokens.length === 2 && tokens[0] === "model" && tokens[1] === "show") return { action: "show" };
	if (tokens.length === 2 && tokens[0] === "model" && tokens[1] === "clear") return { action: "clear" };
	if (tokens.length === 4 && tokens[0] === "model" && tokens[1] === "set" && tokens[2] === "--model" && tokens[3])
		return { action: "set", model: tokens[3] };
	if (tokens[0] === "model" && tokens[1] === "add" && tokens[2]?.trim() && tokens.length >= 4) {
		const description = tokens.slice(3).join(" ").trim();
		if (description) return { action: "add", model: tokens[2], description };
	}
	if (tokens.length === 3 && tokens[0] === "model" && tokens[1] === "remove" && tokens[2]?.trim())
		return { action: "remove", model: tokens[2] };
	return { action: "invalid" };
}
export interface JobCommandCompletion {
	value: string;
	label: string;
}
function completeJobActions(query: string): JobCommandCompletion[] {
	return ["show", "set", "clear", "add", "remove"]
		.filter((value) => value.startsWith(query))
		.map((value) => ({
			value: `model ${value}${value === "set" ? " --model " : value === "add" || value === "remove" ? " " : ""}`,
			label: value,
		}));
}

function completeJobModels(
	parts: string[],
	trailingSpace: boolean,
	models: readonly string[],
	registered: readonly string[],
): JobCommandCompletion[] {
	const action = parts[1];
	if (action === "set" && parts.length === 2) return [{ value: "model set --model ", label: "--model" }];
	if (action === "set" && parts[2] !== "--model") {
		return parts.length === 3 && "--model".startsWith(parts[2]!)
			? [{ value: "model set --model ", label: "--model" }]
			: [];
	}
	if (action !== "set" && action !== "add" && action !== "remove") return [];
	const modelIndex = action === "set" ? 3 : 2;
	if (parts.length > modelIndex + 1 || (parts.length === modelIndex + 1 && trailingSpace)) return [];
	const query = parts[modelIndex] ?? "";
	return (action === "remove" ? registered : models)
		.filter((model) => model.toLowerCase().includes(query.toLowerCase()))
		.map((model) => ({ value: `model ${action} ${action === "set" ? "--model " : ""}${model}`, label: model }));
}

export function completeJobCommand(
	prefix: string,
	models: readonly string[],
	registered: readonly string[] = [],
): JobCommandCompletion[] {
	const input = prefix.trimStart();
	const parts = input.trimEnd().split(/\s+/).filter(Boolean);
	if (!/\s/.test(input)) return "model".startsWith(input) ? [{ value: "model ", label: "model" }] : [];
	if (parts[0] !== "model") return [];
	const trailingSpace = /\s$/.test(input);
	if (parts.length === 1 || (parts.length === 2 && !trailingSpace)) {
		return completeJobActions(parts[1] ?? "");
	}
	return completeJobModels(parts, trailingSpace, models, registered);
}
