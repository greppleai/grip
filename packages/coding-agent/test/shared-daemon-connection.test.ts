import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS } from "../src/core/remote-workspace-protocol/contract.ts";
import type { SharedWorkspaceServerFrame } from "../src/core/remote-workspace-protocol/shared-transport.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { SharedDaemonConnection } from "../src/daemon/shared-connection.ts";
import { SharedWorkspaceRoots } from "../src/daemon/shared-roots.ts";

type TestChannelProtocol = { receive: (payload: Buffer) => Promise<void> };
type TestChannel = { protocol: TestChannelProtocol };

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("binds independent channels on one transport, including new directories and duplicate roots", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-channel-"));
	dirs.push(parent);
	const grip = join(parent, "grip");
	const grepple = join(parent, "grepple");
	await mkdir(grip);
	await mkdir(grepple);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const configuration = parsed.configuration!;
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const handshakeRoots = new Map<string, string>();
	const closes: number[] = [];
	const connection = new SharedDaemonConnection(
		configuration,
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
			if (
				message.type === "channel" &&
				message.payload.type === "handshake_ack" &&
				!handshakeRoots.has(message.channelId)
			) {
				handshakeRoots.set(message.channelId, message.payload.workspace.root);
			}
		},
		(code) => {
			closes.push(code);
		},
	);
	const receive = (value: object) => connection.receive(Buffer.from(JSON.stringify(value)));
	try {
		await receive({ type: "hello", id: "hello", version: 2 });
		for (const [id, root] of [
			["a", grip],
			["b", grepple],
			["c", grip],
			["d", parent],
		]) {
			await receive({ type: "open", id, root });
		}
		const newlyCreated = join(parent, "new-project");
		await mkdir(newlyCreated);
		await receive({ type: "open", id: "new", root: newlyCreated });
		const opened = outgoing.filter((message) => message.type === "opened");
		expect(new Set(opened.map((message) => message.channelId)).size).toBe(5);
		for (const [index, root] of [grip, grepple, grip, parent, newlyCreated].entries()) {
			const channelId = opened[index].channelId;
			await receive({
				type: "channel",
				channelId,
				payload: {
					type: "handshake",
					id: "same-id",
					versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
					requiredCapabilities: [],
					optionalCapabilities: ["primitive_operations"],
					receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				},
			});
			expect(handshakeRoots.get(channelId)).toBe(root);
		}
		await receive({ type: "close", channelId: opened[0].channelId });
		expect(outgoing.some((message) => message.type === "closed" && message.channelId === opened[0].channelId)).toBe(
			true,
		);
		await receive({
			type: "channel",
			channelId: opened[1].channelId,
			payload: { type: "request", id: "req", method: "workspace.stat", timeoutMs: 1000, params: { path: grepple } },
		});
		// A correlated ID belonging to B is not a transfer or cancellation owned by C/D.
		// The offending channels are dropped, while B continues to serve requests.
		await receive({
			type: "channel",
			channelId: opened[2].channelId,
			payload: { type: "transfer_chunk", id: "req", sequence: 0, dataBase64: "YQ==" },
		});
		await receive({ type: "channel", channelId: opened[3].channelId, payload: { type: "cancel", id: "req" } });
		for (const channelId of [opened[2].channelId, opened[3].channelId]) {
			expect(outgoing).toContainEqual({
				type: "closed",
				channelId,
				reason: expect.objectContaining({ code: "protocol_error" }),
			});
		}
		// A malformed inner message with a usable ID is an error on B, not a socket failure.
		await receive({
			type: "channel",
			channelId: opened[1].channelId,
			payload: { type: "cancel", id: "bad-inner", forged: true },
		});
		expect(outgoing).toContainEqual({
			type: "channel",
			channelId: opened[1].channelId,
			payload: expect.objectContaining({
				type: "error",
				id: "bad-inner",
				error: expect.objectContaining({ code: "invalid_request" }),
			}),
		});
		// A malformed inner message without a usable ID terminates only its own channel.
		await receive({ type: "channel", channelId: opened[4].channelId, payload: { type: "unknown" } });
		expect(outgoing).toContainEqual({
			type: "closed",
			channelId: opened[4].channelId,
			reason: expect.objectContaining({ code: "invalid_payload" }),
		});
		await receive({
			type: "channel",
			channelId: opened[1].channelId,
			payload: {
				type: "request",
				id: "after-cross-talk",
				method: "workspace.stat",
				timeoutMs: 1000,
				params: { path: grepple },
			},
		});
		await vi.waitFor(() => {
			expect(
				outgoing.some(
					(message) =>
						message.type === "channel" &&
						message.channelId === opened[1].channelId &&
						message.payload.type === "result" &&
						message.payload.id === "after-cross-talk",
				),
			).toBe(true);
		});
		expect(closes).toEqual([]);
	} finally {
		await connection.disconnect();
	}
});

