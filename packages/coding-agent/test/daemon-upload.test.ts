import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS } from "../src/core/remote-workspace-protocol/contract.ts";
import { SHARED_WORKSPACE_WEBSOCKET_PROTOCOL } from "../src/core/remote-workspace-protocol/shared-transport.ts";
import { DAEMON_WEBSOCKET_PROTOCOL, parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

it.each([false, true])("streams verified uploads through daemon (shared=%s)", async (shared) => {
	const root = await mkdtemp(join(tmpdir(), "daemon-upload-"));
	const outside = await mkdtemp(join(tmpdir(), "daemon-upload-outside-"));
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", root, "--daemon-shared-parent", root],
		{},
		root,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0, maxBufferedOutputBytes: 1024 });
	const address = await server.listen();
	const socket = new WebSocket(address.url, shared ? SHARED_WORKSPACE_WEBSOCKET_PROTOCOL : DAEMON_WEBSOCKET_PROTOCOL);
	const wait = (frame: object, match: (message: any) => boolean): Promise<any> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.off("message", receive);
				reject(new Error("response timeout"));
			}, 5000);
			function receive(data: WebSocket.RawData) {
				const message = JSON.parse(data.toString());
				if (match(message)) {
					clearTimeout(timer);
					socket.off("message", receive);
					resolve(message);
				}
			}
			socket.on("message", receive);
			socket.send(JSON.stringify(frame));
		});
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		let channelId = "";
		if (shared) {
			await wait({ type: "hello", version: 2, id: "hello" }, (m) => m.type === "hello_ack");
			channelId = (await wait({ type: "open", id: "open", root }, (m) => m.type === "opened")).channelId;
		}
		const wrap = (payload: object) => (shared ? { type: "channel", channelId, payload } : payload);
		const inner = (message: any) => (shared ? message.payload : message);
		const ack = inner(
			await wait(
				wrap({
					type: "handshake",
					id: "h",
					versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
					requiredCapabilities: ["file_transfer"],
					optionalCapabilities: [],
					receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				}),
				(m) => inner(m)?.type === "handshake_ack",
			),
		);
		expect(ack.catalog.operations).toContain("transfer.upload");
		const sha = (s: string) => createHash("sha256").update(s).digest("hex");
		async function upload(id: string, path: string, content: string, overwrite: boolean, digest = sha(content)) {
			socket.send(
				JSON.stringify(
					wrap({
						type: "request",
						id,
						method: "transfer.upload",
						timeoutMs: 3000,
						params: { path, length: Buffer.byteLength(content), sha256: digest, overwrite },
					}),
				),
			);
			socket.send(
				JSON.stringify(
					wrap({ type: "transfer_chunk", id, sequence: 0, dataBase64: Buffer.from(content).toString("base64") }),
				),
			);
			return inner(
				await wait(
					wrap({ type: "transfer_finish", id, length: Buffer.byteLength(content), sha256: digest }),
					(m) => inner(m)?.id === id,
				),
			);
		}
		const target = join(root, "file");
		if (shared) {
			await writeFile(target, "original");
			const rejected = inner(
				await wait(
					wrap({
						type: "request",
						id: "shared-upload",
						method: "transfer.upload",
						timeoutMs: 3000,
						params: { path: target, length: 5, sha256: sha("hello"), overwrite: true },
					}),
					(m) => inner(m)?.id === "shared-upload",
				),
			);
			expect(rejected.type).toBe("error");
			expect(rejected.error.executionState).toBe("not_started");
			expect(await readFile(target, "utf8")).toBe("original");
			return;
		}
		expect((await upload("ok", target, "hello", false)).type).toBe("result");
		expect(await readFile(target, "utf8")).toBe("hello");
		expect((await upload("exists", target, "other", false)).type).toBe("error");
		expect(await readFile(target, "utf8")).toBe("hello");
		expect((await upload("digest", target, "other", true, sha("wrong"))).type).toBe("error");
		expect(await readFile(target, "utf8")).toBe("hello");
		expect((await upload("overwrite", target, "updated", true)).type).toBe("result");
		expect(await readFile(target, "utf8")).toBe("updated");
		const tooLarge = inner(
			await wait(
				wrap({
					type: "request",
					id: "large",
					method: "transfer.upload",
					timeoutMs: 3000,
					params: { path: target, length: 1025, sha256: sha("x"), overwrite: true },
				}),
				(m) => inner(m)?.id === "large",
			),
		);
		expect(tooLarge.error.code).toBe("limit_exceeded");
		socket.send(
			JSON.stringify(
				wrap({
					type: "request",
					id: "cancel",
					method: "transfer.upload",
					timeoutMs: 3000,
					params: { path: target, length: 5, sha256: sha("hello"), overwrite: true },
				}),
			),
		);
		socket.send(
			JSON.stringify(
				wrap({
					type: "transfer_chunk",
					id: "cancel",
					sequence: 0,
					dataBase64: Buffer.from("he").toString("base64"),
				}),
			),
		);
		const cancelled = inner(await wait(wrap({ type: "cancel", id: "cancel" }), (m) => inner(m)?.id === "cancel"));
		expect(cancelled.error.code).toBe("cancelled");
		expect(await readFile(target, "utf8")).toBe("updated");
		await symlink(outside, join(root, "escape"), "dir");
		expect((await upload("escape", join(root, "escape", "file"), "other", true)).type).toBe("error");
		await writeFile(join(outside, "sentinel"), "safe");
		expect(await readdir(outside)).toEqual(["sentinel"]);
		expect((await readdir(root)).filter((name) => name.startsWith(".grip-remote-write"))).toEqual([]);
	} finally {
		socket.terminate();
		await server.forceClose();
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
