import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRemoteToolOperations } from "../src/core/tools/operations.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

it("writes small and chunked binary content through a remote daemon", async () => {
	const root = await mkdtemp(join(tmpdir(), "remote-write-upload-"));
	const parsed = await parseDaemonCommand(["--daemon", "--daemon-allow-root", "--daemon-cwd", root], {}, root);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0, maxBufferedOutputBytes: 4 * 1024 * 1024 });
	const address = await server.listen();
	const operations = await createRemoteToolOperations(address.url);
	try {
		const path = join(root, "binary");
		await operations.writeFile(path, Buffer.from([0, 255, 1]));
		expect(await readFile(path)).toEqual(Buffer.from([0, 255, 1]));
		const large = Buffer.alloc(2 * 1024 * 1024);
		for (let i = 0; i < large.length; i++) large[i] = i % 251;
		await operations.writeFile(path, large);
		expect(await readFile(path)).toEqual(large);
	} finally {
		await operations.dispose();
		await server.forceClose();
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
