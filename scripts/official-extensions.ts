import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import ts from "typescript-ast";
import {
	decodeOfficialArtifact, encodeOfficialArtifact, officialJson, officialSha256,
	type OfficialArtifactContents, type OfficialArtifactFile,
} from "../packages/coding-agent/src/core/official-artifact.ts";
import {
	OFFICIAL_LIMITS, OFFICIAL_REPOSITORY, type OfficialCatalog, type OfficialRelease,
	officialObject, officialReleaseTag, parseOfficialCatalog, parseOfficialManifest, parseOfficialRelease,
	validateOfficialId, validateOfficialRelativePath,
} from "../packages/coding-agent/src/core/official-catalog.ts";

// Exact loader virtual-module keys, not wildcard package externals. No arbitrary Grip subpaths.
export const OFFICIAL_EXTERNALS = [
	"@greppleai/grip", "@greppleai/grip-coding-agent", "@greppleai/grip-agent-core",
	"@greppleai/grip-ai", "@greppleai/grip-ai/oauth", "@greppleai/grip-tui",
	"typebox", "typebox/compile", "typebox/value",
	"@sinclair/typebox", "@sinclair/typebox/compile", "@sinclair/typebox/value",
];

export interface OfficialPackageResult {
	release: OfficialRelease;
	bytes: Buffer;
}

export function emptyOfficialCatalog(): OfficialCatalog {
	return { schemaVersion: 1, repository: OFFICIAL_REPOSITORY, extensions: [] };
}

export function mergeOfficialReleases(previous: OfficialCatalog, releases: OfficialRelease[]): OfficialCatalog {
	const catalog = parseOfficialCatalog(previous);
	const seen = new Set<string>();
	for (const value of releases) {
		const id = value.manifest.grip.official.id;
		const release = parseOfficialRelease(value, id);
		const key = `${id}@${release.manifest.version}`;
		if (seen.has(key)) throw new Error(`Duplicate release input: ${key}`);
		seen.add(key);
		let entry = catalog.extensions.find((entry) => entry.id === id);
		if (!entry) { entry = { id, releases: [] }; catalog.extensions.push(entry); }
		const existing = entry.releases.find((item) => item.manifest.version === release.manifest.version);
		// An unchanged extension rebuilt by a later core commit retains its original source reference.
		if (existing && officialJson({ ...existing, sourceCommit: release.sourceCommit }) !== officialJson(release)) throw new Error(`Cannot reuse published version: ${key}`);
		if (!existing) entry.releases.push(release);
	}
	catalog.extensions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	for (const entry of catalog.extensions) entry.releases.sort((a, b) => a.manifest.version < b.manifest.version ? -1 : a.manifest.version > b.manifest.version ? 1 : 0);
	if (Buffer.byteLength(officialJson(catalog)) + 1 > OFFICIAL_LIMITS.catalogBytes) throw new Error("Official catalog exceeds size limit");
	return catalog;
}

async function readContainedFile(root: string, path: string): Promise<Buffer> {
	validateOfficialRelativePath(path);
	const canonicalRoot = await realpath(root);
	let target = canonicalRoot;
	for (const part of path.split("/")) {
		target = join(target, part);
		if ((await lstat(target)).isSymbolicLink()) throw new Error(`Symlink is not permitted: ${path}`);
	}
	const inside = relative(canonicalRoot, await realpath(target));
	if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside) || !(await lstat(target)).isFile())
		throw new Error(`Not a contained regular file: ${path}`);
	if ((await lstat(target)).size > OFFICIAL_LIMITS.expandedBytes) throw new Error(`Oversized file: ${path}`);
	return readFile(target);
}

function auditRuntimeImports(source: string, path: string): void {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			const loader = expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(expression) && ["require", "createRequire", "eval"].includes(expression.text)) ||
				(ts.isPropertyAccessExpression(expression) && ["require", "createRequire", "resolve"].includes(expression.name.text) && expression.expression.getText(file) === "require");
			if (loader && (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || expression.getText(file).includes("createRequire") || expression.getText(file) === "eval"))
				throw new Error(`Unsupported computed runtime import/loader in ${path}`);
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
}

