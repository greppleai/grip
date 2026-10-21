import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { VERSION } from "../src/config.ts";
import { DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS } from "../src/core/remote-workspace-protocol/contract.ts";
import { SHARED_WORKSPACE_WEBSOCKET_PROTOCOL } from "../src/core/remote-workspace-protocol/shared-transport.ts";
import { DAEMON_WEBSOCKET_PROTOCOL, parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

interface WebSocketWithSocket {
	readonly _socket: Socket;
}

// @types/ws does not export a send-arguments type; this test owns its spy contract.
type WebSocketSendArgs = [data: unknown, options?: unknown, callback?: (error?: Error) => void];

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sendAndReceive(socket: WebSocket, frame: object, matches: (response: any) => boolean): Promise<any> {
	return new Promise((resolve, reject) => {
		const observed: unknown[] = [];
		const timer = setTimeout(() => {
			socket.off("message", onMessage);
			reject(
				new Error(
					`Timed out waiting for v2 response to ${JSON.stringify(frame)}; observed: ${JSON.stringify(observed)}; socket=${socket.readyState}`,
				),
			);
		}, 5000);
		function onMessage(data: WebSocket.RawData) {
			const response = JSON.parse(data.toString());
			observed.push(response);
			if (!matches(response)) return;
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(response);
		}
		socket.on("message", onMessage);
		socket.send(JSON.stringify(frame));
	});
}

it("routes distinct, same-root and newly created workspaces over a single live WebSocket", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-live-"));
	const outside = await mkdtemp(join(tmpdir(), "grip-shared-outside-"));
	dirs.push(parent, outside);
	const grip = join(parent, "grip");
	const grepple = join(parent, "grepple");
	await mkdir(grip);
	await mkdir(grepple);
	const sharedFile = join(grip, "shared.txt");
	await writeFile(sharedFile, "before\n");
	await symlink(outside, join(parent, "escape"), "dir");
	const parsed = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-allow-root",
			"--daemon-allow-process-exec",
			"--daemon-cwd",
			parent,
			"--daemon-shared-parent",
			parent,
		],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const socket = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		expect(socket.protocol).toBe(SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
		const hello = await sendAndReceive(
			socket,
			{ type: "hello", version: 2, id: "hello" },
			(msg) => msg.type === "hello_ack",
		);
		expect(hello.epoch).toHaveLength(24);
		expect(hello.daemonVersion).toBe(VERSION);
		const channelCatalog = new Map<string, any>();
		const channels: string[] = [];
		for (const [id, root] of [
			["a", grip],
			["b", grepple],
			["c", grip],
			["d", parent],
		]) {
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			channels.push(opened.channelId);
			const ack = await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "same-id",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations", "tool_updates"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
			channelCatalog.set(opened.channelId, ack.payload);
			expect(ack.payload.workspace.root).toBe(root);
			const result = await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "request",
						id: "stat",
						method: "workspace.stat",
						timeoutMs: 1000,
						params: { path: root },
					},
				},
				(msg) => msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.id === "stat",
			);
			expect(result.payload.type).toBe("result");
		}
		const [first, second] = [channels[0]!, channels[2]!];
		const oldRead = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: first,
				payload: {
					type: "request",
					id: "read-revision",
					method: "workspace.read",
					timeoutMs: 2000,
					params: { path: sharedFile },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === first && msg.payload.id === "read-revision",
		);
		expect(oldRead.payload.type).toBe("result");
		const revision = oldRead.payload.result.revision;
		const readCatalog = channelCatalog.get(first);
		const toolRead = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: first,
				payload: {
					type: "request",
					id: "tool-read",
					method: "tool.invoke",
					timeoutMs: 2000,
					params: {
						generation: 1,
						catalogHash: readCatalog.catalogHash,
						toolName: "read",
						schemaHash: readCatalog.catalog.tools.find((tool: any) => tool.name === "read").schemaHash,
						argumentsPrepared: true,
						arguments: { path: sharedFile },
						executionOptions: {},
					},
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === first && msg.payload.id === "tool-read",
		);
		expect(toolRead.payload.type).toBe("result");
		const hash = /^([A-Za-z0-9_-]{3})│before/m.exec(toolRead.payload.result.content[0].text)?.[1];
		expect(hash).toHaveLength(3);
		const editArgs = {
			path: sharedFile,
			changes: [{ hash_range_inclusive: [hash, hash], content_lines: ["changed"] }],
		};
		for (const [channelId, requestId, replacement, expected] of [
			[first, "first-edit", "changed", "result"],
			[second, "stale-edit", "overwritten", "error"],
		] as const) {
			const ack = channelCatalog.get(channelId);
			const edited = await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId,
					payload: {
						type: "request",
						id: requestId,
						method: "tool.invoke",
						timeoutMs: 3000,
						params: {
							generation: 1,
							catalogHash: ack.catalogHash,
							toolName: "edit",
							schemaHash: ack.catalog.tools.find((tool: any) => tool.name === "edit").schemaHash,
							argumentsPrepared: true,
							arguments: {
								...editArgs,
								changes: [{ hash_range_inclusive: [hash, hash], content_lines: [replacement] }],
							},
							expectedRevision: { sha256: revision },
							executionOptions: {},
						},
					},
				},
				(msg) => msg.type === "channel" && msg.channelId === channelId && msg.payload.id === requestId,
			);
			expect(edited.payload.type).toBe(expected);
			if (expected === "error") {
				expect(edited.payload.error.code).toBe("conflict");
				expect(edited.payload.error.executionState).toBe("not_started");
			}
		}
		expect(await readFile(sharedFile, "utf8")).toBe("changed\n");
		const primitive = (channelId: string, id: string, path: string, expectedRevision?: object) =>
			sendAndReceive(
				socket,
				{
					type: "channel",
					channelId,
					payload: {
						type: "request",
						id,
						method: "workspace.write",
						timeoutMs: 2000,
						params: {
							path,
							contentBase64: Buffer.from(id.startsWith("racing-") ? `${id}\n` : "from parent\n").toString(
								"base64",
							),
							...(expectedRevision ? { expectedRevision } : {}),
						},
					},
				},
				(msg) => msg.type === "channel" && msg.channelId === channelId && msg.payload.id === id,
			);
		const parentChannel = channels[3]!;
		expect((await primitive(parentChannel, "without-revision", sharedFile)).payload.error.code).toBe(
			"invalid_request",
		);
		expect(
			(await primitive(parentChannel, "expected-absence", sharedFile, { absent: true })).payload.error.code,
		).toBe("conflict");
		const freshRead = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: parentChannel,
				payload: {
					type: "request",
					id: "parent-read",
					method: "workspace.read",
					timeoutMs: 2000,
					params: { path: sharedFile },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === parentChannel && msg.payload.id === "parent-read",
		);
		expect(
			(await primitive(parentChannel, "parent-write", sharedFile, { sha256: freshRead.payload.result.revision }))
				.payload.type,
		).toBe("result");
		expect(
			(await primitive(first, "child-stale", sharedFile, { sha256: freshRead.payload.result.revision })).payload
				.error.code,
		).toBe("conflict");
		const created = join(grip, "created.txt");
		expect((await primitive(second, "create-absent", created, { absent: true })).payload.type).toBe("result");
		expect((await primitive(second, "unsafe-write", created, { unsafeOverwrite: true })).payload.type).toBe("result");
		expect(await readFile(sharedFile, "utf8")).toBe("from parent\n");
		expect(await readFile(created, "utf8")).toBe("from parent\n");
		const concurrentRevision = createHash("sha256")
			.update(await readFile(sharedFile))
			.digest("hex");
		const races = await Promise.all([
			primitive(first, "racing-child", sharedFile, { sha256: concurrentRevision }),
			primitive(parentChannel, "racing-parent", sharedFile, { sha256: concurrentRevision }),
		]);
		expect(races.map((response) => response.payload.type).sort()).toEqual(["error", "result"]);
		expect(races.find((response) => response.payload.type === "error")?.payload.error.code).toBe("conflict");
		const absentPath = join(grip, "absent-race.txt");
		const absentStat = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: first,
				payload: {
					type: "request",
					id: "stat-absent",
					method: "workspace.stat",
					timeoutMs: 2000,
					params: { path: absentPath },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === first && msg.payload.id === "stat-absent",
		);
		expect(absentStat.payload.type).toBe("result");
		expect(absentStat.payload.result.kind).toBe("absent");
		expect(absentStat.payload.result.workspace.root).toBe(grip);
		const absentRaces = await Promise.all([
			primitive(first, "racing-absent-child", absentPath, { absent: true }),
			primitive(parentChannel, "racing-absent-parent", absentPath, { absent: true }),
		]);
		expect(absentRaces.map((response) => response.payload.type).sort()).toEqual(["error", "result"]);
		expect(absentRaces.find((response) => response.payload.type === "error")?.payload.error.code).toBe("conflict");
		const execute = (channelId: string) => ({
			type: "channel",
			channelId,
			payload: {
				type: "request",
				id: "same-process-id",
				method: "workspace.exec",
				timeoutMs: 5000,
				params: { cwd: grip, command: "printf ready; sleep 1; printf done" },
			},
		});
		for (const channelId of [first, second]) {
			const ready = await sendAndReceive(
				socket,
				execute(channelId),
				(msg) =>
					msg.type === "channel" &&
					msg.channelId === channelId &&
					msg.payload.type === "update" &&
					msg.payload.id === "same-process-id",
			);
			expect(ready.payload.type).toBe("update");
		}
		const cancelled = await sendAndReceive(
			socket,
			{ type: "channel", channelId: first, payload: { type: "cancel", id: "same-process-id" } },
			(msg) =>
				msg.type === "channel" &&
				msg.channelId === first &&
				msg.payload.id === "same-process-id" &&
				msg.payload.type === "error",
		);
		expect(cancelled.payload.error.code).toBe("cancelled");
		const siblingProcess = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: second,
				payload: { type: "request", id: "keep-listening", method: "catalog.get", timeoutMs: 1000, params: {} },
			},
			(msg) =>
				msg.type === "channel" &&
				msg.channelId === second &&
				msg.payload.id === "same-process-id" &&
				msg.payload.type === "result",
		);
		expect(siblingProcess.payload.type).toBe("result");
		// The earlier matcher observes the independent process completion, not the catalog
		// reply. Request another catalog snapshot and match its own ID explicitly.
		const siblingCatalog = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: second,
				payload: { type: "request", id: "still-usable", method: "catalog.get", timeoutMs: 1000, params: {} },
			},
			(msg) =>
				msg.type === "channel" &&
				msg.channelId === second &&
				msg.payload.id === "still-usable" &&
				msg.payload.type === "result",
		);
		expect(siblingCatalog.payload.result.operations).toContain("workspace.read");
		const newRoot = join(parent, "new-project");
		await mkdir(newRoot);
		const fresh = await sendAndReceive(
			socket,
			{ type: "open", id: "new", root: newRoot },
			(msg) => msg.type === "opened" && msg.id === "new",
		);
		expect(fresh.channelId).toBeTruthy();
		for (const [id, root] of [
			["outside", outside],
			["escape", join(parent, "escape")],
		]) {
			const rejected = await sendAndReceive(
				socket,
				{ type: "open", id, root },
				(msg) => msg.type === "control_error" && msg.id === id,
			);
			expect(rejected.code).toBe("invalid_root");
		}
		const stillOpen = await sendAndReceive(
			socket,
			{ type: "open", id: "after-rejection", root: grip },
			(msg) => msg.type === "opened" && msg.id === "after-rejection",
		);
		expect(stillOpen.channelId).toBeTruthy();
		await server.reload();
		for (const channelId of channels) {
			const refreshed = await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId,
					payload: {
						type: "request",
						id: "catalog-after-reload",
						method: "catalog.get",
						timeoutMs: 1000,
						params: {},
					},
				},
				(msg) => msg.type === "channel" && msg.channelId === channelId && msg.payload.id === "catalog-after-reload",
			);
			expect(refreshed.payload.type).toBe("result");
			expect(refreshed.payload.result.generation).toBe(2);
		}
		const disconnected = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
		socket.send(JSON.stringify({ type: "close", channelId: "0123456789abcdef01234567" }));
		expect(await disconnected).toBe(1002);
	} finally {
		socket.terminate();
		await server.forceClose();
	}
});

