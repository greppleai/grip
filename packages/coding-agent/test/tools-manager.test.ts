import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToolPath } from "../src/utils/tools-manager.ts";

describe("search tool discovery", () => {
	let testDir: string;
	let originalPath: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "grip-search-tools-"));
		originalPath = process.env.PATH;
		originalAgentDir = process.env.GRIP_CODING_AGENT_DIR;
		process.env.PATH = testDir;
		process.env.GRIP_CODING_AGENT_DIR = testDir;
	});

	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalAgentDir === undefined) delete process.env.GRIP_CODING_AGENT_DIR;
		else process.env.GRIP_CODING_AGENT_DIR = originalAgentDir;
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("does not download or install missing fd and rg", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		expect(getToolPath("fd")).toBeUndefined();
		expect(getToolPath("rg")).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(existsSync(join(testDir, "bin"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("recognizes system fdfind and a previously installed local rg", () => {
		const fdfind = join(testDir, "fdfind");
		writeFileSync(fdfind, "#!/bin/sh\necho fdfind 1.0\n");
		chmodSync(fdfind, 0o755);
		mkdirSync(join(testDir, "bin"));
		writeFileSync(join(testDir, "bin", "rg"), "#!/bin/sh\necho rg 1.0\n");
		expect(getToolPath("fd")).toBe("fdfind");
		expect(getToolPath("rg")).toBe(join(testDir, "bin", "rg"));
	});
});
