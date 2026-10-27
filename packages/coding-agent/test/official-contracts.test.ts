import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertOfficialScope,
	OFFICIAL_REPOSITORY,
	type OfficialManifest,
	type OfficialRelease,
	officialReleaseTag,
	parseOfficialCatalog,
	parseOfficialManifest,
	parseOfficialSource,
	parseOfficialUpdatePolicy,
	selectOfficialRelease,
	validateOfficialRelativePath,
} from "../src/core/official-catalog.ts";
import {
	type OfficialInstallationState,
	officialInstallationRoot,
	officialVersionDirectory,
	parseOfficialState,
	readOfficialState,
} from "../src/core/official-state.ts";

function manifest(version = "1.0.0", range = ">=0.1.0 <1.0.0"): OfficialManifest {
	return {
		name: "@grip-extensions/fixture",
		version,
		description: "Fixture extension",
		type: "module",
		engines: { grip: range },
		grip: {
			official: { id: "fixture", displayName: "Fixture" },
			extensions: ["index.js"],
			skills: [],
			rules: [],
			prompts: [],
			themes: [],
		},
	};
}

function release(version = "1.0.0", range = ">=0.1.0 <1.0.0"): OfficialRelease {
	return {
		manifest: manifest(version, range),
		sourceCommit: "a".repeat(40),
		tag: officialReleaseTag("fixture", version),
		artifact: {
			url: `https://github.com/greppleai/grip/releases/download/extension-fixture-v${version}/fixture-${version}.json.gz`,
			size: 123,
			sha256: "b".repeat(64),
		},
	};
}

function catalog() {
	return { schemaVersion: 1, repository: OFFICIAL_REPOSITORY, extensions: [{ id: "fixture", releases: [release()] }] };
}