it("rejects v2 and mixed subprotocol offers unless shared mode is explicitly configured", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-not-shared-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(["--daemon", "--daemon-allow-root", "--daemon-cwd", parent], {}, parent);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	try {
		for (const protocols of [
			SHARED_WORKSPACE_WEBSOCKET_PROTOCOL,
			["grip.workspace.v1", SHARED_WORKSPACE_WEBSOCKET_PROTOCOL],
		]) {
			const socket = new WebSocket(address.url, protocols);
			try {
				const status = await new Promise<number>((resolve, reject) => {
					socket.once("unexpected-response", (_request, response) => {
						response.resume();
						resolve(response.statusCode ?? 0);
					});
					socket.once("error", reject);
				});
				expect(status).toBe(400);
			} finally {
				socket.terminate();
			}
		}
	} finally {
		await server.forceClose();
	}
});

it("keeps the physical v2 socket and sibling channel alive after an invalid inner frame", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-inner-frame-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const socket = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		await sendAndReceive(socket, { type: "hello", id: "hello", version: 2 }, (msg) => msg.type === "hello_ack");
		const channels: string[] = [];
		for (const id of ["bad", "good"]) {
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			channels.push(opened.channelId);
			await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "handshake",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
		}
		const closed = await sendAndReceive(
			socket,
			{ type: "channel", channelId: channels[0], payload: { type: "unknown" } },
			(msg) => msg.type === "closed" && msg.channelId === channels[0],
		);
		expect(closed.reason.code).toBe("invalid_payload");
		const result = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: channels[1],
				payload: {
					type: "request",
					id: "still-serving",
					method: "workspace.stat",
					timeoutMs: 1000,
					params: { path: parent },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === channels[1] && msg.payload.id === "still-serving",
		);
		expect(result.payload.type).toBe("result");
		expect(socket.readyState).toBe(WebSocket.OPEN);
	} finally {
		socket.terminate();
		await server.forceClose();
	}
});
it("keeps v1 mutations unconditioned but rejects v2 preconditions on a v1 socket", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-v1-"));
	dirs.push(parent);
	const file = join(parent, "v1.txt");
	await writeFile(file, "original");
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const socket = new WebSocket(address.url, DAEMON_WEBSOCKET_PROTOCOL);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const handshake = await sendAndReceive(
			socket,
			{
				type: "handshake",
				id: "h",
				versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
				requiredCapabilities: [],
				optionalCapabilities: ["primitive_operations"],
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			},
			(msg) => msg.type === "handshake_ack",
		);
		expect(handshake.workspace.root).toBe(parent);
		const params = { path: file, contentBase64: Buffer.from("updated").toString("base64") };
		const rejected = await sendAndReceive(
			socket,
			{
				type: "request",
				id: "conditioned",
				method: "workspace.write",
				timeoutMs: 1000,
				params: { ...params, expectedRevision: { unsafeOverwrite: true } },
			},
			(msg) => msg.id === "conditioned",
		);
		expect(rejected.error.code).toBe("invalid_request");
		expect(await readFile(file, "utf8")).toBe("original");
		const accepted = await sendAndReceive(
			socket,
			{
				type: "request",
				id: "unconditioned",
				method: "workspace.write",
				timeoutMs: 1000,
				params,
			},
			(msg) => msg.id === "unconditioned",
		);
		expect(accepted.type).toBe("result");
		expect(await readFile(file, "utf8")).toBe("updated");
	} finally {
		socket.terminate();
		await server.forceClose();
	}
});

