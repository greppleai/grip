import { describe, expect, it } from "vitest";
import { createExtensionInventory, type ExtensionInventoryInput } from "../src/core/extension-inventory.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function emptyInput(): ExtensionInventoryInput {
	return {
		configuredPackages: [],
		resources: [],
		diagnostics: [],
		result: { extensions: [], errors: [], runtime: createExtensionRuntime() },
		noExtensions: false,
	};
}

describe("extension inventory contracts", () => {
	it("includes explicit SDK factories without inventing management rights or versions", async () => {
		const result = await createTestExtensionsResult([() => {}]);
		const loader = createTestResourceLoader({ extensionsResult: result });
		const rows = await loader.getExtensionInventory();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status: "loaded",
			configured: false,
			version: null,
			removal: null,
			scope: "temporary",
		});
		expect(rows[0].entries[0].path).toBe("<inline:1>");
		expect(await createTestResourceLoader().getExtensionInventory()).toEqual([]);
	});
	it("merges aliases using the canonical manager identity but keeps separate settings scopes", () => {
		const input = emptyInput();
		const https = "git:github.com/fixture/repo";
		const ssh = "git:git@github.com:fixture/repo";
		input.configuredPackages = [https, ssh].map((source) => ({
			source,
			scope: "user",
			identity: https,
			managed: true,
			filtered: false,
			installedPath: "/fixture/repo",
			version: null,
			error: null,
		}));
		input.configuredPackages.push({ ...input.configuredPackages[0], scope: "project" });
		input.resources = ["first.ts", "second.ts"].map((name) => ({
			path: `/fixture/repo/${name}`,
			enabled: false,
			metadata: { source: ssh, scope: "user", origin: "package" },
		}));
		const rows = createExtensionInventory(input);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ scope: "user", status: "disabled" });
		expect(rows[0].entries).toHaveLength(2);
		expect(rows[1]).toMatchObject({ scope: "project", status: "not-loaded" });
	});
	it("does not suppress explicit temporary paths with noExtensions or infer ownership for failed manual paths", () => {
		const input = emptyInput();
		input.noExtensions = true;
		input.resources = [
			{
				path: "/manual/explicit.ts",
				enabled: true,
				metadata: { source: "cli", scope: "temporary", origin: "top-level" },
			},
		];
		input.result.errors = [
			{
				path: "/manual/broken.ts",
				error: "Fixture failure",
				sourceInfo: { path: "/manual/broken.ts", source: "unclassified", scope: "temporary", origin: "top-level" },
			},
		];
		const rows = createExtensionInventory(input);
		expect(rows[0]).toMatchObject({ status: "not-loaded", removal: null, version: null });
		expect(rows[1]).toMatchObject({ status: "failed", removal: null, version: null });
		expect(rows[1].entries[0]).toMatchObject({
			errors: ["Fixture failure"],
			sourceInfo: { path: "/manual/broken.ts", scope: "temporary", source: "unclassified" },
		});
	});
	it("returns detached metadata so consumers cannot mutate the loader snapshot", () => {
		const input = emptyInput();
		input.resources = [
			{
				path: "/fixture/entry.js",
				enabled: false,
				metadata: {
					source: "official:fixture",
					scope: "user",
					origin: "package",
					official: { id: "fixture", version: "1.0.0" },
				},
			},
		];
		const rows = createExtensionInventory(input);
		rows[0].entries[0].sourceInfo.official!.version = "invented";
		expect(createExtensionInventory(input)[0].entries[0].sourceInfo.official!.version).toBe("1.0.0");
	});
});
