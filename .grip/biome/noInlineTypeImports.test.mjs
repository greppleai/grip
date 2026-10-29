import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeInlineTypeImportSource, analyzeRepository } from "./noInlineTypeImports.mjs";

function analyze(sourceText) {
	return analyzeInlineTypeImportSource("packages/example/src/fixture.ts", sourceText);
}

function writeFixtureFile(repositoryRoot, path, contents) {
	const filePath = join(repositoryRoot, path);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

async function withTemporaryRepository(run) {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "grip-inline-type-imports-"));
	try {
		await run(repositoryRoot);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
}

describe("noInlineTypeImports", () => {
	it("reports inline module types, imported members, assertions, and generic arguments", () => {
		const diagnostics = analyze(`
			type Photon = typeof import("photon-node");
			let theme: typeof import("./theme.ts").theme;
			function render(value: import("./theme.ts").Theme): import("./render.ts").RenderResult {
				return value as typeof import("./render.ts").fallback;
			}
			declare function importActual<T>(path: string): Promise<T>;
			void importActual<typeof import("node:fs")>("node:fs");
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[2, 3, 4, 4, 5, 8],
		);
		assert.match(diagnostics[0].message, /^\[noInlineTypeImports\]/);
		assert.match(diagnostics[1].message, /\.\/theme\.ts/);
	});

	it("allows top-level type imports and runtime dynamic imports", () => {
		const diagnostics = analyze(`
			import type { Theme } from "./theme.ts";
			import type * as PhotonModule from "photon-node";
			let theme: Theme;
			type Photon = typeof PhotonModule;
			async function load() {
				return await import("./runtime.ts");
			}
			void theme;
			void load;
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("preserves package discovery when extensions is absent", async () => {
		await withTemporaryRepository(async (repositoryRoot) => {
			writeFixtureFile(repositoryRoot, "packages/example/src/flagged.ts", 'type Value = import("example").Value;');
			writeFixtureFile(repositoryRoot, "packages/example/other/ignored.ts", 'type Value = import("example").Value;');

			const diagnostics = await analyzeRepository(repositoryRoot);

			assert.deepEqual(
				diagnostics.map((diagnostic) => diagnostic.location.path),
				["packages/example/src/flagged.ts"],
			);
		});
	});

	it("discovers official extension TypeScript while excluding ignored directories", async () => {
		await withTemporaryRepository(async (repositoryRoot) => {
			writeFixtureFile(repositoryRoot, "packages/example/src/allowed.ts", "type Value = string;");
			writeFixtureFile(
				repositoryRoot,
				"extensions/official/extensions/flagged.ts",
				'type Value = import("example").Value;',
			);
			for (const directory of [".git", ".worktrees", "dist", "node_modules"]) {
				writeFixtureFile(
					repositoryRoot,
					`extensions/official/${directory}/ignored.ts`,
					'type Value = import("example").Value;',
				);
			}

			const diagnostics = await analyzeRepository(repositoryRoot);

			assert.deepEqual(
				diagnostics.map((diagnostic) => diagnostic.location.path),
				["extensions/official/extensions/flagged.ts"],
			);
		});
	});
});
