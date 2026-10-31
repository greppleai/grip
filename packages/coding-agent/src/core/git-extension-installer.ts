import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import type { InstalledSourceScope } from "./package-manager.ts";

export interface GitExtensionPreparation {
	id: string;
	source: string;
	requestedRef: string | null;
	commit: string;
	scope: InstalledSourceScope;
	warning: string;
	profile: string | null;
	name: string | null;
	version: string | null;
	entries: string[];
}

export interface GitExtensionPrepareOptions {
	scope: InstalledSourceScope;
	signal: AbortSignal;
}

export interface GitExtensionInstallerDependencies {
	getTarget: (source: GitSource, scope: InstalledSourceScope) => string;
	getProfile: () => string | null;
	isOffline: () => boolean;
	validateResources: (root: string) => void;
	runGit: (args: string[], cwd: string) => Promise<string>;
	installDependencies: (root: string) => Promise<void>;
	beforePublish: (scope: InstalledSourceScope) => void;
	persist: (source: string, scope: InstalledSourceScope, profile: string | null) => Promise<void>;
}

interface PreparedCheckout {
	review: GitExtensionPreparation;
	parsed: GitSource;
	staging: string;
	checkout: string;
	target: string;
	manifest: string;
	entryHashes: string[];
}

function displayText(value: unknown): string | null {
	return typeof value === "string"
		? stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		: null;
}

