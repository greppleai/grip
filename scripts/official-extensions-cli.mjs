import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseOfficialCatalog, officialReleaseTag, validateOfficialId } from "../packages/coding-agent/src/core/official-catalog.ts";
import { checkOfficialVersionChanges, emptyOfficialCatalog, packageOfficialExtension, packageOfficialRepository } from "./official-extensions.ts";
import { GitHubOfficialPublisher, publishOfficialExtension } from "./publish-official-extension.ts";

const args = process.argv.slice(2);
const command = args.shift();
const values = new Map();
while (args.length) {
	const key = args.shift();
	const value = args.shift();
	if (!["--root", "--out", "--previous", "--base", "--id"].includes(key) || !value || values.has(key)) throw new Error("Invalid official extension CLI arguments");
	values.set(key, value);
}
const root = resolve(values.get("--root") ?? ".");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (values.has("--base")) checkOfficialVersionChanges(root, values.get("--base"));
if (command === "pack") {
	const output = values.get("--out");
	if (!output) throw new Error("pack requires --out PATH");
	const previous = values.has("--previous") ? parseOfficialCatalog(JSON.parse(await readFile(values.get("--previous"), "utf8"))) : emptyOfficialCatalog();
	await packageOfficialRepository(root, resolve(output), commit, previous);
} else if (command === "publish") {
	if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "greppleai/grip" || process.env.GITHUB_EVENT_NAME !== "push") throw new Error("Publication is restricted to the official tag workflow");
	const id = validateOfficialId(values.get("--id"));
	const result = await packageOfficialExtension(join(root, "extensions", id), commit);
	if (process.env.GITHUB_REF !== `refs/tags/${officialReleaseTag(id, result.release.manifest.version)}`) throw new Error("Publication tag does not match manifest version");
	const tagCommit = execFileSync("git", ["rev-parse", `${process.env.GITHUB_REF}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
	if (tagCommit !== commit) throw new Error("Publication checkout does not match extension tag");
	await publishOfficialExtension(result, new GitHubOfficialPublisher(process.env.GH_TOKEN ?? ""));
} else if (command === "validate-published") {
	const publisher = new GitHubOfficialPublisher(process.env.GH_TOKEN ?? "");
	const previous = await publisher.readCatalog();
	const output = values.get("--out");
	if (!output) throw new Error("validate-published requires --out PATH");
	await mkdir(resolve(output), { recursive: true });
	await writeFile(join(resolve(output), "previous-catalog.json"), JSON.stringify(previous));
	await packageOfficialRepository(root, resolve(output), commit, previous);
} else {
	throw new Error("Use pack --out PATH [--previous CATALOG] [--base REF], validate-published --out PATH, or publish --id ID");
}