it("shares the daemon active-request quota across v1 and v2 and releases it on channel detach", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-budget-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-allow-root",
			"--daemon-allow-process-exec",
			"--daemon-cwd",
			parent,
			"--daemon-shared-parent",
			parent,
		],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, maxGlobalRequests: 1, port: 0 });
	const address = await server.listen();
	const shared = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	const legacy = new WebSocket(address.url, DAEMON_WEBSOCKET_PROTOCOL);
	try {
		await Promise.all(
			[shared, legacy].map(
				(socket) =>
					new Promise<void>((resolve, reject) => {
						socket.once("open", resolve);
						socket.once("error", reject);
					}),
			),
		);
		await sendAndReceive(shared, { type: "hello", id: "h", version: 2 }, (msg) => msg.type === "hello_ack");
		const channels: string[] = [];
		for (const id of ["first", "second"]) {
			const opened = await sendAndReceive(
				shared,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			channels.push(opened.channelId);
			await sendAndReceive(
				shared,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "h",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations", "tool_updates"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
		}
		await sendAndReceive(
			legacy,
			{
				type: "handshake",
				id: "h",
				versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
				requiredCapabilities: [],
				optionalCapabilities: ["primitive_operations"],
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			},
			(msg) => msg.type === "handshake_ack",
		);
		const active = channels[0]!;
		const peer = channels[1]!;
		await sendAndReceive(
			shared,
			{
				type: "channel",
				channelId: active,
				payload: {
					type: "request",
					id: "long-running",
					method: "workspace.exec",
					timeoutMs: 15000,
					params: { cwd: parent, command: "printf ready; sleep 10" },
				},
			},
			(msg) =>
				msg.type === "channel" &&
				msg.channelId === active &&
				msg.payload.type === "update" &&
				msg.payload.id === "long-running",
		);
		let serial = 0;
		const peerStat = () => {
			const id = `peer-${++serial}`;
			return sendAndReceive(
				shared,
				{
					type: "channel",
					channelId: peer,
					payload: { type: "request", id, method: "workspace.stat", timeoutMs: 1000, params: { path: parent } },
				},
				(msg) => msg.type === "channel" && msg.channelId === peer && msg.payload.id === id,
			);
		};
		const legacyStat = () => {
			const id = `legacy-${++serial}`;
			return sendAndReceive(
				legacy,
				{ type: "request", id, method: "workspace.stat", timeoutMs: 1000, params: { path: parent } },
				(msg) => msg.id === id,
			);
		};
		expect((await peerStat()).payload.error.code).toBe("limit_exceeded");
		expect((await legacyStat()).error.code).toBe("limit_exceeded");
		const closed = await sendAndReceive(
			shared,
			{ type: "close", channelId: active },
			(msg) => msg.type === "closed" && msg.channelId === active,
		);
		expect(closed.channelId).toBe(active);
		await vi.waitFor(async () => expect((await peerStat()).payload.type).toBe("result"), { timeout: 5000 });
		expect((await legacyStat()).type).toBe("result");
	} finally {
		shared.terminate();
		legacy.terminate();
		await server.forceClose();
	}
});

