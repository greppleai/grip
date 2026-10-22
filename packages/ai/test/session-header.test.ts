import { afterEach, describe, expect, it } from "vitest";
import { registerApiProvider, unregisterApiProviders } from "../src/api-registry.ts";
import { stream, streamSimple } from "../src/stream.ts";
import type { Context, Model, StreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const sourceId = "session-header-test";
const model = { api: "session-header-test" } as Model<"session-header-test">;
const context: Context = { systemPrompt: "", messages: [] };

afterEach(() => unregisterApiProviders(sourceId));

describe("session request header", () => {
	it("forwards the session ID in both stream APIs without changing caller headers", () => {
		const received: Array<StreamOptions | undefined> = [];
		const capture = (_model: Model<"session-header-test">, _context: Context, options?: StreamOptions) => {
			received.push(options);
			return new AssistantMessageEventStream();
		};
		registerApiProvider({ api: model.api, stream: capture, streamSimple: capture }, sourceId);
		const headers = { "x-custom": "value", "x-session-id": "stale" };
		const options = { sessionId: "our-session", headers };
		stream(model, context, options);
		streamSimple(model, context, options);
		expect(received).toHaveLength(2);
		for (const value of received) {
			expect(value?.headers).toEqual({ "x-custom": "value", "x-session-id": "our-session" });
		}
		expect(headers["x-session-id"]).toBe("stale");
	});

	it("leaves requests without a session ID alone", () => {
		let received: StreamOptions | undefined;
		const capture = (_model: Model<"session-header-test">, _context: Context, options?: StreamOptions) => {
			received = options;
			return new AssistantMessageEventStream();
		};
		registerApiProvider({ api: model.api, stream: capture, streamSimple: capture }, sourceId);
		streamSimple(model, context, { headers: { "x-custom": "value" } });
		expect(received?.headers).toEqual({ "x-custom": "value" });
		stream(model, context);
		expect(received).toBeUndefined();
	});
});
