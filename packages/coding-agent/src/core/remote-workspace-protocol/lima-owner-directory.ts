import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Private host location for named-VM owner locks. Keep the established directory identity. */
export async function prepareSharedLimaOwnerDirectory(baseDirectory: string): Promise<string> {
	if (process.platform === "win32" || !process.getuid) throw new Error("Shared Lima owner requires Unix credentials");
	const base = await realpath(baseDirectory);
	const baseInfo = await lstat(base);
	const uid = process.getuid();
	if (
		!baseInfo.isDirectory() ||
		(baseInfo.uid !== uid && baseInfo.uid !== 0) ||
		((baseInfo.mode & 0o022) !== 0 && (baseInfo.mode & 0o1000) === 0)
	) {
		throw new Error("Shared Lima owner base directory is not owned or sticky-safe");
	}
	// Existing owner locks live here; changing this path could bypass a live lock.
	const directory = join(base, `grip-broker-${uid}`);
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	// Never repair an existing directory: it might belong to another principal.
	const info = await lstat(directory);
	if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
		throw new Error("Shared Lima owner directory is not private and owned by this user");
	}
	return directory;
}
