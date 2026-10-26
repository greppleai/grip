import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { OFFICIAL_EXTENSIONS } from "../src/core/official-extensions.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import {
	catalogConfigurationKey,
	catalogRuntimeOwners,
	type ExtensionCatalogHost,
	OfficialExtensionCatalog,
} from "../src/modes/interactive/extension-catalog.ts";

interface CommandOptions {
	cwd?: string;
}

interface PackageCommands {
	runCommand(command: string, args: string[], options?: CommandOptions): Promise<void>;
}

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const yamlRoot = dirname(createRequire(import.meta.url).resolve("yaml/package.json"));
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["user", "project"] as const)(
	"installs the shipped planner pin through the catalog in isolated %s settings and loads one owner",
	async (scope) => {
		const root = mkdtempSync(join(tmpdir(), "grip-catalog-install-"));
		roots.push(root);
		const cwd = join(root, "host");
		const agentDir = join(root, "agent");
		const backend = join(root, "backend");
		for (const path of [cwd, agentDir, backend]) mkdirSync(path);
		vi.stubEnv("HOME", root);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "gitconfig"));
		writeFileSync(join(root, "gitconfig"), "");
		// The reviewed commit is cloned locally; no Git host or package registry is contacted.
		const commands = vi.spyOn(DefaultPackageManager.prototype as unknown as PackageCommands, "runCommand");
		commands.mockImplementation(async (command, args, options) => {
			if (command === "git") {
				const localArgs = args[0] === "clone" ? ["clone", "--no-hardlinks", "--", repository, args[2]] : args;
				execFileSync("git", localArgs, { cwd: options?.cwd, stdio: "pipe", timeout: 15_000 });
				return;
			}
			expect(command).toBe("npm");
			expect(args).toContain("--ignore-scripts");
			expect(args).toContain("--legacy-peer-deps");
			if (!options?.cwd) throw new Error("Missing selected package cwd");
			// Mock dependency hydration with the already installed runtime; never run npm.
			mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
			symlinkSync(yamlRoot, join(options.cwd, "node_modules/yaml"), "junction");
		});
		const settings = SettingsManager.create(cwd, agentDir);
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
		expect(commands).not.toHaveBeenCalled();

		const replies = ["planner", "install", scope, "proceed", "now"];
		const host: ExtensionCatalogHost = {
			packages: manager,
			hostCwd: cwd,
			settingsPath: (selected) => settings.getFilePath(selected === "user" ? "global" : "project")!,
			runtimeOwners: () => catalogRuntimeOwners(loader.getExtensions().extensions),
			choose: vi.fn(async () => replies.shift()),
			notify: vi.fn(),
			reload: () => loader.reload(),
			isIdle: () => true,
			projectAvailable: () => true,
			contextKey: () => cwd,
			configurationKey: () => catalogConfigurationKey(settings),
			runOperation: (operation) => operation(),
		};
		await new OfficialExtensionCatalog(host).show();
		expect(vi.mocked(host.notify).mock.calls.filter(([, error]) => error)).toEqual([]);
		const source = OFFICIAL_EXTENSIONS[0].target!.source;
		const installed = manager.getInstalledPath(source, scope)!;
		expect(manager.listConfiguredPackages()).toMatchObject([{ source, scope }]);
		expect(readFileSync(host.settingsPath(scope), "utf8")).toContain(source);
		expect(installed.endsWith("extensions/planner")).toBe(true);
		expect(existsSync(join(installed, "../../package.json"))).toBe(false);
		for (let attempt = 0; attempt < 2; attempt++) {
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toHaveLength(1);
			const extension = loader.getExtensions().extensions[0];
			expect([...extension.tools.keys()]).toEqual(OFFICIAL_EXTENSIONS[0].tools);
			expect([...extension.commands.keys()]).toEqual(["planner"]);
			expect(loader.getSkills().diagnostics).toEqual([]);
			expect(loader.getSkills().skills).toHaveLength(1);
			expect(loader.getSkills().skills[0].filePath).toBe(join(installed, "skills/planner/SKILL.md"));
		}
		const extension = loader.getExtensions().extensions[0];
		const ctx = {
			cwd,
			toolOperations: new LocalToolOperations(backend),
			signal: new AbortController().signal,
			execToolBackend: async () => ({
				output: "fixture has no Grepple",
				exitCode: 127,
				cancelled: false,
				truncated: false,
			}),
		} satisfies Pick<ExtensionContext, "cwd" | "toolOperations" | "signal" | "execToolBackend">;
		await extension.tools
			.get("planner_prepare")!
			.definition.execute(
				"prepare",
				{ planName: "saved" },
				undefined,
				undefined,
				ctx as unknown as ExtensionContext,
			);
		const saved = join(backend, ".planner/saved/INDEX.md");
		expect(existsSync(saved)).toBe(true);
		expect(existsSync(join(cwd, ".planner"))).toBe(false);

		// Loaded ownership blocks changing its package even when the fixture session is idle.
		replies.push("planner", "remove");
		await new OfficialExtensionCatalog(host).show();
		expect(manager.listConfiguredPackages()).toHaveLength(1);
		// Model exiting Grip: the next resource loader starts without a loaded owner.
		const nextLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
		host.runtimeOwners = () => catalogRuntimeOwners(nextLoader.getExtensions().extensions);
		host.reload = () => nextLoader.reload();
		replies.push("planner", "remove", "proceed", "now");
		await new OfficialExtensionCatalog(host).show();
		expect(manager.listConfiguredPackages()).toEqual([]);
		expect(existsSync(installed)).toBe(false);
		expect(existsSync(saved)).toBe(true);
		expect(nextLoader.getExtensions().extensions).toEqual([]);
		expect(nextLoader.getSkills().skills).toEqual([]);
	},
	30_000,
);