it("dispatches a sibling during a channel-local wait but retains the global inbound message cap", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-fair-receive-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const closes: number[] = [];
	const connection = new SharedDaemonConnection(
		parsed.configuration!,
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
		},
		(code) => {
			closes.push(code);
		},
	);
	const receive = (value: object) => connection.receive(Buffer.from(JSON.stringify(value)));
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		await receive({ type: "hello", id: "hello", version: 2 });
		for (const id of ["a", "b"]) await receive({ type: "open", id, root: parent });
		const opened = outgoing.filter((message) => message.type === "opened");
		const [a, b] = opened.map((message) => message.channelId);
		for (const channelId of [a, b]) {
			await receive({
				type: "channel",
				channelId,
				payload: {
					type: "handshake",
					id: "handshake",
					versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
					requiredCapabilities: [],
					optionalCapabilities: ["primitive_operations"],
					receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				},
			});
		}
		// Controlled channel-local wait. Unlike a blocked physical WebSocket send,
		// it must not prevent the other channel's already admitted request.
		const channels = (connection as unknown as { channels: Map<string, TestChannel> }).channels;
		const aProtocol = channels.get(a)!.protocol;
		const started = vi.fn();
		vi.spyOn(aProtocol, "receive").mockImplementation(async () => {
			started();
			await blocked;
		});
		const slow = receive({
			type: "channel",
			channelId: a,
			payload: {
				type: "request",
				id: "slow",
				method: "catalog.get",
				params: {},
				timeoutMs: 1000,
			},
		});
		await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
		const fast = receive({
			type: "channel",
			channelId: b,
			payload: {
				type: "request",
				id: "fast",
				method: "catalog.get",
				params: {},
				timeoutMs: 1000,
			},
		});
		await vi.waitFor(
			() =>
				expect(outgoing).toContainEqual({
					type: "channel",
					channelId: b,
					payload: expect.objectContaining({ type: "result", id: "fast" }),
				}),
			{ timeout: 1500 },
		);
		await fast;
		// A slow channel cannot hold up an unrelated open/handshake on this socket.
		await receive({ type: "open", id: "late", root: parent });
		const late = outgoing.find((message) => message.type === "opened" && message.id === "late");
		expect(late?.type).toBe("opened");
		if (late?.type !== "opened") throw new Error("Late channel did not open");
		await receive({
			type: "channel",
			channelId: late.channelId,
			payload: {
				type: "handshake",
				id: "handshake",
				versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
				requiredCapabilities: [],
				optionalCapabilities: ["primitive_operations"],
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			},
		});
		expect(outgoing).toContainEqual({
			type: "channel",
			channelId: late.channelId,
			payload: expect.objectContaining({ type: "handshake_ack", id: "handshake" }),
		});
		// Dispatch fairness does not release the physical connection's inbound
		// budget. Hold A's already admitted work and exhaust the shared message cap.
		const flood = Array.from(
			{ length: parsed.configuration!.protocolLimits.maxPendingInboundMessages - 1 },
			(_, index) =>
				receive({
					type: "channel",
					channelId: a,
					payload: {
						type: "request",
						id: `queued-${index}`,
						method: "catalog.get",
						params: {},
						timeoutMs: 1000,
					},
				}),
		);
		await vi.waitFor(() =>
			expect(started).toHaveBeenCalledTimes(parsed.configuration!.protocolLimits.maxPendingInboundMessages),
		);
		await receive({
			type: "channel",
			channelId: b,
			payload: {
				type: "request",
				id: "over-budget",
				method: "catalog.get",
				params: {},
				timeoutMs: 1000,
			},
		});
		expect(closes).toEqual([1009]);
		release();
		await Promise.all([slow, ...flood]);
	} finally {
		release();
		await connection.disconnect();
	}
});
it("detaching a channel cancels queued write and directory creation without harming siblings", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-detach-write-"));
	dirs.push(parent);
	const path = join(parent, "file.txt");
	await writeFile(path, "old");
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const closes: number[] = [];
	const connection = new SharedDaemonConnection(
		{
			...parsed.configuration!,
			protocolLimits: { ...parsed.configuration!.protocolLimits, maxCancellationMs: 1500 },
		},
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
		},
		(code) => {
			closes.push(code);
		},
	);
	const receive = (value: object) => connection.receive(Buffer.from(JSON.stringify(value)));
	let release!: () => void;
	let started!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const blocker = withFileMutationQueue(path, async () => {
		started();
		await held;
	});
	await entered;
	const directory = join(parent, "new-directory");
	let releaseDirectory!: () => void;
	let startedDirectory!: () => void;
	const heldDirectory = new Promise<void>((resolve) => {
		releaseDirectory = resolve;
	});
	const enteredDirectory = new Promise<void>((resolve) => {
		startedDirectory = resolve;
	});
	const directoryBlocker = withFileMutationQueue(directory, async () => {
		startedDirectory();
		await heldDirectory;
	});
	await enteredDirectory;
	try {
		await receive({ type: "hello", id: "hello", version: 2 });
		await receive({ type: "open", id: "writer", root: parent });
		await receive({ type: "open", id: "sibling", root: parent });
		const opened = outgoing.filter((message) => message.type === "opened");
		const writer = opened[0].channelId;
		const sibling = opened[1].channelId;
		for (const channelId of [writer, sibling]) {
			await receive({
				type: "channel",
				channelId,
				payload: {
					type: "handshake",
					id: "handshake",
					versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
					requiredCapabilities: [],
					optionalCapabilities: ["primitive_operations"],
					receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				},
			});
		}
		await receive({
			type: "channel",
			channelId: writer,
			payload: {
				type: "request",
				id: "queued-write",
				method: "workspace.write",
				timeoutMs: 2000,
				params: {
					path,
					contentBase64: Buffer.from("new").toString("base64"),
					expectedRevision: { unsafeOverwrite: true },
				},
			},
		});
		await receive({
			type: "channel",
			channelId: writer,
			payload: {
				type: "request",
				id: "queued-mkdir",
				method: "workspace.mkdir",
				timeoutMs: 2000,
				params: { path: directory, recursive: true },
			},
		});
		await receive({ type: "close", channelId: writer });
		expect(outgoing).toContainEqual({ type: "closed", channelId: writer });
		await receive({
			type: "channel",
			channelId: sibling,
			payload: {
				type: "request",
				id: "after-detach",
				method: "catalog.get",
				timeoutMs: 2000,
				params: {},
			},
		});
		await vi.waitFor(() =>
			expect(outgoing).toContainEqual({
				type: "channel",
				channelId: sibling,
				payload: expect.objectContaining({ type: "result", id: "after-detach" }),
			}),
		);
		expect(closes).toEqual([]);
		let disconnected = false;
		const shutdown = connection.disconnect().then(() => {
			disconnected = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(disconnected).toBe(false);
		release();
		releaseDirectory();
		await shutdown;
		await blocker;
		await directoryBlocker;
		await withFileMutationQueue(path, async () => undefined);
		await withFileMutationQueue(directory, async () => undefined);
		expect(await readFile(path, "utf8")).toBe("old");
		await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		release();
		releaseDirectory();
		await Promise.all([blocker, directoryBlocker]);
		await connection.disconnect();
	}
});