/** Build only; never imports the author's entry point or runs install/lifecycle scripts. */
export async function packageOfficialExtension(directory: string, sourceCommit: string): Promise<OfficialPackageResult> {
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("Extension directory must not be a symlink");
	const root = await realpath(directory);
	const id = validateOfficialId(basename(root));
	const pkg = officialObject(JSON.parse((await readContainedFile(root, "package.json")).toString("utf8")), "package");
	const manifest = parseOfficialManifest(pkg, id);
	const sourceEntry = manifest.grip.extensions[0];
	await readContainedFile(root, sourceEntry);
	manifest.grip.extensions = [sourceEntry.replace(/\.(?:ts|js|mjs)$/, ".js")];
	const outputPath = manifest.grip.extensions[0];
	const result = await build({
		absWorkingDir: root, entryPoints: [sourceEntry], outfile: outputPath, allowOverwrite: true,
		bundle: true, packages: "bundle", platform: "node", format: "esm", target: "node24",
		write: false, metafile: true, logLevel: "silent", legalComments: "eof", charset: "utf8",
		tsconfigRaw: {},
		plugins: [{ name: "official-runtime-contract", setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => {
				if (args.path === "module" || args.path === "node:module") throw new Error("Custom runtime loaders are unsupported");
				if (OFFICIAL_EXTERNALS.includes(args.path) || isBuiltin(args.path)) {
					if (args.kind === "require-call") return { path: args.path, namespace: "official-commonjs-external" };
					return { path: args.path, external: true };
				}
				if (/^@greppleai\/grip(?:[-/]|$)/.test(args.path)) throw new Error(`Unsupported Grip runtime subpath: ${args.path}`);
				if (args.path.endsWith(".node")) throw new Error("Native dependencies are unsupported for official artifacts");
				return undefined;
			});
			// Static ESM imports keep CommonJS dependency externals on jiti's alias/virtual-module path.
			// A Node createRequire banner would bypass virtual modules in the standalone executable.
			builder.onLoad({ filter: /.*/, namespace: "official-commonjs-external" }, (args) => ({
				contents: isBuiltin(args.path)
					? `import value from ${JSON.stringify(args.path)}; module.exports = value;`
					: `import * as value from ${JSON.stringify(args.path)}; module.exports = value;`,
				loader: "js",
			}));
			builder.onLoad({ filter: /\.(?:[cm]?[jt]s|tsx|jsx)$/ }, async (args) => {
				const inside = relative(root, args.path);
				if ((inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) && !args.path.split(sep).includes("node_modules")) throw new Error(`Bundle input outside extension/dependencies: ${args.path}`);
				const contents = await readFile(args.path, "utf8");
				auditRuntimeImports(contents, args.path);
				const extension = extname(args.path);
				const loader = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : "js";
				return { contents, loader };
			});
		} }],
	});
	if (result.warnings.length) throw new Error(`Unsupported bundle: ${result.warnings.map((warning) => warning.text).join("; ")}`);
	for (const output of Object.values(result.metafile.outputs)) {
		for (const imported of output.imports) {
			if (!imported.external || (!OFFICIAL_EXTERNALS.includes(imported.path) && !isBuiltin(imported.path)))
				throw new Error(`Unresolved runtime import: ${imported.path}`);
		}
	}
	if (result.outputFiles.length !== 1) throw new Error("Expected one bundled extension entry");
	const files: OfficialArtifactFile[] = [
		{ path: "package.json", base64: Buffer.from(officialJson(manifest)).toString("base64") },
		{ path: outputPath, base64: Buffer.from(result.outputFiles[0].contents).toString("base64") },
	];
	const declared = pkg.files ?? [];
	if (!Array.isArray(declared) || declared.some((value) => typeof value !== "string")) throw new Error("Official package files must be an array of exact asset paths");
	const assets = new Set<string>(["LICENSE", ...declared, ...manifest.grip.skills, ...manifest.grip.rules, ...manifest.grip.prompts, ...manifest.grip.themes]);
	for (const path of [...assets].sort()) {
		validateOfficialRelativePath(path);
		if (path === "package.json" || path === outputPath || /\.(?:[cm]?[jt]s|tsx|jsx|node)$/i.test(path)) throw new Error(`Assets must not replace code: ${path}`);
		files.push({ path, base64: (await readContainedFile(root, path)).toString("base64") });
	}
	// Preserve third-party notices from every bundled dependency, including transitive inputs.
	const dependencyRoots = new Set<string>();
	for (const input of Object.keys(result.metafile.inputs)) {
		const path = resolve(root, input);
		const parts = path.split(sep);
		const index = parts.lastIndexOf("node_modules");
		if (index < 0) continue;
		const end = index + (parts[index + 1]?.startsWith("@") ? 3 : 2);
		dependencyRoots.add(parts.slice(0, end).join(sep));
	}
	const notices: string[] = [];
	for (const dependencyRoot of [...dependencyRoots].sort()) {
		const metadata = officialObject(JSON.parse(await readFile(join(dependencyRoot, "package.json"), "utf8")), "dependency package");
		const licenses = (await readdir(dependencyRoot)).filter((name) => /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(name)).sort();
		if (!licenses.length || typeof metadata.license !== "string") throw new Error(`Dependency license review required: ${metadata.name}`);
		const text: string[] = [];
		for (const name of licenses) text.push((await readContainedFile(dependencyRoot, name)).toString("utf8"));
		notices.push(`${metadata.name}@${metadata.version} (${metadata.license})\n${text.join("\n")}`);
	}
	files.push({ path: "THIRD-PARTY-NOTICES.txt", base64: Buffer.from(notices.sort().join("\n\n")).toString("base64") });
	const contents: OfficialArtifactContents = { schemaVersion: 1, manifest, files };
	const bytes = encodeOfficialArtifact(contents);
	const tag = officialReleaseTag(id, manifest.version);
	const release = parseOfficialRelease({ manifest, sourceCommit, tag, artifact: {
		url: `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${tag}/${id}-${manifest.version}.json.gz`,
		size: bytes.length, sha256: officialSha256(bytes),
	} }, id);
	decodeOfficialArtifact(bytes, release);
	return { release, bytes };
}

export async function packageOfficialRepository(root: string, output: string, sourceCommit: string, previous: OfficialCatalog): Promise<OfficialCatalog> {
	const releases: OfficialRelease[] = [];
	await mkdir(output, { recursive: true });
	for (const entry of (await readdir(join(root, "extensions"), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		if (entry.name.endsWith(".md")) continue;
		if (!entry.isDirectory()) throw new Error(`Unexpected official extension entry: ${entry.name}`);
		const result = await packageOfficialExtension(join(root, "extensions", entry.name), sourceCommit);
		releases.push(result.release);
		await writeFile(join(output, `${entry.name}-${result.release.manifest.version}.json.gz`), result.bytes);
	}
	const catalog = mergeOfficialReleases(previous, releases);
	await writeFile(join(output, "catalog.json"), `${officialJson(catalog)}\n`);
	return catalog;
}
