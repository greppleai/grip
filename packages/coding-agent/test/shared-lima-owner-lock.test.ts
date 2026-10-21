import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareSharedLimaOwnerDirectory } from "../src/core/remote-workspace-protocol/lima-owner-directory.ts";
import { acquireSharedLimaOwnerLock } from "../src/core/remote-workspace-protocol/lima-owner-lock.ts";

it("claims one private owner for a named VM and releases without stealing", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-shared-lima-lock-"));
	try {
		const owner = await acquireSharedLimaOwnerLock("shared-test", base);
		expect((await stat(owner.path)).mode & 0o077).toBe(0);
		await expect(acquireSharedLimaOwnerLock("shared-test", base)).rejects.toThrow("occupied");
		const independent = await acquireSharedLimaOwnerLock("other-vm", base);
		await independent.release();
		await owner.release();
		await owner.release();
		const successor = await acquireSharedLimaOwnerLock("shared-test", base);
		await successor.release();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

it("uses one default named-VM lock despite different TMPDIR values", async () => {
	const firstTmp = await mkdtemp(join(tmpdir(), "grip-lock-tmp-one-"));
	const secondTmp = await mkdtemp(join(tmpdir(), "grip-lock-tmp-two-"));
	const before = process.env.TMPDIR;
	const name = `shared-${randomUUID()}`;
	try {
		process.env.TMPDIR = firstTmp;
		const owner = await acquireSharedLimaOwnerLock(name);
		try {
			process.env.TMPDIR = secondTmp;
			await expect(acquireSharedLimaOwnerLock(name)).rejects.toThrow("occupied");
		} finally {
			await owner.release();
		}
	} finally {
		if (before === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = before;
		await Promise.all([
			rm(firstTmp, { recursive: true, force: true }),
			rm(secondTmp, { recursive: true, force: true }),
		]);
	}
});

it("requires manual reconciliation for dead, malformed or replaced owner locks", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-shared-lima-stale-"));
	try {
		const owner = await acquireSharedLimaOwnerLock("shared-test", base);
		await writeFile(owner.path, JSON.stringify({ pid: 2147483647, nonce: "dead" }), { mode: 0o600 });
		await expect(acquireSharedLimaOwnerLock("shared-test", base)).rejects.toThrow("stale");
		await expect(owner.release()).rejects.toThrow("contents changed");
		await rm(owner.path);
		const replacement = await acquireSharedLimaOwnerLock("shared-test", base);
		await rm(replacement.path);
		await writeFile(replacement.path, "bad", { mode: 0o600 });
		await expect(acquireSharedLimaOwnerLock("shared-test", base)).rejects.toThrow("unverifiable");
		await expect(replacement.release()).rejects.toThrow("identity changed");
		const contents = await readFile(replacement.path, "utf8");
		expect(contents).toBe("bad");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")("rejects unsafe host owner directory replacements", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-lima-owner-dir-"));
	try {
		const directory = join(base, `grip-broker-${process.getuid?.()}`);
		await writeFile(directory, "not a directory");
		await expect(prepareSharedLimaOwnerDirectory(base)).rejects.toThrow("not private");
		await rm(directory);
		await symlink(base, directory);
		await expect(prepareSharedLimaOwnerDirectory(base)).rejects.toThrow("not private");
		await rm(directory);
		await prepareSharedLimaOwnerDirectory(base);
		expect((await lstat(directory)).mode & 0o077).toBe(0);
		await chmod(directory, 0o755);
		await expect(prepareSharedLimaOwnerDirectory(base)).rejects.toThrow("not private");
		await chmod(directory, 0o700);
		await chmod(base, 0o777);
		await expect(prepareSharedLimaOwnerDirectory(base)).rejects.toThrow("not owned or sticky-safe");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
