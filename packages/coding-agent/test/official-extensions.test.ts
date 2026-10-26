import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getOfficialExtensionAction,
	getOfficialExtensionTarget,
	inspectOfficialExtension,
	OFFICIAL_EXTENSIONS,
	type OfficialExtension,
	type OfficialExtensionActionHost,
	OfficialExtensionActions,
	type OfficialExtensionState,
} from "../src/core/official-extensions.ts";
import { DefaultPackageManager, type InstalledSourceScope } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const revision = "1234567890abcdef1234567890abcdef12345678";
const target = `git:github.com/greppleai/planner@${revision}`;
const entry: OfficialExtension = {
	...OFFICIAL_EXTENSIONS[0],
	target: { source: target, revision },
	unavailableReason: null,
};
const empty: OfficialExtensionState = { installations: [], loadedOwners: [], conflict: null };

function configuredState(source: string, scope: InstalledSourceScope = "user"): OfficialExtensionState {
	return inspectOfficialExtension(entry, [{ source, scope, filtered: false }], []);
}

describe("official extension identity and trusted targets", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grip-catalog-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("pins the shipped planner target to its reviewed monorepo subdirectory", () => {
		const planner = OFFICIAL_EXTENSIONS[0];
		expect(planner.repository).toBe(
			`https://github.com/greppleai/grip/tree/${planner.target?.revision}/extensions/planner`,
		);
		expect(getOfficialExtensionTarget(planner)?.source).toBe(
			`git:github.com/greppleai/grip@${planner.target?.revision}#path=extensions/planner`,
		);
		expect(getOfficialExtensionAction(planner, empty, "install", "user").source).toBe(planner.target?.source);
	});

	it("does not identify the Grip repository root or a sibling package as planner", () => {
		for (const source of [
			"git:github.com/greppleai/grip",
			"git:github.com/greppleai/grip#path=extensions/other",
			"git:github.com/greppleai/planner#path=other",
		]) {
			expect(configuredState(source).installations).toEqual([]);
		}
	});

	it("recognizes the selected planner package but refuses to migrate legacy Git sources as an upgrade", () => {
		const planner = OFFICIAL_EXTENSIONS[0];
		const state = configuredState("git:git@GitHub.com:GreppleAI/Grip@old#path=extensions/planner");
		expect(state.installations).toHaveLength(1);
		expect(getOfficialExtensionAction(planner, state, "upgrade", "user").source).toBe(planner.target?.source);
		expect(() =>
			getOfficialExtensionAction(
				planner,
				configuredState("git:github.com/greppleai/planner@old"),
				"upgrade",
				"user",
			),
		).toThrow("Changing Git repository or selected package");
	});

	it.each([
		"git:github.com/greppleai/planner@old",
		"git:git@github.com:greppleai/planner.git@old",
		"ssh://git@github.com/greppleai/planner.git@old",
		"https://github.com/greppleai/planner.git",
		"git:GITHUB.COM/GreppleAI/Planner@old",
		"npm:@greppleai/planner@1.0.0",
	])("recognizes %s as an existing owner even when files are missing", (source) => {
		const state = configuredState(source);
		expect(state.installations).toHaveLength(1);
		expect(state.installations[0].installed).toBe(false);
		expect(() => getOfficialExtensionAction(entry, state, "install", "project")).toThrow("second install");
	});

	it("equates npm/git aliases across scopes without silently deduplicating settings", () => {
		const state = inspectOfficialExtension(
			entry,
			[
				{ source: "npm:@greppleai/planner", scope: "user", filtered: false },
				{ source: "git:github.com/greppleai/planner", scope: "project", filtered: true },
			],
			[],
		);
		expect(state.installations).toHaveLength(2);
		expect(() => getOfficialExtensionAction(entry, state, "remove", "project")).toThrow("Multiple");
	});

	it("recognizes a local manifest through a symlink without executing package code", () => {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@greppleai/planner", version: "1.2.3" }));
		const link = `${root}-link`;
		symlinkSync(root, link, "dir");
		try {
			const state = inspectOfficialExtension(
				entry,
				[{ source: link, scope: "user", filtered: true, installedPath: link }],
				[],
			);
			expect(state.installations[0]).toMatchObject({
				kind: "local",
				root,
				installed: true,
				version: "1.2.3",
				filtered: true,
			});
			expect(() => getOfficialExtensionAction(entry, state, "upgrade", "user")).toThrow("unmanaged");
			expect(getOfficialExtensionAction(entry, state, "remove", "user").source).toBe(link);
		} finally {
			rmSync(link);
		}
	});

	it("does not infer identity from a basename, malformed metadata, or another managed package name", () => {
		const directory = join(root, "planner");
		mkdirSync(directory);
		writeFileSync(join(directory, "package.json"), "not json");
		expect(
			inspectOfficialExtension(
				entry,
				[{ source: directory, scope: "user", filtered: false, installedPath: directory }],
				[],
			).installations,
		).toEqual([]);
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@greppleai/planner" }));
		expect(
			inspectOfficialExtension(
				entry,
				[{ source: "npm:unrelated", scope: "user", filtered: false, installedPath: directory }],
				[],
			).installations,
		).toEqual([]);
	});

	it.each([null, "not json", "{}", '{"name":"other-package","version":"9.9.9"}'])(
		"does not call a directory with %s metadata an installed package",
		(manifest) => {
			if (manifest !== null) writeFileSync(join(root, "package.json"), manifest);
			const state = inspectOfficialExtension(
				entry,
				[{ source: target, scope: "user", filtered: false, installedPath: root }],
				[],
			);
			expect(state.installations[0]).toMatchObject({ root, installed: false, version: null });
		},
	);

	it("blocks unknown reserved command or lazy-tool owners, including temporary factories", () => {
		for (const commands of [[], ["planner"]]) {
			const tools = commands.length ? [] : ["planner_done"];
			const state = inspectOfficialExtension(
				entry,
				[],
				[{ path: "<factory>", source: "local", scope: "temporary", commands, tools }],
			);
			expect(state.conflict).toContain("unknown");
			expect(() => getOfficialExtensionAction(entry, state, "install", "user")).toThrow("unknown");
		}
	});

	it("does not confuse a sibling directory or escaping symlink with verified loaded ownership", () => {
		const packageRoot = join(root, "package");
		const sibling = join(root, "package-copy");
		mkdirSync(packageRoot);
		mkdirSync(sibling);
		writeFileSync(join(packageRoot, "package.json"), "{}");
		const extension = join(sibling, "index.ts");
		writeFileSync(extension, "throw new Error('must never execute')");
		const link = join(packageRoot, "index.ts");
		symlinkSync(extension, link);
		const state = inspectOfficialExtension(
			entry,
			[{ source: target, scope: "user", filtered: false, installedPath: packageRoot }],
			[{ path: link, source: target, scope: "user", commands: ["planner"], tools: [] }],
		);
		expect(state.conflict).toContain("unknown");
	});

	it("refuses changes to a loaded runtime even with verified package provenance", () => {
		const extension = join(root, "index.ts");
		writeFileSync(extension, "");
		writeFileSync(join(root, "package.json"), "{}");
		const state = inspectOfficialExtension(
			entry,
			[{ source: "git:github.com/greppleai/planner", scope: "user", filtered: false, installedPath: root }],
			[
				{
					path: extension,
					source: "git:github.com/greppleai/planner",
					scope: "user",
					commands: ["planner"],
					tools: [],
				},
			],
		);
		expect(state.conflict).toBeNull();
		expect(() => getOfficialExtensionAction(entry, state, "upgrade", "user")).toThrow("Loaded extension activity");
		expect(() => getOfficialExtensionAction(entry, state, "remove", "user")).toThrow("Loaded extension activity");
	});

	it.each([
		["git:github.com/greppleai/planner@main", "main"],
		[`git:github.com/untrusted/planner@${revision}`, revision],
		[`git:github.com/greppleai/grip@${revision}`, revision],
		[`git:github.com/greppleai/grip/extensions/planner@${revision}`, revision],
		["npm:@greppleai/planner@latest", "latest"],
		["npm:@greppleai/planner@^1.2.3", "^1.2.3"],
		["npm:@greppleai/planner@1.2.4", "1.2.3"],
	])("rejects unreviewed/moving target %s", (source, pin) => {
		expect(getOfficialExtensionTarget({ ...entry, target: { source, revision: pin } })).toBeNull();
	});

	it("accepts exact declared git and npm targets but never switches source kinds on upgrade", () => {
		expect(getOfficialExtensionTarget(entry)?.source).toBe(target);
		const npm: OfficialExtension = {
			...entry,
			target: { source: "npm:@greppleai/planner@1.2.3", revision: "1.2.3" },
		};
		expect(getOfficialExtensionTarget(npm)?.revision).toBe("1.2.3");
		expect(() =>
			getOfficialExtensionAction(entry, configuredState("npm:@greppleai/planner"), "upgrade", "user"),
		).toThrow("source kinds");
		expect(() => getOfficialExtensionAction(entry, configuredState(target), "upgrade", "user")).toThrow(
			"already configured",
		);
	});
});

