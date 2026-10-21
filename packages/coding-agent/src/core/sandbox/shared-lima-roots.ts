import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, sep } from "node:path";

export interface SharedLimaWorkspaceBinding {
	/** Canonical fixed mount source; never the individual client's cwd. */
	hostParent: string;
	/** Canonical current client workspace, beneath the fixed mount source. */
	hostRoot: string;
	guestParent: string;
	guestRoot: string;
}

/** Resolve an existing directory *at attach time*, including post-VM-start children. */
export async function resolveSharedLimaWorkspace(
	hostParent: string,
	guestParent: string,
	hostRoot: string,
): Promise<SharedLimaWorkspaceBinding> {
	if (!isAbsolute(hostParent) || !isAbsolute(hostRoot)) throw new Error("Shared Lima host paths must be absolute");
	if (!posix.isAbsolute(guestParent) || posix.normalize(guestParent) !== guestParent || guestParent.includes("\0")) {
		throw new Error("Shared Lima guest parent must be a canonical absolute POSIX path");
	}
	const [canonicalParent, canonicalRoot] = await Promise.all([realpath(hostParent), realpath(hostRoot)]);
	const [parentInfo, rootInfo] = await Promise.all([stat(canonicalParent), stat(canonicalRoot)]);
	if (!parentInfo.isDirectory() || !rootInfo.isDirectory())
		throw new Error("Shared Lima workspaces must be directories");
	const suffix = relative(canonicalParent, canonicalRoot);
	if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
		throw new Error("Shared Lima workspace escapes the fixed parent mount");
	}
	return {
		hostParent: canonicalParent,
		hostRoot: canonicalRoot,
		guestParent,
		guestRoot: suffix ? posix.join(guestParent, ...suffix.split(sep)) : guestParent,
	};
}
