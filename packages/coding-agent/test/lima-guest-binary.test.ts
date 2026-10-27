import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { acquireSharedLimaOwnerLock } from "../src/core/remote-workspace-protocol/lima-owner-lock.ts";
import type { SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";
import { inspectLocalGuestBinary, installLocalGuestBinary } from "../src/core/sandbox/lima-guest-binary.ts";

class Runner implements SandboxRunner {
	readonly calls: string[][] = [];
	results: SandboxCommandResult[] = [];
	async run(_binary: string, args: string[]): Promise<SandboxCommandResult> {
		this.calls.push(args);
		return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
	}
}

async function withBinary(action: (path: string) => Promise<void>, machine = 62): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "grip-guest-binary-test-"));
	try {
		const file = join(root, "grip-linux");
		const header = Buffer.alloc(20);
		Buffer.from("7f454c46", "hex").copy(header);
		header[4] = 2;
		header[5] = 1;
		header.writeUInt16LE(machine, 18);
		await writeFile(file, header);
		await action(file);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

it("rejects a host executable before any Lima mutation", async () => {
	const runner = new Runner();
	await withBinary(async (path) => {
		await writeFile(path, "macOS or JS CLI");
		const service = new LimaSandboxService({ runner, env: { GRIP_SANDBOX_GUEST_BINARY: path } });
		await expect(service.start({ workspaceRoot: "/host/project" })).rejects.toThrow("Linux guest binary");
		expect(runner.calls).toHaveLength(0);
	});
});

it("copies a checked Linux executable and rechecks daemon state before atomic replacement", async () => {
	await withBinary(async (path) => {
		const binary = await inspectLocalGuestBinary(path);
		expect(binary.arch).toBe("x86_64");
		const runner = new Runner();
		await installLocalGuestBinary(runner, "limactl", "dev", binary, VERSION);
		expect(runner.calls.map((args) => args[0])).toEqual(["shell", "shell", "copy", "shell", "shell"]);
		const copy = runner.calls[2];
		expect(copy?.[1]).toBe(binary.path);
		expect(copy?.[2]).toMatch(/^dev:\/tmp\/grip-guest-[a-f0-9]{24}\/grip$/);
		const probe = runner.calls[0]?.at(-1) ?? "";
		expect(probe).toContain("uname -m");
		expect(probe).toContain("/proc/[0-9]*");
		const install = runner.calls[3]?.at(-1) ?? "";
		expect(install).toContain(binary.sha256);
		expect(install).toContain("daemon-mode.lock");
		expect(install).toContain('mv -f "$tmp" "$target"');
		for (const call of runner.calls.filter((args) => args[0] === "shell")) {
			const script = call.at(-1) ?? "";
			const parsed = spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" });
			expect(parsed.status, parsed.stderr).toBe(0);
		}
	});
});

it("refuses copy if daemon state or guest architecture is uncertain", async () => {
	await withBinary(async (path) => {
		const runner = new Runner();
		runner.results = [{ exitCode: 41, stdout: "", stderr: "" }];
		await expect(
			installLocalGuestBinary(runner, "limactl", "dev", await inspectLocalGuestBinary(path), VERSION),
		).rejects.toThrow("not copied");
		expect(runner.calls).toHaveLength(1);
	});
});

it("reuses a byte-identical installed guest binary without copying over a running daemon", async () => {
	await withBinary(async (path) => {
		const binary = await inspectLocalGuestBinary(path);
		const runner = new Runner();
		runner.results = [{ exitCode: 0, stdout: "GRIP_GUEST_BINARY_MATCH\n", stderr: "" }];
		await installLocalGuestBinary(runner, "limactl", "dev", binary, VERSION);
		expect(runner.calls).toHaveLength(1);
		const probe = runner.calls[0]?.at(-1) ?? "";
		expect(probe).toContain(binary.sha256);
		expect(probe).toContain("/proc/[0-9]*");
		expect(probe).toContain('test ! -L "$target"');
		expect(spawnSync("sh", ["-n", "-c", probe]).status).toBe(0);
	});
});

it("refuses replacement when copy fails and leaves the target untouched", async () => {
	await withBinary(async (path) => {
		const runner = new Runner();
		runner.results = [
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 1, stdout: "", stderr: "" },
		];
		await expect(
			installLocalGuestBinary(runner, "limactl", "dev", await inspectLocalGuestBinary(path), VERSION),
		).rejects.toThrow("copy failed");
		expect(runner.calls.map((args) => args[0])).toEqual(["shell", "shell", "copy", "shell"]);
	});
});

