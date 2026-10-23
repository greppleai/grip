import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDirectoryCompletions, getSandboxDirectoryCompletions } from "../src/utils/directory-completions.ts";

const tempDirectories: string[] = [];

function createFixture(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cd-completions-"));
	tempDirectories.push(cwd);
	mkdirSync(join(cwd, "alpha"));
	mkdirSync(join(cwd, "directory with spaces"));
	mkdirSync(join(cwd, "nested", "child"), { recursive: true });
	writeFileSync(join(cwd, "not-a-directory.txt"), "test");
	return cwd;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("getDirectoryCompletions", () => {
	it("lists only matching child directories", () => {
		const cwd = createFixture();

		expect(getDirectoryCompletions("a", cwd)).toEqual([{ value: "alpha/", label: "alpha/" }]);
		expect(getDirectoryCompletions("not", cwd)).toEqual([]);
	});

	it("completes nested directory paths", () => {
		const cwd = createFixture();

		expect(getDirectoryCompletions("nested/", cwd)).toEqual([{ value: "nested/child/", label: "child/" }]);
	});

	it("quotes directory paths containing spaces", () => {
		const cwd = createFixture();

		expect(getDirectoryCompletions("dir", cwd)).toEqual([
			{ value: '"directory with spaces/"', label: "directory with spaces/" },
		]);
	});
});

describe("getSandboxDirectoryCompletions", () => {
	const directories = new Set([
		"/workspace",
		"/workspace/grip",
		"/workspace/grip/nested",
		"/workspace/grip/nested/child",
		"/workspace/grip/directory with spaces",
		"/workspace/planner",
	]);
	const operations = {
		readdir: vi.fn(async (directory: string) => {
			if (directory === "/workspace") return ["grip", "planner"];
			if (directory === "/workspace/grip") return ["nested", "directory with spaces", "file.txt", "outside-link"];
			if (directory === "/workspace/grip/nested") return ["child"];
			return [];
		}),
		resolveWorkspaceDirectory: vi.fn(async (directory: string) => {
			const normalized = posix.normalize(directory);
			if (!directories.has(normalized)) throw new Error("Remote workspace request handler failed");
			return normalized;
		}),
	};

	it("uses guest cwd for relative and quoted directory paths, not host files", async () => {
		expect(await getSandboxDirectoryCompletions("nes", "/workspace/grip", "posix", operations)).toEqual([
			{ value: "nested/", label: "nested/" },
		]);
		expect(await getSandboxDirectoryCompletions("nested/", "/workspace/grip", "posix", operations)).toEqual([
			{ value: "nested/child/", label: "child/" },
		]);
		expect(await getSandboxDirectoryCompletions('"dir', "/workspace/grip", "posix", operations)).toEqual([
			{ value: '"directory with spaces/"', label: "directory with spaces/" },
		]);
	});

	it("completes siblings only if they are inside the guest workspace", async () => {
		expect(await getSandboxDirectoryCompletions("../pl", "/workspace/grip", "posix", operations)).toEqual([
			{ value: "../planner/", label: "planner/" },
		]);
		expect(await getSandboxDirectoryCompletions("../../", "/workspace/grip", "posix", operations)).toEqual([]);
		expect(await getSandboxDirectoryCompletions("file", "/workspace/grip", "posix", operations)).toEqual([]);
	});
});
