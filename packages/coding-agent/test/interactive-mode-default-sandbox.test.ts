import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SandboxStartUserCommand } from "../src/core/sandbox/command.ts";
import type { SandboxService, SandboxStartResult } from "../src/core/sandbox/config.ts";
import { type ProfileSettings, SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type WorkspaceBackend = "local" | "remote";

function createMode(name?: string, backend: WorkspaceBackend = "local", profile?: ProfileSettings) {
	const cwd = realpathSync(process.cwd());
	const settingsManager = SettingsManager.inMemory(
		{
			defaultSandboxes: name ? { [cwd]: name } : undefined,
			profiles: profile ? { work: profile } : undefined,
			profileDirectories: profile ? { [cwd]: "work" } : undefined,
		},
		cwd,
	);
	const service = {
		list: vi.fn(async () => [{ name: "my-vm" }]),
	};
	const startSandboxBackend = vi.fn(
		async (
			_command: SandboxStartUserCommand,
			_service: SandboxService,
			_cwd: string,
			_key: string,
		): Promise<SandboxStartResult> => ({
			containerId: "my-vm",
			containerName: "my-vm",
			workspaceRoot: cwd,
			workspaceMountPath: "/workspace",
			daemonUrl: "ws://127.0.0.1:8787/pi/workspace",
			daemonUrlRedacted: "ws://127.0.0.1:8787/pi/workspace",
			token: "test-token",
			labels: {},
		}),
	);
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const activeSession = { getCwd: () => cwd, getSessionId: () => "session" };
	const sessionSandboxStates = new Map();
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: {
			session: { session: activeSession, settingsManager, getToolBackendInfo: () => ({ type: backend, cwd }) },
		},
		sessionSandboxStates,
		activeSandboxBackendConnected: false,
		createLimaSandboxService: () => service,
		startSandboxBackend,
		showWarning,
		showStatus,
		showError,
	});
	const connect = () => (mode as unknown as { connectDefaultSandbox(): Promise<void> }).connectDefaultSandbox();
	const command = (text: string) =>
		(mode as unknown as { handleSandboxCommand(text: string): Promise<void> }).handleSandboxCommand(text);
	const activateNamedVm = (root = cwd) => {
		sessionSandboxStates.set(`${cwd}\0session`, {
			type: "daemon",
			containerId: "my-vm",
			containerName: "my-vm",
			hostWorkspaceRoot: root,
		});
		Object.assign(mode, { activeSandboxBackendConnected: true, activeSandboxContainerId: "my-vm" });
	};
	const attachRawDaemon = () => {
		sessionSandboxStates.set(`${cwd}\0session`, { type: "daemon", url: "ws://daemon.test/pi/workspace" });
		Object.assign(mode, { activeSandboxBackendConnected: true, activeSandboxContainerId: undefined });
	};
	return {
		cwd,
		settingsManager,
		service,
		startSandboxBackend,
		showWarning,
		showStatus,
		showError,
		connect,
		command,
		activateNamedVm,
		attachRawDaemon,
	};
}

