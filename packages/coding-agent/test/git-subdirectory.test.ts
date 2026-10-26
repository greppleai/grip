import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SourceScope } from "../src/core/source-info.ts";
import { type GitSource, getGitSourceIdentity, parseGitUrl } from "../src/utils/git.ts";

interface CommandOptions {
	cwd?: string;
}

interface PackageInternals {
	runCommand(command: string, args: string[], options?: CommandOptions): Promise<void>;
	getGitInstallPath(source: GitSource, scope: SourceScope): string;
}

function parsed(source: string): GitSource {
	const result = parseGitUrl(source);
	if (!result) throw new Error(`Invalid fixture source: ${source}`);
	return result;
}

const repository = "git:github.com/fixture/monorepo";
const sourceA = `${repository}@v1#path=packages/a`;
const sourceB = `${repository}@v1#path=packages/b`;

function writePackage(root: string, name: string): void {
	mkdirSync(join(root, "extensions"), { recursive: true });
	mkdirSync(join(root, "skills", name), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name,
			version: "1.0.0",
			grip: { extensions: ["extensions/index.ts", "extensions/other.ts"], skills: ["skills"] },
			dependencies: { "fixture-runtime": "1.0.0" },
			peerDependencies: { "@greppleai/grip": ">=0.1.5" },
			scripts: { postinstall: "exit 99" },
		}),
	);
	writeFileSync(join(root, "extensions", "index.ts"), "export default function () {}\n");
	writeFileSync(join(root, "extensions", "other.ts"), "export default function () {}\n");
	writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
}

describe("Git subdirectory selectors", () => {
	it.each([
		"git:github.com/fixture/monorepo@feature/branch",
		"https://github.com/fixture/monorepo.git@feature/branch",
		"git:git@github.com:fixture/monorepo@feature/branch",
		"ssh://git@github.com/fixture/monorepo@feature/branch",
		"git://example.com/team/monorepo@feature/branch",
		"git:example.com/team/nested/monorepo@feature/branch",
	])("separates ref, clone URL, and selected directory for %s", (base) => {
		const result = parsed(`${base}#path=packages/a`);
		expect(result.subdirectory).toBe("packages/a");
		expect(result.ref).toBe("feature/branch");
		expect(result.pinned).toBe(true);
		expect(result.repo).not.toContain("#path=");
		expect(result.repo).not.toContain("@feature/");
	});

	it("canonicalizes encoded directory names without changing directory case", () => {
		const a = parsed(`${repository}@v1#path=packages/My%20Package`);
		const b = parsed("git:git@GitHub.com:Fixture/Monorepo@v2#path=packages/My Package");
		expect(a.subdirectory).toBe("packages/My Package");
		expect(getGitSourceIdentity(a)).toBe(getGitSourceIdentity(b));
		expect(getGitSourceIdentity(a)).toBe("github.com/fixture/monorepo#path=packages/My%20Package");
		expect(getGitSourceIdentity(parsed(repository))).not.toBe(getGitSourceIdentity(a));
		expect(getGitSourceIdentity(parsed(sourceA))).not.toBe(getGitSourceIdentity(parsed(sourceB)));
	});

	it.each([
		"",
		".",
		"..",
		"../a",
		"/packages/a",
		"packages/../a",
		"packages/./a",
		"packages//a",
		"packages/a/",
		"packages\\a",
		"%2e%2e/a",
		"packages%2fa",
		"packages/%252e%252e",
		"packages/%00a",
		"packages/a\n",
		"packages/C:/a",
		".git",
		"packages/.GIT/config",
		"packages/*",
		"packages/[ab]",
		"packages/a#path=packages/b",
		"packages/a.",
		"packages/a%",
		"packages/a%23b",
	])("rejects non-literal, ambiguous, or escaping directory %j", (directory) => {
		expect(parseGitUrl(`${repository}@v1#path=${directory}`)).toBeNull();
	});

	it("leaves legacy root and hash-ref parsing intact", () => {
		expect(parsed(repository)).toMatchObject({ subdirectory: null, pinned: false });
		expect(parsed("https://github.com/fixture/monorepo#v1")).toMatchObject({ subdirectory: null, ref: "v1" });
	});
});

