import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import type { SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";
import { createRemoteToolOperations } from "../src/core/tools/operations.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

it("attaches two TUI workspaces to the same running shared guest without a host broker", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-direct-shared-"));
	const child = join(parent, "child");
	const other = join(parent, "other");
	await mkdir(child);
	await mkdir(other);
	await writeFile(join(child, "one.txt"), "one");
	await writeFile(join(other, "two.txt"), "two");
	const token = Buffer.alloc(32, 5).toString("base64");
	const parsed = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-allow-root",
			"--daemon-allow-process-exec",
			"--daemon-cwd",
			parent,
			"--daemon-shared-parent",
			parent,
		],
		{ GRIP_DAEMON_TOKEN: token },
		parent,
	);
	const daemon = createDaemonServer({ ...parsed.configuration!, port: 0, token });
	try {
		const { url } = await daemon.listen();
		const port = Number(new URL(url).port);
		const name = "direct-shared-tui-test";
		const record = JSON.stringify({
			name,
			status: "Running",
			config: {
				mounts: [{ location: parent, mountPoint: parent, writable: true }],
				portForwards: [{ guestPort: port, hostPort: port, hostIP: "127.0.0.1" }],
			},
		});
		const calls: string[][] = [];
		const runner: SandboxRunner = {
			async run(_binary, args): Promise<SandboxCommandResult> {
				calls.push(args);
				if (args[0] === "list") return { exitCode: 0, stdout: record, stderr: "" };
				const script = args.at(-1) ?? "";
				if (script.includes('printf "GRIP_SHARED_GUEST'))
					return { exitCode: 0, stdout: "GRIP_SHARED_GUEST\n", stderr: "" };
				if (script === "grip --version") return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
				if (script.includes("GRIP_SHARED_TOKEN=%s"))
					return { exitCode: 0, stdout: `GRIP_SHARED_TOKEN=${token}\n`, stderr: "" };
				return { exitCode: 1, stdout: "", stderr: "" };
			},
		};
		const service = new LimaSandboxService({
			runner,
			env: { GRIP_SANDBOX_DAEMON_PORT: String(port), GRIP_SANDBOX_WORKSPACE_MOUNT: parent },
			readinessWaiter: async () => {},
		});
		const [firstResult, secondResult] = [
			await service.start({ workspaceRoot: child, name }),
			await service.start({ workspaceRoot: other, name }),
		];
		expect(firstResult.daemonUrl).toContain("grip+ws:");
		expect(secondResult.daemonUrl).toContain("grip+ws:");
		expect(calls.some((args) => args[0] === "copy" || args[0] === "start")).toBe(false);
		const first = await createRemoteToolOperations(firstResult.daemonUrl, { token: firstResult.token });
		const second = await createRemoteToolOperations(secondResult.daemonUrl, { token: secondResult.token });
		try {
			expect(first.cwd).toBe(child);
			expect(second.cwd).toBe(other);
			expect(await first.readdir(child)).toContain("one.txt");
			expect(await second.readdir(other)).toContain("two.txt");
			await expect(first.readdir(other)).rejects.toThrow();
			await first.dispose();
			expect(await second.readdir(other)).toContain("two.txt");
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	} finally {
		await daemon.forceClose();
		await rm(parent, { recursive: true, force: true });
	}
});