it("detects Linux ARM64 rather than relying on the macOS host architecture", async () => {
	await withBinary(async (path) => {
		expect((await inspectLocalGuestBinary(path)).arch).toBe("aarch64");
	}, 183);
});

it("uses the local binary on an existing named legacy VM before launching its daemon", async () => {
	await withBinary(async (path) => {
		const workspaceRoot = join(dirname(path), "workspace");
		await mkdir(workspaceRoot);
		const runner = new Runner();
		runner.run = async (_binary, args) => {
			runner.calls.push(args);
			if (args[0] === "list") {
				return {
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify({
						name: "dev-binary-test",
						status: "Running",
						config: {
							mounts: [{ location: workspaceRoot, mountPoint: "/workspace", writable: true }],
							portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
						},
					}),
				};
			}
			if (args.at(-1)?.includes("GRIP_SANDBOX_ABSENT")) {
				return { exitCode: 0, stdout: "GRIP_SANDBOX_ABSENT\n", stderr: "" };
			}
			return {
				exitCode: 0,
				stderr: "",
				stdout: args.at(-1)?.includes("GRIP_LEGACY_GUEST")
					? "GRIP_LEGACY_GUEST\n"
					: args.at(-1)?.includes("GRIP_SANDBOX_TOKEN=%s")
						? "GRIP_SANDBOX_TOKEN=dev-token\n"
						: "",
			};
		};
		const service = new LimaSandboxService({
			runner,
			env: { GRIP_SANDBOX_GUEST_BINARY: path },
			readinessWaiter: async () => {},
		});
		await expect(service.start({ workspaceRoot, name: "dev-binary-test" })).resolves.toMatchObject({
			token: "dev-token",
		});
		const copyIndex = runner.calls.findIndex((args) => args[0] === "copy");
		const launchIndex = runner.calls.findIndex((args) => args.at(-1)?.includes("nohup env GRIP_DAEMON_TOKEN="));
		expect(copyIndex).toBeGreaterThan(0);
		expect(launchIndex).toBeGreaterThan(copyIndex);
		expect(runner.calls[launchIndex]?.at(-1)).toContain("$HOME/.local/bin/grip");
	});
});

