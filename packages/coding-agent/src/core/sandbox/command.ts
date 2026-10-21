import type { SandboxContainer, SandboxStartResult, SandboxStopResult } from "./config.ts";

export interface SandboxStartUserCommand {
	subcommand: "start";
	name?: string;
	template?: string;
	update?: boolean;
}

export type SandboxUserCommand =
	| { subcommand: "status" }
	| { subcommand: "clear" }
	| { subcommand: "attach"; url: string }
	| SandboxStartUserCommand
	| { subcommand: "list" }
	| { subcommand: "stop"; target?: string };

function splitCommandLine(input: string): string[] {
	const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return tokens.map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1);
		}
		return token;
	});
}

function parseSandboxStartValue(
	option: string | undefined,
	value: string | undefined,
): Pick<SandboxStartUserCommand, "name" | "template"> {
	if (option !== "--name" && option !== "--template") {
		throw new Error(`Unsupported /sandbox start argument: ${option}`);
	}
	if (!value || value.startsWith("--")) {
		throw new Error("Usage: /sandbox start [--name <lima-instance>] [--template <lima-template>] [--update]");
	}
	return option === "--name" ? { name: value } : { template: value };
}

function parseSandboxStartCommand(tokens: string[]): SandboxUserCommand {
	const fields: Pick<SandboxStartUserCommand, "name" | "template"> = {};
	let update = false;
	for (let index = 2; index < tokens.length; index++) {
		const option = tokens[index];
		if (option === "--update") {
			if (update) throw new Error("Duplicate /sandbox start --update");
			update = true;
			continue;
		}
		Object.assign(fields, parseSandboxStartValue(option, tokens[++index]));
	}
	if (update && (!fields.name || fields.template)) {
		throw new Error("/sandbox start --update requires --name and cannot be combined with --template");
	}
	return {
		subcommand: "start",
		...fields,
		...(update ? { update: true } : {}),
	};
}

export function parseSandboxUserCommand(input: string): SandboxUserCommand {
	const tokens = splitCommandLine(input.trim());
	if (tokens[0] !== "/sandbox") throw new Error("Sandbox command must start with /sandbox");

	const subcommand = tokens[1];
	switch (subcommand) {
		case undefined:
		case "status":
			if (tokens.length > 2) throw new Error("Usage: /sandbox status");
			return { subcommand: "status" };
		case "clear":
			if (tokens.length > 2) throw new Error("Usage: /sandbox clear");
			return { subcommand: "clear" };
		case "--attach":
			if (tokens.length !== 3) throw new Error("Usage: /sandbox --attach <ws://url>");
			return { subcommand: "attach", url: tokens[2]! };
		case "start":
			return parseSandboxStartCommand(tokens);
		case "list":
			if (tokens.length !== 2) throw new Error("Usage: /sandbox list");
			return { subcommand: "list" };
		case "stop":
			if (tokens.length > 3) throw new Error("Usage: /sandbox stop [vm]");
			return tokens[2] ? { subcommand: "stop", target: tokens[2] } : { subcommand: "stop" };
		default:
			throw new Error(
				`Unsupported /sandbox subcommand: ${subcommand}. Use status, clear, --attach, start, list, or stop.`,
			);
	}
}

export function formatSandboxStartResult(result: SandboxStartResult): string {
	return [
		`Sandbox started: ${result.containerName} (${result.containerId})`,
		`Workspace: ${result.workspaceRoot} -> ${result.workspaceMountPath}`,
		`Daemon: ${result.daemonUrlRedacted}`,
		"Sandbox mode active: workspace tools/resources now route through the sandbox daemon.",
	].join("\n");
}

export function formatSandboxList(containers: SandboxContainer[]): string {
	if (containers.length === 0) return "No Grip sandboxes found for this workspace.";
	return containers
		.map((container) => {
			const endpoint = container.daemonEndpoint ? ` daemon=${container.daemonEndpoint}` : "";
			const mount = container.workspaceMountPath ? ` workspace=${container.workspaceMountPath}` : "";
			return `${container.id}\t${container.name}\t${container.state ?? container.status}\t${container.image}${mount}${endpoint}`;
		})
		.join("\n");
}

export function formatSandboxStopResult(result: SandboxStopResult): string {
	if (result.status === "not-found") return result.message;
	if (result.status === "already-stopped")
		return `Sandbox already stopped: ${result.container.name} (${result.container.id})`;
	if (result.status === "removed") return `Sandbox removed: ${result.container.name} (${result.container.id})`;
	return `Sandbox stopped: ${result.container.name} (${result.container.id})`;
}
