import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeRepository, analyzeStringLiteralUnionSource } from "./noInlineStringLiteralUnions.mjs";

function analyze(sourceText) {
	return analyzeStringLiteralUnionSource("packages/example/src/fixture.ts", sourceText);
}

function writeFixtureFile(repositoryRoot, path, contents) {
	const filePath = join(repositoryRoot, path);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

async function withTemporaryRepository(run) {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "grip-string-literal-unions-"));
	try {
		await run(repositoryRoot);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
}

describe("noInlineStringLiteralUnions", () => {
	it("reports inline string-literal unions in interface and class properties", () => {
		const diagnostics = analyze(`
			export interface PiAgentDiagnostic {
				type: "info" | "warning" | "error";
				message: string;
			}
			class WorkspaceState {
				availability: "remote" | "unavailable" = "unavailable";
			}
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[3, 7],
		);
		assert.match(diagnostics[0].message, /^\[noInlineStringLiteralUnions\]/);
		assert.match(diagnostics[0].message, /named type alias/);
		assert.match(diagnostics[0].message, /do not use an enum/);
	});

	it("reports inline string-literal unions in parameters and return types", () => {
		const diagnostics = analyze(`
			function resolveWorkspaceToolExecution(
				mode: "local" | "remote",
			): "remote" | "unavailable" {
				return mode === "remote" ? "remote" : "unavailable";
			}
			interface Resolver {
				resolve(mode: "local" | "remote"): Promise<"remote" | "unavailable">;
			}
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[3, 4, 8, 8],
		);
	});

	it("reports constructor parameters and nested signature annotations without duplicates", () => {
		const diagnostics = analyze(`
			class Runner {
				constructor(public mode: "local" | "remote") {}
				handler: (state: "idle" | "running") => Promise<"done" | "failed">;
			}
		`);
		assert.equal(diagnostics.length, 3);
	});

	it("allows named string-literal unions and does not require enums", () => {
		const diagnostics = analyze(`
			type WorkspaceAvailability = "remote" | "unavailable";
			type DiagnosticType = "info" | "warning" | "error";
			interface Diagnostic {
				type: DiagnosticType;
			}
			class Resolver {
				resolve(mode: WorkspaceAvailability): WorkspaceAvailability {
					return mode;
				}
			}
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("does not report single literals, property-key unions, or unrelated annotations", () => {
		const diagnostics = analyze(`
			interface Fixed { type: "info"; value: string | number; }
			interface State { left: string; right: string; }
			type InlineOptions = { mode: "local" | "remote" };
			const value: "left" | "right" = "left";
			function select(input: Pick<State, "left" | "right">): State["left" | "right"] {
				return input.left;
			}
			void value;
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("preserves package discovery when extensions is absent", async () => {
		await withTemporaryRepository(async (repositoryRoot) => {
			writeFixtureFile(
				repositoryRoot,
				"packages/example/src/flagged.ts",
				'interface Value { status: "enabled" | "disabled"; }',
			);
			writeFixtureFile(
				repositoryRoot,
				"packages/example/other/ignored.ts",
				'interface Value { status: "enabled" | "disabled"; }',
			);

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
				'interface Value { status: "enabled" | "disabled"; }',
			);
			for (const directory of [".git", ".worktrees", "dist", "node_modules"]) {
				writeFixtureFile(
					repositoryRoot,
					`extensions/official/${directory}/ignored.ts`,
					'interface Value { status: "enabled" | "disabled"; }',
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
