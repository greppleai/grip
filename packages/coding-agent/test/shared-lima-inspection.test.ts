import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";

function record(hostParent: string) {
	return {
		name: "shared-test",
		status: "Running",
		config: {
			mounts: [{ location: hostParent, mountPoint: "/workspace", writable: true }],
			portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
		},
	};
}

class ReadOnlyRunner implements SandboxRunner {
	readonly calls: string[][] = [];
	response: unknown;
	constructor(response: unknown) {
		this.response = response;
	}
	async run(_binary: string, args: string[]): Promise<SandboxCommandResult> {
		this.calls.push(args);
		if (args[0] !== "list") throw new Error("Inspection must not mutate the VM or daemon");
		return { exitCode: 0, stdout: JSON.stringify(this.response), stderr: "" };
	}
}

it("inspects a single fixed writable mount and stable loopback forward for parent and post-start child", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-lima-inspect-"));
	try {
		const parent = join(base, "workspace");
		await mkdir(parent);
		const runner = new ReadOnlyRunner(record(parent));
		const service = new LimaSandboxService({ runner });
		const options = { instanceName: "shared-test", hostParent: parent, hostRoot: parent };
		const first = await service.inspectSharedInstance(options);
		expect(first).toMatchObject({
			hostParent: parent,
			guestParent: "/workspace",
			guestRoot: "/workspace",
			daemonUrl: "ws://127.0.0.1:8787/grip/workspace",
		});
		const child = join(parent, "later-child");
		await mkdir(child);
		const second = await service.inspectSharedInstance({ ...options, hostRoot: child });
		expect(second).toMatchObject({
			hostParent: parent,
			hostRoot: child,
			guestRoot: "/workspace/later-child",
			daemonUrl: first.daemonUrl,
		});
		expect((await service.inspectSharedInstance({ ...options, hostRoot: child })).guestRoot).toBe(second.guestRoot);
		expect(runner.calls).toEqual(Array.from({ length: 3 }, () => ["list", "--json", "shared-test"]));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

it("fails closed on absent, wrong, stopped, read-only or mismatched VM mounts and forwards", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-lima-inspect-reject-"));
	try {
		const parent = join(base, "workspace");
		const different = join(base, "different");
		await Promise.all([mkdir(parent), mkdir(different)]);
		const runner = new ReadOnlyRunner(record(parent));
		const service = new LimaSandboxService({ runner });
		const options = { instanceName: "shared-test", hostParent: parent, hostRoot: parent };
		runner.response = [];
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("exact name");
		const wrongName = record(parent);
		wrongName.name = "shared-test-extra";
		runner.response = wrongName;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("exact name");
		const stopped = record(parent);
		stopped.status = "Stopped";
		runner.response = stopped;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("not running");
		const readOnly = record(parent);
		readOnly.config.mounts[0].writable = false;
		runner.response = readOnly;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("writable fixed parent mount");
		const wrongMount = record(different);
		runner.response = wrongMount;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("different host parent");
		const wrongGuestMount = record(parent);
		wrongGuestMount.config.mounts[0].mountPoint = "/different";
		runner.response = wrongGuestMount;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("writable fixed parent mount");
		const wrongForward = record(parent);
		wrongForward.config.portForwards[0].hostIP = "0.0.0.0";
		runner.response = wrongForward;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("loopback daemon forward");
		const wrongPort = record(parent);
		wrongPort.config.portForwards[0].hostPort = 9999;
		runner.response = wrongPort;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("loopback daemon forward");
		const duplicateForward = record(parent);
		duplicateForward.config.portForwards.push({ ...duplicateForward.config.portForwards[0] });
		runner.response = duplicateForward;
		await expect(service.inspectSharedInstance(options)).rejects.toThrow("loopback daemon forward");
		await expect(service.inspectSharedInstance({ ...options, instanceName: "../shared-test" })).rejects.toThrow(
			"Invalid shared Lima instance name",
		);
		expect(runner.calls.every((args) => args[0] === "list")).toBe(true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
