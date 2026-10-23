import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { acquireSharedLimaOwnerLock } from "../src/core/remote-workspace-protocol/lima-owner-lock.ts";
import type { SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";

const secret = Buffer.alloc(32, 5).toString("base64");
type GuestShellResult = { code: number; stdout: string };

class DaemonRunner implements SandboxRunner {
	readonly calls: string[][] = [];
	version = VERSION;
	failDaemon = false;
	readonly parent: string;
	constructor(parent: string) {
		this.parent = parent;
	}
	async run(_binary: string, args: string[]): Promise<SandboxCommandResult> {
		this.calls.push(args);
		if (args[0] === "list") {
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					name: "shared-test",
					status: "Running",
					config: {
						mounts: [{ location: this.parent, mountPoint: "/workspace", writable: true }],
						portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
					},
				}),
				stderr: "",
			};
		}
		if (args.at(-1) === "grip --version") return { exitCode: 0, stdout: `${this.version}\n`, stderr: "" };
		if (this.failDaemon) return { exitCode: 1, stdout: `GRIP_SHARED_TOKEN=${secret}\n`, stderr: secret };
		return { exitCode: 0, stdout: `GRIP_SHARED_TOKEN=${secret}\n`, stderr: "" };
	}
}

/** Fake the user service manager, not the daemon's PID or /proc identity checks. */
async function installFakeSystemd(bin: string): Promise<void> {
	const run = join(bin, "systemd-run");
	const ctl = join(bin, "systemctl");
	const login = join(bin, "loginctl");
	await writeFile(
		run,
		'#!/bin/sh\nwhile test "$#" -gt 0; do if test "$1" = "--"; then shift; break; fi; shift; done\nnohup "$@" >/dev/null 2>&1 </dev/null &\nprintf "%s" "$!" >"$FAKE_UNIT_PID"\n',
	);
	await writeFile(
		ctl,
		'#!/bin/sh\nif test "$2" = show-environment; then exit 0; elif test "$2" = show; then cat "$FAKE_UNIT_PID"; elif test "$2" = is-active; then kill -0 "$(cat "$FAKE_UNIT_PID")"; else exit 1; fi\n',
	);
	await writeFile(login, '#!/bin/sh\nprintf "yes\\n"\n');
	await Promise.all([chmod(run, 0o700), chmod(ctl, 0o700), chmod(login, 0o700)]);
}
it("checks the installed version, uses private persistent PID/token files and waits for readiness", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-shared-daemon-"));
	try {
		const parent = join(base, "workspace");
		await mkdir(parent);
		const owner = await acquireSharedLimaOwnerLock("shared-test", base);
		try {
			const runner = new DaemonRunner(parent);
			const ready = vi.fn(async () => {});
			const service = new LimaSandboxService({ runner, readinessWaiter: ready });
			const options = { instanceName: "shared-test", hostParent: parent, hostRoot: parent };
			expect(await service.ensureSharedDaemon(options, owner)).toBe(secret);
			expect(ready).toHaveBeenCalledWith("127.0.0.1", 8787);
			const script = runner.calls.at(-1)?.at(-1) ?? "";
			expect(script).toContain("umask 077");
			expect(script).toContain('if ($1 == "Z" || $1 == "X") exit 1');
			const statParser = script.match(/awk '([^']+)' "\/proc\/\$pid\/stat"/)?.[1];
			expect(statParser).toBeDefined();
			const statFile = join(base, "guest-proc-stat");
			const fields = ["S", ...Array(18).fill("0"), "4711"];
			await writeFile(statFile, `123 (grip worker) ${fields.join(" ")}\n`);
			const living = spawnSync("awk", [statParser ?? "", statFile], { encoding: "utf8" });
			expect(living.status).toBe(0);
			expect(living.stdout.trim()).toBe("4711");
			fields[0] = "Z";
			await writeFile(statFile, `123 (grip worker) ${fields.join(" ")}\n`);
			expect(spawnSync("awk", [statParser ?? "", statFile], { encoding: "utf8" }).status).toBe(1);
			expect(script).toContain('chmod 600 "$token_file"');
			expect(script).toContain('kill -0 "$pid"');
			expect(script).toContain("systemd-run --user");
			expect(script).toContain("--property=Restart=no");
			expect(script).toContain("\"$grip_bin\" '/workspace'");
			expect(script).toContain('--daemon-cwd "$2" --daemon-shared-parent "$2"');
			expect(script).toContain("--daemon-allow-full-filesystem");
			expect(script).not.toContain('kill "$pid"');
			expect(script).not.toContain(secret);
			expect(await service.ensureSharedDaemon(options, owner)).toBe(secret);
			expect(runner.calls.every((args) => args[0] === "list" || args[0] === "shell")).toBe(true);
			runner.version = "0.0.0-wrong";
			await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("version mismatch");
			runner.version = VERSION;
			runner.failDaemon = true;
			await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
		} finally {
			await owner.release();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

it("refuses to return a daemon credential if VM ownership is lost during readiness", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-shared-daemon-lost-owner-"));
	try {
		const parent = join(base, "workspace");
		await mkdir(parent);
		const owner = await acquireSharedLimaOwnerLock("shared-test", base);
		try {
			const runner = new DaemonRunner(parent);
			const service = new LimaSandboxService({
				runner,
				readinessWaiter: async () => {
					await owner.release();
				},
			});
			await expect(
				service.ensureSharedDaemon({ instanceName: "shared-test", hostParent: parent, hostRoot: parent }, owner),
			).rejects.toThrow("already released");
			expect(runner.calls.at(-1)?.at(-1)).not.toContain(secret);
		} finally {
			await owner.release();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

/** Exercise the guest guard with abrupt death and two overlapping real shells. */
it.skipIf(!existsSync("/proc/sys/kernel/random/boot_id"))(
	"refuses interrupted and overlapping guest shells without a second daemon",
	async () => {
		const base = await mkdtemp(join(tmpdir(), "grip-shared-daemon-race-"));
		const home = join(base, "guest-home");
		const bin = join(base, "guest-bin");
		const parent = join(base, "workspace");
		const starts = join(base, "starts");
		const release = join(base, "release-start");
		const pidFile = join(home, ".cache", "grip", "shared-lima", "daemon-8787.pid");
		let firstShell: Promise<GuestShellResult> | undefined;
		try {
			await Promise.all([mkdir(home), mkdir(bin), mkdir(parent)]);
			const grip = join(bin, "grip");
			await writeFile(grip, '#!/bin/sh\nprintf "started\\n" >>"$FAKE_STARTS"\nexec sleep 120\n');
			await chmod(grip, 0o700);
			await installFakeSystemd(bin);
			const owner = await acquireSharedLimaOwnerLock("shared-test", base);
			let script: string;
			try {
				const runner = new DaemonRunner(parent);
				await new LimaSandboxService({ runner, readinessWaiter: async () => {} }).ensureSharedDaemon(
					{ instanceName: "shared-test", hostParent: parent, hostRoot: parent },
					owner,
				);
				script = runner.calls.at(-1)?.at(-1) ?? "";
			} finally {
				await owner.release();
			}
			const reserve = '  mkdir "$start_lock" || exit 26';
			expect(script).toContain(reserve);
			// Pause the first shell while it owns the actual atomic guest start directory.
			const delayed = script.replace(reserve, `${reserve}\n  while test ! -e "$RELEASE_START"; do sleep 0.02; done`);
			const env = {
				...process.env,
				HOME: home,
				PATH: `${bin}:${process.env.PATH}`,
				FAKE_STARTS: starts,
				FAKE_UNIT_PID: join(home, "fake-unit.pid"),
				RELEASE_START: release,
			};
			const runGuest = (captureKill?: (kill: () => boolean) => void): Promise<GuestShellResult> =>
				new Promise((resolve, reject) => {
					const child = spawn("sh", ["-c", delayed], { env, stdio: ["ignore", "pipe", "pipe"] });
					captureKill?.(() => child.kill("SIGKILL"));
					let stdout = "";
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
					});
					child.stderr.resume();
					child.once("error", reject);
					child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
				});
			const startLock = join(home, ".cache", "grip", "shared-lima", "daemon-8787.starting");
			let killShell: (() => boolean) | undefined;
			const crashedShell = runGuest((kill) => {
				killShell = kill;
			});
			await vi.waitFor(() => expect(existsSync(startLock)).toBe(true), { timeout: 5000 });
			expect(killShell?.()).toBe(true);
			expect((await crashedShell).code).not.toBe(0);
			expect(existsSync(startLock)).toBe(true); // SIGKILL cannot run the EXIT trap.
			const crashBlocked = await runGuest();
			expect(crashBlocked.code).not.toBe(0);
			expect(crashBlocked.stdout).not.toContain("GRIP_SHARED_TOKEN=");
			await rm(startLock, { recursive: true }); // Deliberate operator reconciliation in the fixture.
			firstShell = runGuest();
			await vi.waitFor(() => expect(existsSync(startLock)).toBe(true), { timeout: 5000 });
			const blocked = await runGuest();
			expect(blocked.code).not.toBe(0);
			expect(blocked.stdout).not.toContain("GRIP_SHARED_TOKEN=");
			await writeFile(release, "go");
			const first = await firstShell;
			expect(first.code).toBe(0);
			expect(first.stdout).toMatch(/GRIP_SHARED_TOKEN=[A-Za-z0-9+/]{43}=/);
			await vi.waitFor(async () => expect((await readFile(starts, "utf8")).trim()).toBe("started"));
			expect(existsSync(startLock)).toBe(false);
			const reused = await runGuest();
			expect(reused).toEqual(first);
			expect((await readFile(starts, "utf8")).trim()).toBe("started");
		} finally {
			await writeFile(release, "go");
			await firstShell?.catch(() => undefined);
			try {
				process.kill(Number(await readFile(pidFile, "utf8")), "SIGTERM");
			} catch {
				/* no daemon PID */
			}
			await rm(base, { recursive: true, force: true });
		}
	},
);

/** Execute the guest script as a local POSIX shell, without a real Lima guest or network. */
it.skipIf(!existsSync("/proc/sys/kernel/random/boot_id"))(
	"persists a private token, reuses one daemon PID, and refuses incomplete or stale state",
	async () => {
		const base = await mkdtemp(join(tmpdir(), "grip-shared-daemon-shell-"));
		const home = join(base, "guest-home");
		const bin = join(base, "guest-bin");
		const parent = join(base, "workspace");
		const starts = join(base, "starts");
		const daemonArgs = join(base, "daemon-args");
		const daemonCredential = join(base, "daemon-credential");
		let daemonPid: number | undefined;
		try {
			await Promise.all([mkdir(home), mkdir(bin), mkdir(parent)]);
			const grip = join(bin, "grip");
			await writeFile(
				grip,
				'#!/bin/sh\nprintf "%s\\n" "$@" >"$FAKE_ARGS"\nprintf "%s" "$GRIP_DAEMON_TOKEN" >"$FAKE_CREDENTIAL"\nprintf "started\\n" >>"$FAKE_STARTS"\nexec sleep 120\n',
			);
			await chmod(grip, 0o700);
			await installFakeSystemd(bin);
			const owner = await acquireSharedLimaOwnerLock("shared-test", base);
			try {
				const runner = new DaemonRunner(parent);
				const original = runner.run.bind(runner);
				runner.run = async (binary, args) => {
					if (!args.at(-1)?.startsWith("set -eu\n")) return original(binary, args);
					const result = spawnSync("sh", ["-c", args.at(-1) ?? ""], {
						encoding: "utf8",
						timeout: 5000,
						env: {
							...process.env,
							HOME: home,
							PATH: `${bin}:${process.env.PATH}`,
							FAKE_STARTS: starts,
							FAKE_ARGS: daemonArgs,
							FAKE_CREDENTIAL: daemonCredential,
							FAKE_UNIT_PID: join(home, "fake-unit.pid"),
						},
					});
					return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
				};
				const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
				const options = { instanceName: "shared-test", hostParent: parent, hostRoot: parent };
				const directory = join(home, ".cache", "grip", "shared-lima");
				const target = join(base, "keep-intact");
				const legacyDirectory = join(home, ".cache", "grip");
				await mkdir(legacyDirectory, { recursive: true });
				await writeFile(target, "intact");
				for (const suffix of ["pid", "log"]) {
					const legacyFile = join(legacyDirectory, `sandbox-daemon-8787.${suffix}`);
					await writeFile(legacyFile, "legacy");
					await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
					expect(existsSync(directory)).toBe(false);
					await rm(legacyFile);
				}
				const legacyFile = join(legacyDirectory, "sandbox-daemon-8787.pid");
				await symlink(target, legacyFile);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				expect(existsSync(directory)).toBe(false);
				await rm(legacyFile);
				const modeLock = join(legacyDirectory, "daemon-mode.lock");
				await mkdir(modeLock);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				expect(existsSync(directory)).toBe(false);
				await rm(modeLock, { recursive: true }); // Deliberate reconciliation in the fixture.
				// No guest user manager: refuse before creating a token, PID or shared directory.
				await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n");
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				expect(existsSync(directory)).toBe(false);
				expect(existsSync(modeLock)).toBe(false);
				await installFakeSystemd(bin);
				await writeFile(join(bin, "loginctl"), '#!/bin/sh\nprintf "no\\n"\n');
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				expect(existsSync(directory)).toBe(false);
				await installFakeSystemd(bin);
				const logFile = join(directory, "daemon-8787.log");
				await mkdir(directory, { recursive: true });
				await symlink(target, logFile);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				expect(await readFile(target, "utf8")).toBe("intact");
				await rm(logFile);
				const startLock = join(directory, "daemon-8787.starting");
				await mkdir(startLock, { mode: 0o700 }); // Simulate a crashed or concurrent launcher.
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await expect(readFile(join(directory, "daemon-8787.token"), "utf8")).rejects.toMatchObject({
					code: "ENOENT",
				});
				await rm(startLock, { recursive: true }); // Operator reconciliation in this fixture.
				// Once the manager rejects a launch, leave the credential for an operator;
				// a retry must not create a second unit or silently rotate it.
				await writeFile(join(bin, "systemd-run"), "#!/bin/sh\nexit 1\n");
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				const uncertainToken = join(directory, "daemon-8787.token");
				const credential = await readFile(uncertainToken, "utf8");
				expect(credential).toMatch(/^[A-Za-z0-9+/]{43}=$/);
				expect(existsSync(startLock)).toBe(false);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				expect(await readFile(uncertainToken, "utf8")).toBe(credential);
				await rm(uncertainToken); // Deliberate reconciliation only in this fixture.
				await installFakeSystemd(bin);
				const first = await service.ensureSharedDaemon(options, owner);
				const pidFile = join(directory, "daemon-8787.pid");
				const tokenFile = join(directory, "daemon-8787.token");
				const identityFile = join(directory, "daemon-8787.identity");
				daemonPid = Number(await readFile(pidFile, "utf8"));
				expect(Number.isSafeInteger(daemonPid)).toBe(true);
				expect((await stat(directory)).mode & 0o777).toBe(0o700);
				expect((await stat(pidFile)).mode & 0o777).toBe(0o600);
				expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
				expect((await stat(identityFile)).mode & 0o777).toBe(0o600);
				const identity = await readFile(identityFile, "utf8");
				expect(identity).toMatch(/^[a-f0-9-]+:[0-9]+$/);
				expect(await readFile(tokenFile, "utf8")).toBe(first);
				expect(existsSync(modeLock)).toBe(false);
				await vi.waitFor(async () =>
					expect(await readFile(daemonArgs, "utf8")).toContain("--daemon-shared-parent\n/workspace\n"),
				);
				expect(await readFile(daemonArgs, "utf8")).toContain("--daemon-cwd\n/workspace\n");
				await vi.waitFor(async () => expect(await readFile(daemonCredential, "utf8")).toBe(first));
				expect(await readFile(daemonArgs, "utf8")).not.toContain(first);
				expect(runner.calls.at(-1)?.at(-1)).not.toContain(`env GRIP_DAEMON_TOKEN=`);
				await vi.waitFor(async () => expect((await readFile(starts, "utf8")).trim()).toBe("started"));
				expect(await service.ensureSharedDaemon(options, owner)).toBe(first);
				await writeFile(join(home, "fake-unit.pid"), "1");
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(join(home, "fake-unit.pid"), String(daemonPid));
				await expect(stat(startLock)).rejects.toMatchObject({ code: "ENOENT" });
				await mkdir(startLock, { mode: 0o700 });
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await rm(startLock, { recursive: true });
				expect(await service.ensureSharedDaemon(options, owner)).toBe(first);
				const [bootId, startTime] = identity.split(":");
				await writeFile(identityFile, `${bootId}:0`);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(identityFile, `other-boot:${startTime}`);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(identityFile, identity);
				expect(await service.ensureSharedDaemon(options, owner)).toBe(first);
				await chmod(identityFile, 0o644);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await chmod(identityFile, 0o600);
				await writeFile(pidFile, String(process.pid)); // Live, but not the daemon process.
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(pidFile, String(daemonPid));
				await rm(identityFile);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(identityFile, identity, { mode: 0o600 });
				expect(await service.ensureSharedDaemon(options, owner)).toBe(first);
				await chmod(tokenFile, 0o644);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await chmod(tokenFile, 0o600);
				await rm(pidFile);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(pidFile, "999999999");
				await chmod(pidFile, 0o600);
				await expect(service.ensureSharedDaemon(options, owner)).rejects.toThrow("state is uncertain");
				await writeFile(pidFile, String(daemonPid));
				expect(await service.ensureSharedDaemon(options, owner)).toBe(first);
				expect(await readFile(tokenFile, "utf8")).toBe(first);
				expect((await readFile(starts, "utf8")).trim()).toBe("started");
			} finally {
				await owner.release();
			}
		} finally {
			if (daemonPid) {
				try {
					process.kill(daemonPid, "SIGTERM");
				} catch {
					/* child already exited */
				}
			}
			await rm(base, { recursive: true, force: true });
		}
	},
);
