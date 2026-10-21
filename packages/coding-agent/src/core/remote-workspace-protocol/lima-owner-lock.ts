import { createHash, randomBytes } from "node:crypto";
import { type FileHandle, lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { prepareSharedLimaOwnerDirectory } from "./lima-owner-directory.ts";

export interface SharedLimaOwnerLock {
	readonly path: string;
	readonly instanceName: string;
	assertHeld(): Promise<void>;
	release(): Promise<void>;
}

interface LockRecord {
	pid: number;
	nonce: string;
}

function isAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Exclusive owner lifetime, not a client lease. Never silently steal a stale lock. */
export async function acquireSharedLimaOwnerLock(
	instanceName: string,
	baseDirectory?: string,
): Promise<SharedLimaOwnerLock> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(instanceName)) throw new Error("Invalid shared Lima instance name");
	// The production lock must not follow TMPDIR: separate processes can otherwise
	// claim the same named VM through different private temporary directories.
	// An explicit base is reserved for isolated embedded tests.
	const directory = await prepareSharedLimaOwnerDirectory(baseDirectory ?? "/tmp");
	const digest = createHash("sha256").update(instanceName).digest("hex").slice(0, 32);
	const path = join(directory, `lima-owner-${digest}.lock`);
	const record: LockRecord = { pid: process.pid, nonce: randomBytes(16).toString("hex") };
	let handle: FileHandle;
	try {
		handle = await open(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// Even a dead PID is ambiguous (crash during a mutation or VM startup). Manual
		// reconciliation is required; another owner must not implicitly take over.
		let state = "unverifiable";
		try {
			const info = await lstat(path);
			if (info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0) {
				const existing = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
				state = typeof existing.pid === "number" && isAlive(existing.pid) ? "occupied" : "stale";
			}
		} catch {
			// A racing file change is not grounds for a new owner.
		}
		throw new Error(`Shared Lima owner lock ${state}; inspect and reconcile before retrying`);
	}
	try {
		await handle.writeFile(JSON.stringify(record));
		const identity = await handle.stat();
		let released = false;
		const assertHeld = async (): Promise<void> => {
			if (released) throw new Error("Shared Lima owner lock already released");
			const current = await lstat(path);
			if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile()) {
				throw new Error("Shared Lima owner lock identity changed; refusing operation");
			}
			const content = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
			if (content.pid !== record.pid || content.nonce !== record.nonce) {
				throw new Error("Shared Lima owner lock contents changed; refusing operation");
			}
		};
		return {
			path,
			instanceName,
			assertHeld,
			async release(): Promise<void> {
				if (released) return;
				try {
					await assertHeld();
					await unlink(path);
					released = true;
				} finally {
					await handle.close();
				}
			},
		};
	} catch (error) {
		await handle.close();
		// Do not unlink an ambiguous lock after an interrupted write.
		throw error;
	}
}
