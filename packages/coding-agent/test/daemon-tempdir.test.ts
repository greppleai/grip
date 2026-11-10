import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DeferredRemoteToolOperations, RemoteToolOperations } from "../src/core/tools/operations.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

it.each([false, true])("writes clipboard bytes in backend OS temporary storage (shared=%s)", async (shared) => {
	const root = await mkdtemp(join(tmpdir(), "grip-clipboard-workspace-"));
	const parsed = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-allow-root",
			"--daemon-allow-full-filesystem",
			"--daemon-cwd",
			root,
			"--daemon-shared-parent",
			root,
		],
		{ GRIP_DAEMON_TOKEN: "clipboard-test-token-at-least-32-bytes" },
		root,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const token = parsed.configuration!.token;
	const operations = new DeferredRemoteToolOperations(root);
	let imagePath: string | undefined;
	try {
		let url = address.url;
		if (shared) url = `${url.replace(/^ws:/, "grip+ws:")}?root=${encodeURIComponent(root)}`;
		await operations.configureRemote(url, { token });
		const directory = await operations.getTemporaryDirectory();
		expect(directory).toBe(await realpath(tmpdir()));
		imagePath = join(directory, `grip-clipboard-${randomUUID()}.png`);
		const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
		await operations.writeFile(imagePath, bytes);
		expect(await operations.readFile(imagePath)).toEqual(bytes);
		expect(await readFile(imagePath)).toEqual(bytes);
		expect(await readdir(root)).toEqual([]);
	} finally {
		await operations.dispose();
		await server.forceClose();
		if (imagePath) await rm(imagePath, { force: true });
		await rm(root, { recursive: true, force: true });
	}
});

it.each([false, true])(
	"requires an explicit temporary root for confined daemons (configured=%s)",
	async (configured) => {
		const root = await mkdtemp(join(tmpdir(), "grip-clipboard-confined-"));
		const scratch = await mkdtemp(join(tmpdir(), "grip-clipboard-scratch-"));
		const environment: NodeJS.ProcessEnv = {};
		if (configured) environment.GRIP_DAEMON_TEMP_ROOT = scratch;
		const parsed = await parseDaemonCommand(
			["--daemon", "--daemon-allow-root", "--daemon-cwd", root],
			environment,
			root,
		);
		const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
		const address = await server.listen();
		let operations: RemoteToolOperations | undefined;
		try {
			operations = await RemoteToolOperations.connect(address.url, { token: parsed.configuration!.token });
			if (configured) {
				const directory = await operations.getTemporaryDirectory();
				expect(directory).toBe(await realpath(scratch));
				const imagePath = join(directory, "clipboard.png");
				await operations.writeFile(imagePath, Buffer.from([1, 2, 3]));
				expect(await operations.readFile(imagePath)).toEqual(Buffer.from([1, 2, 3]));
			} else {
				await expect(operations.getTemporaryDirectory()).rejects.toThrow("GRIP_DAEMON_TEMP_ROOT");
				await expect(operations.writeFile(join(scratch, "escape.png"), Buffer.from([1]))).rejects.toMatchObject({
					code: "internal_error",
				});
			}
			expect(await readdir(root)).toEqual([]);
		} finally {
			await operations?.dispose();
			await server.forceClose();
			await rm(root, { recursive: true, force: true });
			await rm(scratch, { recursive: true, force: true });
		}
	},
);
