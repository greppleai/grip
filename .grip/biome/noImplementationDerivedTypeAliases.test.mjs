import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeRepository, analyzeTypeAliasSource } from "./noImplementationDerivedTypeAliases.mjs";

function analyze(sourceText) {
	return analyzeTypeAliasSource("packages/example/src/fixture.ts", sourceText);
}

function writeFixtureFile(repositoryRoot, path, contents) {
	const filePath = join(repositoryRoot, path);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

async function withTemporaryRepository(run) {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "grip-implementation-derived-type-aliases-"));
	try {
		await run(repositoryRoot);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
}

describe("noImplementationDerivedTypeAliases", () => {
	it("reports aliases derived through return, parameter, and indexed member extraction", () => {
		const diagnostics = analyze(`
			declare function load(input: LoadInput): Promise<LoadResult>;
			interface Service {
				handler?: (input: LoadInput) => Promise<LoadResult>;
				load(): Promise<LoadResult>;
			}
			type LoadedResult = ReturnType<Service["load"]>;
			type LoadArgument = Parameters<typeof load>[0];
			type Handler = NonNullable<Service["handler"]>;
			type HandlerResult = Exclude<Awaited<ReturnType<Handler>>, undefined>;
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[7, 8, 9, 10],
		);
		assert.match(diagnostics[0].message, /^\[noImplementationDerivedTypeAliases\]/);
		assert.match(diagnostics[0].message, /ReturnType, indexed member access/);
		assert.match(diagnostics[1].message, /Parameters/);
		assert.match(diagnostics[2].message, /indexed member access/);
	});

	it("allows stable named contracts and non-contract utility annotations", () => {
		const diagnostics = analyze(`
			interface LoadInput { path: string; }
			interface LoadResult { content: string; }
			type OptionalResult = LoadResult | undefined;
			type ResultFields = Pick<LoadResult, "content">;
			const timer: ReturnType<typeof setTimeout> | undefined = undefined;
			function run(input: string): LoadResult {
				return { content: input };
			}
			void timer;
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("reports implementation-derived types used directly in function signatures", () => {
		const diagnostics = analyze(`
			interface Model { id: string; }
			class AgentSession {
				model: Model | undefined;
				requireModel(): NonNullable<AgentSession["model"]> {
					throw new Error();
				}
			}
			declare function consume(input: Parameters<(value: string) => void>[0]): void;
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[5, 9],
		);
		assert.match(diagnostics[0].message, /requireModel derives a function signature contract/);
		assert.match(diagnostics[0].message, /indexed member access/);
		assert.match(diagnostics[1].message, /Parameters/);
	});

	it("preserves package discovery when extensions is absent", async () => {
		await withTemporaryRepository(async (repositoryRoot) => {
			writeFixtureFile(repositoryRoot, "packages/example/src/flagged.ts", "type Value = ReturnType<typeof load>;");
			writeFixtureFile(repositoryRoot, "packages/example/other/ignored.ts", "type Value = ReturnType<typeof load>;");

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
				"type Value = ReturnType<typeof load>;",
			);
			for (const directory of [".git", ".worktrees", "dist", "node_modules"]) {
				writeFixtureFile(
					repositoryRoot,
					`extensions/official/${directory}/ignored.ts`,
					"type Value = ReturnType<typeof load>;",
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