it("keeps successful shared catalogs alive when a different transport fails during reload", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-reload-failure-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const shared = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	const legacy = new WebSocket(address.url, DAEMON_WEBSOCKET_PROTOCOL);
	try {
		await Promise.all(
			[shared, legacy].map(
				(socket) =>
					new Promise<void>((resolve, reject) => {
						socket.once("open", resolve);
						socket.once("error", reject);
					}),
			),
		);
		await sendAndReceive(shared, { type: "hello", id: "h", version: 2 }, (msg) => msg.type === "hello_ack");
		const opened = await sendAndReceive(
			shared,
			{ type: "open", id: "bind", root: parent },
			(msg) => msg.type === "opened" && msg.id === "bind",
		);
		await sendAndReceive(
			shared,
			{
				type: "channel",
				channelId: opened.channelId,
				payload: {
					type: "handshake",
					id: "h",
					versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
					requiredCapabilities: [],
					optionalCapabilities: ["primitive_operations", "catalog_refresh"],
					receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
		);
		await sendAndReceive(
			legacy,
			{
				type: "handshake",
				id: "h",
				versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
				requiredCapabilities: [],
				optionalCapabilities: ["primitive_operations", "catalog_refresh"],
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			},
			(msg) => msg.type === "handshake_ack",
		);
		const originalSend = WebSocket.prototype.send;
		const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			...args: WebSocketSendArgs
		) {
			if (JSON.parse(String(args[0])).type === "catalog_changed") {
				const callback = args[2];
				if (callback) callback(new Error("injected v1 catalog publication failure"));
				return;
			}
			return Reflect.apply(originalSend, this, args);
		});
		try {
			const legacyClosed = new Promise<void>((resolve) => legacy.once("close", () => resolve()));
			await expect(server.reload()).rejects.toThrow("failed for 1 connection");
			await legacyClosed;
		} finally {
			sendSpy.mockRestore();
		}
		for (const generation of [2, 3]) {
			if (generation === 3) await server.reload();
			const result = await sendAndReceive(
				shared,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "request",
						id: `catalog-${generation}`,
						method: "catalog.get",
						timeoutMs: 1000,
						params: {},
					},
				},
				(msg) =>
					msg.type === "channel" &&
					msg.channelId === opened.channelId &&
					msg.payload.id === `catalog-${generation}`,
			);
			expect(result.payload.result.generation).toBe(generation);
		}
	} finally {
		shared.terminate();
		legacy.terminate();
		await server.forceClose();
	}
});

