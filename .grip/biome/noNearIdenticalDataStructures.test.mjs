import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeInterfaceSources, analyzeRepository, normalizeInterfaceMember } from "./noNearIdenticalDataStructures.mjs";

function analyze(...sources) {
	return analyzeInterfaceSources(
		sources.map((sourceText, index) => ({ path: `src/fixture-${index + 1}.ts`, sourceText })),
	);
}

describe("noNearIdenticalDataStructures", () => {
	it("normalizes optional, readonly, nullable, unordered union, whitespace, and member order differences", () => {
		const diagnostics = analyze(
			`interface Person {
				age: number;
				readonly name: string | undefined;
				status: string | number;
				id: string;
			}`,
			`interface User {
				id: string;
				name?: string;
				status?: number | undefined | string;
				age: null | number;
			}`,
		);
		assert.equal(diagnostics.length, 2);
		assert.match(diagnostics[0].message, /^\[noNearIdenticalDataStructures\]/);
		assert.match(diagnostics[0].message, /Person/);
		assert.match(diagnostics[1].message, /User/);
	});

	it("does not merge materially different structures or trivial one-member contracts", () => {
		const diagnostics = analyze(`
			interface Person { id: string; age: number; }
			interface User { id: string; age: bigint; }
			interface LeftId { id: string; }
			interface RightId { id?: string | undefined; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("preserves generic constraints and heritage when comparing structures", () => {
		const diagnostics = analyze(`
			interface StringValue<T extends string> { id: string; value: T; }
			interface NumberValue<T extends number> { value: T; id: string; }
			interface StoredValue extends StoredRecord { id: string; value: string; }
			interface WireValue extends WireRecord { value: string; id: string; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("preserves nested structure while normalizing top-level unions", () => {
		assert.equal(
			normalizeInterfaceMember("callback?: ((value: string) => number) | undefined;"),
			"callback:((value:string)=>number)",
		);
		const diagnostics = analyze(`
			interface First { id: string; payload: { value: string }; }
			interface Second { payload: { value: number }; id: string; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("supports a reasoned declaration-level ignore for intentionally distinct domains", () => {
		const diagnostics = analyze(`
			interface Person { id: string; age: number; }
			// grip-ignore noNearIdenticalDataStructures: External user identity has separate lifecycle ownership.
			interface User { age: number | null; id?: string; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("does not accept an ignore directive without a reason", () => {
		const diagnostics = analyze(`
			interface Person { id: string; age: number; }
			// grip-ignore noNearIdenticalDataStructures:
			interface User { age: number | null; id?: string; }
			/* grip-ignore noNearIdenticalDataStructures: */
			interface Account { id: string | undefined; age?: number; }
		`);
		assert.equal(diagnostics.length, 3);
	});

	it("discovers extension TypeScript files and tolerates a missing extensions directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "no-near-identical-data-structures-"));
		try {
			const packageSourceDirectory = join(root, "packages", "fixture", "src");
			await mkdir(packageSourceDirectory, { recursive: true });
			await writeFile(
				join(packageSourceDirectory, "package-contract.ts"),
				"interface PackageContract { id: string; value: number; }\n",
			);

			assert.deepEqual(await analyzeRepository(root), []);

			const extensionSourceDirectory = join(root, "extensions", "fixture", "src");
			await mkdir(extensionSourceDirectory, { recursive: true });
			await writeFile(
				join(extensionSourceDirectory, "extension-contract.ts"),
				"interface ExtensionContract { value: number; id: string; }\n",
			);

			const diagnostics = await analyzeRepository(root);
			assert.equal(diagnostics.length, 2);
			assert.deepEqual(
				diagnostics.map((diagnostic) => diagnostic.location.path),
				[
					"extensions/fixture/src/extension-contract.ts",
					"packages/fixture/src/package-contract.ts",
				],
			);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