describe("explicit official extension package actions", () => {
	const install = vi.fn(async () => {});
	const remove = vi.fn(async () => true);
	let host: OfficialExtensionActionHost;
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grip-catalog-actions-"));
		vi.clearAllMocks();
		host = {
			packages: { installAndPersist: install, removeAndPersist: remove },
			readState: () => empty,
			isIdle: () => true,
			projectAvailable: () => true,
			contextKey: () => "session:/host/project",
			configurationKey: () => "unchanged package settings",
			confirm: async () => false,
			runOperation: async (operation) => operation(),
		};
	});

	it("cancels before starting any package operation", async () => {
		expect(await new OfficialExtensionActions(host).run(entry, "install", "user")).toBe("cancelled");
		expect(install).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("requires script/full-access consent and targets only the selected project scope", async () => {
		host.confirm = vi.fn(async () => true);
		expect(await new OfficialExtensionActions(host).run(entry, "install", "project")).toBe("changed");
		expect(host.confirm).toHaveBeenCalledWith(
			{ kind: "install", source: target, scope: "project" },
			expect.stringContaining("lifecycle scripts"),
		);
		expect(install).toHaveBeenCalledExactlyOnceWith(target, { local: true });
		expect(remove).not.toHaveBeenCalled();
	});

	it("does not report successful removal if the settings entry was not removed", async () => {
		host.readState = () => configuredState("npm:@greppleai/planner");
		host.confirm = async () => true;
		remove.mockResolvedValueOnce(false);
		await expect(new OfficialExtensionActions(host).run(entry, "remove", "user")).rejects.toThrow(
			"files may have changed",
		);
	});

	it("allows explicit removal of an unavailable configured source with data-preservation warning", async () => {
		host.readState = () => configuredState("npm:@greppleai/planner");
		host.confirm = vi.fn(async () => true);
		await new OfficialExtensionActions(host).run(OFFICIAL_EXTENSIONS[0], "remove", "user");
		expect(host.confirm).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "remove" }),
			expect.stringContaining(".planner data are preserved"),
		);
		expect(remove).toHaveBeenCalledExactlyOnceWith("npm:@greppleai/planner", { local: false });
	});

	it("refuses busy sessions and unavailable host project scope before confirmation", async () => {
		host.isIdle = () => false;
		await expect(new OfficialExtensionActions(host).run(entry, "install", "user")).rejects.toThrow("Wait");
		host.isIdle = () => true;
		host.projectAvailable = () => false;
		await expect(new OfficialExtensionActions(host).run(entry, "install", "project")).rejects.toThrow(
			"No host project",
		);
		expect(install).not.toHaveBeenCalled();
	});

	it.each(["state", "activity", "context", "scope", "filters"])(
		"revalidates %s after confirmation",
		async (changed) => {
			host.confirm = async () => {
				if (changed === "state") host.readState = () => configuredState("npm:@greppleai/planner");
				if (changed === "activity") host.isIdle = () => false;
				if (changed === "context") host.contextKey = () => "other-session:/other/project";
				if (changed === "scope") host.projectAvailable = () => false;
				if (changed === "filters") host.configurationKey = () => "changed filter contents";
				return true;
			};
			await expect(new OfficialExtensionActions(host).run(entry, "install", "project")).rejects.toThrow(/changed/);
			expect(install).not.toHaveBeenCalled();
		},
	);

	it("captures state before a dialog instead of retaining mutable owner references", async () => {
		const state = configuredState("git:github.com/greppleai/planner@old");
		host.readState = () => state;
		host.confirm = async () => {
			state.installations[0].source = "git:github.com/greppleai/planner@changed";
			return true;
		};
		await expect(new OfficialExtensionActions(host).run(entry, "remove", "user")).rejects.toThrow("state changed");
		expect(remove).not.toHaveBeenCalled();
	});

	it("revalidates again after terminal handoff and never promises a rollback", async () => {
		host.confirm = async () => true;
		host.runOperation = async (operation) => {
			host.isIdle = () => false;
			await operation();
		};
		await expect(new OfficialExtensionActions(host).run(entry, "install", "user")).rejects.toThrow(
			"activity changed",
		);
		expect(install).not.toHaveBeenCalled();
	});

	it("serializes dialogs, reports partial failures, and releases the lock after failure", async () => {
		let complete: (value: boolean) => void = () => {
			throw new Error("not awaiting confirmation");
		};
		host.confirm = () =>
			new Promise<boolean>((resolve) => {
				complete = resolve;
			});
		const actions = new OfficialExtensionActions(host);
		const pending = actions.run(entry, "install", "user");
		await expect(actions.run(entry, "install", "user")).rejects.toThrow("in progress");
		complete(false);
		await expect(pending).resolves.toBe("cancelled");
		host.confirm = async () => true;
		install.mockRejectedValueOnce(new Error("files changed; settings write failed"));
		await expect(actions.run(entry, "install", "user")).rejects.toThrow("settings write failed");
		expect(remove).not.toHaveBeenCalled();
		await expect(actions.run(entry, "install", "user")).resolves.toBe("changed");
	});

	it("uses the real settings path to preserve project filters without changing user scope", async () => {
		const settings = SettingsManager.inMemory();
		settings.setPackages(["npm:unrelated@1.0.0"]);
		settings.setProjectPackages([
			{ source: "git:github.com/greppleai/planner@old", extensions: ["extensions/index.ts"], skills: [] },
		]);
		const packages = new DefaultPackageManager({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: settings,
		});
		const installFiles = vi.spyOn(packages, "install").mockResolvedValue();
		host.packages = packages;
		host.readState = () => inspectOfficialExtension(entry, packages.listConfiguredPackages(), []);
		host.confirm = async () => true;
		await new OfficialExtensionActions(host).run(entry, "upgrade", "project");
		expect(installFiles).toHaveBeenCalledExactlyOnceWith(target, { local: true });
		expect(settings.getGlobalSettings().packages).toEqual(["npm:unrelated@1.0.0"]);
		expect(settings.getProjectSettings().packages).toEqual([
			{ source: target, extensions: ["extensions/index.ts"], skills: [] },
		]);
		installFiles.mockRestore();
	});
});
