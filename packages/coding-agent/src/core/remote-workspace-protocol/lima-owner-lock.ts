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

type OwnerLockState = "occupied" | "stale" | "unverifiable";

export class SharedLimaOwnerLockError extends Error {
	readonly state: OwnerLockState;

	constructor(state: OwnerLockState) {
		super(`Shared Lima owner lock ${state}; inspect and reconcile before retrying`);
		this.name = "SharedLimaOwnerLockError";
		this.state = state;
	}
}

function inspectOwnerPid(pid: unknown): OwnerLockState {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff) return "unverifiable";
	try {
		process.kill(pid, 0);
		return "occupied";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "stale";
		return code === "EPERM" ? "occupied" : "unverifiable";
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
		// A dead PID does not authorize lifecycle changes: a prior mutation may be incomplete.
		let state: OwnerLockState = "unverifiable";
		try {
			const info = await lstat(path);
			if (info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0) {
				const existing = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord> | null;
				const current = await lstat(path);
				if (
					typeof existing?.nonce === "string" &&
					/^[a-f0-9]{32}$/.test(existing.nonce) &&
					info.dev === current.dev &&
					info.ino === current.ino &&
					info.ctimeMs === current.ctimeMs
				) {
					state = inspectOwnerPid(existing.pid);
				}
			}
		} catch {
			// A racing file change is not grounds for a new owner.
		}
		throw new SharedLimaOwnerLockError(state);
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
