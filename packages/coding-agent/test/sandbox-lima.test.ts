import { describe, expect, it, vi } from "vitest";
import type { DockerCommandOptions, DockerCommandResult, DockerRunner } from "../src/core/sandbox/docker.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";

interface RunnerCall {
	command: string;
	args: string[];
	options?: DockerCommandOptions;
}

class FakeLimaRunner implements DockerRunner {
	readonly calls: RunnerCall[] = [];
	private readonly results: DockerCommandResult[];

	constructor(results: DockerCommandResult[]) {
		this.results = [...results];
	}

	async run(command: string, args: string[], options?: DockerCommandOptions): Promise<DockerCommandResult> {
		this.calls.push({ command, args, options });
		return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
	}
}

function ok(stdout = ""): DockerCommandResult {
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

		const result = await service.start({ workspaceRoot: "/host/project", sessionId: "session-a", runtime: "lima" });

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
		expect(daemonScript).toContain("grip --daemon");
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
				runtime: "lima",
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
			expect(runner.calls[3]?.args.at(-1)).toContain("sudo npm install -g");
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

		await expect(
			service.start({ workspaceRoot: "/host/project", runtime: "lima", name: "my-dev" }),
		).resolves.toMatchObject({
			containerName: "my-dev",
		});
		expect(runner.calls[1]?.args).toContain("--name");
	});

	it("does not create a named VM when listing fails", async () => {
		const runner = new FakeLimaRunner([{ exitCode: 1, stdout: "", stderr: "permission denied" }]);
		const service = new LimaSandboxService({ runner });

		await expect(service.start({ workspaceRoot: "/host/project", runtime: "lima", name: "my-dev" })).rejects.toThrow(
			"permission denied",
		);
		expect(runner.calls).toHaveLength(1);
	});

	it.each(["Running", "Stopped"])(
		"reuses a named %s instance only when it already mounts the workspace",
		async (status) => {
			const runner = new FakeLimaRunner([
				ok(limaRecord("existing", status)),
				...(status === "Stopped" ? [ok()] : []),
				ok("/usr/bin/grip\n"),
				ok("GRIP_SANDBOX_TOKEN=reused-token\n"),
			]);
			const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });

			const result = await service.start({ workspaceRoot: "/host/project", runtime: "lima", name: "existing" });

			expect(result.containerName).toBe("existing");
			if (status === "Stopped") expect(runner.calls[1]?.args).toEqual(["start", "--tty=false", "existing"]);
			else expect(runner.calls.some((call) => call.args[0] === "start")).toBe(false);
			expect(runner.calls.some((call) => call.args.includes("--mount-none"))).toBe(false);
		},
	);

	it("rejects a named instance whose workspace mount does not match", async () => {
		const mismatched = limaRecord("wrong").replace("/host/project", "/host/other");
		const service = new LimaSandboxService({ runner: new FakeLimaRunner([ok(mismatched)]) });

		await expect(service.start({ workspaceRoot: "/host/project", runtime: "lima", name: "wrong" })).rejects.toThrow(
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
			ok("/usr/bin/grip\n"),
			ok("GRIP_SANDBOX_TOKEN=reused-token\n"),
			ok(limaRecord("existing")),
			ok(),
		]);
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		await service.start({ workspaceRoot: "/host/project", runtime: "lima", name: "existing" });

		await expect(service.stop({ workspaceRoot: "/host/project", target: "existing" })).resolves.toMatchObject({
			status: "stopped",
		});
		expect(runner.calls.at(-1)?.args[0]).toBe("shell");
		expect(runner.calls.some((call) => call.args[0] === "stop" || call.args[0] === "delete")).toBe(false);
	});

	it("cleans up a newly created named VM when provisioning fails", async () => {
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

		await expect(service.start({ workspaceRoot: "/host/project", runtime: "lima", name: "my-dev" })).rejects.toThrow(
			"install failed",
		);
		expect(runner.calls.at(-1)?.args).toEqual(["delete", "--force", "my-dev"]);
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

		await expect(service.start({ workspaceRoot: "/host/project", runtime: "lima" })).rejects.toThrow(
			"Lima command failed",
		);
	});
});
