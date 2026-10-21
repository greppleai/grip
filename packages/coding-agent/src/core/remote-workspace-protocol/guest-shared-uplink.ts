import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { VERSION } from "../../config.ts";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS as limits,
	parseRemoteWorkspaceClientMessage,
	type RemoteWorkspaceClientMessage,
	type RemoteWorkspaceServerMessage,
} from "./contract.ts";
import { type GuestOutboundFrame, GuestOutboundScheduler } from "./guest-shared-outbound-scheduler.ts";
import {
	parseSharedWorkspaceServerFrame,
	SHARED_WORKSPACE_WEBSOCKET_PROTOCOL,
	type SharedWorkspaceServerFrame,
} from "./shared-transport.ts";

export interface GuestUplinkChannel {
	readonly id: string;
	send(message: RemoteWorkspaceClientMessage): Promise<void>;
	close(): Promise<void>;
}

export type GuestUplinkMessageHandler = (message: RemoteWorkspaceServerMessage) => void;
export type GuestUplinkFailureHandler = (error: Error) => void;

type Channel = {
	onMessage: GuestUplinkMessageHandler;
	onFailure: GuestUplinkFailureHandler;
	closing: boolean;
	closePromise?: Promise<void>;
	resolveClose?: () => void;
	rejectClose?: (error: Error) => void;
};

type GuestControlFrame = Extract<SharedWorkspaceServerFrame, { type: "opened" | "control_error" }>;

/** Owns one v2 physical socket. Loss invalidates every channel; nothing is replayed. */
export class GuestSharedUplink {
	private readonly channels = new Map<string, Channel>();
	private readonly opens = new Map<string, { resolve: (id: string) => void; reject: (error: Error) => void }>();
	private failure?: Error;
	private readonly outbound: GuestOutboundScheduler;
	private readonly socket: WebSocket;
	readonly epoch: string;
	/** Resolves on any terminal uplink failure (including explicit disposal); never reconnects. */
	readonly whenFailed: Promise<void>;
	private resolveFailure!: () => void;

	private constructor(socket: WebSocket, epoch: string) {
		this.socket = socket;
		this.epoch = epoch;
		this.whenFailed = new Promise<void>((resolve) => {
			this.resolveFailure = resolve;
		});
		this.outbound = new GuestOutboundScheduler(
			(bytes, callback) =>
				socket.send(bytes, { binary: false, compress: false }, (error) => callback(error ?? undefined)),
			() => socket.bufferedAmount,
			(error) => this.fail(error),
		);
		socket.on("message", (data, isBinary) => this.receive(data as Buffer, isBinary));
		socket.on("close", () =>
			this.fail(new Error("Shared workspace uplink disconnected; operations may have committed")),
		);
		socket.on("error", () => this.fail(new Error("Shared workspace uplink failed; operations may have committed")));
		if (socket.readyState !== WebSocket.OPEN) this.fail(new Error("Shared workspace uplink disconnected"));
	}

	private receive(data: Buffer, isBinary: boolean): void {
		try {
			if (isBinary) throw new Error("Unexpected binary shared workspace frame");
			this.route(parseSharedWorkspaceServerFrame(data, limits));
		} catch {
			this.fail(new Error("Invalid or unrouteable shared workspace response"));
		}
	}

	private routeControl(frame: GuestControlFrame): void {
		const pending = this.opens.get(frame.id);
		if (!pending) throw new Error("Unknown shared workspace control ID");
		this.opens.delete(frame.id);
		if (frame.type === "opened") pending.resolve(frame.channelId);
		else pending.reject(new Error(`Shared workspace open failed: ${frame.code}`));
	}

	private route(frame: SharedWorkspaceServerFrame): void {
		if (frame.type === "hello_ack") throw new Error("Unexpected shared workspace hello acknowledgement");
		if (frame.type === "opened" || frame.type === "control_error") {
			this.routeControl(frame);
			return;
		}
		const channel = this.channels.get(frame.channelId);
		if (!channel) throw new Error("Unknown shared workspace channel ID");
		if (frame.type === "closed") {
			this.channels.delete(frame.channelId);
			if (frame.reason || !channel.closing) {
				const error = new Error(frame.reason?.message ?? "Shared workspace channel closed unexpectedly");
				channel.rejectClose?.(error);
				channel.onFailure(error);
			} else channel.resolveClose?.();
			return;
		}
		// An in-flight response can race a requested detach; deliver until closed is acknowledged.
		channel.onMessage(frame.payload);
	}