it("reuses a matching guest binary on direct shared attachment without copying it", async () => {
	await withBinary(async (path) => {
		const root = await mkdtemp(join(tmpdir(), "grip-guest-shared-test-"));
		try {
			const owner = await acquireSharedLimaOwnerLock("dev-binary-shared", root);
			try {
				const runner = new Runner();
				runner.run = async (_binary, args) => {
					runner.calls.push(args);
					if (args[0] === "list")
						return {
							exitCode: 0,
							stderr: "",
							stdout: JSON.stringify({
								name: "dev-binary-shared",
								status: "Running",
								config: {
									mounts: [{ location: root, mountPoint: "/workspace", writable: true }],
									portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
								},
							}),
						};
					const script = args.at(-1) ?? "";
					if (script === '"$HOME/.local/bin/grip" --version')
						return { exitCode: 0, stderr: "", stdout: `${VERSION}\n` };
					return {
						exitCode: 0,
						stderr: "",
						stdout: script.includes("GRIP_SHARED_TOKEN=%s")
							? `GRIP_SHARED_TOKEN=${Buffer.alloc(32, 5).toString("base64")}\n`
							: "",
					};
				};
				const service = new LimaSandboxService({
					runner,
					env: { GRIP_SANDBOX_GUEST_BINARY: path },
					readinessWaiter: async () => {},
				});
				await expect(
					service.ensureSharedDaemon(
						{ instanceName: "dev-binary-shared", hostParent: root, hostRoot: root },
						owner,
					),
				).resolves.toBe(Buffer.alloc(32, 5).toString("base64"));
				const copyIndex = runner.calls.findIndex((args) => args[0] === "copy");
				const versionIndex = runner.calls.findIndex((args) => args.at(-1) === '"$HOME/.local/bin/grip" --version');
				expect(copyIndex).toBe(-1);
				expect(versionIndex).toBeGreaterThan(0);
			} finally {
				await owner.release();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

it.skipIf(process.platform !== "linux")(
	"clears only verified stale guest PID markers under the install lock",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "grip-stale-guest-pid-"));
		try {
			const home = join(root, "home");
			const cache = join(home, ".cache/grip");
			await mkdir(cache, { recursive: true });
			const procRoot = join(root, "proc");
			await mkdir(join(procRoot, "1"), { recursive: true });
			await writeFile(join(procRoot, "1/comm"), "init\n");
			const marker = join(cache, "sandbox-daemon-8787.pid");
			const log = join(cache, "sandbox-daemon-8787.log");
			await writeFile(marker, "99999999\n", { mode: 0o600 });
			await writeFile(log, "keep this log\n");
			const binary = join(root, "grip");
			const bytes = Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${VERSION}'\n`);
			await writeFile(binary, bytes, { mode: 0o700 });
			const runner = new Runner();
			runner.run = async (_command, args) => {
				runner.calls.push(args);
				if (args[0] === "copy") {
					await copyFile(binary, (args[2] ?? "").replace(/^dev:/, ""));
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				const script = join(root, "guest-script.sh");
				await writeFile(script, (args.at(-1) ?? "").replaceAll("/proc", procRoot));
				const run = spawnSync("sh", [script], {
					encoding: "utf8",
					env: { ...process.env, HOME: home },
				});
				return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
			};
			await installLocalGuestBinary(
				runner,
				"limactl",
				"dev",
				{
					path: binary,
					arch: process.arch === "arm64" ? "aarch64" : "x86_64",
					sha256: createHash("sha256").update(bytes).digest("hex"),
				},
				VERSION,
			);
			expect(existsSync(marker)).toBe(false);
			expect(await readFile(log, "utf8")).toBe("keep this log\n");
			expect(await readFile(join(home, ".local/bin/grip"))).toEqual(bytes);
			expect(runner.calls.map((args) => args[0])).toEqual(["shell", "shell", "copy", "shell", "shell"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it.skipIf(process.platform !== "linux")(
	"refuses live, malformed, and symlinked guest PID markers before copying",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "grip-unsafe-guest-pid-"));
		try {
			const home = join(root, "home");
			const cache = join(home, ".cache/grip");
			await mkdir(cache, { recursive: true });
			const procRoot = join(root, "proc");
			await mkdir(join(procRoot, "1"), { recursive: true });
			await writeFile(join(procRoot, "1/comm"), "init\n");
			const marker = join(cache, "sandbox-daemon-8787.pid");
			const runner = new Runner();
			runner.run = async (_command, args) => {
				runner.calls.push(args);
				const script = join(root, "guest-script.sh");
				await writeFile(script, (args.at(-1) ?? "").replaceAll("/proc", procRoot));
				const run = spawnSync("sh", [script], {
					encoding: "utf8",
					env: { ...process.env, HOME: home },
				});
				return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
			};
			for (const value of ["1", "unknown"]) {
				await writeFile(marker, value, { mode: 0o600 });
				await expect(
					installLocalGuestBinary(
						runner,
						"limactl",
						"dev",
						{ path: "unused", arch: process.arch === "arm64" ? "aarch64" : "x86_64", sha256: "unused" },
						VERSION,
					),
				).rejects.toThrow("not copied");
				expect(await readFile(marker, "utf8")).toBe(value);
				await rm(marker);
			}
			const target = join(root, "target");
			await writeFile(target, "99999999\n");
			await symlink(target, marker);
			await expect(
				installLocalGuestBinary(
					runner,
					"limactl",
					"dev",
					{ path: "unused", arch: process.arch === "arm64" ? "aarch64" : "x86_64", sha256: "unused" },
					VERSION,
				),
			).rejects.toThrow("not copied");
			expect(await readFile(target, "utf8")).toBe("99999999\n");
			expect(runner.calls.every((args) => args[0] === "shell")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
it.skipIf(process.platform !== "linux")("does not copy over a live Grip-named process", async () => {
	await withBinary(async (path) => {
		const root = await mkdtemp(join(tmpdir(), "grip-running-guest-"));
		const executable = join(root, "grip");
		try {
			await copyFile("/bin/sh", executable);
			await chmod(executable, 0o700);
			const child = spawn(executable, ["-c", "read x"], { stdio: ["pipe", "ignore", "ignore"] });
			try {
				await new Promise<void>((resolve, reject) => {
					child.once("spawn", resolve);
					child.once("error", reject);
				});
				const runner = new Runner();
				runner.run = async (_binary, args) => {
					runner.calls.push(args);
					if (args[0] === "copy") throw new Error("must not copy");
					const run = spawnSync("sh", ["-lc", args.at(-1) ?? ""], { encoding: "utf8" });
					return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
				};
				await expect(
					installLocalGuestBinary(runner, "limactl", "dev", await inspectLocalGuestBinary(path), VERSION),
				).rejects.toThrow("not copied");
				expect(runner.calls).toHaveLength(1);
			} finally {
				child.kill();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
