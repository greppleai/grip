import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalGripPackageDir = process.env.GRIP_PACKAGE_DIR;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

interface PackageInstallFixture {
	packageDir: string;
}

interface NpmPrefixInstallFixture extends PackageInstallFixture {
	prefix: string;
}

interface PnpmGlobalInstallFixture extends PackageInstallFixture {
	root: string;
}

interface YarnGlobalInstallFixture extends PackageInstallFixture {
	globalDir: string;
}

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalGripPackageDir === undefined) {
		delete process.env.GRIP_PACKAGE_DIR;
	} else {
		process.env.GRIP_PACKAGE_DIR = originalGripPackageDir;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "grip-prefix-"): NpmPrefixInstallFixture {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@greppleai");
	const packageDir = join(scopeDir, "grip");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.GRIP_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.ts"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): PnpmGlobalInstallFixture {
	const temp = mkdtempSync(join(tmpdir(), "grip-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@greppleai", "grip");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.GRIP_PACKAGE_DIR = packageDir;
	setExecPath(join(root, ".pnpm", "@greppleai+grip@0.0.0", "node_modules", "@greppleai", "grip", "dist", "cli.ts"));
	return { root, packageDir };
}

function createYarnGlobalInstall(): YarnGlobalInstallFixture {
	const temp = mkdtempSync(join(tmpdir(), "grip-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@greppleai", "grip");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.GRIP_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@greppleai", "grip", "dist", "cli.ts"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): PackageInstallFixture {
	const temp = mkdtempSync(join(tmpdir(), "grip-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@greppleai");
	const packageDir = join(scopeDir, "grip");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.GRIP_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.ts"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@greppleai+grip@0.67.68\\node_modules\\@greppleai\\grip\\dist\\cli.ts",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@greppleai/grip")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @greppleai/grip",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@greppleai/grip")).toBeUndefined();
		expect(getUpdateInstruction("@greppleai/grip")).toBe(
			"Update @greppleai/grip using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@greppleai/grip");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@greppleai/grip"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @greppleai/grip`,
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@greppleai/grip", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@greppleai/grip"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @greppleai/grip`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@greppleai/grip", []);

		expect(command?.args).toEqual([
			"--prefix",
			prefix,
			"install",
			"-g",
			"--ignore-scripts",
			"--min-release-age=0",
			"@greppleai/grip",
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		const command = getSelfUpdateCommand("@greppleai/grip");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @greppleai/grip`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@greppleai\\grip";
		process.env.GRIP_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@greppleai/grip")).toBe(
			"Run: npm install -g --ignore-scripts --min-release-age=0 @greppleai/grip",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@greppleai/grip");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@greppleai/grip"],
			display: "bun install -g --ignore-scripts --minimum-release-age=0 @greppleai/grip",
		});
	});

	test("self-updates pnpm global installs without uninstalling", () => {
		createPnpmGlobalInstall();
		const command = getSelfUpdateCommand("@greppleai/grip");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@greppleai/grip"],
			display: "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @greppleai/grip",
		});
	});

	test("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "grip-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@greppleai/grip";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@greppleai", "grip");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@greppleai",
			"grip",
			"0.75.0",
			"hash",
			"node_modules",
			"@greppleai",
			"grip",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.GRIP_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.ts");
		setExecPath(join(storePackageDir, "dist", "cli.ts"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test("self-updates yarn global installs without uninstalling", () => {
		createYarnGlobalInstall();
		const command = getSelfUpdateCommand("@greppleai/grip");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@greppleai/grip"],
			display: "yarn global add --ignore-scripts @greppleai/grip",
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@greppleai/grip")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@greppleai/grip")).toContain("the install path is not writable");
	});
});