it("cancels a queued v2 mkdir as not started without detaching its channel", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-cancel-mkdir-"));
	dirs.push(parent);
	const directory = join(parent, "new-directory");
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const closes: number[] = [];
	const connection = new SharedDaemonConnection(
		{
			...parsed.configuration!,
			protocolLimits: { ...parsed.configuration!.protocolLimits, maxCancellationMs: 1500 },
		},
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
		},
		(code) => {
			closes.push(code);
		},
	);
	const receive = (frame: object) => connection.receive(Buffer.from(JSON.stringify(frame)));
	let release!: () => void;
	let started!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const blocker = withFileMutationQueue(directory, async () => {
		started();
		await held;
	});
	await entered;
	try {
		await receive({ type: "hello", id: "hello", version: 2 });
		await receive({ type: "open", id: "open", root: parent });
		const opened = outgoing.find((message) => message.type === "opened");
		if (opened?.type !== "opened") throw new Error("Expected channel to open");
		const channelId = opened.channelId;
		await receive({
			type: "channel",
			channelId,
			payload: {
				type: "handshake",
				id: "handshake",
				versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
				requiredCapabilities: [],
				optionalCapabilities: ["primitive_operations"],
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			},
		});
		await receive({
			type: "channel",
			channelId,
			payload: {
				type: "request",
				id: "mkdir",
				method: "workspace.mkdir",
				timeoutMs: 2000,
				params: { path: directory, recursive: true },
			},
		});
		const cancelled = receive({ type: "channel", channelId, payload: { type: "cancel", id: "mkdir" } });
		// Allow the receive queue to abort the handler before releasing the file queue.
		await new Promise<void>((resolve) => setTimeout(resolve, 15));
		release();
		await cancelled;
		await blocker;
		await withFileMutationQueue(directory, async () => undefined);
		expect(outgoing).toContainEqual({
			type: "channel",
			channelId,
			payload: expect.objectContaining({
				type: "error",
				id: "mkdir",
				error: expect.objectContaining({ code: "cancelled", executionState: "not_started" }),
			}),
		});
		await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
		await receive({
			type: "channel",
			channelId,
			payload: {
				type: "request",
				id: "after-cancel",
				method: "catalog.get",
				timeoutMs: 1000,
				params: {},
			},
		});
		await vi.waitFor(() =>
			expect(outgoing).toContainEqual({
				type: "channel",
				channelId,
				payload: expect.objectContaining({ type: "result", id: "after-cancel" }),
			}),
		);
		expect(closes).toEqual([]);
	} finally {
		release();
		await blocker;
		await connection.disconnect();
	}
});

