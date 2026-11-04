import type { ExtensionAPI, ExtensionContext } from "@greppleai/grip";

const INACTIVE_TOOLS = new Set(["read", "grep", "edit", "write", "grepple"]);

const INSTALL_COMMAND = [
	"set -eu",
	"installer=$(mktemp)",
	"trap 'rm -f \"$installer\"' 0",
	"curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output \"$installer\" https://raw.githubusercontent.com/greppleai/grepple/main/install.sh",
	'sh "$installer" --bin-dir "$HOME/.local/bin"',
	'PATH="$HOME/.local/bin:$PATH" grepple --version',
].join("\n");
const MAX_GUARD_REQUEST_BYTES = 1024 * 1024;
const GREPPLE_REMINDER = [
	"For broad local Grepple tree/search, first use real checksum-current --domain-area or --functional-area labels from overview or a local tree with a narrow path; add --purpose when useful.",
	"For example: `grepple tree --domain-area LABEL PATH`, then `grepple --functional-area LABEL -F 'Name' --count-summary PATH` (replace LABEL with an observed label).",
	"For local declaration reads, use `grepple --outline FILE` then `grepple --at FILE @KIND:START-END` with the emitted native token; use `--at FILE:LINE[-END]` for literal or remote spans.",
	"Recheck unfiltered if coverage is incomplete or the task needs exhaustive evidence. Metadata filters do not apply to graph, grit, architecture, or remote queries.",
].join(" ");
const GREPPLE_PROMPT = [
	"### Grepple repository workflow",
	"",
	"Start with `grepple overview` and `grepple tree --depth 1`; narrow to a relevant subtree before searching.",
	GREPPLE_REMINDER,
	"Use clean Grepple anchors before editing with `grepple write --root .` and a quoted literal heredoc. Use `::grepple replace PATH START [END]`, `::grepple create PATH`, or `::grepple delete PATH SHA256`; the next directive or EOF ends the body (no end marker or `::grepple end`). Obtain clean anchors before replacement; search hits are not edit anchors.",
	"Prefer Grepple over local find/grep/rg/fd; use `# grep-guard:allow` only when a legacy command is genuinely required.",
].join("\n");

function insertGreppleGuidance(prompt: string, guidance: string): string {
	// Keep Grepple guidance inside Grip's Guidelines section, ahead of the catalogs.
	const sections = ["\n\n## Skills\n", "\n\n## Jobs\n", "\n\n## Grip documentation\n"];
	const contextEnd = prompt.lastIndexOf("</project_context>");
	const searchFrom = contextEnd < 0 ? 0 : contextEnd + "</project_context>".length;
	const firstSection = Math.min(
		...sections.map((section) => {
			const index = prompt.indexOf(section, searchFrom);
			return index < 0 ? Infinity : index;
		}),
	);
	if (firstSection !== Infinity) return `${prompt.slice(0, firstSection)}\n\n${guidance}${prompt.slice(firstSection)}`;
	const date = prompt.lastIndexOf("\nCurrent date:");
	if (date >= 0) return `${prompt.slice(0, date)}\n\n${guidance}${prompt.slice(date)}`;
	return `${prompt}\n\n${guidance}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function greppleGuardReason(command: unknown, ctx: ExtensionContext): Promise<string | undefined> {
	if (typeof command !== "string") return;
	const request = JSON.stringify({ command });
	if (Buffer.byteLength(request, "utf8") > MAX_GUARD_REQUEST_BYTES) return;
	try {
		// The guard runs in Grip's active local/remote tool backend, never in the extension host.
		const result = await ctx.execToolBackend(
			`PATH="$HOME/.local/bin:$PATH"; export PATH; printf '%s' ${shellQuote(request)} | grepple grep-guard`,
			{
				cwd: ctx.cwd,
				signal: ctx.signal,
				timeout: 10,
			},
		);
		if (result.exitCode !== 0 || result.cancelled || result.truncated) return;
		const response: unknown = JSON.parse(result.output);
		if (!response || typeof response !== "object" || Array.isArray(response)) return;
		const { blocked, reason } = response as { blocked?: unknown; reason?: unknown };
		if (blocked === true && typeof reason === "string" && reason.trim()) return reason;
	} catch {
		// Like Grepple's Pi guard, missing/old binaries and invalid responses fail open.
	}
	return;
}

async function validateInstallTarget(ctx: ExtensionContext, sandbox: boolean): Promise<boolean> {
	if (ctx.getToolBackendInfo().type === "remote" && !sandbox) {
		ctx.ui.notify(
			"Grepple install requires a local backend or connected Grip sandbox; detached remote backends cannot install on the host.",
			"error",
		);
		return false;
	}
	if (!sandbox) return true;
	if (!ctx.hasUI || !ctx.toolOperations.mapWorkspaceDirectoryToHost) {
		ctx.ui.notify("Grepple host install requires an approval UI and a verified sandbox-to-host mount.", "error");
		return false;
	}
	try {
		await ctx.toolOperations.mapWorkspaceDirectoryToHost(ctx.cwd);
		return true;
	} catch {
		ctx.ui.notify("Grepple host install requires a verified sandbox-to-host mount.", "error");
		return false;
	}
}

async function installGreppleBackend(ctx: ExtensionContext): Promise<boolean> {
	try {
		const guest = await ctx.execToolBackend(INSTALL_COMMAND, { cwd: ctx.cwd, timeout: 600 });
		if (guest.cancelled || guest.exitCode !== 0) {
			ctx.ui.notify("Grepple install failed in the active tool backend; host install was not attempted.", "error");
			return false;
		}
		return true;
	} catch (error) {
		ctx.ui.notify(
			`Grepple backend install failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return false;
	}
}