it("serves a sibling channel while one channel's outbound send is stalled", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-outbound-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const socket = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		await sendAndReceive(socket, { type: "hello", id: "hello", version: 2 }, (msg) => msg.type === "hello_ack");
		const channels: string[] = [];
		for (const id of ["blocked", "sibling"]) {
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			channels.push(opened.channelId);
			const ack = await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "handshake",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations", "file_transfer"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
			expect(ack.payload.catalog.operations).not.toContain("workspace.exec");
			expect(ack.payload.catalog.operations).not.toContain("transfer.upload");
			expect(ack.payload.catalog.operations).not.toContain("transfer.download");
			expect(ack.payload.capabilities).not.toContain("file_transfer");
			expect(ack.payload.catalog.tools).not.toContainEqual(expect.objectContaining({ name: "bash" }));
		}
		const denied = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: channels[1],
				payload: {
					type: "request",
					id: "denied-exec",
					method: "workspace.exec",
					timeoutMs: 1000,
					params: { cwd: parent, command: "printf must-not-run" },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === channels[1] && msg.payload.id === "denied-exec",
		);
		expect(denied.payload.error.code).toBe("not_available");
		const upload = await sendAndReceive(
			socket,
			{
				type: "channel",
				channelId: channels[1],
				payload: {
					type: "request",
					id: "unsupported-upload",
					method: "transfer.upload",
					timeoutMs: 1000,
					params: { path: "file", length: 1, sha256: "0".repeat(64), overwrite: false },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === channels[1] && msg.payload.id === "unsupported-upload",
		);
		expect(upload.payload.type).toBe("error");
		expect(upload.payload.error).toMatchObject({ code: "not_available", executionState: "not_started" });
		const [blocked, sibling] = channels;
		let markStalled!: () => void;
		const stalled = new Promise<void>((resolve) => {
			markStalled = resolve;
		});
		let resume: (() => void) | undefined;
		const originalSend = WebSocket.prototype.send;
		const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			...args: WebSocketSendArgs
		) {
			const frame = JSON.parse(String(args[0]));
			if (
				frame.type === "channel" &&
				frame.channelId === blocked &&
				frame.payload.type === "result" &&
				frame.payload.id === "held"
			) {
				resume = () => {
					Reflect.apply(originalSend, this, args);
				};
				markStalled();
				return;
			}
			return Reflect.apply(originalSend, this, args);
		});
		try {
			const held = sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: blocked,
					payload: {
						type: "request",
						id: "held",
						method: "workspace.stat",
						timeoutMs: 1000,
						params: { path: parent },
					},
				},
				(msg) => msg.type === "channel" && msg.channelId === blocked && msg.payload.id === "held",
			);
			await stalled;
			const other = await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: sibling,
					payload: {
						type: "request",
						id: "free",
						method: "workspace.stat",
						timeoutMs: 1000,
						params: { path: parent },
					},
				},
				(msg) => msg.type === "channel" && msg.channelId === sibling && msg.payload.id === "free",
			);
			expect(other.payload.type).toBe("result");
			resume?.();
			resume = undefined;
			expect((await held).payload.type).toBe("result");
		} finally {
			resume?.();
			spy.mockRestore();
		}
	} finally {
		socket.terminate();
		await server.forceClose();
	}
});

