import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type AgentToolResult, type ExecResult, type ExtensionAPI, getAgentDir, truncateHead } from "@greppleai/grip";
import { Type } from "typebox";
import { authorize, readPolicy } from "./policy.ts";

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
	for (const command of commands) {
		pi.registerTool({
			name: command.name,
			label: `Host ${command.name}`,
			description: `Run ${command.name} on the host through a deny-by-default argv policy and fresh user approval. Pass arguments as separate strings, not shell text. Output limited to 2000 lines or 50 KiB. Allowed templates (each nested array is one argument's choices): ${JSON.stringify(command.allow)}`,
			promptSnippet: `Policy-restricted host ${command.name} (requires sandbox and approval)`,
			parameters: Type.Object(
				{ args: Type.Array(Type.String(), { maxItems: 64 }) },
				{ additionalProperties: false },
			),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!ctx.isSandbox()) throw new Error("Host CLI tools require a connected mapped sandbox");
				if (signal?.aborted) throw new Error("Host CLI execution cancelled");
				// Re-read before every invocation: removals and invalid policies never fall back to cached grants.
				const current = (await readPolicy(policyPath)).find((entry) => entry.name === command.name);
				if (!current) throw new Error(`Host CLI tool ${command.name} is no longer allowed`);
				const args = authorize(current, params.args);
				const result = await ctx.execHostProcess(current.name, args, {
					question: `Allow policy-matched host ${command.name}? Output will be returned to the agent.`,
					signal,
					timeout: current.timeoutMs,
				});
				return hostResult(command.name, result);
			},
		});
	}
}
