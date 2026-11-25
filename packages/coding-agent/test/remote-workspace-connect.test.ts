import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
	RemoteWorkspaceDisconnectedError,
	RemoteWorkspaceTransportError,
} from "../src/core/remote-workspace-protocol/session.ts";
import {
	DeferredRemoteToolOperations,
	RemoteToolOperations,
	type RemoteToolOperationsConnectOptions,
	type ToolBackendInfo,
} from "../src/core/tools/operations.ts";

vi.mock("ws", () => ({ default: vi.fn() }));
interface DelayOptions {
	signal: AbortSignal;
}

vi.mock("node:timers/promises", () => ({
	setTimeout: (ms: number, _value: unknown, options: DelayOptions) =>
		new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				options.signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				cleanup();
				reject(new Error("aborted"));
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, ms);
			options.signal.addEventListener("abort", abort, { once: true });
			if (options.signal.aborted) abort();
		}),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function remoteFixture(id = "fixture", root = "/workspace") {
	let disconnected = false;
	const remote = {
		cwd: root,
		workspacePathFlavor: "posix" as const,
		getBackendInfo: (): ToolBackendInfo => ({
			type: "remote",
			configured: true,
			protocol: "ws",
			url: "ws://fixture",
			cwd: root,
			workspace: { id, root, pathFlavor: "posix" },
		}),
		verifyWorkspace: vi.fn(async (): Promise<void> => undefined),
		resolveWorkspaceDirectory: vi.fn(async (path: string) => path),
		restoreToolSchemas: vi.fn(),
		onWorkspaceToolCatalogChanged: vi.fn(() => () => undefined),
		isDisconnected: () => disconnected,
		dispose: vi.fn(async () => undefined),
		readFile: vi.fn(async () => Buffer.from("recovered")),
		writeFile: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({ exitCode: 0 })),
	};
	return {
		...remote,
		operations: remote as unknown as RemoteToolOperations,
		lose: (options: RemoteToolOperationsConnectOptions | undefined) => {
			disconnected = true;
			options?.onDisconnect?.("fixture transport lost");
		},
	};
}

const endpoint = "ws://127.0.0.1:8787/grip/workspace";

describe("remote workspace connection failures", () => {
	it("rejects without an uncaught error when teardown emits another error", async () => {
		let socket!: EventEmitter;
		const terminate = vi.fn();
		class MockSocket extends EventEmitter {
			constructor() {
				super();
				socket = this;
			}
			terminate() {
				terminate();
				this.emit("error", new Error("Connection ended"));
			}
		}
		vi.mocked(WebSocket).mockImplementation(MockSocket as unknown as typeof WebSocket);
		const connection = RemoteToolOperations.connect(endpoint);
		const rejected = expect(connection).rejects.toThrow("Remote workspace connection failed");
		expect(() => socket.emit("error", new Error("Connection ended"))).not.toThrow();
		await rejected;
		expect(terminate).toHaveBeenCalledOnce();
		expect(() => socket.emit("error", new Error("Late error"))).not.toThrow();
		expect(socket.listenerCount("open")).toBe(0);
	});
});

