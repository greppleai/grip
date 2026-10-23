import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AutocompleteItem } from "@greppleai/grip-tui";
import type { PortablePathFlavor } from "../core/lsp/portable-path.ts";

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

export function resolveDirectoryPath(value: string, cwd: string): string | undefined {
	try {
		const directory = realpathSync(resolve(cwd, expandHome(value)));
		return statSync(directory).isDirectory() ? directory : undefined;
	} catch {
		return undefined;
	}
}

function isDirectory(directory: string, name: string): boolean {
	try {
		return statSync(join(directory, name)).isDirectory();
	} catch {
		return false;
	}
}

/** Build immediate child-directory completions for a path relative to cwd. */
export function getDirectoryCompletions(argumentPrefix: string, cwd: string): AutocompleteItem[] {
	const quoted = argumentPrefix.startsWith('"');
	const rawPrefix = (quoted ? argumentPrefix.slice(1) : argumentPrefix).replaceAll("\\", "/");
	if (rawPrefix === "~") {
		return [{ value: "~/", label: "~/" }];
	}

	const expandedPrefix = expandHome(rawPrefix);
	const hasTrailingSeparator = rawPrefix.endsWith("/");
	const searchDirectory = resolveDirectoryPath(hasTrailingSeparator ? rawPrefix : dirname(rawPrefix), cwd);
	if (!searchDirectory) return [];
	const namePrefix = hasTrailingSeparator ? "" : basename(expandedPrefix);
	const displayDirectory = hasTrailingSeparator
		? rawPrefix
		: rawPrefix.includes("/")
			? rawPrefix.slice(0, rawPrefix.lastIndexOf("/") + 1)
			: "";

	try {
		return readdirSync(searchDirectory, { withFileTypes: true })
			.filter((entry) => entry.name.toLowerCase().startsWith(namePrefix.toLowerCase()))
			.filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(searchDirectory, entry.name)))
			.map((entry) => {
				const directoryPath = `${displayDirectory}${entry.name}/`;
				const needsQuotes = quoted || directoryPath.includes(" ");
				return {
					value: needsQuotes ? `"${directoryPath}"` : directoryPath,
					label: `${entry.name}/`,
				};
			})
			.sort((left, right) => left.label.localeCompare(right.label));
	} catch {
		return [];
	}
}

interface SandboxDirectoryOperations {
	readdir(path: string): Promise<string[]>;
	resolveWorkspaceDirectory(path: string): Promise<string>;
}

/** Complete guest paths through the active sandbox, never through the host filesystem. */
export async function getSandboxDirectoryCompletions(
	argumentPrefix: string,
	cwd: string,
	pathFlavor: PortablePathFlavor,
	operations: SandboxDirectoryOperations,
): Promise<AutocompleteItem[]> {
	const paths = pathFlavor === "windows" ? win32 : posix;
	const quoted = argumentPrefix.startsWith('"');
	const rawPrefix = (quoted ? argumentPrefix.slice(1) : argumentPrefix).replaceAll("\\", "/");
	const hasTrailingSeparator = rawPrefix.endsWith("/");
	const parent = hasTrailingSeparator ? rawPrefix : paths.dirname(rawPrefix);
	const namePrefix = hasTrailingSeparator ? "" : paths.basename(rawPrefix);
	const displayDirectory = hasTrailingSeparator
		? rawPrefix
		: rawPrefix.includes("/")
			? rawPrefix.slice(0, rawPrefix.lastIndexOf("/") + 1)
			: "";
	try {
		const searchDirectory = await operations.resolveWorkspaceDirectory(paths.resolve(cwd, parent));
		const names = await operations.readdir(searchDirectory);
		const matches = names.filter((name) => name.toLowerCase().startsWith(namePrefix.toLowerCase()));
		const items: AutocompleteItem[] = [];
		// Bound concurrent daemon requests for large directories such as node_modules.
		for (let index = 0; index < matches.length; index += 16) {
			const batch = await Promise.all(
				matches.slice(index, index + 16).map(async (name): Promise<AutocompleteItem | undefined> => {
					try {
						await operations.resolveWorkspaceDirectory(paths.join(searchDirectory, name));
					} catch {
						return undefined;
					}
					const directoryPath = `${displayDirectory}${name}/`;
					return {
						value: quoted || directoryPath.includes(" ") ? `"${directoryPath}"` : directoryPath,
						label: `${name}/`,
					};
				}),
			);
			items.push(...batch.filter((item): item is AutocompleteItem => item !== undefined));
		}
		return items.sort((a, b) => a.label.localeCompare(b.label));
	} catch {
		return [];
	}
}
