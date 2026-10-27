import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { OfficialExtensionError } from "./official-transport.ts";

export function officialMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** A pinned agent-directory anchor. Managed descendants must never contain links. */
export class OfficialFileStore {
	readonly root: string;
	private readonly configured: string;
	private readonly identity: string;

	private constructor(configured: string, root: string, identity: string) {
		this.configured = configured;
		this.root = root;
		this.identity = identity;
	}

	static async create(agentDir: string): Promise<OfficialFileStore> {
		const configured = resolve(agentDir);
		await mkdir(configured, { recursive: true, mode: 0o700 });
		const root = await realpath(configured);
		const stat = await lstat(root);
		if (!stat.isDirectory()) throw new OfficialExtensionError("filesystem", "Invalid official agent directory");
		return new OfficialFileStore(configured, root, `${stat.dev}:${stat.ino}`);
	}

	private async checkComponent(path: string, create: boolean, parent: boolean): Promise<boolean> {
		const stat = await lstat(path).catch(async (error: unknown) => {
			if (!officialMissing(error)) throw error;
			if (!create) return null;
			try {
				await mkdir(path, { mode: 0o700 });
			} catch (mkdirError) {
				if (
					!(
						typeof mkdirError === "object" &&
						mkdirError !== null &&
						"code" in mkdirError &&
						mkdirError.code === "EEXIST"
					)
				)
					throw mkdirError;
			}
			return lstat(path);
		});
		if (!stat) return false;
		if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
			throw new OfficialExtensionError("filesystem", "Links or nonregular official paths are forbidden");
		if (parent && !stat.isDirectory())
			throw new OfficialExtensionError("filesystem", "Official parent is not a directory");
		const resolved = await realpath(path).catch((error: unknown) => {
			if (!officialMissing(error)) throw error;
			return null;
		});
		// Another process may release a lock directory after lstat succeeds.
		if (resolved === null) return false;
		if (resolved !== path) throw new OfficialExtensionError("filesystem", "Official path escaped its anchor");
		return true;
	}

	async check(path: string, createParents = false): Promise<string> {
		const anchor = await lstat(this.root);
		if (
			!anchor.isDirectory() ||
			anchor.isSymbolicLink() ||
			`${anchor.dev}:${anchor.ino}` !== this.identity ||
			(await realpath(this.configured)) !== this.root
		)
			throw new OfficialExtensionError("filesystem", "Official agent directory changed");
		const absolute = resolve(this.root, path);
		const inside = relative(this.root, absolute);
		if (
			!inside ||
			inside === ".." ||
			inside.startsWith(`..${sep}`) ||
			isAbsolute(inside) ||
			inside.split(sep)[0] !== "official"
		)
			throw new OfficialExtensionError("filesystem", "Path outside official managed root");
		const parts = inside.split(sep);
		let current = this.root;
		for (let index = 0; index < parts.length; index++) {
			current = join(current, parts[index]);
			const parent = index < parts.length - 1;
			if (!(await this.checkComponent(current, createParents && parent, parent))) break;
		}
		return absolute;
	}

	async directory(path: string): Promise<string> {
		const absolute = await this.check(path, true);
		try {
			await mkdir(absolute, { mode: 0o700 });
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		}
		await this.check(path);
		if (!(await lstat(absolute)).isDirectory())
			throw new OfficialExtensionError("filesystem", "Expected official directory");
		return absolute;
	}

	async read(path: string, maxBytes: number): Promise<Buffer> {
		const absolute = await this.check(path);
		const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink !== 1)
				throw new OfficialExtensionError("filesystem", "Invalid official file");
			if (stat.size > maxBytes) throw new OfficialExtensionError("size", "Oversized official file");
			const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
			let size = 0;
			while (size < buffer.length) {
				const part = await handle.read(buffer, size, buffer.length - size, null);
				if (!part.bytesRead) break;
				size += part.bytesRead;
			}
			if (size > maxBytes || size !== stat.size)
				throw new OfficialExtensionError("filesystem", "Official file changed while reading");
			await this.check(path);
			const after = await lstat(absolute);
			if (after.ino !== stat.ino || after.dev !== stat.dev)
				throw new OfficialExtensionError("filesystem", "Official file replaced while reading");
			return buffer.subarray(0, size);
		} finally {
			await handle.close();
		}
	}

	async writeNew(path: string, bytes: Uint8Array): Promise<void> {
		const absolute = await this.check(path, true);
		const handle = await open(absolute, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await this.check(path);
	}

	async atomicWrite(path: string, bytes: Uint8Array, immutable = false): Promise<void> {
		await this.check(path, true);
		if (immutable) {
			try {
				if (!(await this.read(path, bytes.length)).equals(Buffer.from(bytes)))
					throw new OfficialExtensionError("integrity", "Cannot overwrite immutable official file");
				return;
			} catch (error) {
				if (!officialMissing(error)) throw error;
			}
		}
		const temporary = join(dirname(path), `.partial-${randomUUID()}`);
		await this.writeNew(temporary, bytes);
		await this.check(path);
		await this.check(temporary);
		await rename(resolve(this.root, temporary), resolve(this.root, path));
		await this.check(path);
	}

	async promote(from: string, to: string): Promise<void> {
		await this.check(from);
		await this.check(to, true);
		try {
			await lstat(resolve(this.root, to));
			throw new OfficialExtensionError("filesystem", "Official version already exists");
		} catch (error) {
			if (!officialMissing(error)) throw error;
		}
		await rename(resolve(this.root, from), resolve(this.root, to));
		await this.check(to);
	}
}
