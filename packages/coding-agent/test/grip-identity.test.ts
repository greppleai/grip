import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, PACKAGE_NAME } from "../src/config.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { readGripManifest } from "../src/core/grip-manifest.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface GripPackageConfig {
	configDir: string;
}

interface GripPackageManifest {
	name: string;
	bin: Record<string, string>;
	gripConfig: GripPackageConfig;
}

describe("Grip CLI identity", () => {
	it("uses the same executable and package identity in the manifest and runtime", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as GripPackageManifest;
		expect(pkg.name).toBe("@greppleai/grip");
		expect(pkg.bin).toEqual({ grip: "dist/cli.js" });
		expect(pkg.gripConfig.configDir).toBe(".grip");
		expect(pkg).not.toHaveProperty("piConfig");
		expect(PACKAGE_NAME).toBe(pkg.name);
		expect(APP_NAME).toBe("grip");
		expect(CONFIG_DIR_NAME).toBe(pkg.gripConfig.configDir);
		expect(ENV_AGENT_DIR).toBe("GRIP_CODING_AGENT_DIR");
	});

	it("advertises the Grip command and active configuration in help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			printHelp();
			const help = log.mock.calls.flat().join("\n");
			expect(help).toContain("grip [options]");
			expect(help).toContain("grip --daemon [options]");
			expect(help).toContain("GRIP_CODING_AGENT_DIR");
			expect(help).toContain("~/.grip/agent");
			expect(help).not.toMatch(/\bpi\s+--daemon\b/);
		} finally {
			log.mockRestore();
		}
	});

	describe("extension and package discovery", () => {
		it("uses only the grip manifest key for extensions and package resources", async () => {
			const root = mkdtempSync(join(tmpdir(), "grip-discovery-"));
			try {
				const extensionsDir = join(root, "extensions");
				const legacyDir = join(extensionsDir, "legacy");
				const gripDir = join(extensionsDir, "current");
				mkdirSync(legacyDir, { recursive: true });
				mkdirSync(gripDir);
				const indexPath = join(legacyDir, "index.ts");
				const ignoredPath = join(legacyDir, "ignored.ts");
				const activePath = join(gripDir, "active.ts");
				for (const file of [indexPath, ignoredPath, activePath]) {
					writeFileSync(file, "export default function () {}\n");
				}
				const legacyManifestPath = join(legacyDir, "package.json");
				writeFileSync(legacyManifestPath, JSON.stringify({ pi: { extensions: ["./ignored.ts"] } }));
				writeFileSync(join(gripDir, "package.json"), JSON.stringify({ grip: { extensions: ["./active.ts"] } }));

				expect(readGripManifest(legacyManifestPath)).toBeNull();
				const discovered = await discoverAndLoadExtensions([], root, root);
				expect(discovered.errors).toHaveLength(0);
				expect(discovered.extensions.map((extension) => extension.path).sort()).toEqual(
					[activePath, indexPath].sort(),
				);
				const packageManager = new DefaultPackageManager({
					cwd: root,
					agentDir: join(root, "agent"),
					settingsManager: SettingsManager.inMemory(),
				});
				const resources = await packageManager.resolveExtensionSources([legacyDir, gripDir]);
				expect(resources.extensions.map((extension) => extension.path).sort()).toEqual(
					[activePath, legacyDir].sort(),
				);
				expect(resources.extensions.map((extension) => extension.path)).not.toContain(ignoredPath);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("discovers project extensions from .grip but not legacy .pi", async () => {
			const root = mkdtempSync(join(tmpdir(), "grip-project-discovery-"));
			try {
				const legacyPath = join(root, ".pi", "extensions", "legacy.ts");
				const activePath = join(root, ".grip", "extensions", "active.ts");
				mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
				mkdirSync(join(root, ".grip", "extensions"), { recursive: true });
				writeFileSync(legacyPath, "export default function () {}\n");
				writeFileSync(activePath, "export default function () {}\n");
				const packageManager = new DefaultPackageManager({
					cwd: root,
					agentDir: join(root, "agent"),
					settingsManager: SettingsManager.inMemory(),
				});
				const resources = await packageManager.resolve();
				expect(resources.extensions.map((extension) => extension.path)).toContain(activePath);
				expect(resources.extensions.map((extension) => extension.path)).not.toContain(legacyPath);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
