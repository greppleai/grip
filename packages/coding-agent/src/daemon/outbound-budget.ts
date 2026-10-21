/** Aggregate outstanding sends on one physical WebSocket (v1 or v2). */
export class DaemonOutboundBudget {
	private pendingBytes = 0;
	private pendingMessages = 0;
	private readonly maxBytes: number;
	private readonly maxMessages: number;

	constructor(maxBytes: number, maxMessages: number) {
		this.maxBytes = maxBytes;
		this.maxMessages = maxMessages;
	}

	reserve(bytes: number, bufferedAmount: number): () => void {
		// ws.bufferedAmount measures socket-queued data; a callback can also stall after
		// the socket accepts data. Bound both views without double-counting overlap.
		if (
			this.pendingMessages >= this.maxMessages ||
			Math.max(this.pendingBytes, bufferedAmount) + bytes > this.maxBytes
		) {
			throw new Error("WebSocket outbound buffer exceeds daemon limits");
		}
		this.pendingMessages++;
		this.pendingBytes += bytes;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.pendingMessages--;
			this.pendingBytes -= bytes;
		};
	}
}
