import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseExtensionGitUrl } from "../src/core/git-extension-installer.ts";
import { DefaultPackageManager, type InstalledSourceScope } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { type CommandOptions, git, type NpmCommand } from "./fixtures/local-git.ts";

const source = "https://example.com/author/extension";
const signal = () => new AbortController().signal;

describe("reviewed Git extension installation", () => {
	let root: string;
	let remote: string;
	let agentDir: string;
	let settings: SettingsManager;
	let manager: DefaultPackageManager;
	let gitCalls: string[][];
	let npm: ReturnType<typeof vi.fn<NpmCommand>>;
	let storage: InMemorySettingsStorage;

	function target(scope: InstalledSourceScope = "user"): string {
		return join(scope === "project" ? join(root, ".grip") : agentDir, "git", "example.com", "author", "extension");
	}

	function commit(pkg: unknown = { grip: { extensions: ["extension.ts"] } }): string {
		writeFileSync(join(remote, "package.json"), JSON.stringify(pkg));
		git(["add", "."], remote);
		git(["commit", "--allow-empty", "-m", "fixture"], remote);
		return git(["rev-parse", "HEAD"], remote).trim();
	}

	function attachManager(): void {
		manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
		const internals = manager as unknown as {
			runCommandCapture: (command: string, args: string[], options: CommandOptions) => Promise<string>;
			runNpmCommand: NpmCommand;
		};
		internals.runCommandCapture = async (command, args, options) => {
			expect(command).toBe("git");
			gitCalls.push([...args]);
			const localArgs = args.map((arg) => (arg === source ? remote : arg));
			return git(localArgs, options.cwd);
		};
		internals.runNpmCommand = npm;
	}

	function staging(): string[] {
		const parent = dirname(target());
		return existsSync(parent) ? readdirSync(parent).filter((name) => name.includes(".grip-")) : [];
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grip-git-review-"));
		remote = join(root, "remote");
		agentDir = join(root, "agent");
		mkdirSync(remote);
		git(["init", "--initial-branch=main"], remote);
		git(["config", "user.email", "fixture@example.com"], remote);
		git(["config", "user.name", "Fixture"], remote);
		// Importing this file would fail. Recognition must never execute it.
		writeFileSync(join(remote, "extension.ts"), "throw new Error('DO NOT EXECUTE'); export default () => {};\n");
		storage = new InMemorySettingsStorage();
		settings = SettingsManager.fromStorage(storage, root);
		gitCalls = [];
		npm = vi.fn(async () => {});
		attachManager();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each([
		"npm:extension",
		"./local",
		"github.com/author/extension",
		"git:github.com/author/extension",
		"git@github.com:author/extension",
		"http://example.com/author/extension",
		"file:///tmp/repo",
		"git://example.com/a/b",
		"https://token@example.com/a/b",
		"ssh://git:password@example.com/a/b",
		"https://example.com/a/b?token=x",
		"https://example.com/a/b#ref",
		"https://example.com/a/b\n@main",
		"\nhttps://example.com/a/b",
		"https://example.com/a/b@",
		"https://example.com/a/b@-main",
	])("rejects %s without starting commands", async (input) => {
		await expect(manager.prepareGitExtension(input, { scope: "user", signal: signal() })).rejects.toThrow();
		expect(gitCalls).toEqual([]);
		expect(npm).not.toHaveBeenCalled();
	});

	it("accepts explicit HTTPS/SSH URLs and the optional git: prefix/ref", () => {
		expect(parseExtensionGitUrl(`git:${source}@main`).ref).toBe("main");
		expect(parseExtensionGitUrl("ssh://git@example.com/author/extension@v1").repo).toBe(
			"ssh://git@example.com/author/extension",
		);
	});

	it("prepares data only, sanitizes metadata, deduplicates entries, and discards idempotently", async () => {
		commit({
			name: "\u001b[31munsafe\nname",
			version: "1.0",
			grip: { extensions: ["extension.ts", "./extension.ts"] },
		});
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		expect(review.name).toBe("unsafe name");
		expect(review.entries).toEqual(["extension.ts"]);
		expect(review.warning).toContain("full user permissions");
		expect(npm).not.toHaveBeenCalled();
		expect(settings.getPackages()).toEqual([]);
		expect(existsSync(target())).toBe(false);
		manager.discardGitExtension(review.id);
		manager.discardGitExtension(review.id);
		expect(staging()).toEqual([]);
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("expired");
	});

	it.each([
		{},
		{ grip: { extensions: [] } },
		{ grip: { extensions: "extension.ts" } },
		{ grip: { extensions: ["missing.ts"] } },
		{ grip: { extensions: ["../extension.ts"] } },
		{ grip: { extensions: ["/tmp/extension.ts"] } },
		{ grip: { extensions: ["*.ts"] } },
		{ grip: { extensions: ["extensions"] } },
		{ grip: { extensions: [false] } },
	])("rejects invalid or convention-only manifests: %j", async (pkg) => {
		commit(pkg);
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: signal() })).rejects.toThrow();
		expect(npm).not.toHaveBeenCalled();
		expect(settings.getPackages()).toEqual([]);
		expect(staging()).toEqual([]);
	});

	it("rejects a symlink escape without reading or executing the entry", async () => {
		symlinkSync(join(root, "outside.ts"), join(remote, "escape.ts"));
		writeFileSync(join(root, "outside.ts"), "outside");
		commit({ grip: { extensions: ["escape.ts"] } });
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: signal() })).rejects.toThrow(
			"confined",
		);
		expect(npm).not.toHaveBeenCalled();
		expect(staging()).toEqual([]);
	});

	it("accepts confined symlinks and deduplicates their canonical entries", async () => {
		symlinkSync("extension.ts", join(remote, "alias.ts"));
		commit({ grip: { extensions: ["alias.ts", "extension.ts"] } });
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		expect(review.entries).toEqual(["extension.ts"]);
		manager.discardGitExtension(review.id);
	});

	it.each(["user", "project"] as const)("pins the reviewed commit despite a moving ref in %s scope", async (scope) => {
		const reviewedCommit = commit();
		const review = await manager.prepareGitExtension(`${source}@main`, { scope, signal: signal() });
		writeFileSync(join(remote, "extension.ts"), "export default () => 'new';");
		commit();
		const pinned = await manager.installPreparedGitExtension(review.id);
		expect(pinned).toBe(`${source}@${reviewedCommit}`);
		expect(git(["rev-parse", "HEAD"], target(scope)).trim()).toBe(reviewedCommit);
		expect(npm).toHaveBeenCalledTimes(1);
		const packages =
			scope === "project" ? settings.getProjectSettings().packages : settings.getUserSettings().packages;
		expect(packages).toContain(pinned);
		expect(staging()).toEqual([]);
	});

	it("persists membership in the active profile", async () => {
		storage.withLock("global", () => JSON.stringify({ profiles: { work: { packages: [] } } }));
		settings = SettingsManager.fromStorage(storage, root);
		settings.useProfile("work");
		attachManager();
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		const pinned = await manager.installPreparedGitExtension(review.id);
		expect(settings.getProfile("work")?.packages).toContain(pinned);
		expect(settings.getGlobalSettings().packages ?? []).toEqual([]);
	});

	it("cleans up canceled and failed preparations without running npm", async () => {
		commit();
		const controller = new AbortController();
		controller.abort();
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: controller.signal })).rejects.toThrow();
		expect(gitCalls).toEqual([]);
		const internals = manager as unknown as { runCommandCapture: () => Promise<string> };
		const pending = new AbortController();
		internals.runCommandCapture = async () => {
			pending.abort();
			return "";
		};
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: pending.signal })).rejects.toThrow();
		expect(staging()).toEqual([]);
		expect(npm).not.toHaveBeenCalled();
	});

	it("consumes approval once and never selects after dependency failure", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		npm.mockRejectedValue(new Error("dependency failed"));
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("dependency failed");
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("expired");
		expect(npm).toHaveBeenCalledTimes(1);
		expect(settings.getPackages()).toEqual([]);
		expect(existsSync(target())).toBe(false);
		expect(staging()).toEqual([]);
	});

	it("rejects tampered entries before running dependency scripts", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		writeFileSync(join(dirname(target()), staging()[0], "checkout", "extension.ts"), "tampered");
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("entries changed");
		expect(npm).not.toHaveBeenCalled();
		expect(staging()).toEqual([]);
	});

	it("retains installed files and reports reconciliation when settings persistence fails", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		vi.spyOn(storage, "withLock").mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("Files installed");
		expect(existsSync(target())).toBe(true);
		expect(settings.getPackages()).toEqual([]);
		expect(staging()).toEqual([]);
	});

	it("preserves existing/manual targets before preparation and after approval", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		mkdirSync(target());
		writeFileSync(join(target(), "manual"), "keep");
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("already installed");
		const count = gitCalls.length;
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: signal() })).rejects.toThrow(
			"already installed",
		);
		expect(gitCalls).toHaveLength(count);
		expect(readFileSync(join(target(), "manual"), "utf-8")).toBe("keep");
		expect(npm).not.toHaveBeenCalled();
	});

	it("locks concurrent commits and does not delete another operation's lock", async () => {
		commit();
		const first = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		const second = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		const installing = manager.installPreparedGitExtension(first.id);
		await expect(manager.installPreparedGitExtension(second.id)).rejects.toThrow("busy");
		expect(existsSync(`${target()}.grip-install-lock`)).toBe(true);
		await installing;
		expect(npm).toHaveBeenCalledTimes(1);
		expect(staging()).toEqual([]);
	});
	it.each(["missing", "malformed", "symlink", "directory"])("rejects %s manifest/entry structures", async (kind) => {
		commit();
		const manifest = join(remote, "package.json");
		if (kind === "missing") rmSync(manifest);
		if (kind === "malformed") writeFileSync(manifest, "{not-json");
		if (kind === "symlink") {
			rmSync(manifest);
			writeFileSync(join(remote, "metadata.json"), JSON.stringify({ grip: { extensions: ["extension.ts"] } }));
			symlinkSync("metadata.json", manifest);
		}
		if (kind === "directory") {
			rmSync(join(remote, "extension.ts"));
			mkdirSync(join(remote, "extension.ts"));
			writeFileSync(join(remote, "extension.ts", "index.ts"), "export default () => {};");
		}
		git(["add", "."], remote);
		git(["commit", "-m", "invalid structure"], remote);
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: signal() })).rejects.toThrow();
		expect(npm).not.toHaveBeenCalled();
		expect(staging()).toEqual([]);
	});

	it("cleans a fetch failure and sanitizes untrusted error text", async () => {
		const internals = manager as unknown as { runCommandCapture: () => Promise<string> };
		internals.runCommandCapture = async () => {
			throw new Error("remote: \u001b[31muntrusted\nmessage");
		};
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: signal() })).rejects.toThrow(
			"remote: untrusted message",
		);
		expect(staging()).toEqual([]);
		expect(npm).not.toHaveBeenCalled();
	});

	it.each(["manifest", "entry", "resource"])("does not select after npm changes a reviewed %s", async (kind) => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		npm.mockImplementation(async (_args, options) => {
			if (kind === "manifest") writeFileSync(join(options.cwd, "package.json"), "{}");
			if (kind === "entry") writeFileSync(join(options.cwd, "extension.ts"), "export default () => {};");
			if (kind === "resource") {
				mkdirSync(join(root, "outside-skills"));
				symlinkSync(join(root, "outside-skills"), join(options.cwd, "skills"));
			}
		});
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow();
		expect(settings.getPackages()).toEqual([]);
		expect(existsSync(target())).toBe(false);
		expect(staging()).toEqual([]);
	});

	it("rejects a profile switch before running approved scripts", async () => {
		storage.withLock("global", () => JSON.stringify({ profiles: { work: { packages: [] } } }));
		await settings.reload();
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		settings.useProfile("work");
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("profile changed");
		expect(npm).not.toHaveBeenCalled();
		expect(staging()).toEqual([]);
	});

	it("disables checkout hooks, templates, fsmonitor and submodule recursion", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		for (const args of gitCalls) {
			expect(args).toContain("core.fsmonitor=false");
			expect(args).toContain("submodule.recurse=false");
			expect(args.some((arg) => arg.startsWith("core.hooksPath="))).toBe(true);
		}
		expect(gitCalls.find((args) => args.includes("clone"))).toContain("--template=");
		expect(gitCalls.find((args) => args.includes("clone"))).toContain("--no-checkout");
		manager.discardGitExtension(review.id);
	});
	it("rejects offline preparation and approval without running npm", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		vi.stubEnv("GRIP_OFFLINE", "1");
		const count = gitCalls.length;
		await expect(manager.prepareGitExtension(source, { scope: "user", signal: signal() })).rejects.toThrow("offline");
		expect(gitCalls).toHaveLength(count);
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("offline");
		expect(npm).not.toHaveBeenCalled();
		expect(staging()).toEqual([]);
	});

	it("preserves a target created while dependencies were installing", async () => {
		commit();
		const review = await manager.prepareGitExtension(source, { scope: "user", signal: signal() });
		npm.mockImplementation(async () => {
			mkdirSync(target());
			writeFileSync(join(target(), "manual"), "keep");
		});
		await expect(manager.installPreparedGitExtension(review.id)).rejects.toThrow("already installed");
		expect(readFileSync(join(target(), "manual"), "utf-8")).toBe("keep");
		expect(settings.getPackages()).toEqual([]);
		expect(staging()).toEqual([]);
	});
});