it("closes an uncertain multi-channel socket on partial reload without stopping another physical peer", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-partial-reload-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, port: 0 });
	const address = await server.listen();
	const uncertain = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	const healthy = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	try {
		await Promise.all(
			[uncertain, healthy].map(
				(socket) =>
					new Promise<void>((resolve, reject) => {
						socket.once("open", resolve);
						socket.once("error", reject);
					}),
			),
		);
		const openChannel = async (socket: WebSocket, id: string) => {
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "h",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["catalog_refresh"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
			return opened.channelId as string;
		};
		for (const socket of [uncertain, healthy])
			await sendAndReceive(socket, { type: "hello", id: "h", version: 2 }, (msg) => msg.type === "hello_ack");
		const first = await openChannel(uncertain, "first");
		const failing = await openChannel(uncertain, "failing");
		const surviving = await openChannel(healthy, "surviving");
		const observed: object[] = [];
		uncertain.on("message", (data) => observed.push(JSON.parse(data.toString())));
		const originalSend = WebSocket.prototype.send;
		const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			...args: WebSocketSendArgs
		) {
			const frame = JSON.parse(String(args[0]));
			if (frame.type === "channel" && frame.channelId === failing && frame.payload.type === "catalog_changed") {
				args[2]?.(new Error("injected second channel catalog failure"));
				return;
			}
			return Reflect.apply(originalSend, this, args);
		});
		try {
			const closed = new Promise<void>((resolve) => uncertain.once("close", () => resolve()));
			await expect(server.reload()).rejects.toThrow("failed for 1 connection");
			await closed;
			// The earlier channel may already have observed a newer generation; the entire
			// physical socket must go away rather than rolling just one channel back.
			expect(observed).toContainEqual(
				expect.objectContaining({
					type: "channel",
					channelId: first,
					payload: expect.objectContaining({ type: "catalog_changed", generation: 2 }),
				}),
			);
		} finally {
			sendSpy.mockRestore();
		}
		for (const generation of [2, 3]) {
			if (generation === 3) await server.reload();
			const result = await sendAndReceive(
				healthy,
				{
					type: "channel",
					channelId: surviving,
					payload: {
						type: "request",
						id: `catalog-${generation}`,
						method: "catalog.get",
						timeoutMs: 1000,
						params: {},
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === surviving && msg.payload.id === `catalog-${generation}`,
			);
			expect(result.payload.result.generation).toBe(generation);
		}
	} finally {
		uncertain.terminate();
		healthy.terminate();
		await server.forceClose();
	}
});

