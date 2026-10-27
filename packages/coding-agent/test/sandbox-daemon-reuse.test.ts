import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";

it.skipIf(process.platform !== "linux")(
	"attaches two agents without restarting a legacy daemon or claiming ownership",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "grip-reuse-daemon-"));
		const workspace = join(root, "project's files");
		const home = join(root, "home");
		const cache = join(home, ".cache/grip");
		await mkdir(workspace);
		const project = join(workspace, "nested", "project");
		await mkdir(project, { recursive: true });
		await mkdir(cache, { recursive: true });
		const fixture = join(root, "daemon.cjs");
		await writeFile(fixture, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
		const token = Buffer.alloc(32, 7).toString("base64");
		const child = spawn(process.execPath, [fixture, "--daemon", "--daemon-port", "8787", "--daemon-cwd", workspace], {
			env: { ...process.env, GRIP_DAEMON_TOKEN: token },
			stdio: ["ignore", "pipe", "inherit"],
		});
		const closed = once(child, "exit");
		try {
			await once(child.stdout!, "data");
			const pidFile = join(cache, "sandbox-daemon-8787.pid");
			await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
			const scripts: string[] = [];
			const runner: SandboxRunner = {
				async run(_command, args): Promise<SandboxCommandResult> {
					if (args[0] === "list") {
						return {
							exitCode: 0,
							stderr: "",
							stdout: JSON.stringify({
								name: "reuse-test",
								status: "Running",
								config: {
									mounts: [{ location: workspace, mountPoint: workspace, writable: true }],
									portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
								},
							}),
						};
					}
					expect(args[0]).toBe("shell");
					const script = args.at(-1)!;
					scripts.push(script);
					// No installer, binary replacement, or daemon launch is allowed during attachment.
					expect(script).not.toContain("nohup");
					expect(script).not.toContain("curl");
					const result = spawnSync("sh", ["-c", script], {
						env: { ...process.env, HOME: home },
						encoding: "utf8",
					});
					return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
				},
			};
			for (const [sessionId, selectedRoot] of [
				["first", workspace],
				["second", project],
			] as const) {
				const service = new LimaSandboxService({
					runner,
					env: { GRIP_SANDBOX_WORKSPACE_MOUNT: workspace },
					readinessWaiter: async () => {},
				});
				await expect(
					service.start({ name: "reuse-test", workspaceRoot: selectedRoot, sessionId }),
				).resolves.toMatchObject({ token, workspaceMountPath: selectedRoot });
				const beforeCleanup = scripts.length;
				await service.stopManagedInstances();
				expect(scripts).toHaveLength(beforeCleanup);
				expect(await readFile(pidFile, "utf8")).toBe(`${child.pid}\n`);
				expect(() => process.kill(child.pid!, 0)).not.toThrow();
			}

			const probe = scripts.find((script) => script.includes("GRIP_SANDBOX_ABSENT"))!;
			const runProbe = (script = probe) =>
				spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });
			expect(
				runProbe(
					probe.replace(`expected_root='${workspace.replaceAll("'", `'"'"'`)}'`, "expected_root='/different'"),
				),
			).toMatchObject({ status: 32, stdout: "" });
			await writeFile(pidFile, "invalid\n");
			expect(runProbe()).toMatchObject({ status: 31, stdout: "" });
			await rm(pidFile);
			await symlink(fixture, pidFile);
			expect(runProbe()).toMatchObject({ status: 31, stdout: "" });
			await rm(pidFile);
			expect(runProbe()).toMatchObject({ status: 0, stdout: "GRIP_SANDBOX_ABSENT\n" });
		} finally {
			child.kill();
			await closed;
			await rm(root, { recursive: true, force: true });
		}
	},
);
