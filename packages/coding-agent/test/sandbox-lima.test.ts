import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireSharedLimaOwnerLock } from "../src/core/remote-workspace-protocol/lima-owner-lock.ts";
import type { SandboxCommandOptions, SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";

interface RunnerCall {
	command: string;
	args: string[];
	options?: SandboxCommandOptions;
}

class FakeLimaRunner implements SandboxRunner {
	readonly calls: RunnerCall[] = [];
	private readonly results: SandboxCommandResult[];
	private readonly modeProbeResult: SandboxCommandResult;

	constructor(results: SandboxCommandResult[], modeProbeResult = ok("GRIP_LEGACY_GUEST\n")) {
		this.results = [...results];
		this.modeProbeResult = modeProbeResult;
	}

	async run(command: string, args: string[], options?: SandboxCommandOptions): Promise<SandboxCommandResult> {
		this.calls.push({ command, args, options });
		if (args[0] === "shell" && args.at(-1)?.includes("GRIP_LEGACY_GUEST")) return this.modeProbeResult;
		return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
	}
}

function ok(stdout = ""): SandboxCommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

function limaRecord(name: string, status = "Running"): string {
	return JSON.stringify({
		name,
		status,
		arch: "x86_64",
		vmType: "qemu",
		config: {
			mounts: [{ location: "/host/project", mountPoint: "/workspace", writable: true }],
			portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
		},
	});
}

describe("Lima sandbox core", () => {
	it("creates a managed VM with a writable workspace mount and starts the daemon", async () => {
		const runner = new FakeLimaRunner([ok(), ok("/usr/local/bin/grip\n"), ok("GRIP_SANDBOX_TOKEN=vm-token\n")]);
		const service = new LimaSandboxService({
			runner,
			portAllocator: async () => 8787,
			readinessWaiter: async () => {},
		});

		const result = await service.start({ workspaceRoot: "/host/project", sessionId: "session-a" });

		expect(result).toMatchObject({
			workspaceRoot: "/host/project",
			workspaceMountPath: "/workspace",
			daemonUrl: "ws://127.0.0.1:8787/grip/workspace",
			token: "vm-token",
		});
		expect(result.containerName).toMatch(/^grip-sandbox-project-[a-f0-9]{12}-session-p8787-[a-f0-9]{8}$/);
		expect(runner.calls[0]?.args).toEqual(
			expect.arrayContaining(["start", "--name", result.containerName, "--mount-none", "template:docker-rootful"]),
		);
		expect(runner.calls[0]?.args.join(" ")).toContain('"mountPoint":"/workspace"');
		expect(runner.calls[0]?.args.join(" ")).toContain('"location":"/host/project"');
		const daemonScript = runner.calls[2]?.args.at(-1) ?? "";
		expect(daemonScript).toContain("--daemon --daemon-host");
		expect(daemonScript).toContain("--daemon-allow-full-filesystem");
		expect(daemonScript).toContain("&\necho $!");
		expect(daemonScript).not.toContain("&;");
		expect(daemonScript).not.toContain("vm-token");
	});

	it.each(["my-dev", "grip-sandbox-my-dev"])(
		"creates missing named VM %s and preserves it on shutdown",
		async (name) => {
			const runner = new FakeLimaRunner([
				ok("[]"),
				ok(),
				{ exitCode: 1, stdout: "", stderr: "missing grip" },
				ok(),
				ok("GRIP_SANDBOX_TOKEN=named-token\n"),
				ok(limaRecord(name)),
				ok(limaRecord(name)),
				ok(),
			]);
			const service = new LimaSandboxService({
				runner,
				env: { GRIP_SANDBOX_CLEANUP: "remove" },
				portAllocator: async () => 8787,
				readinessWaiter: async () => {},
			});

			const result = await service.start({
				workspaceRoot: "/host/project",
				name,
				limaTemplate: "template:ubuntu",
			});

			expect(result.containerName).toBe(name);
			expect(runner.calls[0]?.args).toEqual(["list", "--json", name]);
			expect(runner.calls[1]?.args).toEqual(
				expect.arrayContaining(["start", "--name", name, "--mount-none", "template:ubuntu"]),
			);
			expect(runner.calls[1]?.args.join(" ")).toContain('"location":"/host/project"');
			expect(runner.calls[1]?.args.join(" ")).toContain('"writable":true');
			expect(runner.calls[3]?.args.at(-1)).toContain("GRIP_VERSION=");
			await service.stopManagedInstances();
			expect(runner.calls.at(-1)?.args.at(-1)).toContain('kill "$pid"');
			expect(runner.calls.some((call) => call.args[0] === "stop" || call.args[0] === "delete")).toBe(false);
		},
	);

	it("creates a named VM when Lima reports an unmatched name", async () => {
		const runner = new FakeLimaRunner([
			{ exitCode: 1, stdout: "", stderr: "instance my-dev not found" },
			ok(),
			ok(),
			ok("GRIP_SANDBOX_TOKEN=named-token\n"),
		]);
		const service = new LimaSandboxService({
			runner,
			portAllocator: async () => 8787,
			readinessWaiter: async () => {},
		});

		await expect(service.start({ workspaceRoot: "/host/project", name: "my-dev" })).resolves.toMatchObject({
			containerName: "my-dev",
		});
		expect(runner.calls[1]?.args).toContain("--name");
	});

	it("does not create a named VM when listing fails", async () => {
		const runner = new FakeLimaRunner([{ exitCode: 1, stdout: "", stderr: "permission denied" }]);
		const service = new LimaSandboxService({ runner });

		await expect(service.start({ workspaceRoot: "/host/project", name: "my-dev" })).rejects.toThrow(
			"permission denied",
		);
		expect(runner.calls).toHaveLength(1);
	});

	it.each([
		["nonmatching", limaRecord("other")],
		["ambiguous", `[${limaRecord("existing")},${limaRecord("other")}]`],
	])("refuses a %s named Lima lookup before mutating any VM", async (_case, listing) => {
		const runner = new FakeLimaRunner([ok(listing)]);
		const service = new LimaSandboxService({ runner });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
			"one exact name",
		);
		expect(runner.calls.map((call) => call.args)).toEqual([["list", "--json", "existing"]]);
	});

	it.each(["Starting", "Stopping", "Unknown", ""])(
		"refuses a named Lima VM with %s status without resuming or launching a daemon",
		async (status) => {
			const runner = new FakeLimaRunner([ok(limaRecord("existing", status))]);
			const service = new LimaSandboxService({ runner });
			await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
				"uncertain state",
			);
			expect(runner.calls.map((call) => call.args)).toEqual([["list", "--json", "existing"]]);
		},
	);

	it.each(["Running", "Stopped"])(
		"reuses a named %s instance only when it already mounts the workspace",
		async (status) => {
			const runner = new FakeLimaRunner([
				ok(limaRecord("existing", status)),
				...(status === "Stopped" ? [ok()] : []),
				ok(), // No shared guest state.
				ok("/usr/bin/grip\n"),
				ok("GRIP_SANDBOX_TOKEN=reused-token\n"),
			]);
			const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });

			const result = await service.start({ workspaceRoot: "/host/project", name: "existing" });

			expect(result.containerName).toBe("existing");
			if (status === "Stopped") expect(runner.calls[1]?.args).toEqual(["start", "--tty=false", "existing"]);
			else expect(runner.calls.some((call) => call.args[0] === "start")).toBe(false);
			expect(runner.calls.some((call) => call.args.includes("--mount-none"))).toBe(false);
		},
	);
	it.each(["Running", "Stopped"])("installs the latest release in an existing %s VM without Grip", async (status) => {
		const runner = new FakeLimaRunner([
			ok(limaRecord("existing", status)),
			...(status === "Stopped" ? [ok()] : []),
			ok(), // No shared guest state.
			{ exitCode: 1, stdout: "", stderr: "grip missing" },
			ok(), // Installer succeeded.
			ok("GRIP_SANDBOX_TOKEN=installed-token\n"),
		]);
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).resolves.toMatchObject({
			containerName: "existing",
			token: "installed-token",
		});
		const scripts = runner.calls.map((call) => call.args.at(-1) ?? "");
		const install = scripts.find((script) =>
			script.includes("raw.githubusercontent.com/greppleai/grip/main/install.sh"),
		);
		expect(install).toContain('sh "$tmp"');
		expect(install).not.toContain("GRIP_VERSION=");
		expect(runner.calls.at(-1)?.args.at(-1)).toContain("--daemon --daemon-host");
	});

	it("does not start a daemon when installing Grip in an existing VM fails", async () => {
		const runner = new FakeLimaRunner([
			ok(limaRecord("existing")),
			ok(),
			{ exitCode: 1, stdout: "", stderr: "grip missing" },
			{ exitCode: 1, stdout: "", stderr: "download failed" },
		]);
		const service = new LimaSandboxService({ runner });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow();
		expect(runner.calls).toHaveLength(5); // Includes the named guest-mode probe.
		expect(runner.calls.some((call) => call.args.at(-1)?.includes("--daemon --daemon-host"))).toBe(false);
	});

	it("installs the local development binary in an existing VM without Grip", async () => {
		const root = await mkdtemp(join(tmpdir(), "grip-existing-dev-"));
		try {
			const binary = join(root, "grip-linux");
			const header = Buffer.alloc(20);
			Buffer.from("7f454c46", "hex").copy(header);
			header[4] = 2;
			header[5] = 1;
			header.writeUInt16LE(62, 18);
			await writeFile(binary, header);
			const runner = new FakeLimaRunner([
				ok(limaRecord("existing")),
				ok(), // No shared guest state.
				ok(), // Architecture and daemon-state probe.
				ok(), // Reserve staging directory.
				ok(), // Copy binary.
				ok(), // Verify and install.
				ok(), // Clean staging directory.
				ok("GRIP_SANDBOX_TOKEN=dev-token\n"),
			]);
			const service = new LimaSandboxService({
				runner,
				env: { GRIP_SANDBOX_GUEST_BINARY: binary },
				readinessWaiter: async () => {},
			});
			await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).resolves.toMatchObject({
				token: "dev-token",
			});
			expect(runner.calls.find((call) => call.args[0] === "copy")?.args[1]).toBe(binary);
			expect(runner.calls.some((call) => call.args.at(-1)?.includes("raw.githubusercontent.com"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each(["Running", "Stopped"])(
		"refuses named %s VM reuse while a shared host owner holds the name",
		async (status) => {
			const owner = await acquireSharedLimaOwnerLock("existing");
			try {
				const runner = new FakeLimaRunner([ok(limaRecord("existing", status))]);
				const service = new LimaSandboxService({ runner });
				await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
					"occupied",
				);
				expect(runner.calls).toHaveLength(0); // Even a stopped VM cannot be resumed.
			} finally {
				await owner.release();
			}
		},
	);
	it.each(["Running", "Stopped"])("refuses legacy reuse of a %s named VM with shared guest state", async (status) => {
		const runner = new FakeLimaRunner([
			ok(limaRecord("existing", status)),
			...(status === "Stopped" ? [ok()] : []),
			{ exitCode: 52, stdout: "secret-must-not-leak", stderr: "secret-must-not-leak" },
		]);
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
			"legacy attach refused; reconcile manually",
		);
		const probe = runner.calls.at(-1)?.args;
		expect(probe?.slice(0, 5)).toEqual(["shell", "--tty=false", "existing", "sh", "-lc"]);
		expect(probe?.at(-1)).toContain(".cache/grip/shared-lima");
		expect(runner.calls.some((call) => call.args.some((arg) => arg.includes("grip --daemon")))).toBe(false);
		expect(runner.calls.some((call) => call.args[0] === "delete" || call.args[0] === "stop")).toBe(false);
	});

	it.each([
		{ probe: { exitCode: 42, stdout: "", stderr: "secret" }, label: "invalid marker" },
		{ probe: ok("unknown mode\n"), label: "unexpected reply" },
	])("refuses a running named VM with $label before legacy startup", async ({ probe }) => {
		const runner = new FakeLimaRunner([ok(limaRecord("existing"))], probe);
		const service = new LimaSandboxService({ runner });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
			"guest daemon mode is uncertain",
		);
		expect(runner.calls.map((call) => call.args[0])).toEqual(["list", "shell"]);
	});

	it("distinguishes shared, absent, and symlinked guest state with a POSIX shell", async () => {
		const runner = new FakeLimaRunner([ok(limaRecord("existing"))], { exitCode: 42, stdout: "", stderr: "" });
		const service = new LimaSandboxService({ runner });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
			"guest daemon mode is uncertain",
		);
		const script = runner.calls[1]?.args.at(-1) ?? "";
		const home = await mkdtemp(join(tmpdir(), "grip-named-mode-probe-"));
		const marker = join(home, ".cache/grip/shared-lima");
		try {
			const run = () => spawnSync("sh", ["-lc", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });
			expect(run()).toMatchObject({ status: 0, stdout: "GRIP_LEGACY_GUEST\n" });
			await mkdir(marker, { recursive: true });
			expect(run()).toMatchObject({ status: 0, stdout: "GRIP_SHARED_GUEST\n" });
			await rm(marker, { recursive: true });
			await symlink(home, marker);
			expect(run().status).not.toBe(0);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("checks the guest-state probe with an actual POSIX shell", async () => {
		const runner = new FakeLimaRunner([ok(limaRecord("existing")), { exitCode: 52, stdout: "", stderr: "" }]);
		const service = new LimaSandboxService({ runner });
		await expect(service.start({ workspaceRoot: "/host/project", name: "existing" })).rejects.toThrow(
			"legacy attach refused",
		);
		const script =
			runner.calls
				.find((call) => call.args.at(-1)?.includes('test ! -e "$HOME/.cache/grip/shared-lima"'))
				?.args.at(-1) ?? "";
		const home = await mkdtemp(join(tmpdir(), "grip-legacy-lima-guest-probe-"));
		try {
			const runProbe = () => spawnSync("sh", ["-lc", script], { env: { ...process.env, HOME: home } }).status;
			expect(runProbe()).toBe(0);
			await mkdir(join(home, ".cache/grip/shared-lima"), { recursive: true });
			expect(runProbe()).not.toBe(0);
			await rm(join(home, ".cache/grip/shared-lima"), { recursive: true });
			await symlink(home, join(home, ".cache/grip/shared-lima"));
			expect(runProbe()).not.toBe(0);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("rechecks the guest mode inside legacy daemon launch before touching a daemon", async () => {
		const runner = new FakeLimaRunner([
			ok(limaRecord("existing")),
			ok(), // Earlier guest-state probe passed.
			ok("/usr/bin/grip\n"),
			ok("GRIP_SANDBOX_TOKEN=placeholder\n"),
		]);
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		await service.start({ workspaceRoot: "/host/project", name: "existing" });
		const script = runner.calls.at(-1)?.args.at(-1) ?? "";
		const home = await mkdtemp(join(tmpdir(), "grip-legacy-mode-lock-"));
		try {
			const cache = join(home, ".cache/grip");
			await mkdir(cache, { recursive: true });
			const run = () => spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home } });
			const lock = join(cache, "daemon-mode.lock");
			await mkdir(lock);
			expect(run().status).not.toBe(0);
			await rm(lock, { recursive: true });
			await mkdir(join(cache, "shared-lima"));
			expect(run().status).not.toBe(0);
			expect(run().stdout.toString()).not.toContain("GRIP_SANDBOX_TOKEN=");
			expect(existsSync(join(cache, "sandbox-daemon-8787.pid"))).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	it("rejects a named instance whose workspace mount does not match", async () => {
		const mismatched = limaRecord("wrong").replace("/host/project", "/host/other");
		const service = new LimaSandboxService({ runner: new FakeLimaRunner([ok(mismatched)]) });

		await expect(service.start({ workspaceRoot: "/host/project", name: "wrong" })).rejects.toThrow(
			"must mount /host/project read-write at /workspace",
		);
	});

	it("lists Lima instances with a matching workspace mount", async () => {
		const runner = new FakeLimaRunner([
			ok(`${limaRecord("matching")}\n${limaRecord("other").replace("/host/project", "/host/other")}\n`),
		]);
		const service = new LimaSandboxService({ runner });

		const instances = await service.list({ workspaceRoot: "/host/project" });

		expect(instances).toHaveLength(1);
		expect(instances[0]).toMatchObject({
			id: "matching",
			name: "matching",
			state: "running",
			workspaceRoot: "/host/project",
			daemonEndpoint: "ws://127.0.0.1:8787/grip/workspace",
		});
		expect(runner.calls[0]?.args).toEqual(["list", "--json"]);
	});

	it("leaves a reused user-owned VM running when stopping its daemon", async () => {
		const runner = new FakeLimaRunner([
			ok(limaRecord("existing")),
			ok(), // No shared guest state.
			ok("/usr/bin/grip\n"),
			ok("GRIP_SANDBOX_TOKEN=reused-token\n"),
			ok(limaRecord("existing")),
			ok(limaRecord("existing")),
			ok(), // Guest shared-state probe under the host lock.
			ok(), // Stop only the legacy daemon; leave the user-owned VM running.
		]);
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		await service.start({ workspaceRoot: "/host/project", name: "existing" });

		await expect(service.stop({ workspaceRoot: "/host/project", target: "existing" })).resolves.toMatchObject({
			status: "stopped",
		});
		expect(runner.calls.at(-1)?.args[0]).toBe("shell");
		expect(runner.calls.some((call) => call.args[0] === "stop" || call.args[0] === "delete")).toBe(false);
	});

	it.each(["Running", "Stopped"])(
		"refuses to stop an untracked %s VM even when its name looks managed",
		async (status) => {
			for (const name of ["grip-sandbox-shared-parent", "user-managed"]) {
				const runner = new FakeLimaRunner([ok(limaRecord(name, status))]);
				const service = new LimaSandboxService({ runner, env: { GRIP_SANDBOX_CLEANUP: "remove" } });
				await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow(
					"ownership is unknown",
				);
				expect(runner.calls.map((call) => call.args)).toEqual([["list", "--json"]]);
			}
		},
	);

	it("stops a session-tracked managed VM without relying on a name prefix", async () => {
		const name = "owned-without-prefix";
		const runner = new FakeLimaRunner([ok(limaRecord(name)), ok(limaRecord(name)), ok(), ok(), ok()]);
		const service = new LimaSandboxService({
			runner,
			env: { GRIP_SANDBOX_CLEANUP: "remove" },
			managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 8787, managed: true }]]),
		});
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).resolves.toMatchObject({
			status: "removed",
		});
		expect(runner.calls.at(-1)?.args).toEqual(["delete", "--force", name]);
	});
	it("refuses to stop a tracked named VM while a shared broker owns it", async () => {
		const name = "tracked-with-shared-owner";
		const owner = await acquireSharedLimaOwnerLock(name);
		try {
			const runner = new FakeLimaRunner([ok(limaRecord(name))]);
			const service = new LimaSandboxService({
				runner,
				managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 8787, managed: true }]]),
			});
			await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow("occupied");
			expect(runner.calls.map((call) => call.args)).toEqual([["list", "--json"]]);
		} finally {
			await owner.release();
		}
	});

	it("refuses to stop a VM whose state changes before reinspection under the owner lock", async () => {
		const name = "tracked-changing-state";
		const runner = new FakeLimaRunner([ok(limaRecord(name)), ok(limaRecord(name, "Stopped"))]);
		const service = new LimaSandboxService({
			runner,
			managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 8787, managed: true }]]),
		});
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow("identity changed");
		expect(runner.calls.map((call) => call.args)).toEqual([
			["list", "--json"],
			["list", "--json"],
		]);
	});

	it("refuses legacy stop when shared guest state is present despite an old in-process record", async () => {
		const name = "tracked-now-shared";
		const runner = new FakeLimaRunner([
			ok(limaRecord(name)),
			ok(limaRecord(name)),
			{ exitCode: 1, stdout: "secret-guest-state", stderr: "secret-guest-state" },
		]);
		const service = new LimaSandboxService({
			runner,
			env: { GRIP_SANDBOX_CLEANUP: "remove" },
			managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 8787, managed: true }]]),
		});
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow(
			"legacy stop refused",
		);
		expect(runner.calls.map((call) => call.args[0])).toEqual(["list", "list", "shell"]);
		expect(runner.calls[2]?.args.at(-1)).toContain("shared-lima");
	});

	it("does not delete a tracked managed VM already stopped outside this process", async () => {
		const name = "tracked-already-stopped";
		const runner = new FakeLimaRunner([ok(limaRecord(name, "Stopped")), ok(limaRecord(name, "Stopped"))]);
		const service = new LimaSandboxService({
			runner,
			env: { GRIP_SANDBOX_CLEANUP: "remove" },
			managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 8787, managed: true }]]),
		});
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow("unverifiable VM");
		expect(runner.calls.map((call) => call.args[0])).toEqual(["list", "list"]);
	});

	it("refuses stop when the tracked daemon port no longer matches the selected VM", async () => {
		const name = "tracked-wrong-port";
		const runner = new FakeLimaRunner([ok(limaRecord(name))]);
		const service = new LimaSandboxService({
			runner,
			managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 9999, managed: true }]]),
		});
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow(
			"daemon port changed",
		);
		expect(runner.calls.map((call) => call.args[0])).toEqual(["list"]);
	});

	it.each(["initial", "locked"])("refuses %s duplicate named VM records during stop", async (phase) => {
		const name = "tracked-ambiguous";
		const single = limaRecord(name);
		const duplicate = JSON.stringify([JSON.parse(single), JSON.parse(single)]);
		const runner = new FakeLimaRunner([
			ok(phase === "initial" ? duplicate : single),
			...(phase === "locked" ? [ok(duplicate)] : []),
		]);
		const service = new LimaSandboxService({
			runner,
			managedInstances: new Map([[name, { workspaceRoot: "/host/project", daemonPort: 8787, managed: true }]]),
		});
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow(
			phase === "initial" ? "ambiguous" : "identity changed",
		);
		expect(runner.calls.map((call) => call.args[0])).toEqual(phase === "initial" ? ["list"] : ["list", "list"]);
	});

	it("does not track a named VM as stoppable when daemon readiness is uncertain", async () => {
		const name = "not-ready-named";
		const runner = new FakeLimaRunner([
			ok(limaRecord(name)), // Exact named instance lookup.
			ok(), // Guest shared-state probe.
			ok("/usr/bin/grip\n"),
			ok("GRIP_SANDBOX_TOKEN=not-ready-token\n"),
			ok(limaRecord(name)), // Subsequent stop lookup.
		]);
		const tracked = new Map<string, { workspaceRoot: string; daemonPort: number; managed: boolean }>();
		const service = new LimaSandboxService({
			runner,
			managedInstances: tracked,
			readinessWaiter: async () => {
				throw new Error("readiness uncertain");
			},
		});
		await expect(service.start({ workspaceRoot: "/host/project", name })).rejects.toThrow("readiness uncertain");
		expect(tracked.size).toBe(0);
		await expect(service.stop({ workspaceRoot: "/host/project", target: name })).rejects.toThrow(
			"ownership is unknown",
		);
		expect(runner.calls.map((call) => call.args[0])).toEqual(["list", "shell", "shell", "shell", "shell", "list"]);
	});

	it("leaves a newly created named VM for inspection when provisioning fails", async () => {
		const runner = new FakeLimaRunner([
			ok("[]"),
			ok(),
			{ exitCode: 1, stdout: "", stderr: "missing grip" },
			{ exitCode: 1, stdout: "", stderr: "install failed" },
			ok(),
		]);
		const service = new LimaSandboxService({
			runner,
			portAllocator: async () => 8787,
			readinessWaiter: async () => {},
		});

		await expect(service.start({ workspaceRoot: "/host/project", name: "my-dev" })).rejects.toThrow("install failed");
		expect(runner.calls.some((call) => call.args[0] === "delete")).toBe(false);
	});

	it("reports provisioning failures without exposing daemon tokens", async () => {
		const runner = new FakeLimaRunner([
			ok(),
			{ exitCode: 1, stdout: "", stderr: "missing" },
			{ exitCode: 1, stdout: "", stderr: "install failed" },
			ok(),
		]);
		const service = new LimaSandboxService({
			runner,
			portAllocator: async () => 8787,
			readinessWaiter: vi.fn(),
		});

		await expect(service.start({ workspaceRoot: "/host/project" })).rejects.toThrow("Lima command failed");
	});
});