it("does not expose operator resources or a global temporary root on v2 channels, including after reload", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-resource-"));
	const outside = await mkdtemp(join(tmpdir(), "grip-shared-private-"));
	dirs.push(parent, outside);
	const child = join(parent, "child");
	await mkdir(child);
	const userAgentsPath = join(outside, "AGENTS.md");
	await writeFile(userAgentsPath, "operator-only");
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const configuration = {
		...parsed.configuration!,
		temporaryRoot: outside,
		userAgentsPath,
		sandboxInstructionsPath: join(outside, "SANDBOX.md"),
	};
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const connection = new SharedDaemonConnection(
		configuration,
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
		},
		() => undefined,
	);
	const receive = (frame: object) => connection.receive(Buffer.from(JSON.stringify(frame)));
	try {
		await receive({ type: "hello", id: "hello", version: 2 });
		await receive({ type: "open", id: "child", root: child });
		const opened = outgoing.find((message) => message.type === "opened")!;
		const channelId = opened.channelId;
		await receive({
			type: "channel",
			channelId,
			payload: {
				type: "handshake",
				id: "h",
				versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
				requiredCapabilities: [],
				optionalCapabilities: ["primitive_operations", "catalog_refresh"],
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			},
		});
		const ack = outgoing.find((message) => message.type === "channel" && message.payload.type === "handshake_ack")!;
		expect(
			ack.type === "channel" && ack.payload.type === "handshake_ack" && ack.payload.catalog.operations,
		).not.toContain("resource.read");
		for (const [id, method, path] of [
			["resource", "resource.read", "AGENTS.md"],
			["temp", "workspace.read", userAgentsPath],
		] as const) {
			await receive({
				type: "channel",
				channelId,
				payload: { type: "request", id, method, timeoutMs: 1000, params: { path } },
			});
			await vi.waitFor(() =>
				expect(outgoing).toContainEqual({
					type: "channel",
					channelId,
					payload: expect.objectContaining({ type: "error", id }),
				}),
			);
		}
		await connection.reload();
		await receive({
			type: "channel",
			channelId,
			payload: { type: "request", id: "catalog", method: "catalog.get", timeoutMs: 1000, params: {} },
		});
		await vi.waitFor(() =>
			expect(outgoing).toContainEqual({
				type: "channel",
				channelId,
				payload: expect.objectContaining({
					type: "result",
					id: "catalog",
					result: expect.objectContaining({ operations: expect.not.arrayContaining(["resource.read"]) }),
				}),
			}),
		);
	} finally {
		await connection.disconnect();
	}
});