	static async connect(url: string, token?: string): Promise<GuestSharedUplink> {
		const endpoint = new URL(url);
		if (
			!(["ws:", "wss:"] as string[]).includes(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.hash
		) {
			throw new Error("Invalid shared workspace endpoint");
		}
		const socket = new WebSocket(endpoint.toString(), SHARED_WORKSPACE_WEBSOCKET_PROTOCOL, {
			perMessageDeflate: false,
			...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Shared workspace connection timed out")), 5000);
				socket.once("open", () => {
					clearTimeout(timer);
					resolve();
				});
				socket.once("error", () => {
					clearTimeout(timer);
					reject(new Error("Shared workspace connection failed"));
				});
			});
			if (socket.protocol !== SHARED_WORKSPACE_WEBSOCKET_PROTOCOL) {
				throw new Error("Daemon does not support grip.workspace.v2");
			}
			const id = randomBytes(12).toString("hex");
			const epoch = await new Promise<string>((resolve, reject) => {
				let settled = false;
				const timer = setTimeout(() => settle(undefined, new Error("Shared workspace hello timed out")), 5000);
				const settle = (value?: string, error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.off("message", onMessage);
					socket.off("close", onClose);
					socket.off("error", onError);
					if (error) reject(error);
					else resolve(value!);
				};
				const onError = () => settle(undefined, new Error("Shared workspace hello failed"));
				const onClose = () => settle(undefined, new Error("Shared workspace hello failed"));
				const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
					try {
						if (isBinary) throw new Error("Unexpected binary frame");
						const frame = parseSharedWorkspaceServerFrame(Buffer.from(data as Buffer), limits);
						if (frame.type !== "hello_ack" || frame.id !== id) throw new Error("Unexpected hello response");
						if (frame.daemonVersion !== VERSION) {
							settle(undefined, new Error("Shared workspace daemon version mismatch"));
							return;
						}
						settle(frame.epoch);
					} catch {
						settle(undefined, new Error("Invalid shared workspace hello response"));
					}
				};
				socket.on("message", onMessage);
				socket.once("close", onClose);
				socket.once("error", onError);
				socket.send(JSON.stringify({ type: "hello", version: 2, id }), (error) => {
					if (error) settle(undefined, new Error("Shared workspace hello send failed"));
				});
			});
			return new GuestSharedUplink(socket, epoch);
		} catch (error) {
			socket.on("error", () => undefined);
			socket.terminate();
			throw error;
		}
	}

	async open(
		root: string,
		onMessage: GuestUplinkMessageHandler,
		onFailure: GuestUplinkFailureHandler,
	): Promise<GuestUplinkChannel> {
		if (this.failure) throw this.failure;
		if (this.channels.size + this.opens.size >= 32) throw new Error("Shared workspace channel limit exceeded");
		const id = randomBytes(12).toString("hex");
		const channelId = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => this.fail(new Error("Shared workspace open timed out; operations may have committed")),
				5000,
			);
			this.opens.set(id, {
				resolve: (openedId) => {
					clearTimeout(timer);
					resolve(openedId);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			void this.send({ type: "open", id, root }).catch((error: Error) => {
				const pending = this.opens.get(id);
				this.opens.delete(id);
				pending?.reject(error);
			});
		});
		if (this.failure) throw this.failure;
		const channel: Channel = { onMessage, onFailure, closing: false };
		this.channels.set(channelId, channel);
		return {
			id: channelId,
			send: (payload) => {
				if (channel.closing || this.channels.get(channelId) !== channel) {
					return Promise.reject(new Error("Shared workspace channel is closed"));
				}
				parseRemoteWorkspaceClientMessage(payload, limits);
				return this.send({ type: "channel", channelId, payload });
			},
			close: () => {
				if (channel.closePromise) return channel.closePromise;
				if (this.channels.get(channelId) !== channel) return Promise.resolve();
				channel.closing = true;
				channel.closePromise = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.fail(new Error("Shared workspace detach timed out; operations may have committed"));
					}, 5000);
					channel.resolveClose = () => {
						clearTimeout(timer);
						resolve();
					};
					channel.rejectClose = (error) => {
						clearTimeout(timer);
						reject(error);
					};
					void this.send({ type: "close", channelId }).catch(channel.rejectClose);
				});
				return channel.closePromise;
			},
		};
	}

	private send(frame: GuestOutboundFrame): Promise<void> {
		return this.outbound.send(frame);
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.outbound.fail(error);
		this.socket.terminate();
		for (const pending of this.opens.values()) pending.reject(error);
		this.opens.clear();
		for (const channel of this.channels.values()) {
			channel.rejectClose?.(error);
			try {
				channel.onFailure(error);
			} catch {
				// Do not let one local callback block failure delivery to sibling channels.
			}
		}
		this.channels.clear();
		this.resolveFailure();
	}

	dispose(): void {
		this.fail(new Error("Shared workspace uplink stopped; operations may have committed"));
	}
}
