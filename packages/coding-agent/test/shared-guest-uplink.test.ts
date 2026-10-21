import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { VERSION } from "../src/config.ts";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
	type RemoteWorkspaceServerMessage,
} from "../src/core/remote-workspace-protocol/contract.ts";
import { GuestSharedUplink } from "../src/core/remote-workspace-protocol/guest-shared-uplink.ts";
import { SHARED_WORKSPACE_WEBSOCKET_PROTOCOL } from "../src/core/remote-workspace-protocol/shared-transport.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function inbox() {
	const messages: RemoteWorkspaceServerMessage[] = [];
	const waiters: Array<(message: RemoteWorkspaceServerMessage) => void> = [];
	return {
		receive(message: RemoteWorkspaceServerMessage) {
			const waiter = waiters.shift();
			if (waiter) waiter(message);
			else messages.push(message);
		},
		next: () => {
			const first = messages.shift();
			if (first) return Promise.resolve(first);
			return new Promise<RemoteWorkspaceServerMessage>((resolve) => waiters.push(resolve));
		},
	};
}

it("opens independent daemon channels on one authenticated v2 uplink and fails closed on loss", async () => {
	const parent = await mkdtemp(join(tmpdir(), "grip-broker-uplink-"));
	const outside = await mkdtemp(join(tmpdir(), "grip-broker-outside-"));
	roots.push(parent, outside);
	const child = join(parent, "child");
	await mkdir(child);
	const parsed = await parseDaemonCommand(
		["--daemon", "--daemon-allow-root", "--daemon-cwd", parent, "--daemon-shared-parent", parent],
		{},
		parent,
	);
	const server = createDaemonServer({
		...parsed.configuration!,
		port: 0,
		token: "local-test-token-with-more-than-32-bytes",
	});
	const { url } = await server.listen();
	let uplink: GuestSharedUplink | undefined;
	try {
		await expect(GuestSharedUplink.connect(url, "incorrect")).rejects.toThrow("Shared workspace connection failed");
		uplink = await GuestSharedUplink.connect(url, "local-test-token-with-more-than-32-bytes");
		expect(uplink.epoch).toHaveLength(24);
		const first = inbox();
		const second = inbox();
		const failures: string[] = [];
		const a = await uplink.open(child, first.receive, (error) => failures.push(`first:${error.message}`));
		const b = await uplink.open(child, second.receive, (error) => failures.push(`second:${error.message}`));
		expect(a.id).not.toBe(b.id);
		await expect(
			uplink.open(
				outside,
				() => undefined,
				() => undefined,
			),
		).rejects.toThrow("invalid_root");
		const handshake = {
			type: "handshake" as const,
			id: "same-id",
			versions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
			requiredCapabilities: [],
			optionalCapabilities: ["primitive_operations", "tool_updates"],
			receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
		};
		await Promise.all([a.send(handshake), b.send(handshake)]);
		const [ackA, ackB] = await Promise.all([first.next(), second.next()]);
		expect(ackA.type).toBe("handshake_ack");
		expect(ackB.type).toBe("handshake_ack");
		const stat = {
			type: "request" as const,
			id: "same-request",
			method: "workspace.stat" as const,
			timeoutMs: 1000,
			params: { path: child },
		};
		await Promise.all([a.send(stat), b.send(stat)]);
		expect((await first.next()).type).toBe("result");
		expect((await second.next()).type).toBe("result");
		await a.close();
		await expect(a.send(stat)).rejects.toThrow("closed");
		uplink.dispose();
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("second:");
		await expect(b.send(stat)).rejects.toThrow("closed");
	} finally {
		uplink?.dispose();
		await server.forceClose();
	}
});

it("refuses a v2 daemon whose running binary version does not match the broker", async () => {
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		handleProtocols: () => SHARED_WORKSPACE_WEBSOCKET_PROTOCOL,
	});
	try {
		server.on("connection", (socket) => {
			socket.on("message", (data) => {
				const frame = JSON.parse(data.toString()) as { id: string };
				socket.send(
					JSON.stringify({
						type: "hello_ack",
						id: frame.id,
						version: 2,
						epoch: "fake-epoch-1234567890123456",
						daemonVersion: `${VERSION}-stale`,
					}),
				);
			});
		});
		if (!server.address()) await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address() as AddressInfo;
		await expect(GuestSharedUplink.connect(`ws://127.0.0.1:${address.port}/grip/workspace`)).rejects.toThrow(
			"daemon version mismatch",
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
