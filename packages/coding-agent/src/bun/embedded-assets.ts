import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import assetPath from "../../dist/bun/grip-assets.blob";

interface EmbeddedAsset extends Blob {
	name: string;
}
interface EmbeddedBun {
	embeddedFiles?: EmbeddedAsset[];
}
interface EmbeddedGlobal {
	Bun?: EmbeddedBun;
}

/** A compiled executable carries its assets; extract them into a private temporary directory for filesystem-based consumers and native add-ons. */
export async function prepareEmbeddedAssets(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "grip-assets-"));
	try {
		const files = (globalThis as typeof globalThis & EmbeddedGlobal).Bun?.embeddedFiles;
		const archive = files?.find((file) => file.name === basename(assetPath));
		if (!archive) throw new Error("Compiled Grip binary is missing its embedded assets");
		const bytes = gunzipSync(Buffer.from(await archive.arrayBuffer()), { maxOutputLength: 96 * 1024 * 1024 });
		const entries: unknown = JSON.parse(bytes.toString("utf8"));
		if (!Array.isArray(entries) || entries.length > 4096) throw new Error("Invalid embedded asset manifest");
		for (const entry of entries) {
			if (
				!Array.isArray(entry) ||
				entry.length !== 2 ||
				typeof entry[0] !== "string" ||
				typeof entry[1] !== "string"
			) {
				throw new Error("Invalid embedded asset entry");
			}
			const [name, content] = entry;
			if (
				isAbsolute(name) ||
				name.includes("\\") ||
				name.split("/").some((part) => !part || part === "." || part === "..")
			) {
				throw new Error("Unsafe embedded asset path");
			}
			const destination = join(root, ...name.split("/"));
			if (!destination.startsWith(`${root}${sep}`)) throw new Error("Embedded asset escapes private directory");
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			writeFileSync(destination, Buffer.from(content, "base64"), { mode: 0o600, flag: "wx" });
		}
		process.env.GRIP_EMBEDDED_ASSET_DIR = root;
		process.once("exit", () => {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Windows can retain a loaded native add-on until process teardown; leave only private temporary data.
			}
		});
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