function state(): OfficialInstallationState {
	return {
		schemaVersion: 1,
		id: "fixture",
		active: {
			version: "1.0.0",
			sha256: "b".repeat(64),
			directory: officialVersionDirectory("1.0.0", "b".repeat(64)),
		},
		pending: null,
		failure: null,
	};
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("official source and manifest contracts", () => {
	it("keeps official identity distinct without claiming existing source types", () => {
		expect(parseOfficialSource("official:fixture-tools")).toEqual({ type: "official", id: "fixture-tools" });
		for (const source of ["npm:fixture", "git:github.com/greppleai/grip", "./fixture", "/tmp/fixture"]) {
			expect(parseOfficialSource(source)).toBeNull();
		}
		expect(() => assertOfficialScope("user")).not.toThrow();
		for (const scope of ["project", "temporary"]) expect(() => assertOfficialScope(scope)).toThrow(/global/);
	});

	it.each([
		"",
		"..",
		"a/../b",
		"../fixture",
		"A",
		"a_b",
		"a%2fb",
		"a\\b",
		"a@1.0.0",
		"a ",
		"-a",
		"a--b",
		"con",
		"nul",
		"a".repeat(65),
	])("rejects unsafe ID %j", (id) => {
		expect(() => parseOfficialSource(`official:${id}`)).toThrow();
	});

	it.each([
		"/x.js",
		"../x.js",
		"a/../x.js",
		"a//x.js",
		"a\\x.js",
		"C:/x.js",
		"%2e%2e/x.js",
		"a/*.js",
		"a/CON.txt",
		"a./x.js",
		"x.js\0",
	])("rejects unsafe entry path %j", (entry) => {
		expect(() => validateOfficialRelativePath(entry)).toThrow();
	});

	it("validates the canonical package.json without executing it", () => {
		expect(parseOfficialManifest(manifest(), "fixture")).toEqual(manifest());
		expect(() => parseOfficialManifest(manifest(), "other")).toThrow(/ID/);
		for (const version of ["v1.0.0", "01.0.0", "1", "nope", "1.0.0+mutable"]) {
			expect(() => parseOfficialManifest(manifest(version), "fixture")).toThrow();
		}
		expect(() => parseOfficialManifest(manifest("1.0.0", "not a range"), "fixture")).toThrow(/range/);
		const invalid = manifest();
		invalid.grip.extensions = [] as unknown as [string];
		expect(() => parseOfficialManifest(invalid, "fixture")).toThrow(/entry point/);
	});
});

describe("official catalog", () => {
	it("accepts an empty catalog, rejecting unsupported schemas, repositories and duplicates", () => {
		expect(
			parseOfficialCatalog({ schemaVersion: 1, repository: OFFICIAL_REPOSITORY, extensions: [] }).extensions,
		).toEqual([]);
		expect(parseOfficialCatalog(catalog())).toEqual(catalog());
		expect(() => parseOfficialCatalog({ ...catalog(), schemaVersion: 2 })).toThrow(/schema/);
		expect(() => parseOfficialCatalog({ ...catalog(), repository: "attacker/grip" })).toThrow(/repository/);
		const duplicate = catalog();
		duplicate.extensions.push(duplicate.extensions[0]);
		expect(() => parseOfficialCatalog(duplicate)).toThrow(/Duplicate/);
		const duplicateRelease = catalog();
		duplicateRelease.extensions[0].releases.push(release());
		expect(() => parseOfficialCatalog(duplicateRelease)).toThrow(/Duplicate/);
	});

	it.each([0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER, "123"])("rejects invalid artifact size %j", (size) => {
		const invalidRelease = { ...release(), artifact: { ...release().artifact, size } };
		const value = { ...catalog(), extensions: [{ id: "fixture", releases: [invalidRelease] }] };
		expect(() => parseOfficialCatalog(value)).toThrow(/size/);
	});

	it("pins artifact origin, source commit, tag and digest", () => {
		for (const url of [
			"http://github.com/x",
			"https://github.com.evil/x",
			`${release().artifact.url}?token=1`,
			release().artifact.url.replace("greppleai", "attacker"),
			release().artifact.url.replace("1.0.0", "2.0.0"),
		]) {
			const value = catalog();
			value.extensions[0].releases[0].artifact.url = url;
			expect(() => parseOfficialCatalog(value)).toThrow(/URL/);
		}
		for (const digest of ["", "A".repeat(64), "../state.json", "a".repeat(63)]) {
			const value = catalog();
			value.extensions[0].releases[0].artifact.sha256 = digest;
			expect(() => parseOfficialCatalog(value)).toThrow(/digest/);
		}
		const value = catalog();
		value.extensions[0].releases[0].sourceCommit = "main";
		expect(() => parseOfficialCatalog(value)).toThrow(/commit/);
		value.extensions[0].releases[0] = { ...release(), tag: "v1.0.0" };
		expect(() => parseOfficialCatalog(value)).toThrow(/tag/);
	});

	it("selects the highest compatible stable release, not the latest overall", () => {
		const entry = {
			id: "fixture",
			releases: [release("1.2.0"), release("1.10.0"), release("2.0.0", ">=1"), release("3.0.0-beta.1")],
		};
		expect(selectOfficialRelease(entry, "0.1.8")?.manifest.version).toBe("1.10.0");
		expect(selectOfficialRelease(entry, "0.1.8", "1.2.0")?.manifest.version).toBe("1.10.0");
		expect(selectOfficialRelease(entry, "0.1.8", "1.10.0")).toBeNull();
		expect(selectOfficialRelease(entry, "0.1.8", "4.0.0")).toBeNull();
		expect(selectOfficialRelease(entry, "0.0.1")).toBeNull();
	});

	it("bounds network policy and supports explicit auto-update opt-out", () => {
		expect(parseOfficialUpdatePolicy().autoUpdate).toBe(true);
		expect(parseOfficialUpdatePolicy({ autoUpdate: false }).autoUpdate).toBe(false);
		expect(parseOfficialUpdatePolicy({ requestTimeoutMs: 100 }).requestTimeoutMs).toBe(100);
		for (const value of [
			{ autoUpdate: "false" },
			{ startupBudgetMs: 60001 },
			{ requestTimeoutMs: 0 },
			{ catalogMaxAgeMs: Infinity },
		]) {
			expect(() => parseOfficialUpdatePolicy(value)).toThrow();
		}
	});
});

describe("observed installation state", () => {
	it("requires exact identity and immutable relative version directory", () => {
		expect(parseOfficialState(state(), "fixture")).toEqual(state());
		expect(() => parseOfficialState(state(), "other")).toThrow(/ID/);
		expect(() => parseOfficialState({ ...state(), schemaVersion: 2 }, "fixture")).toThrow(/schema/);
		for (const directory of ["/tmp/user.ts", "../extensions", "versions/1.0.0", "versions/../../x"]) {
			const value = state();
			if (value.active) value.active.directory = directory;
			expect(() => parseOfficialState(value, "fixture")).toThrow(/directory/);
		}
		expect(officialInstallationRoot("/tmp/custom-agent", "fixture")).toBe(
			join("/tmp/custom-agent", "official", "fixture"),
		);
	});

	it("records pending activation and actionable failures without losing the old active version", () => {
		const value = state();
		value.pending = {
			operation: "install",
			target: {
				version: "2.0.0",
				sha256: "c".repeat(64),
				directory: officialVersionDirectory("2.0.0", "c".repeat(64)),
			},
		};
		value.failure = { code: "network", message: "Download timed out; retry install", at: 42 };
		expect(parseOfficialState(value, "fixture")).toEqual(value);
		value.pending.target = null;
		expect(() => parseOfficialState(value, "fixture")).toThrow(/target/);
		value.pending = { operation: "remove", target: null };
		expect(parseOfficialState(value, "fixture").pending).toEqual(value.pending);
	});

	it("distinguishes missing and corrupt state and never treats either as owned", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "grip-official-contracts-"));
		temporaryDirectories.push(agentDir);
		expect((await readOfficialState(agentDir, "fixture")).status).toBe("missing");
		const root = officialInstallationRoot(agentDir, "fixture");
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "state.json"), "{broken");
		expect(await readOfficialState(agentDir, "fixture")).toMatchObject({ status: "corrupt", state: null });
		await writeFile(join(root, "state.json"), JSON.stringify(state()));
		expect(await readOfficialState(agentDir, "fixture")).toEqual({ status: "valid", state: state(), error: null });
	});
});
