import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

let directory: string;
let agentDir: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "grip-diagnostics-settings-"));
	agentDir = join(directory, "agent");
	await mkdir(agentDir);
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("performance diagnostics setting", () => {
	it("defaults to disabled, persists enable and disable, and reloads file edits", async () => {
		const manager = SettingsManager.create(directory, agentDir);
		expect(manager.getPerformanceDiagnostics()).toBe(false);
		for (const enabled of [true, false]) {
			manager.setPerformanceDiagnostics(enabled);
			await manager.flush();
			expect(manager.getPerformanceDiagnostics()).toBe(enabled);
			expect(SettingsManager.create(directory, agentDir).getPerformanceDiagnostics()).toBe(enabled);
		}
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ performanceDiagnostics: true }));
		await manager.reload();
		expect(manager.getPerformanceDiagnostics()).toBe(true);
	});
	it("requires an explicit boolean opt-in", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ performanceDiagnostics: "false" }));
		expect(SettingsManager.create(directory, agentDir).getPerformanceDiagnostics()).toBe(false);
	});
	it("honors project settings over global settings", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ performanceDiagnostics: true }));
		await mkdir(join(directory, ".grip"));
		await writeFile(join(directory, ".grip", "settings.json"), JSON.stringify({ performanceDiagnostics: false }));
		const manager = SettingsManager.create(directory, agentDir);
		expect(manager.getPerformanceDiagnostics()).toBe(false);
		for (const enabled of [true, false]) {
			manager.setPerformanceDiagnostics(enabled);
			await manager.flush();
			expect(manager.getPerformanceDiagnostics()).toBe(enabled);
			expect(SettingsManager.create(directory, agentDir).getPerformanceDiagnostics()).toBe(enabled);
		}
	});
});
