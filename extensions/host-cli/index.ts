import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type AgentToolResult,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	truncateHead,
} from "@greppleai/grip";
import { Type } from "typebox";
import { executeHostCli } from "./execute.ts";
import { authorize, MAX_TEXT_ARGUMENT_LENGTH, readPolicy } from "./policy.ts";

function hostResult(name: string, result: ExecResult): AgentToolResult<unknown> {
	const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
	const truncated = truncateHead(output);
	let text = truncated.content.trim() || "(no output)";
	if (truncated.truncated) text += "\n[Output truncated; omitted host output is not saved.]";
	if (result.killed || result.code !== 0) {
		throw new Error(`Host ${name} failed (exit ${result.code ?? "unknown"}, killed: ${result.killed}).\n${text}`);
	}
	return {
		content: [{ type: "text", text }],
		details: { exitCode: result.code, truncated: truncated.truncated },
	};
}

export default async function hostCli(pi: ExtensionAPI) {
	const policyPath = join(getAgentDir(), "host-cli.yaml");
	const commands = await readPolicy(policyPath);
	const toolNames = new Set(commands.map((command) => command.name));

	function syncActiveTools(ctx: ExtensionContext) {
		const active = pi.getActiveTools();
		const next = new Set(active);
		const sandbox = ctx.isSandbox();
		for (const name of toolNames) {
			if (sandbox) next.add(name);
			else next.delete(name);
		}
		if (next.size !== active.length) pi.setActiveTools([...next]);
	}

	pi.on("session_start", (_event, ctx) => syncActiveTools(ctx));
	pi.on("before_agent_start", (_event, ctx) => syncActiveTools(ctx));
	pi.on("turn_start", (_event, ctx) => syncActiveTools(ctx));
	for (const command of commands) {
		pi.registerTool({
			name: command.name,
			label: `Host ${command.name}`,
			description: `Run ${command.name} on the host through a host-owned deny-by-default argv policy. Matching commands run without approval; a mapped sandbox is required. Pass separate argv strings, not shell text; maximum 64 arguments. Rules: args is an ordered prefix; array slots are exact choices and {text:true} is one literal text argument (at most 65536 characters, no NUL). After args, options may appear in any order: names are explicit aliases, value is one nonempty argument (null means boolean), required options must be present, and duplicate options/aliases are denied. positionals must follow a literal -- terminator and match exactly; no options are parsed after it. flags permits listed standalone flags, including duplicates; legacy "*"/"--*" explicitly grant short/long or long-only wildcard flags, including inline values, but cannot mix with options or positionals. No implicit combined flags, inline option values or shell expansion. Output capped at 2000 lines / 50 KiB. Rules: ${JSON.stringify(command.allow)}`,
			promptSnippet: `Policy-restricted host ${command.name} (policy-authorized, no approval prompt; requires mapped sandbox)`,
			parameters: Type.Object(
				{ args: Type.Array(Type.String({ maxLength: MAX_TEXT_ARGUMENT_LENGTH }), { maxItems: 64 }) },
				{ additionalProperties: false },
			),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!ctx.isSandbox()) throw new Error("Host CLI tools require a connected mapped sandbox");
				if (signal?.aborted) throw new Error("Host CLI execution cancelled");
				// Re-read before every invocation: removals and invalid policies never fall back to cached grants.
				const current = (await readPolicy(policyPath)).find((entry) => entry.name === command.name);
				if (!current) throw new Error(`Host CLI tool ${command.name} is no longer allowed`);
				const args = authorize(current, params.args);
				const operations = ctx.toolOperations;
				if (!operations.mapWorkspaceDirectoryToHost) throw new Error("No verified host mount mapping is available");
				const cwd = await operations.mapWorkspaceDirectoryToHost(operations.cwd);
				if (!ctx.isSandbox()) throw new Error("Sandbox disconnected before host execution");
				const result = await executeHostCli(current.name, args, { cwd, signal, timeoutMs: current.timeoutMs });
				return hostResult(command.name, result);
			},
		});
	}
}
