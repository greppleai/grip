import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The parent mount is fixed; children can be created at any time. */
export class SharedWorkspaceRoots {
	readonly parent: string;
	private constructor(parent: string) {
		this.parent = parent;
	}

	static async fromParent(parent: string): Promise<SharedWorkspaceRoots> {
		const canonical = await realpath(parent);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Shared workspace parent is not a directory");
		return new SharedWorkspaceRoots(canonical);
	}

	async bind(requested: string): Promise<string> {
		if (!isAbsolute(requested) || requested.includes("\0"))
			throw new Error("Shared workspace root must be an absolute path");
		const candidate = resolve(requested);
		this.assertWithin(candidate);
		const canonical = await realpath(candidate);
		this.assertWithin(canonical);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Shared workspace root is not a directory");
		return canonical;
	}

	private assertWithin(path: string): void {
		const suffix = relative(this.parent, path);
		if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
			throw new Error("Shared workspace root escapes the parent mount");
		}
	}
}
