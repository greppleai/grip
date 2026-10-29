import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compare, inc, prerelease } from "semver";
import { type OfficialCatalog, type OfficialRelease, officialObject, officialReleaseTag, parseOfficialManifest } from "../packages/coding-agent/src/core/official-catalog.ts";
import { mergeOfficialReleases, packageOfficialExtension } from "./official-extensions.ts";
import { type OfficialPublisher, publishOfficialExtension } from "./publish-official-extension.ts";

export interface OfficialVersionChange {
	id: string;
	version: string;
	manifestPath: string;
	manifestText: string;
}

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Also used by read-only CI: only the disposable checkout's manifests are changed. */
export async function prepareOfficialVersions(root: string, previous: OfficialCatalog): Promise<OfficialVersionChange[]> {
	const changes: OfficialVersionChange[] = [];
	const commit = git(root, ["rev-parse", "HEAD"]);
	for (const entry of (await readdir(join(root, "extensions"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.endsWith(".md")) continue;
		if (!entry.isDirectory()) throw new Error(`Unexpected official extension entry: ${entry.name}`);
		const result = await packageOfficialExtension(join(root, "extensions", entry.name), commit);
		let version = result.release.manifest.version;
		if (prerelease(version) !== null) throw new Error(`Official automatic releases must be stable: ${entry.name}`);
		const releases = previous.extensions.find(extension => extension.id === entry.name)?.releases ?? [];
		const latest = [...releases].sort((a, b) => compare(b.manifest.version, a.manifest.version))[0];
		if (latest) {
			if (compare(version, latest.manifest.version) < 0) throw new Error(`Official source version is behind publication: ${entry.name}`);
			const paths = git(root, ["diff", "--name-only", latest.sourceCommit, "--", `extensions/${entry.name}/`]);
			if (!paths && result.release.artifact.sha256 === latest.artifact.sha256) continue;
			if (version === latest.manifest.version) {
				const next = inc(version, "patch");
				if (!next) throw new Error(`Cannot increment official version: ${entry.name}`);
				version = next;
			}
		}
		const manifestPath = `extensions/${entry.name}/package.json`;
		const text = await readFile(join(root, manifestPath), "utf8");
		const pkg = officialObject(JSON.parse(text), "package");
		parseOfficialManifest(pkg, entry.name);
		// Preserve all formatting and non-version metadata in the source manifest.
		const manifestText = text.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${version}$2`);
		if (JSON.parse(manifestText).version !== version) throw new Error(`Cannot update official version: ${entry.name}`);
		changes.push({ id: entry.name, version, manifestPath, manifestText });
	}
	// Finish planning all extensions before applying any edits.
	for (const change of changes) await writeFile(join(root, change.manifestPath), change.manifestText);
	return changes;
}

/** Runs only in the serialized main workflow, after tests, with a clean full-history checkout. */
export async function publishAutomaticOfficialExtensions(root: string, publisher: OfficialPublisher): Promise<void> {
	if (git(root, ["status", "--porcelain"])) throw new Error("Automatic official publication requires a clean checkout");
	const previous = await publisher.readCatalog();
	const changes = await prepareOfficialVersions(root, previous);
	if (!changes.length) {
		// readCatalog can recover a backup after interrupted primary replacement.
		// Restore discovery even when every release is already present in that backup.
		await publisher.publishCatalog(previous);
		console.log("No official extension changes to publish; catalog refreshed");
		return;
	}
	const tags = changes.map(change => officialReleaseTag(change.id, change.version));
	const sourceCommits = new Map<string, string>();
	for (const [index, change] of changes.entries()) {
		const tag = tags[index];
		if (!git(root, ["tag", "--list", tag])) continue;
		// A failed catalog publication may have already pushed this immutable tag.
		// Reuse it only if both the extension and packaging inputs still match.
		const paths = git(root, ["diff", "--name-only", tag, "--", `extensions/${change.id}/`, "package-lock.json", "scripts/"]);
		if (paths) throw new Error(`Pending official tag ${tag} differs from main; retry publication on that tag before releasing newer changes`);
		sourceCommits.set(tag, git(root, ["rev-parse", `${tag}^{commit}`]));
	}
	// Validate generated versions and the complete merged catalog before pushing tags.
	const releases: OfficialRelease[] = [];
	const provisionalCommit = git(root, ["rev-parse", "HEAD"]);
	for (const [index, change] of changes.entries()) {
		const result = await packageOfficialExtension(join(root, "extensions", change.id), sourceCommits.get(tags[index]) ?? provisionalCommit);
		releases.push(result.release);
	}
	mergeOfficialReleases(previous, releases);
	if (git(root, ["diff", "--name-only"]).length) {
		git(root, ["add", "--", ...changes.map(change => change.manifestPath)]);
		git(root, ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m", "chore(extensions): bump changed official extensions"]);
	}
	const commit = git(root, ["rev-parse", "HEAD"]);
	for (const tag of tags) {
		if (sourceCommits.has(tag)) continue;
		git(root, ["tag", tag, commit]);
		sourceCommits.set(tag, commit);
	}
	// Never force: a concurrent main push must reject the whole branch/tag update.
	git(root, ["push", "--atomic", "origin", "HEAD:refs/heads/main", ...tags.map(tag => `refs/tags/${tag}`)]);
	// GITHUB_TOKEN pushes do not trigger tag workflows; publish in this job directly.
	for (const [index, change] of changes.entries()) {
		const result = await packageOfficialExtension(join(root, "extensions", change.id), sourceCommits.get(tags[index])!);
		await publishOfficialExtension(result, publisher);
	}
}