describe("directory default sandboxes", () => {
	it("connects an existing named VM during startup before the first prompt", async () => {
		const { connect, service, startSandboxBackend, cwd, showWarning } = createMode("my-vm");
		await connect();
		expect(service.list).toHaveBeenCalledWith({ workspaceRoot: cwd, allWorkspaces: true });
		expect(startSandboxBackend).toHaveBeenCalledWith(
			{ subcommand: "start", name: "my-vm" },
			service,
			cwd,
			`${cwd}\0session`,
		);
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("does nothing when unconfigured and respects an explicit remote backend", async () => {
		const empty = createMode();
		await empty.connect();
		expect(empty.service.list).not.toHaveBeenCalled();
		const remote = createMode("my-vm", "remote");
		await remote.connect();
		expect(remote.service.list).not.toHaveBeenCalled();
		expect(remote.startSandboxBackend).not.toHaveBeenCalled();
		expect(remote.showWarning).toHaveBeenCalledWith(expect.stringContaining("already active"));
	});

	it("warns and remains local instead of creating a missing VM", async () => {
		const { connect, service, startSandboxBackend, showWarning } = createMode("missing-vm");
		await connect();
		expect(service.list).toHaveBeenCalledOnce();
		expect(startSandboxBackend).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
	});

	it("sets, shows and clears the user-home default from the /sandbox command", async () => {
		const { command, settingsManager, cwd, showStatus, showError } = createMode();
		await command("/sandbox default --name my-vm");
		expect(settingsManager.getDefaultSandbox(cwd)).toBe("my-vm");
		await command("/sandbox default");
		expect(showStatus).toHaveBeenLastCalledWith(`Default sandbox for ${cwd}: my-vm`);
		await command("/sandbox default clear");
		expect(settingsManager.getDefaultSandbox(cwd)).toBeUndefined();
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not persist a missing or malformed VM assignment", async () => {
		const { command, settingsManager, service, cwd, showError } = createMode();
		service.list.mockResolvedValueOnce([]);
		await command("/sandbox default --name missing");
		expect(settingsManager.getDefaultSandbox(cwd)).toBeUndefined();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
		await command("/sandbox default --name BAD");
		expect(settingsManager.getDefaultSandbox(cwd)).toBeUndefined();
	});

	it("assigns the active named VM to the host workspace without using the guest cwd", async () => {
		const { command, activateNamedVm, settingsManager, cwd, service, showError } = createMode();
		activateNamedVm();
		await command("/sandbox default set");
		expect(settingsManager.getDefaultSandbox(cwd)).toBe("my-vm");
		expect(service.list).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("rejects default set for an unattached, raw daemon, or other-workspace sandbox", async () => {
		const inactive = createMode();
		await inactive.command("/sandbox default set");
		expect(inactive.showError).toHaveBeenCalledWith(expect.stringContaining("No active named Lima VM"));
		const other = createMode();
		other.activateNamedVm(realpathSync("/"));
		await other.command("/sandbox default set");
		expect(other.showError).toHaveBeenCalledWith(expect.stringContaining("different host directory"));
		expect(other.settingsManager.getDefaultSandbox(other.cwd)).toBeUndefined();
		const attached = createMode();
		attached.attachRawDaemon();
		await attached.command("/sandbox default set");
		expect(attached.showError).toHaveBeenCalledWith(expect.stringContaining("No active named Lima VM"));
		expect(attached.settingsManager.getDefaultSandbox(attached.cwd)).toBeUndefined();
	});

	it("sets the default only after /sandbox start --name succeeds", async () => {
		const { command, settingsManager, startSandboxBackend, cwd, showError } = createMode();
		startSandboxBackend.mockRejectedValueOnce(new Error("VM start failed"));
		await command("/sandbox start --name my-vm --set-default");
		expect(settingsManager.getDefaultSandbox(cwd)).toBeUndefined();
		expect(showError).toHaveBeenCalledWith("VM start failed");
		await command("/sandbox start --name my-vm --set-default");
		expect(settingsManager.getDefaultSandbox(cwd)).toBe("my-vm");
		expect(startSandboxBackend).toHaveBeenLastCalledWith(
			{ subcommand: "start", name: "my-vm", setDefault: true },
			expect.anything(),
			cwd,
			`${cwd}\0session`,
			false,
		);
	});
	it("connects the selected profile VM ahead of a directory default", async () => {
		const { connect, settingsManager, startSandboxBackend, cwd } = createMode("directory-vm", "local", {
			defaultSandbox: "my-vm",
			autoConnectSandbox: true,
		});
		expect(settingsManager.getDefaultSandbox(cwd)).toBe("directory-vm");
		await connect();
		expect(startSandboxBackend).toHaveBeenCalledWith(
			{ subcommand: "start", name: "my-vm" },
			expect.anything(),
			cwd,
			`${cwd}\0session`,
		);
	});

	it("auto-connects a profile VM by default, but respects a profile opt-out and remote backend", async () => {
		const enabled = createMode(undefined, "local", { defaultSandbox: "my-vm" });
		await enabled.connect();
		expect(enabled.startSandboxBackend).toHaveBeenCalledOnce();

		const disabled = createMode("my-vm", "local", { defaultSandbox: "my-vm", autoConnectSandbox: false });
		await disabled.connect();
		expect(disabled.service.list).not.toHaveBeenCalled();
		expect(disabled.startSandboxBackend).not.toHaveBeenCalled();

		const remote = createMode(undefined, "remote", { defaultSandbox: "my-vm" });
		await remote.connect();
		expect(remote.startSandboxBackend).not.toHaveBeenCalled();
		expect(remote.showWarning).toHaveBeenCalledWith(expect.stringContaining("already active"));
	});
});
