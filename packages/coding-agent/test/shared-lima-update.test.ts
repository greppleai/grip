import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import type { SandboxCommandResult, SandboxRunner } from "../src/core/sandbox/config.ts";
import { LimaSandboxService } from "../src/core/sandbox/lima.ts";
import { stageSharedGuestBinary } from "../src/core/sandbox/update-shared-guest-binary.ts";

const token = Buffer.alloc(32, 5).toString("base64");

class UpdateRunner implements SandboxRunner {
	readonly calls: string[][] = [];
	readonly parent: string;
	failPreflight = false;
	failStage = false;
	digest = "a".repeat(64);
	constructor(parent: string) {
		this.parent = parent;
	}
	async run(_binary: string, args: string[]): Promise<SandboxCommandResult> {
		this.calls.push(args);
		if (args[0] === "list") {
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					name: "shared-update",
					status: "Running",
					config: {
						mounts: [{ location: this.parent, mountPoint: "/workspace", writable: true }],
						portForwards: [{ guestPort: 8787, hostPort: 8787, hostIP: "127.0.0.1" }],
					},
				}),
				stderr: "",
			};
		}
		const script = args.at(-1) ?? "";
		if (script.includes("GRIP_LEGACY_GUEST")) return { exitCode: 0, stdout: "GRIP_SHARED_GUEST\n", stderr: "" };
		if (script === "grip --version" || script === '"$HOME/.local/bin/grip" --version') {
			return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
		}
		if (this.failPreflight && script.includes("show -P ExecStart") && !script.includes("systemctl --user stop")) {
			return { exitCode: 46, stdout: "", stderr: "wrong binary" };
		}
		if (this.failStage && script.includes("curl -fLsS")) {
			return { exitCode: 1, stdout: "", stderr: "download failed" };
		}
		if (script.includes("GRIP_STAGE_SHA256=")) {
			return { exitCode: 0, stdout: `GRIP_STAGE_SHA256=${this.digest}\n`, stderr: "" };
		}
		return { exitCode: 0, stdout: `GRIP_SHARED_TOKEN=${token}\n`, stderr: "" };
	}
}

it("stages the pinned release before disconnecting all shared clients and restarts the verified daemon", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-update-"));
	const child = join(parent, "project");
	await mkdir(child);
	try {
		const runner = new UpdateRunner(parent);
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		const result = await service.start({ workspaceRoot: child, name: "shared-update", update: true });
		expect(result).toMatchObject({ containerName: "shared-update", token });
		const scripts = runner.calls.map((args) => args.at(-1) ?? "");
		const download = scripts.findIndex((script) => script.includes("curl -fLsS"));
		const stop = scripts.findIndex((script) => script.includes("systemctl --user stop"));
		const install = scripts.findIndex((script) => script.includes('mv -f "$tmp" "$target"'));
		const restart = scripts.findIndex((script) => script.includes('systemctl --user start "$unit"'));
		expect(download).toBeGreaterThan(0);
		expect(scripts[download]).toContain(`v${VERSION}`);
		expect(scripts[download]).toContain("sha256sum");
		expect(stop).toBeGreaterThan(download);
		expect(scripts[stop]).toContain('systemctl --user show -P MainPID "$unit"');
		expect(install).toBeGreaterThan(stop);
		expect(restart).toBeGreaterThan(install);
		expect(runner.calls.some((args) => args[0] === "stop" || args[0] === "delete")).toBe(false);
		for (const args of runner.calls) {
			if (args[0] === "shell") expect(spawnSync("sh", ["-n"], { input: args.at(-1) }).status).toBe(0);
		}
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

it.each(["failPreflight", "failStage"] as const)("does not disconnect clients when %s fails", async (failure) => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-update-refuse-"));
	try {
		const runner = new UpdateRunner(parent);
		runner[failure] = true;
		const service = new LimaSandboxService({ runner, readinessWaiter: async () => {} });
		await expect(service.start({ workspaceRoot: parent, name: "shared-update", update: true })).rejects.toThrow();
		expect(runner.calls.some((args) => args.at(-1)?.includes("systemctl --user stop"))).toBe(false);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

it("stages the verified local development binary instead of downloading a release", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-dev-update-"));
	try {
		const binary = join(parent, "grip-linux");
		const header = Buffer.alloc(20);
		Buffer.from("7f454c46", "hex").copy(header);
		header[4] = 2;
		header[5] = 1;
		header.writeUInt16LE(62, 18);
		await writeFile(binary, header);
		const runner = new UpdateRunner(parent);
		runner.digest = createHash("sha256").update(header).digest("hex");
		const service = new LimaSandboxService({
			runner,
			env: { GRIP_SANDBOX_GUEST_BINARY: binary },
			readinessWaiter: async () => {},
		});
		await service.start({ workspaceRoot: parent, name: "shared-update", update: true });
		const copy = runner.calls.find((args) => args[0] === "copy");
		expect(copy).toContain(binary);
		expect(runner.calls.some((args) => args.at(-1)?.includes("curl -fLsS"))).toBe(false);
		expect(runner.calls.some((args) => args.at(-1)?.includes("systemctl --user stop"))).toBe(true);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

it("validates a checksummed pinned release before offering to stop the daemon", async () => {
	const home = await mkdtemp(join(tmpdir(), "grip-staged-release-"));
	try {
		const bin = join(home, "bin");
		await mkdir(bin);
		const binary = join(home, "grip");
		await writeFile(binary, `#!/bin/sh\nprintf '${VERSION}\\n'\n`);
		await chmod(binary, 0o700);
		const digest = createHash("sha256")
			.update(await readFile(binary))
			.digest("hex");
		const fakeCurl = join(bin, "curl");
		await writeFile(
			fakeCurl,
			'#!/bin/sh\nwhile test "$1" != -o; do shift; done\nshift\ncase "$1" in *.sha256) printf "%s  grip-linux-%s\\n" "$FAKE_DIGEST" "$FAKE_ARCH" >"$1";; *) cp "$FAKE_BINARY" "$1";; esac\n',
		);
		await chmod(fakeCurl, 0o700);
		const runner: SandboxRunner = {
			async run(_command, args) {
				const result = spawnSync("sh", ["-c", args.at(-1) ?? ""], {
					encoding: "utf8",
					env: {
						...process.env,
						HOME: home,
						PATH: `${bin}:${process.env.PATH}`,
						FAKE_BINARY: binary,
						FAKE_DIGEST: digest,
						FAKE_ARCH: process.arch === "arm64" ? "arm64" : "x64",
					},
				});
				return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
			},
		};
		const staged = await stageSharedGuestBinary(runner, "limactl", "shared-update", "unit", VERSION);
		await staged.cleanup();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