export default function greppleExtension(pi: ExtensionAPI): void {
	pi.registerJobFactory(registerGreppleWorkflow);
	pi.registerCommand("grepple-install", {
		description: "Install Grepple in the workspace backend and, with approval, on the host",
		handler: async (_args, ctx) => {
			const sandbox = ctx.isSandbox();
			if (!(await validateInstallTarget(ctx, sandbox))) return;
			if (!(await installGreppleBackend(ctx))) return;
			if (!sandbox) {
				ctx.ui.notify("Grepple installed in the local backend (also the host).", "info");
				return;
			}
			try {
				const host = await ctx.execHostCommand(INSTALL_COMMAND, {
					question:
						"Install Grepple from the official installer into host ~/.local/bin? The installer downloads and checksum-verifies the latest published release.",
					cwd: ctx.cwd,
					timeout: 600,
					approvalTimeoutMs: 60_000,
				});
				if (host.cancelled || host.exitCode !== 0) {
					ctx.ui.notify("Grepple installed in the sandbox, but host installation failed.", "error");
					return;
				}
				ctx.ui.notify("Grepple installed in both sandbox and host (~/.local/bin).", "info");
			} catch (error) {
				ctx.ui.notify(
					`Grepple installed in the sandbox, but host installation was not completed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
	registerGreppleWorkflow(pi);
}

function registerGreppleWorkflow(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		const next = active.filter((name) => !INACTIVE_TOOLS.has(name));
		if (!next.includes("bash")) next.unshift("bash");
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
			pi.setActiveTools(next);
		}
	});

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (!options.selectedTools?.includes("bash") || options.customPrompt) return;
		if (options.contextFiles?.some(({ content }) => content.includes("## Grepple-first repository workflow"))) {
			if (event.systemPrompt.includes(GREPPLE_REMINDER)) return;
			return { systemPrompt: insertGreppleGuidance(event.systemPrompt, GREPPLE_REMINDER) };
		}
		return { systemPrompt: insertGreppleGuidance(event.systemPrompt, GREPPLE_PROMPT) };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "edit") {
			return {
				block: true,
				reason:
					"Use bash to run grepple write --root . with a literal directive/body transaction; the next directive or EOF ends its body (no end marker).",
			};
		}
		if (event.toolName !== "bash") return;
		const reason = await greppleGuardReason(event.input.command, ctx);
		if (reason) return { block: true, reason };
	});
}