describe("remote workspace recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("joins concurrent failures, restores cwd/catalog, and ignores stale callbacks", async () => {
		const first = remoteFixture();
		const next = remoteFixture();
		const connect = vi
			.spyOn(RemoteToolOperations, "connect")
			.mockResolvedValueOnce(first.operations)
			.mockResolvedValue(next.operations);
		const interrupted = vi.fn();
		const backend = new DeferredRemoteToolOperations("/workspace", interrupted);
		const catalog = vi.fn();
		backend.onWorkspaceToolCatalogChanged(catalog);
		await backend.configureRemote(endpoint, { token: "private-fixture-token" });
		backend.cwd = "/workspace/project";
		const original = connect.mock.calls[0]![1];
		first.lose(original);
		first.lose(original);
		expect(backend.connectionState.status).toBe("reconnecting");
		expect(backend.isDisconnected()).toBe(true);
		await vi.advanceTimersByTimeAsync(500);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(connect.mock.calls[1]![1]?.token).toBe("private-fixture-token");
		expect(next.resolveWorkspaceDirectory).toHaveBeenCalledWith("/workspace/project", expect.any(AbortSignal));
		expect(next.restoreToolSchemas).toHaveBeenCalledWith(first.operations);
		expect(backend.cwd).toBe("/workspace/project");
		expect(backend.connectionState.status).toBe("recovered");
		expect(backend.isDisconnected()).toBe(false);
		expect(catalog).toHaveBeenCalledOnce();
		expect(interrupted).toHaveBeenCalledOnce();
		first.lose(original);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(connect).toHaveBeenCalledTimes(2);
		await backend.dispose();
	});

	it("retries one safe read but never replays commands or mutations", async () => {
		const first = remoteFixture();
		const next = remoteFixture();
		const connect = vi
			.spyOn(RemoteToolOperations, "connect")
			.mockResolvedValueOnce(first.operations)
			.mockResolvedValue(next.operations);
		const backend = new DeferredRemoteToolOperations("/workspace");
		await backend.configureRemote(endpoint);
		const failure = new RemoteWorkspaceDisconnectedError("fixture loss", "indeterminate");
		first.readFile.mockImplementationOnce(async () => {
			first.lose(connect.mock.calls[0]![1]);
			throw failure;
		});
		first.exec.mockRejectedValueOnce(failure);
		first.writeFile.mockRejectedValueOnce(failure);
		const read = backend.readFile("a");
		await expect(backend.exec("do not replay", { onData: () => undefined })).rejects.toBe(failure);
		await expect(backend.writeFile("a", "b")).rejects.toBe(failure);
		await vi.advanceTimersByTimeAsync(500);
		expect(await read).toEqual(Buffer.from("recovered"));
		expect(next.readFile).toHaveBeenCalledOnce();
		expect(next.exec).not.toHaveBeenCalled();
		expect(next.writeFile).not.toHaveBeenCalled();
		await backend.dispose();
	});

	it("exhausts four transport attempts and preserves the original cause", async () => {
		const first = remoteFixture();
		const connect = vi
			.spyOn(RemoteToolOperations, "connect")
			.mockResolvedValueOnce(first.operations)
			.mockRejectedValue(new RemoteWorkspaceTransportError("still unavailable"));
		const backend = new DeferredRemoteToolOperations("/workspace");
		await backend.configureRemote(endpoint);
		first.lose(connect.mock.calls[0]![1]);
		await vi.advanceTimersByTimeAsync(7500);
		expect(connect).toHaveBeenCalledTimes(5);
		expect(backend.connectionState).toMatchObject({
			status: "exhausted",
			attempt: 4,
			message: expect.stringMatching(/fixture transport lost.*still unavailable/),
		});
		expect(backend.isDisconnected()).toBe(true);
		await backend.dispose();
	});

	it.each(["rejection", "timeout"])("disables a replacement after catalog refresh %s", async (failure) => {
		const first = remoteFixture();
		const next = remoteFixture();
		const connect = vi
			.spyOn(RemoteToolOperations, "connect")
			.mockResolvedValueOnce(first.operations)
			.mockResolvedValueOnce(next.operations);
		const backend = new DeferredRemoteToolOperations("/workspace");
		const catalog = vi.fn(async () => {
			if (failure === "rejection") throw new Error("catalog refresh failed");
			await deferred<void>().promise;
		});
		backend.onWorkspaceToolCatalogChanged(catalog);
		await backend.configureRemote(endpoint);
		first.lose(connect.mock.calls[0]![1]);
		await vi.advanceTimersByTimeAsync(failure === "rejection" ? 500 : 45_000);
		expect(catalog).toHaveBeenCalledOnce();
		expect(backend.connectionState.status).toBe("exhausted");
		expect(next.dispose).toHaveBeenCalledOnce();
		await expect(backend.writeFile("a", "b")).rejects.toBeInstanceOf(RemoteWorkspaceDisconnectedError);
		expect(next.writeFile).not.toHaveBeenCalled();
		await backend.dispose();
	});

	it("does not reconnect after intentional detach during backoff", async () => {
		const first = remoteFixture();
		const connect = vi.spyOn(RemoteToolOperations, "connect").mockResolvedValue(first.operations);
		const backend = new DeferredRemoteToolOperations("/workspace");
		await backend.configureRemote(endpoint);
		first.lose(connect.mock.calls[0]![1]);
		await vi.advanceTimersByTimeAsync(200);
		await backend.clear();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(connect).toHaveBeenCalledOnce();
		expect(backend.connectionState.status).toBe("detached");
	});

	it.each(["authentication rejected", "incompatible protocol", "workspace root mismatch"])(
		"does not retry permanent failure: %s",
		async (message) => {
			const first = remoteFixture();
			const connect = vi
				.spyOn(RemoteToolOperations, "connect")
				.mockResolvedValueOnce(first.operations)
				.mockRejectedValue(new Error(message));
			const backend = new DeferredRemoteToolOperations("/workspace");
			await backend.configureRemote(endpoint);
			first.lose(connect.mock.calls[0]![1]);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(connect).toHaveBeenCalledTimes(2);
			expect(backend.connectionState).toMatchObject({
				status: "exhausted",
				message: expect.stringContaining(message),
			});
			await backend.dispose();
		},
	);

	it.each([remoteFixture("replacement"), remoteFixture("fixture", "/other")])(
		"rejects a different workspace identity",
		async (next) => {
			const first = remoteFixture();
			const connect = vi
				.spyOn(RemoteToolOperations, "connect")
				.mockResolvedValueOnce(first.operations)
				.mockResolvedValue(next.operations);
			const backend = new DeferredRemoteToolOperations("/workspace");
			await backend.configureRemote(endpoint);
			first.lose(connect.mock.calls[0]![1]);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(connect).toHaveBeenCalledTimes(2);
			expect(backend.connectionState).toMatchObject({
				status: "exhausted",
				message: expect.stringContaining("identity changed"),
			});
			expect(next.dispose).toHaveBeenCalledOnce();
			await backend.dispose();
		},
	);

	it("cancels an obsolete configure and disposes its late factory result", async () => {
		const gate = deferred<RemoteToolOperations>();
		const stale = remoteFixture();
		const next = remoteFixture("new");
		const connect = vi
			.spyOn(RemoteToolOperations, "connect")
			.mockReturnValueOnce(gate.promise)
			.mockResolvedValue(next.operations);
		const backend = new DeferredRemoteToolOperations("/workspace");
		const old = expect(backend.configureRemote(endpoint)).rejects.toThrow("cancelled");
		await backend.configureRemote(endpoint);
		await old;
		gate.resolve(stale.operations);
		await vi.advanceTimersByTimeAsync(0);
		expect(stale.dispose).toHaveBeenCalledOnce();
		expect(backend.getBackendInfo()).toMatchObject({ workspace: { id: "new" } });
		expect(backend.connectionState.status).toBe("connected");
		next.lose(connect.mock.calls[1]![1]);
		await vi.advanceTimersByTimeAsync(500);
		expect(connect).toHaveBeenCalledTimes(3);
		await backend.dispose();
	});

	it.each(["factory", "verification", "catalog"])(
		"bounds stalled %s work by the overall recovery budget",
		async (stage) => {
			const gate = deferred<RemoteToolOperations>();
			const first = remoteFixture();
			const next = remoteFixture();
			const connect = vi.spyOn(RemoteToolOperations, "connect").mockResolvedValueOnce(first.operations);
			if (stage === "factory") connect.mockReturnValue(gate.promise);
			else connect.mockResolvedValue(next.operations);
			if (stage === "verification") next.verifyWorkspace.mockReturnValue(new Promise(() => undefined));
			const backend = new DeferredRemoteToolOperations("/workspace");
			if (stage === "catalog") backend.onWorkspaceToolCatalogChanged(() => new Promise(() => undefined));
			await backend.configureRemote(endpoint);
			first.lose(connect.mock.calls[0]![1]);
			await vi.advanceTimersByTimeAsync(45_000);
			expect(backend.connectionState).toMatchObject({
				status: "exhausted",
				message: expect.stringContaining("budget exhausted"),
			});
			expect(backend.isDisconnected()).toBe(true);
			gate.resolve(next.operations);
			await vi.advanceTimersByTimeAsync(0);
			await backend.dispose();
		},
	);
	it("does not publish an obsolete verification after connection replacement", async () => {
		const gate = deferred<void>();
		const stale = remoteFixture();
		stale.verifyWorkspace.mockReturnValue(gate.promise);
		const next = remoteFixture("new");
		vi.spyOn(RemoteToolOperations, "connect")
			.mockResolvedValueOnce(stale.operations)
			.mockResolvedValue(next.operations);
		const backend = new DeferredRemoteToolOperations("/workspace");
		const old = expect(backend.configureRemote(endpoint)).rejects.toThrow("cancelled");
		await vi.advanceTimersByTimeAsync(0);
		expect(stale.verifyWorkspace).toHaveBeenCalledOnce();
		await backend.configureRemote(endpoint);
		await old;
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(stale.dispose).toHaveBeenCalledOnce();
		expect(backend.getBackendInfo()).toMatchObject({ workspace: { id: "new" } });
		await backend.dispose();
	});

	it("does not retry a pending read on an intentionally replaced workspace", async () => {
		const first = remoteFixture();
		const next = remoteFixture("new");
		const connect = vi
			.spyOn(RemoteToolOperations, "connect")
			.mockResolvedValueOnce(first.operations)
			.mockResolvedValue(next.operations);
		const backend = new DeferredRemoteToolOperations("/workspace");
		await backend.configureRemote(endpoint);
		const failure = new RemoteWorkspaceDisconnectedError("interrupted read", "not_started");
		first.readFile.mockImplementationOnce(async () => {
			first.lose(connect.mock.calls[0]![1]);
			throw failure;
		});
		const read = expect(backend.readFile("a")).rejects.toBe(failure);
		await vi.advanceTimersByTimeAsync(0);
		await backend.configureRemote(endpoint);
		await read;
		expect(next.readFile).not.toHaveBeenCalled();
		await backend.dispose();
	});
});
