import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type AgentToolResult, type ExecResult, type ExtensionAPI, getAgentDir, truncateHead } from "@greppleai/grip";
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
	for (const command of commands) {
		pi.registerTool({
			name: command.name,
			label: `Host ${command.name}`,
			description: `Run ${command.name} on the host through a host-owned deny-by-default argv policy. Policy-matched commands run without approval. Pass arguments as separate strings, not shell text. Output limited to 2000 lines or 50 KiB. Allowed templates (arrays list exact choices; {text:true} accepts one literal text argument, including multiline, at most 65536 characters, without NUL): ${JSON.stringify(command.allow)}`,
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