function installationError(error: unknown): Error {
	return new Error(
		displayText(error instanceof Error ? error.message : String(error)) ?? "Git extension installation failed.",
	);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stricter input policy for the manager; existing CLI source parsing is unchanged. */
export function parseExtensionGitUrl(input: string): GitSource {
	const source = input.trim().replace(/^git:(?=https?:\/\/|ssh:\/\/)/i, "");
	if (
		/[\u0000-\u001f\u007f-\u009f]/.test(input) ||
		!/^(https|ssh):\/\//i.test(source) ||
		/[\u0000-\u0020\u007f-\u009f?#]/.test(source)
	) {
		throw new Error(
			"Enter an HTTPS or SSH Git URL, optionally followed by @ref. Other sources are not supported here.",
		);
	}
	const url = new URL(source);
	if (url.password || (url.protocol === "https:" && url.username)) {
		throw new Error("Do not embed credentials in Git URLs. Use your configured Git credential helper or SSH keys.");
	}
	const parsed = parseGitUrl(source);
	if (!parsed || parsed.ref?.startsWith("-") || source.endsWith("@")) throw new Error("Invalid Git URL or ref.");
	return parsed;
}

/** Manifest recognition is data-only: never import the repository to inspect its exports. */
function inspectCheckout(root: string): Pick<GitExtensionPreparation, "name" | "version" | "entries"> {
	const canonicalRoot = realpathSync(root);
	const manifestPath = join(root, "package.json");
	if (!lstatSync(manifestPath).isFile()) throw new Error("Root package.json must be a regular file.");
	const pkg: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
	if (!object(pkg) || !object(pkg.grip) || !Array.isArray(pkg.grip.extensions) || pkg.grip.extensions.length === 0) {
		throw new Error("Root package.json must declare a nonempty grip.extensions array of entry files.");
	}
	const entries = new Set<string>();
	for (const entry of pkg.grip.extensions) {
		if (
			typeof entry !== "string" ||
			!entry ||
			isAbsolute(entry) ||
			/^[a-z]:/i.test(entry) ||
			/[\\*?[\]{}!+\u0000-\u001f\u007f-\u009f]/.test(entry) ||
			entry.startsWith("-") ||
			entry.split("/").includes("..") ||
			!/\.(ts|js)$/.test(entry)
		)
			throw new Error(
				"grip.extensions must contain concrete repository-relative .ts or .js files, not directories or patterns.",
			);
		const path = resolve(root, entry);
		const rel = relative(canonicalRoot, realpathSync(path));
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(path).isFile()) {
			throw new Error("Extension entries must be regular files confined to the checkout.");
		}
		// Verify readability without interpreting or executing source.
		readFileSync(path);
		entries.add(rel.split(sep).join("/"));
	}
	return { name: displayText(pkg.name), version: displayText(pkg.version), entries: [...entries] };
}

/** Owns disposable preparations. Only install() grants permission to run dependency scripts. */
export class GitExtensionInstaller {
	private readonly dependencies: GitExtensionInstallerDependencies;
	private readonly prepared = new Map<string, PreparedCheckout>();

	constructor(dependencies: GitExtensionInstallerDependencies) {
		this.dependencies = dependencies;
	}

	async prepare(input: string, options: GitExtensionPrepareOptions): Promise<GitExtensionPreparation> {
		const parsed = parseExtensionGitUrl(input);
		options.signal.throwIfAborted();
		if (this.dependencies.isOffline()) throw new Error("Git extension installation is unavailable offline.");
		const profile = this.dependencies.getProfile();
		const target = this.dependencies.getTarget(parsed, options.scope);
		this.requireAbsent(target);
		mkdirSync(dirname(target), { recursive: true });
		// Recheck confinement after creating parents, before creating staging alongside the target.
		this.dependencies.getTarget(parsed, options.scope);
		const staging = mkdtempSync(`${target}.grip-stage-`);
		const checkout = join(staging, "checkout");
		const hooks = join(staging, "empty-hooks");
		const git = async (args: string[], cwd: string) => {
			options.signal.throwIfAborted();
			const result = await this.dependencies.runGit(
				["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", ...args],
				cwd,
			);
			options.signal.throwIfAborted();
			return result;
		};
		try {
			mkdirSync(hooks);
			await git(["clone", "--template=", "--no-checkout", "--", parsed.repo, checkout], staging);
			if (parsed.ref) await git(["fetch", "--no-tags", "origin", parsed.ref], checkout);
			const commit = (
				await git(["rev-parse", "--verify", `${parsed.ref ? "FETCH_HEAD" : "HEAD"}^{commit}`], checkout)
			).trim();
			if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git did not return a valid commit ID.");
			await git(["checkout", "--detach", commit], checkout);
			const metadata = inspectCheckout(checkout);
			this.dependencies.validateResources(checkout);
			const review: GitExtensionPreparation = {
				id: randomUUID(),
				source: parsed.repo,
				requestedRef: parsed.ref ?? null,
				commit,
				scope: options.scope,
				profile,
				warning:
					"Unverified third-party code. Extensions and dependency scripts run with your full user permissions. This package may also supply skills, rules, prompts and themes. Validation is not sandboxing or publisher authentication.",
				...metadata,
			};
			this.prepared.set(review.id, {
				review,
				parsed,
				staging,
				checkout,
				target,
				manifest: readFileSync(join(checkout, "package.json"), "utf-8"),
				entryHashes: metadata.entries.map((entry) =>
					createHash("sha256")
						.update(readFileSync(join(checkout, entry)))
						.digest("hex"),
				),
			});
			return structuredClone(review);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw installationError(error);
		}
	}

	discard(id: string): void {
		const preparation = this.prepared.get(id);
		if (!preparation) return;
		this.prepared.delete(id);
		rmSync(preparation.staging, { recursive: true, force: true });
	}

	/** The caller invokes this only after explicit approval of the displayed preparation. */
	async install(id: string): Promise<string> {
		const preparation = this.prepared.get(id);
		if (!preparation) throw new Error("Git preparation expired. Prepare the source again.");
		// Consume before awaiting: duplicate approval cannot run scripts twice.
		this.prepared.delete(id);
		const { review, parsed, staging, checkout, target } = preparation;
		const lock = `${target}.grip-install-lock`;
		let locked = false;
		try {
			if (this.dependencies.isOffline()) throw new Error("Git extension installation is unavailable offline.");
			if (this.dependencies.getProfile() !== review.profile)
				throw new Error("Active profile changed. Prepare the source again.");
			this.dependencies.getTarget(parsed, review.scope);
			this.requireAbsent(target);
			try {
				mkdirSync(lock);
			} catch {
				throw new Error("Git extension installation is busy. Retry after the other operation settles.");
			}
			locked = true;
			await this.verify(preparation);
			this.dependencies.validateResources(checkout);
			await this.dependencies.installDependencies(checkout);
			await this.verify(preparation);
			this.dependencies.validateResources(checkout);
			this.dependencies.getTarget(parsed, review.scope);
			this.dependencies.beforePublish(review.scope);
			this.requireAbsent(target);
			if (this.dependencies.getProfile() !== review.profile)
				throw new Error("Active profile changed. Prepare the source again.");
			// Reserve exclusively before rename; never rename over a manual or concurrent target.
			mkdirSync(target);
			try {
				renameSync(checkout, target);
			} catch (error) {
				// Only the empty reservation is ours. Never recursively remove a target here.
				rmdirSync(target);
				throw error;
			}
			const source = `${parsed.repo}@${review.commit}`;
			try {
				await this.dependencies.persist(source, review.scope, review.profile);
			} catch (error) {
				throw new Error(
					"Files installed, but package selection could not be verified. Review inventory/settings before retrying.",
					{ cause: error },
				);
			}
			return source;
		} catch (error) {
			throw installationError(error);
		} finally {
			rmSync(staging, { recursive: true, force: true });
			if (locked) rmdirSync(lock);
		}
	}

	private requireAbsent(target: string): void {
		if (lstatSync(target, { throwIfNoEntry: false }))
			throw new Error(
				"This Git package is already installed. Manage it with the existing CLI install/update commands.",
			);
	}

	private async verify(preparation: PreparedCheckout): Promise<void> {
		const { checkout, staging, review, manifest } = preparation;
		const head = await this.dependencies.runGit(
			[
				"-c",
				`core.hooksPath=${join(staging, "empty-hooks")}`,
				"-c",
				"core.fsmonitor=false",
				"-c",
				"submodule.recurse=false",
				"rev-parse",
				"HEAD",
			],
			checkout,
		);
		if (head.trim() !== review.commit || readFileSync(join(checkout, "package.json"), "utf-8") !== manifest) {
			throw new Error("Prepared checkout changed. Prepare the source again.");
		}
		const metadata = inspectCheckout(checkout);
		const entryHashes = metadata.entries.map((entry) =>
			createHash("sha256")
				.update(readFileSync(join(checkout, entry)))
				.digest("hex"),
		);
		if (
			JSON.stringify(metadata.entries) !== JSON.stringify(review.entries) ||
			JSON.stringify(entryHashes) !== JSON.stringify(preparation.entryHashes)
		) {
			throw new Error("Prepared entries changed.");
		}
	}
}
