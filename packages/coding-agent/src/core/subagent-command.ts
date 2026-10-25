/** User-only subagent management command parsing and argument completion. */
export const SUBAGENT_COMMAND_USAGE =
	"Usage: /subagent list | /subagent model get --name <name> | /subagent model set --name <name> --model <provider/model-id>";

export type SubagentCommand =
	| { action: "list" }
	| { action: "get"; name: string }
	| { action: "set"; name: string; model: string }
	| { action: "invalid" };

function parseSubagentTokens(argument: string): string[] {
	const tokens = argument.trim().match(/"[^"]*(?:"|$)|\S+/g) ?? [""];
	if (tokens.some((token) => token.startsWith('"') && !token.endsWith('"'))) return [];
	return tokens.map((token) => (token.startsWith('"') ? token.slice(1, -1) : token));
}

export function parseSubagentCommand(argument: string): SubagentCommand {
	const tokens = parseSubagentTokens(argument);
	if (tokens.length === 1 && (tokens[0] === "list" || tokens[0] === "")) return { action: "list" };
	if (tokens[0] !== "model" || !["get", "set"].includes(tokens[1]) || tokens.length % 2 !== 0) {
		return { action: "invalid" };
	}
	const action = tokens[1];
	const flags = new Map<string, string>();
	for (let i = 2; i < tokens.length; i += 2) {
		const flag = tokens[i];
		const value = tokens[i + 1];
		if (!/^--(?:name|model)$/.test(flag) || !value || flags.has(flag)) return { action: "invalid" };
		flags.set(flag, value);
	}
	const name = flags.get("--name");
	if (!name) return { action: "invalid" };
	if (action === "get") return flags.size === 1 ? { action: "get", name } : { action: "invalid" };
	const model = flags.get("--model");
	return model && flags.size === 2 ? { action: "set", name, model } : { action: "invalid" };
}

export interface SubagentCommandCompletion {
	value: string;
	label: string;
}

export function completeSubagentCommand(
	prefix: string,
	names: readonly string[],
	models: readonly string[],
): SubagentCommandCompletion[] {
	const parts = prefix.trim().match(/"[^"]*(?:"|$)|\S+/g) ?? [""];
	if (!prefix.includes(" ")) {
		return ["list", "model"]
			.filter((action) => action.startsWith(prefix))
			.map((action) => ({ value: action === "model" ? "model " : action, label: action }));
	}
	if (parts[0] !== "model") return [];
	if (parts.length === 1 || (parts.length === 2 && !prefix.endsWith(" "))) {
		const query = parts[1] ?? "";
		return ["get", "set"]
			.filter((action) => action.startsWith(query))
			.map((action) => ({ value: `model ${action} `, label: action }));
	}
	if (parts[1] !== "get" && parts[1] !== "set") return [];
	return completeModelSubagentOptions(prefix, parts, names, models);
}

function completeModelSubagentOptions(
	prefix: string,
	parts: string[],
	names: readonly string[],
	models: readonly string[],
): SubagentCommandCompletion[] {
	const action = parts[1];
	const last = prefix.endsWith(" ") ? "" : (parts.at(-1) ?? "");
	const previous = prefix.endsWith(" ") ? parts.at(-1) : parts.at(-2);
	if (previous === "--name" || previous === "--model") {
		const values = previous === "--name" ? names : models;
		const base = parts.slice(0, prefix.endsWith(" ") ? undefined : -1).join(" ");
		const query = last.replace(/^"/, "").toLowerCase();
		return values
			.filter((value) => !value.includes('"') && value.toLowerCase().includes(query))
			.map((value) => ({ value: `${base} ${/\s/.test(value) ? `"${value}"` : value}`, label: value }));
	}
	if (last === "--name" || last === "--model") {
		const values = last === "--name" ? names : models;
		return values
			.filter((value) => !value.includes('"'))
			.map((value) => ({ value: `${parts.join(" ")} ${/\s/.test(value) ? `"${value}"` : value}`, label: value }));
	}
	const used = new Set<string>(parts.slice(2).filter((part) => part === "--name" || part === "--model"));
	const flags = action === "get" ? ["--name"] : ["--name", "--model"];
	const available = flags.filter((flag) => !used.has(flag) && flag.startsWith(last));
	const base = parts.slice(0, prefix.endsWith(" ") ? undefined : -1).join(" ");
	return available.map((flag) => ({ value: `${base} ${flag} `, label: flag }));
}
