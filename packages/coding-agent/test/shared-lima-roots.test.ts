import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveSharedLimaWorkspace } from "../src/core/sandbox/shared-lima-roots.ts";

it("maps parent, new children and duplicate roots under one canonical fixed parent", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-shared-lima-roots-"));
	try {
		const parent = join(base, "workspace");
		await mkdir(parent);
		const parentBinding = await resolveSharedLimaWorkspace(parent, "/workspace", parent);
		expect(parentBinding).toEqual({
			hostParent: parent,
			hostRoot: parent,
			guestParent: "/workspace",
			guestRoot: "/workspace",
		});
		// A new child becomes eligible without changing the parent mount.
		const child = join(parent, "created-after-start");
		await mkdir(child);
		const first = await resolveSharedLimaWorkspace(parent, "/workspace", child);
		const second = await resolveSharedLimaWorkspace(parent, "/workspace", child);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ hostParent: parent, hostRoot: child, guestRoot: "/workspace/created-after-start" });
		await mkdir(join(child, "nested"));
		expect((await resolveSharedLimaWorkspace(parent, "/workspace", join(child, "nested"))).guestRoot).toBe(
			"/workspace/created-after-start/nested",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

it("rejects outside parents, symlink escapes, non-directories and invalid guest mount spelling", async () => {
	const base = await mkdtemp(join(tmpdir(), "grip-shared-lima-reject-"));
	try {
		const parent = join(base, "workspace");
		const outside = join(base, "outside");
		await Promise.all([mkdir(parent), mkdir(outside)]);
		await symlink(outside, join(parent, "escape"));
		await writeFile(join(parent, "file"), "not a directory");
		await expect(resolveSharedLimaWorkspace(parent, "/workspace", outside)).rejects.toThrow("escapes");
		await expect(resolveSharedLimaWorkspace(parent, "/workspace", join(parent, "escape"))).rejects.toThrow("escapes");
		await expect(resolveSharedLimaWorkspace(parent, "/workspace", join(parent, "missing"))).rejects.toThrow();
		await expect(resolveSharedLimaWorkspace(parent, "/workspace", join(parent, "file"))).rejects.toThrow(
			"directories",
		);
		await expect(resolveSharedLimaWorkspace(parent, "workspace", parent)).rejects.toThrow("canonical absolute");
		await expect(resolveSharedLimaWorkspace(parent, "/workspace/../other", parent)).rejects.toThrow(
			"canonical absolute",
		);
		await mkdir(join(parent, "inside"));
		await symlink(join(parent, "inside"), join(parent, "alias"));
		expect((await resolveSharedLimaWorkspace(parent, "/workspace", join(parent, "alias"))).guestRoot).toBe(
			"/workspace/inside",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