it("releases in-flight shared work after a physical socket crash without disrupting another uplink", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-disconnect-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-allow-root",
			"--daemon-allow-process-exec",
			"--daemon-cwd",
			parent,
			"--daemon-shared-parent",
			parent,
		],
		{},
		parent,
	);
	const server = createDaemonServer({ ...parsed.configuration!, maxGlobalRequests: 1, port: 0 });
	const address = await server.listen();
	const lost = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	const surviving = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	try {
		await Promise.all(
			[lost, surviving].map(
				(socket) =>
					new Promise<void>((resolve, reject) => {
						socket.once("open", resolve);
						socket.once("error", reject);
					}),
			),
		);
		const open = async (socket: WebSocket, id: string) => {
			await sendAndReceive(socket, { type: "hello", id: "h", version: 2 }, (msg) => msg.type === "hello_ack");
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "h",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations", "tool_updates"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
			return opened.channelId as string;
		};
		const active = await open(lost, "active");
		const healthy = await open(surviving, "healthy");
		await sendAndReceive(
			lost,
			{
				type: "channel",
				channelId: active,
				payload: {
					type: "request",
					id: "running",
					method: "workspace.exec",
					timeoutMs: 15000,
					params: { cwd: parent, command: "printf ready; sleep 10" },
				},
			},
			(msg) =>
				msg.type === "channel" &&
				msg.channelId === active &&
				msg.payload.type === "update" &&
				msg.payload.id === "running",
		);
		let serial = 0;
		const stat = () => {
			const id = `stat-${++serial}`;
			return sendAndReceive(
				surviving,
				{
					type: "channel",
					channelId: healthy,
					payload: { type: "request", id, method: "workspace.stat", timeoutMs: 1000, params: { path: parent } },
				},
				(msg) => msg.type === "channel" && msg.channelId === healthy && msg.payload.id === id,
			);
		};
		expect((await stat()).payload.error.code).toBe("limit_exceeded");
		const closed = new Promise<void>((resolve) => lost.once("close", () => resolve()));
		lost.terminate();
		await closed;
		await vi.waitFor(async () => expect((await stat()).payload.type).toBe("result"), { timeout: 5000 });
	} finally {
		lost.terminate();
		surviving.terminate();
		await server.forceClose();
	}
});

it("terminates a stalled physical send rather than pinning channel output reservations", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-stalled-send-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({
		...parsed.configuration!,
		port: 0,
		protocolLimits: { ...parsed.configuration!.protocolLimits, maxTransportSendMs: 200 },
	});
	const address = await server.listen();
	const stalled = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	const healthy = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	try {
		await Promise.all(
			[stalled, healthy].map(
				(socket) =>
					new Promise<void>((resolve, reject) => {
						socket.once("open", resolve);
						socket.once("error", reject);
					}),
			),
		);
		const open = async (socket: WebSocket, id: string) => {
			await sendAndReceive(socket, { type: "hello", id: "h", version: 2 }, (msg) => msg.type === "hello_ack");
			const bound = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: bound.channelId,
					payload: {
						type: "handshake",
						id: "h",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === bound.channelId && msg.payload.type === "handshake_ack",
			);
			return bound.channelId as string;
		};
		const failing = await open(stalled, "failing");
		const surviving = await open(healthy, "surviving");
		const originalSend = WebSocket.prototype.send;
		const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			...args: WebSocketSendArgs
		) {
			const frame = JSON.parse(String(args[0]));
			if (frame.type === "channel" && frame.channelId === failing && frame.payload.type === "result") return; // Simulate a physical send callback that never settles.
			return Reflect.apply(originalSend, this, args);
		});
		try {
			const closed = new Promise<void>((resolve) => stalled.once("close", () => resolve()));
			stalled.send(
				JSON.stringify({
					type: "channel",
					channelId: failing,
					payload: {
						type: "request",
						id: "stuck",
						method: "workspace.stat",
						timeoutMs: 1000,
						params: { path: parent },
					},
				}),
			);
			await vi.waitFor(() => expect(stalled.readyState).toBe(WebSocket.CLOSED), { timeout: 3000 });
			await closed;
		} finally {
			spy.mockRestore();
		}
		const result = await sendAndReceive(
			healthy,
			{
				type: "channel",
				channelId: surviving,
				payload: {
					type: "request",
					id: "still-alive",
					method: "workspace.stat",
					timeoutMs: 1000,
					params: { path: parent },
				},
			},
			(msg) => msg.type === "channel" && msg.channelId === surviving && msg.payload.id === "still-alive",
		);
		expect(result.payload.type).toBe("result");
	} finally {
		stalled.terminate();
		healthy.terminate();
		await server.forceClose();
	}
});

