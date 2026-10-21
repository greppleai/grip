import { expect, it, vi } from "vitest";
import { DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS as limits } from "../src/core/remote-workspace-protocol/contract.ts";
import { GuestOutboundScheduler } from "../src/core/remote-workspace-protocol/guest-shared-outbound-scheduler.ts";

type RecordedPayload = { id: string };
type RecordedFrame = { type: string; channelId: string; payload?: RecordedPayload };

function channel(channelId: string, id: string) {
	return {
		type: "channel" as const,
		channelId,
		payload: {
			type: "request" as const,
			id,
			method: "workspace.stat" as const,
			params: { path: "/workspace" },
			timeoutMs: 1000,
		},
	};
}

it("serializes sends round-robin, retaining per-channel FIFO including detach", async () => {
	const emitted: string[] = [];
	const callbacks: Array<(error?: Error) => void> = [];
	const scheduler = new GuestOutboundScheduler(
		(bytes, callback) => {
			const frame = JSON.parse(bytes.toString()) as RecordedFrame;
			emitted.push(frame.payload?.id ?? `${frame.channelId}:close`);
			callbacks.push(callback);
		},
		() => 0,
		(error) => scheduler.fail(error),
	);
	const sent = [
		scheduler.send(channel("A", "A1")),
		scheduler.send(channel("A", "A2")),
		scheduler.send({ type: "close", channelId: "A" }),
		scheduler.send(channel("B", "B1")),
		scheduler.send(channel("B", "B2")),
	];
	await Promise.resolve();
	for (let count = 0; count < sent.length; count++) {
		expect(callbacks).toHaveLength(count + 1);
		callbacks[count]();
		await Promise.resolve();
	}
	await Promise.all(sent);
	expect(emitted).toEqual(["A1", "B1", "A2", "B2", "A:close"]);
});

it("settles queued and in-flight work on uncertain send error; late callbacks do not replay", async () => {
	let callback: ((error?: Error) => void) | undefined;
	const sends = vi.fn((_: Buffer, done: (error?: Error) => void) => {
		callback = done;
	});
	const scheduler = new GuestOutboundScheduler(
		sends,
		() => 0,
		(error) => scheduler.fail(error),
	);
	const first = scheduler.send(channel("A", "A1"));
	const second = scheduler.send(channel("B", "B1"));
	await Promise.resolve();
	expect(sends).toHaveBeenCalledTimes(1);
	callback?.(new Error("network failed"));
	const results = await Promise.allSettled([first, second]);
	expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
	expect(sends).toHaveBeenCalledTimes(1);
	await expect(scheduler.send(channel("B", "B2"))).rejects.toThrow("may have committed");
});

it("bounds a single channel's queued frames without starving admission of a sibling", async () => {
	const scheduler = new GuestOutboundScheduler(
		() => undefined,
		() => 0,
		(error) => scheduler.fail(error),
	);
	const queued = Array.from({ length: 32 }, (_, index) => scheduler.send(channel("A", `A${index}`)));
	const sibling = scheduler.send(channel("B", "B1"));
	const overflow = scheduler.send(channel("A", "overflow"));
	const results = await Promise.allSettled([...queued, sibling, overflow]);
	expect(results).toHaveLength(34);
	expect(results.every((result) => result.status === "rejected")).toBe(true);
	await expect(scheduler.send(channel("B", "B2"))).rejects.toThrow("budget exceeded");
});

it("fails all channels when physical socket buffering exhausts the global byte budget", async () => {
	let completion: ((error?: Error) => void) | undefined;
	const writer = vi.fn((_: Buffer, callback: (error?: Error) => void) => {
		completion = callback;
	});
	let bufferedAmount = 0;
	const onFailure = vi.fn((error: Error) => scheduler.fail(error));
	const scheduler = new GuestOutboundScheduler(writer, () => bufferedAmount, onFailure);
	const uncertain = scheduler.send(channel("A", "mutation"));
	await Promise.resolve();
	expect(writer).toHaveBeenCalledTimes(1);
	bufferedAmount = limits.maxPendingOutboundBytes;
	const other = scheduler.send(channel("B", "unrelated"));
	const outcomes = await Promise.allSettled([uncertain, other]);
	expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
	expect(onFailure).toHaveBeenCalledOnce();
	completion?.();
	await Promise.resolve();
	expect(writer).toHaveBeenCalledTimes(1);
	await expect(scheduler.send(channel("B", "after-failure"))).rejects.toThrow("may have committed");
});

it("bounds a stalled physical send and does not replay uncertain work after a late callback", async () => {
	vi.useFakeTimers();
	try {
		let completion: ((error?: Error) => void) | undefined;
		const writer = vi.fn((_: Buffer, callback: (error?: Error) => void) => {
			completion = callback;
		});
		const onFailure = vi.fn((error: Error) => scheduler.fail(error));
		const scheduler = new GuestOutboundScheduler(writer, () => 0, onFailure);
		const uncertain = scheduler.send(channel("A", "mutation"));
		const sibling = scheduler.send(channel("B", "sibling"));
		const outcomesPromise = Promise.allSettled([uncertain, sibling]);
		await Promise.resolve();
		expect(writer).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(limits.maxTransportSendMs);
		const outcomes = await outcomesPromise;
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
		expect(onFailure).toHaveBeenCalledOnce();
		completion?.();
		await Promise.resolve();
		expect(writer).toHaveBeenCalledTimes(1);
		await expect(scheduler.send(channel("B", "after-timeout"))).rejects.toThrow("may have committed");
	} finally {
		vi.useRealTimers();
	}
});
