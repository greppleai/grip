import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@greppleai/grip-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { ExtensionManagerController } from "../../src/modes/interactive/extension-manager.ts";
import { ExtensionManagerReloadCoordinator } from "../../src/modes/interactive/extension-manager-reload.ts";
import { GIT_EXTENSION_URL } from "../fixtures/git-extension-review.ts";
import { type CommandOptions, git, type NpmCommand } from "../fixtures/local-git.ts";
import { createHarness, type Harness } from "./harness.ts";

interface FixtureCommands {
	runCommandCapture: (command: string, args: string[], options: CommandOptions) => Promise<string>;
	runNpmCommand: NpmCommand;
}

describe("Git extension approval through resource activation", () => {
	let root: string;
	let remote: string;
	let agentDir: string;
	let marker: string;
	let settings: SettingsManager;
	let packageManager: DefaultPackageManager;
	let controller: ExtensionManagerController | null;
	let coordinator: ExtensionManagerReloadCoordinator | null;
	let harness: Harness | null;
	let npm: ReturnType<typeof vi.fn<NpmCommand>>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grip-git-lifecycle-"));
		remote = join(root, "remote");
		agentDir = join(root, "agent");
		marker = join(root, "executed");
		controller = null;
		coordinator = null;
		harness = null;
		mkdirSync(remote);
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ officialExtensions: { autoUpdate: false } }));
		settings = SettingsManager.create(root, agentDir);
		packageManager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
		npm = vi.fn(async () => {});
		const commands = packageManager as unknown as FixtureCommands;
		commands.runCommandCapture = async (command, args, options) => {
			expect(command).toBe("git");
			return git(
				args.map((arg) => (arg === GIT_EXTENSION_URL ? remote : arg)),
				options.cwd,
			);
		};
		// No registry access or lifecycle scripts: spy on the real installer's npm boundary.
		commands.runNpmCommand = npm;
		git(["init", "--initial-branch=main"], remote);
		git(["config", "user.name", "Fixture"], remote);
		git(["config", "user.email", "fixture@example.com"], remote);
		writeFileSync(
			join(remote, "extension.js"),
			`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "import\\n");
export default function () { appendFileSync(${JSON.stringify(marker)}, "factory\\n"); }
`,
		);
		vi.stubEnv("GRIP_OFFLINE", "0");
	});

	afterEach(async () => {
		coordinator?.dispose();
		await controller?.dispose();
		if (harness) {
			await harness.session.dispose();
			harness.cleanup();
		}
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function commit(validManifest = true): string {
		const pkg = {
			name: "local-fixture",
			type: "module",
			grip: { extensions: validManifest ? ["extension.js"] : [] },
		};
		writeFileSync(join(remote, "package.json"), JSON.stringify(pkg));
		git(["add", "."], remote);
		git(["commit", "-m", "fixture"], remote);
		return git(["rev-parse", "HEAD"], remote).trim();
	}

	async function open(noExtensions = false): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: settings,
			noExtensions,
			noContextFiles: true,
		});
		await loader.reload();
		controller = new ExtensionManagerController({ packageManager, resourceLoader: loader, onChange: () => {} });
		await controller.initialize();
		controller.openGitInput();
		controller.requestGitPreparation(`${GIT_EXTENSION_URL}@main`);
		await controller.prepareGit("user");
		return loader;
	}

	it("rejects an invalid repository without selection, dependency installation or imports", async () => {
		commit(false);
		const loader = await open();
		expect(controller?.getState().notice).toContain("nonempty grip.extensions");
		expect(controller?.getState().gitPreparation).toBeNull();
		expect(await controller?.approveGit()).toBe(false);
		expect(settings.getPackages()).toEqual([]);
		expect(npm).not.toHaveBeenCalled();
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(existsSync(marker)).toBe(false);
	});

	it("denial discards a real checkout and executes neither npm nor module/factory code", async () => {
		commit();
		const loader = await open();
		expect(controller?.getState().page).toBe("git-review");
		expect(existsSync(marker)).toBe(false);
		expect(npm).not.toHaveBeenCalled();
		controller?.back();
		expect(controller?.getState().gitPreparation).toBeNull();
		expect(await controller?.approveGit()).toBe(false);
		expect(settings.getPackages()).toEqual([]);
		await loader.reload();
		expect(npm).not.toHaveBeenCalled();
		expect(existsSync(marker)).toBe(false);
		expect(await loader.getExtensionInventory()).toEqual([]);
	});

	it("persists the reviewed commit but imports and runs its factory only after session work settles", async () => {
		const reviewedCommit = commit();
		const loader = await open();
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Wait",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await released.promise;
				return { content: [], details: {} };
			},
		};
		harness = await createHarness({ resourceLoader: loader, tools: [hold] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		const prompt = harness.session.prompt("hold");
		const pinned = `${GIT_EXTENSION_URL}@${reviewedCommit}`;
		const session = harness.session;
		const reload = vi.fn(() => session.reload());
		try {
			await started.promise;
			expect(existsSync(marker)).toBe(false);
			expect(npm).not.toHaveBeenCalled();
			expect(await controller?.approveGit()).toBe(true);
			expect(settings.getPackages()).toEqual([pinned]);
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).packages).toEqual([pinned]);
			expect(npm).toHaveBeenCalledOnce();
			expect(existsSync(marker)).toBe(false);
			expect((await loader.getExtensionInventory())[0].status).toBe("not-loaded");
			expect(await controller?.dispose()).toBe(true);
			coordinator = new ExtensionManagerReloadCoordinator({ getSession: () => session, reload, onStatus: () => {} });
			const pending = coordinator.request();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(reload).not.toHaveBeenCalled();
			expect(existsSync(marker)).toBe(false);
			released.resolve();
			await Promise.all([prompt, pending]);
		} finally {
			released.resolve();
			await prompt;
		}
		expect(reload).toHaveBeenCalledOnce();
		expect(readFileSync(marker, "utf-8")).toBe("import\nfactory\n");
		expect((await loader.getExtensionInventory())[0]).toMatchObject({ source: pinned, status: "loaded" });
	});

	it.each(["no-extensions", "disabled"])("keeps approved code unexecuted under %s after reload", async (mode) => {
		const reviewedCommit = commit();
		const loader = await open(mode === "no-extensions");
		expect(await controller?.approveGit()).toBe(true);
		if (mode === "disabled") {
			settings.setPackages([{ source: `${GIT_EXTENSION_URL}@${reviewedCommit}`, extensions: [] }]);
			await settings.flush();
		}
		await loader.reload();
		expect(npm).toHaveBeenCalledOnce();
		expect(existsSync(marker)).toBe(false);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect((await loader.getExtensionInventory())[0].status).toBe("disabled");
	});

	it("recognizes without importing, then reports invalid factories as postapproval activation errors", async () => {
		writeFileSync(
			join(remote, "extension.js"),
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export default {};
`,
		);
		const reviewedCommit = commit();
		const loader = await open();
		expect(controller?.getState().page).toBe("git-review");
		expect(existsSync(marker)).toBe(false);
		expect(await controller?.approveGit()).toBe(true);
		expect(existsSync(marker)).toBe(false);
		await loader.reload();
		expect(readFileSync(marker, "utf-8")).toBe("imported");
		expect(settings.getPackages()).toEqual([`${GIT_EXTENSION_URL}@${reviewedCommit}`]);
		expect(loader.getExtensions().errors[0].error).toContain("does not export a valid factory function");
		const inventory = await loader.getExtensionInventory();
		expect(inventory[0].status).toBe("failed");
		expect(inventory[0].entries[0].errors[0]).toContain("valid factory function");
	});
});
