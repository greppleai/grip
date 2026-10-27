import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RemoteToolOperations } from "../src/core/tools/operations.ts";

vi.mock("ws", () => ({ default: vi.fn() }));

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
		const connection = RemoteToolOperations.connect("ws://127.0.0.1:8787/grip/workspace");
		const rejected = expect(connection).rejects.toThrow("Failed to connect remote workspace");
		expect(() => socket.emit("error", new Error("Connection ended"))).not.toThrow();
		await rejected;
		expect(terminate).toHaveBeenCalledOnce();
		expect(() => socket.emit("error", new Error("Late error"))).not.toThrow();
		expect(socket.listenerCount("open")).toBe(0);
	});
});