it("rejects roots outside the parent without killing siblings; forged channels fail closed", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-channel-"));
	const outside = await mkdtemp(join(tmpdir(), "grip-shared-outside-"));
	dirs.push(parent, outside);
	await symlink(outside, join(parent, "escape"), "dir");
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const closes: number[] = [];
	const connection = new SharedDaemonConnection(
		parsed.configuration!,
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
		},
		(code) => {
			closes.push(code);
		},
	);
	const receive = (value: object) => connection.receive(Buffer.from(JSON.stringify(value)));
	try {
		await receive({ type: "hello", id: "hello", version: 2 });
		await receive({ type: "open", id: "valid", root: parent });
		await receive({ type: "open", id: "invalid", root: outside });
		await receive({ type: "open", id: "escape", root: join(parent, "escape") });
		expect(outgoing.filter((message) => message.type === "opened")).toHaveLength(1);
		expect(
			outgoing.filter((message) => message.type === "control_error" && message.code === "invalid_root"),
		).toHaveLength(2);
		expect(closes).toEqual([]);
		await receive({ type: "close", channelId: "0123456789abcdef01234567" });
		expect(closes).toEqual([1002]);
	} finally {
		await connection.disconnect();
	}
});

it("bounds the physical v2 inbound queue while a slow send blocks dispatch", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-shared-queue-"));
	dirs.push(parent);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const configuration = parsed.configuration!;
	let unblock!: () => void;
	const held = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const outgoing: SharedWorkspaceServerFrame[] = [];
	const closes: number[] = [];
	let handshakeStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		handshakeStarted = resolve;
	});
	const connection = new SharedDaemonConnection(
		configuration,
		await SharedWorkspaceRoots.fromParent(parent),
		async (message) => {
			outgoing.push(message);
			if (message.type === "hello_ack") {
				handshakeStarted();
				await held;
			}
		},
		(code) => {
			closes.push(code);
		},
	);
	const receive = (value: object) => connection.receive(Buffer.from(JSON.stringify(value)));
	try {
		const pending = [receive({ type: "hello", id: "hello", version: 2 })];
		await started;
		for (let index = 1; index <= configuration.protocolLimits.maxPendingInboundMessages; index++) {
			pending.push(receive({ type: "open", id: `queued-${index}`, root: parent }));
		}
		expect(closes).toEqual([1009]);
		unblock();
		await Promise.all(pending);
		expect(outgoing.map((message) => message.type)).toEqual(["hello_ack"]);
	} finally {
		unblock();
		await connection.disconnect();
	}
});