it("closes the whole multiplexed socket when another channel exhausts its physical send slots", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-output-quota-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({
		...parsed.configuration!,
		port: 0,
		protocolLimits: { ...parsed.configuration!.protocolLimits, maxPendingOutboundMessages: 1 },
	});
	const address = await server.listen();
	const socket = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	let finishHeld = () => {};
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		await sendAndReceive(socket, { type: "hello", id: "hello", version: 2 }, (msg) => msg.type === "hello_ack");
		const channels: string[] = [];
		for (const id of ["first", "second"]) {
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			channels.push(opened.channelId);
			await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "h",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
		}
		let heldStarted!: () => void;
		const held = new Promise<void>((resolve) => {
			heldStarted = resolve;
		});
		const originalSend = WebSocket.prototype.send;
		const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			...args: WebSocketSendArgs
		) {
			const frame = JSON.parse(String(args[0]));
			if (frame.type === "channel" && frame.channelId === channels[0] && frame.payload.type === "result") {
				finishHeld = () => {
					if (typeof args[2] === "function") args[2](new Error("socket closed"));
				};
				heldStarted();
				return;
			}
			return Reflect.apply(originalSend, this, args);
		});
		try {
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			const request = (channelId: string, id: string) =>
				socket.send(
					JSON.stringify({
						type: "channel",
						channelId,
						payload: { type: "request", id, method: "workspace.stat", timeoutMs: 1000, params: { path: parent } },
					}),
				);
			request(channels[0], "held");
			await held;
			request(channels[1], "overflow");
			await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED), { timeout: 2000 });
			await closed;
		} finally {
			finishHeld();
			spy.mockRestore();
		}
	} finally {
		socket.terminate();
		await server.forceClose();
	}
});

it("bounds a real paused TCP reader on a multiplexed socket", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-slow-reader-"));
	dirs.push(parent);
	const file = join(parent, "large.bin");
	await writeFile(file, Buffer.alloc(512 * 1024, 65));
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const maxBytes = 4 * 1024 * 1024;
	const server = createDaemonServer({
		...parsed.configuration!,
		port: 0,
		protocolLimits: {
			...parsed.configuration!.protocolLimits,
			maxPendingOutboundBytes: maxBytes,
			maxTransportSendMs: 3000,
		},
	});
	const address = await server.listen();
	const socket = new WebSocket(address.url, SHARED_WORKSPACE_WEBSOCKET_PROTOCOL);
	let serverSocket: WebSocket | undefined;
	let peakQueuedBytes = 0;
	let largeFrames = 0;
	const originalSend = WebSocket.prototype.send;
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		await sendAndReceive(socket, { type: "hello", id: "hello", version: 2 }, (msg) => msg.type === "hello_ack");
		const channels: string[] = [];
		for (let index = 0; index < 4; index++) {
			const id = `open-${index}`;
			const opened = await sendAndReceive(
				socket,
				{ type: "open", id, root: parent },
				(msg) => msg.type === "opened" && msg.id === id,
			);
			channels.push(opened.channelId);
			await sendAndReceive(
				socket,
				{
					type: "channel",
					channelId: opened.channelId,
					payload: {
						type: "handshake",
						id: "h",
						versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
						requiredCapabilities: [],
						optionalCapabilities: ["primitive_operations"],
						receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
					},
				},
				(msg) =>
					msg.type === "channel" && msg.channelId === opened.channelId && msg.payload.type === "handshake_ack",
			);
		}
		const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			...args: WebSocketSendArgs
		) {
			if (String(args[0]).length < 200_000) return Reflect.apply(originalSend, this, args);
			serverSocket = this;
			largeFrames++;
			peakQueuedBytes = Math.max(peakQueuedBytes, this.bufferedAmount);
			const sent = Reflect.apply(originalSend, this, args);
			peakQueuedBytes = Math.max(peakQueuedBytes, this.bufferedAmount);
			return sent;
		});
		const reader = (socket as unknown as WebSocketWithSocket)._socket;
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		try {
			reader.pause();
			for (let index = 0; index < 40; index++) {
				socket.send(
					JSON.stringify({
						type: "channel",
						channelId: channels[index % channels.length],
						payload: {
							type: "request",
							id: `bulk-${index}`,
							method: "workspace.read",
							timeoutMs: 5000,
							params: { path: file },
						},
					}),
				);
			}
			await vi.waitFor(() => expect(serverSocket?.readyState).toBe(WebSocket.CLOSED), { timeout: 6000 });
		} finally {
			reader.resume();
			spy.mockRestore();
		}
		await closed;
		expect(largeFrames).toBeGreaterThan(0);
		expect(peakQueuedBytes).toBeGreaterThan(0);
		expect(peakQueuedBytes).toBeLessThanOrEqual(maxBytes + 64);
	} finally {
		socket.terminate();
		await server.forceClose();
	}
});