describe("Git subdirectory packages in isolated local repositories", () => {
	let directory: string;
	let fixture: string;
	let settings: SettingsManager;
	let manager: DefaultPackageManager;
	let internals: PackageInternals;

	function git(args: string[], cwd = fixture): string {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "grip-git-subdirectory-"));
		fixture = join(directory, "fixture");
		mkdirSync(fixture);
		mkdirSync(join(directory, "tmp"));
		vi.stubEnv("TMPDIR", join(directory, "tmp"));
		vi.stubEnv("HOME", directory);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "empty-gitconfig"));
		writeFileSync(join(directory, "empty-gitconfig"), "");
		git(["init", "--initial-branch=main"]);
		writePackage(fixture, "monorepo-root");
		writePackage(join(fixture, "packages", "a"), "package-a");
		writePackage(join(fixture, "packages", "b"), "package-b");
		mkdirSync(join(fixture, "packages", "no-manifest"));
		writeFileSync(join(fixture, "packages", "no-manifest", "index.ts"), "export default function () {}\n");
		git(["add", "package.json", "extensions", "skills", "packages"]);
		git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture v1"]);
		git(["tag", "v1"]);
		settings = SettingsManager.inMemory();
		manager = new DefaultPackageManager({
			cwd: directory,
			agentDir: join(directory, "agent"),
			settingsManager: settings,
		});
		internals = manager as unknown as PackageInternals;
		// Only local Git runs. Package-manager commands are recorded but never executed.
		vi.spyOn(internals, "runCommand").mockImplementation(async (command, args, options) => {
			if (command !== "git") return;
			if (args[0] === "clone") {
				git(["clone", "--", fixture, args[2]], directory);
			} else {
				git(args, options?.cwd);
			}
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it.each(["user", "project"] as const)("isolates siblings and repository root in %s scope", async (scope) => {
		const local = scope === "project";
		await manager.install(sourceA, { local });
		await manager.install(sourceB, { local });
		await manager.install(`${repository}@v1`, { local });
		const a = manager.getInstalledPath(sourceA, scope)!;
		const b = manager.getInstalledPath(sourceB, scope)!;
		const root = manager.getInstalledPath(repository, scope)!;
		expect(a).not.toBe(b);
		expect(a.startsWith(root)).toBe(false);
		const checkoutA = internals.getGitInstallPath(parsed(sourceA), scope);
		expect(existsSync(join(checkoutA, "package.json"))).toBe(false);
		expect(existsSync(join(checkoutA, "packages", "b"))).toBe(false);
		expect(JSON.parse(readFileSync(join(a, "package.json"), "utf8")).name).toBe("package-a");
		expect(internals.runCommand).toHaveBeenCalledWith(
			"npm",
			["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--workspaces=false", "--prefix", a],
			{ cwd: a },
		);
		await manager.remove(sourceA, { local });
		expect(existsSync(checkoutA)).toBe(false);
		expect(existsSync(b)).toBe(true);
		expect(existsSync(root)).toBe(true);
	});

	it("updates one selected package without changing its sibling or another scope", async () => {
		await manager.install(sourceA);
		await manager.install(sourceB);
		await manager.install(sourceA, { local: true });
		const aCheckout = internals.getGitInstallPath(parsed(sourceA), "user");
		const bCheckout = internals.getGitInstallPath(parsed(sourceB), "user");
		const projectCheckout = internals.getGitInstallPath(parsed(sourceA), "project");
		const v1 = git(["rev-parse", "HEAD"]);
		writeFileSync(join(fixture, "packages", "a", "version.txt"), "v2");
		git(["add", "packages/a/version.txt"]);
		git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture v2"]);
		git(["tag", "v2"]);
		const v2 = git(["rev-parse", "HEAD"]);
		settings.setPackages([`${repository}@v2#path=packages/a`, sourceB]);
		await manager.update(`${repository}@v2#path=packages/a`);
		expect(git(["rev-parse", "HEAD"], aCheckout)).toBe(v2);
		expect(git(["rev-parse", "HEAD"], bCheckout)).toBe(v1);
		expect(git(["rev-parse", "HEAD"], projectCheckout)).toBe(v1);
		expect(existsSync(join(aCheckout, "package.json"))).toBe(false);
	});

	it("preserves package-relative filters and project-over-user deduplication", async () => {
		await manager.install(sourceA);
		await manager.install(sourceA, { local: true });
		await manager.install(sourceB);
		settings.setPackages([sourceA, sourceB]);
		settings.setProjectPackages([{ source: sourceA, extensions: ["!**/other.ts"], skills: [] }]);
		const resources = await manager.resolve();
		const a = manager.getInstalledPath(sourceA, "project")!;
		const aResources = resources.extensions.filter((entry) => entry.metadata.source === sourceA);
		expect(aResources).toHaveLength(2);
		expect(aResources.every((entry) => entry.metadata.scope === "project" && entry.metadata.baseDir === a)).toBe(
			true,
		);
		expect(aResources.find((entry) => entry.path === join(a, "extensions", "index.ts"))?.enabled).toBe(true);
		expect(aResources.find((entry) => entry.path === join(a, "extensions", "other.ts"))?.enabled).toBe(false);
		expect(
			resources.skills.filter((entry) => entry.metadata.source === sourceA).every((entry) => !entry.enabled),
		).toBe(true);
		expect(resources.extensions.filter((entry) => entry.metadata.source === sourceB)).toHaveLength(2);
	});

	it("keeps selector identity when replacing refs and removing settings", () => {
		settings.setPackages([{ source: sourceA, skills: [] }, sourceB, repository]);
		const next = `${repository}@v2#path=packages/a`;
		expect(manager.addSourceToSettings(next)).toBe(true);
		expect(settings.getGlobalSettings().packages).toEqual([{ source: next, skills: [] }, sourceB, repository]);
		expect(manager.removeSourceFromSettings(next)).toBe(true);
		expect(settings.getGlobalSettings().packages).toEqual([sourceB, repository]);
	});

	it("isolates temporary checkouts under the fixture temporary directory", async () => {
		const resources = await manager.resolveExtensionSources([sourceA, sourceB], { temporary: true });
		expect(resources.extensions).toHaveLength(4);
		const a = internals.getGitInstallPath(parsed(sourceA), "temporary");
		const b = internals.getGitInstallPath(parsed(sourceB), "temporary");
		expect(a).not.toBe(b);
		expect(a.startsWith(join(directory, "tmp"))).toBe(true);
		expect(existsSync(join(a, "package.json"))).toBe(false);
	});

	it.each(["packages/missing", "packages/no-manifest"])(
		"rejects %s without installing root dependencies",
		async (path) => {
			await expect(manager.install(`${repository}@v1#path=${path}`)).rejects.toThrow();
			expect(vi.mocked(internals.runCommand).mock.calls.every(([command]) => command === "git")).toBe(true);
		},
	);

	it.each(["npm", "bun", "pnpm"])(
		"retains the configured %s wrapper with scripts and peer installs disabled",
		async (command) => {
			settings.setNpmCommand(["mise", "exec", `${command}@fixture`, "--", command]);
			await manager.install(sourceA);
			const a = manager.getInstalledPath(sourceA, "user")!;
			const calls = vi.mocked(internals.runCommand).mock.calls.filter(([name]) => name !== "git");
			expect(calls).toHaveLength(1);
			expect(calls[0][0]).toBe("mise");
			expect(calls[0][1].slice(0, 5)).toEqual(["exec", `${command}@fixture`, "--", command, "install"]);
			expect(calls[0][1]).toContain("--ignore-scripts");
			expect(calls[0][1]).toContain(
				command === "bun"
					? "--omit=peer"
					: command === "pnpm"
						? "--config.auto-install-peers=false"
						: "--legacy-peer-deps",
			);
			expect(calls[0][2]).toEqual({ cwd: a });
		},
	);

	it.skipIf(process.platform === "win32")("rejects selected-directory symlinks even within the checkout", async () => {
		symlinkSync("a", join(fixture, "packages", "link"), "dir");
		git(["add", "packages/link"]);
		git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture link"]);
		await expect(manager.install(`${repository}#path=packages/link`)).rejects.toThrow(/symbolic link/);
		expect(vi.mocked(internals.runCommand).mock.calls.every(([command]) => command === "git")).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"confines resources to the selected package, not just the repository",
		async () => {
			await manager.install(sourceA);
			const a = manager.getInstalledPath(sourceA, "user")!;
			settings.setPackages([sourceA]);
			symlinkSync(fixture, join(a, "extensions", "escape"), "dir");
			await expect(manager.resolve()).rejects.toThrow(/outside checkout/);
			rmSync(join(a, "extensions", "escape"));
			writeFileSync(join(a, "package.json"), JSON.stringify({ grip: { extensions: ["../b/extensions"] } }));
			await expect(manager.resolve()).rejects.toThrow(/outside package install root/);
		},
	);
});
