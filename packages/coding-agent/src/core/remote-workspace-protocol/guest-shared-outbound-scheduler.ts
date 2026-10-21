import { DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS as limits } from "./contract.ts";
import type { SharedWorkspaceClientFrame } from "./shared-transport.ts";

export type GuestOutboundFrame = Exclude<SharedWorkspaceClientFrame, { type: "hello" }>;

type Job = { bytes: Buffer; key: string; finish: (error?: Error) => void };

/** FIFO within each channel, round-robin between channels, including ordered detaches. */
export class GuestOutboundScheduler {
	private readonly buckets = new Map<string, Job[]>();
	private readonly ready: string[] = [];
	private readonly pending = new Set<Job>();
	private pendingBytes = 0;
	private inFlight?: Job;
	private scheduled = false;
	private failure?: Error;
	private readonly writer: (bytes: Buffer, callback: (error?: Error) => void) => void;
	private readonly bufferedAmount: () => number;
	private readonly onFailure: (error: Error) => void;

	constructor(
		writer: (bytes: Buffer, callback: (error?: Error) => void) => void,
		bufferedAmount: () => number,
		onFailure: (error: Error) => void,
	) {
		this.writer = writer;
		this.bufferedAmount = bufferedAmount;
		this.onFailure = onFailure;
	}

	private schedule(): void {
		if (this.scheduled || this.failure) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.pump();
		});
	}

	private pump(): void {
		if (this.failure || this.inFlight) return;
		const key = this.ready.shift();
		if (!key) return;
		const bucket = this.buckets.get(key)!;
		const job = bucket.shift()!;
		if (bucket.length) this.ready.push(key);
		else this.buckets.delete(key);
		this.inFlight = job;
		try {
			this.writer(job.bytes, (error) => {
				if (error) this.onFailure(new Error("Shared workspace uplink send failed; operations may have committed"));
				else job.finish();
				this.schedule();
			});
		} catch {
			this.onFailure(new Error("Shared workspace uplink send failed; operations may have committed"));
		}
	}

	send(frame: GuestOutboundFrame): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		const bytes = Buffer.from(JSON.stringify(frame));
		const key = frame.type === "open" ? `open:${frame.id}` : frame.channelId;
		const bucket = this.buckets.get(key);
		const perChannel = (bucket?.length ?? 0) + (this.inFlight?.key === key ? 1 : 0);
		if (
			bytes.length > limits.maxMessageBytes ||
			this.pending.size >= limits.maxPendingOutboundMessages ||
			perChannel >= 32 ||
			this.pendingBytes + bytes.length + this.bufferedAmount() > limits.maxPendingOutboundBytes
		) {
			this.onFailure(new Error("Shared workspace uplink output budget exceeded; operations may have committed"));
			return Promise.reject(this.failure ?? new Error("Shared workspace uplink output budget exceeded"));
		}
		return new Promise<void>((resolve, reject) => {
			let finished = false;
			const timer = setTimeout(() => {
				this.onFailure(new Error("Shared workspace uplink send timed out; operations may have committed"));
			}, limits.maxTransportSendMs);
			const job: Job = {
				bytes,
				key,
				finish: (error) => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					this.pending.delete(job);
					this.pendingBytes -= bytes.length;
					if (this.inFlight === job) this.inFlight = undefined;
					if (error) reject(error);
					else resolve();
				},
			};
			this.pending.add(job);
			this.pendingBytes += bytes.length;
			if (bucket) bucket.push(job);
			else {
				this.buckets.set(key, [job]);
				this.ready.push(key);
			}
			this.schedule();
		});
	}

	fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const job of this.pending) job.finish(error);
		this.buckets.clear();
		this.ready.length = 0;
	}
}
