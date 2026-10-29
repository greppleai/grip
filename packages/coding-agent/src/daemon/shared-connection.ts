import { createHash, randomBytes } from "node:crypto";
import { VERSION } from "../config.ts";
import type {
	RemoteWorkspaceIdentity,
	RemoteWorkspaceServerMessage,
} from "../core/remote-workspace-protocol/contract.ts";
import {
	type RemoteWorkspaceServerHandler,
	RemoteWorkspaceServerProtocol,
} from "../core/remote-workspace-protocol/session.ts";
import {
	parseSharedWorkspaceClientEnvelope,
	type SharedWorkspaceClientEnvelope,
	type SharedWorkspaceServerFrame,
} from "../core/remote-workspace-protocol/shared-transport.ts";
import { DaemonActivityBudget } from "./activity-budget.ts";
import type { DaemonConfiguration } from "./config.ts";
import { withSharedRevisionGuard } from "./shared-revision.ts";
import type { SharedWorkspaceRoots } from "./shared-roots.ts";
import { createDaemonWorkspaceRuntime, type DaemonWorkspaceRuntime } from "./workspace-runtime.ts";

interface Channel {
	readonly protocol: RemoteWorkspaceServerProtocol;
	runtime: DaemonWorkspaceRuntime;
	handler: RemoteWorkspaceServerHandler;
	readonly workspace: RemoteWorkspaceIdentity;
	generation: number;
}

/** One authenticated v2 WebSocket. No state (including request IDs) is shared between channels. */
export class SharedDaemonConnection {
	private readonly channels = new Map<string, Channel>();
	private readonly channelDisposals = new WeakMap<Channel, Promise<void>>();
	private readonly pendingDisposals = new Set<Promise<void>>();
	private readonly usedControlIds = new Set<string>();
	private readonly epoch = randomBytes(18).toString("base64url");
	private hello = false;
	private closed = false;
	private queue: Promise<void> = Promise.resolve();
	private pendingInboundMessages = 0;
	private pendingInboundBytes = 0;
	private readonly budget: DaemonActivityBudget;

	private readonly configuration: DaemonConfiguration;
	private readonly roots: SharedWorkspaceRoots;
	private readonly send: (message: SharedWorkspaceServerFrame) => Promise<void>;
	private readonly closeSocket: (code: number, message: string) => void;

	constructor(
		configuration: DaemonConfiguration,
		roots: SharedWorkspaceRoots,
		send: (message: SharedWorkspaceServerFrame) => Promise<void>,
		closeSocket: (code: number, message: string) => void,
		budget: DaemonActivityBudget = new DaemonActivityBudget(configuration),
	) {
		this.configuration = configuration;
		this.roots = roots;
		this.send = send;
		this.closeSocket = closeSocket;
		this.budget = budget;
	}

	receive(payload: Uint8Array): Promise<void> {
		if (this.closed) return Promise.resolve();
		const limits = this.configuration.protocolLimits;
		if (
			payload.byteLength > limits.maxMessageBytes ||
			this.pendingInboundMessages >= limits.maxPendingInboundMessages ||
			this.pendingInboundBytes + payload.byteLength > limits.maxPendingInboundBytes
		) {
			this.closed = true;
			this.closeSocket(1009, "Shared workspace inbound queue exceeds limits");
			return Promise.resolve();
		}
		// Copy before queuing: WebSocket buffers need not remain stable after the callback returns.
		const queuedPayload = Uint8Array.from(payload);
		this.pendingInboundMessages++;
		this.pendingInboundBytes += queuedPayload.byteLength;
		let complete!: () => void;
		const finished = new Promise<void>((resolve) => {
			complete = resolve;
		});
		let channelPending = false;
		const settle = () => {
			this.pendingInboundMessages--;
			this.pendingInboundBytes -= queuedPayload.byteLength;
			complete();
		};
		const fail = () => {
			if (!this.closed) {
				this.closed = true;
				this.closeSocket(1002, "Invalid shared workspace frame");
			}
		};
		const scheduled = this.queue.then(() => {
			if (this.closed) return;
			const frame = parseSharedWorkspaceClientEnvelope(queuedPayload, limits);
			if (frame.type === "channel") {
				// Validate the channel before letting the control queue advance. Its own
				// protocol preserves per-channel receive order and bounds queued frames.
				if (!this.channels.has(frame.channelId)) throw new Error("Unknown shared workspace channel");
				channelPending = true;
				void this.dispatch(frame).catch(fail).finally(settle);
				return;
			}
			// Hello, opens, closes and reloads remain serialized in control order.
			return this.dispatch(frame);
		});
		this.queue = scheduled.catch(fail).finally(() => {
			if (!channelPending) settle();
		});
		return finished;
	}

	get handshakeComplete(): boolean {
		return this.hello;
	}

	async beginDrain(): Promise<void> {
		await Promise.allSettled([...this.channels.values()].map((channel) => channel.protocol.beginDrain()));
	}

	private createChannelRuntime(root: string): DaemonWorkspaceRuntime {
		return createDaemonWorkspaceRuntime({
			...this.configuration,
			workspaceRoot: root,
			// Operator-wide resource files and the v1 temporary root are not channel-scoped.
			// Keep them available on v1, but never expose them through a child channel.
			temporaryRoot: undefined,
			sandboxInstructionsPath: undefined,
			userAgentsPath: undefined,
		});
	}

	reload(): Promise<void> {
		const operation = this.queue.then(async () => {
			if (this.closed) throw new Error("Shared workspace connection is closed");
			for (const channel of this.channels.values()) {
				const previous = channel.runtime;
				const previousHandler = channel.handler;
				const candidate = this.createChannelRuntime(channel.workspace.root);
				const candidateHandler = candidate.createHandler(channel.workspace, true);
				channel.runtime = candidate;
				channel.handler = candidateHandler;
				try {
					await channel.protocol.publishCatalog({ ...candidate.catalog, generation: channel.generation + 1 });
					channel.generation++;
				} catch (error) {
					channel.runtime = previous;
					channel.handler = previousHandler;
					await candidate.dispose();
					throw error;
				}
				await previous.retire();
			}
		});
		this.queue = operation.catch(() => undefined);
		return operation;
	}

	private async dispatch(frame: SharedWorkspaceClientEnvelope): Promise<void> {
		if (frame.type === "hello") {
			if (this.hello) throw new Error("Duplicate v2 hello");
			this.hello = true;
			this.usedControlIds.add(frame.id);
			await this.send({ type: "hello_ack", id: frame.id, version: 2, epoch: this.epoch, daemonVersion: VERSION });
			return;
		}
		if (!this.hello) throw new Error("V2 hello required before opening channels");
		if (frame.type === "open") {
			if (this.usedControlIds.has(frame.id)) throw new Error("Duplicate v2 control ID");
			if (this.usedControlIds.size >= 65_536) throw new Error("V2 control ID budget exhausted");
			this.usedControlIds.add(frame.id);
			if (this.channels.size >= Math.min(this.configuration.maxConnections, 32)) {
				await this.send({
					type: "control_error",
					id: frame.id,
					code: "limit_exceeded",
					message: "Channel limit reached",
				});
				return;
			}
			let root: string;
			try {
				root = await this.roots.bind(frame.root);
			} catch {
				await this.send({
					type: "control_error",
					id: frame.id,
					code: "invalid_root",
					message: "Workspace root is not an existing directory under the shared parent",
				});
				return;
			}
			await this.open(frame.id, root);
			return;
		}
		const channel = this.channels.get(frame.channelId);
		if (!channel) throw new Error("Unknown shared workspace channel");
		if (frame.type === "close") {
			// Do not wait on a channel's in-flight requests while blocking the socket receive queue.
			this.channels.delete(frame.channelId);
			// Begin cancellation before acknowledging detach; track it for physical shutdown.
			void this.disposeChannel(channel);
			await this.send({ type: "closed", channelId: frame.channelId });
			return;
		}
		await channel.protocol.receive(Buffer.from(JSON.stringify(frame.payload)));
	}

	private async open(id: string, root: string): Promise<void> {
		const channelId = randomBytes(24).toString("base64url");
		const workspace = Object.freeze({
			id: randomBytes(18).toString("base64url"),
			root,
			pathFlavor: "posix" as const,
		});
		let runtime: DaemonWorkspaceRuntime;
		try {
			runtime = this.createChannelRuntime(root);
		} catch {
			// A bad child project configuration is an open failure, not a corrupt
			// physical envelope. Keep already bound sibling channels usable.
			await this.send({
				type: "control_error",
				id,
				code: "invalid_request",
				message: "Unable to initialize shared workspace channel",
			});
			return;
		}
		const handler = runtime.createHandler(workspace, true);
		let channel!: Channel;
		const protocol = new RemoteWorkspaceServerProtocol(
			{
				send: (payload: RemoteWorkspaceServerMessage) =>
					this.channels.has(channelId) && !this.closed
						? this.send({ type: "channel", channelId, payload })
						: Promise.reject(new Error("Shared workspace channel is closed")),
				close: async (reason) => {
					const channel = this.channels.get(channelId);
					if (channel) {
						this.channels.delete(channelId);
						void this.disposeChannel(channel);
						if (!this.closed) await this.send({ type: "closed", channelId, reason });
					}
				},
			},
			{
				validateToolArguments: (toolName, value) => channel.handler.validateToolArguments(toolName, value),
				handleUploadChunk: (request, chunk, sequence, context) =>
					channel.handler.handleUploadChunk!(request, chunk, sequence, context),
				handleUploadFinish: (request, metadata, context) =>
					channel.handler.handleUploadFinish!(request, metadata, context),
				handleRequest: (request, context) =>
					this.budget.run(request.method, async () => {
						const result = await withSharedRevisionGuard(
							request,
							workspace.root,
							channel.runtime.operations,
							context,
							() => channel.handler.handleRequest(request, context),
						);
						if (request.method !== "workspace.read") return result;
						const read = result as { contentBase64: string };
						return {
							...read,
							revision: createHash("sha256").update(Buffer.from(read.contentBase64, "base64")).digest("hex"),
						};
					}),
			},
			{
				workspace,
				catalog: runtime.catalog,
				capabilities: runtime.capabilities,
				limits: this.configuration.protocolLimits,
				backendLabel: "grip-shared-workspace-daemon",
			},
		);
		channel = { runtime, handler, protocol, workspace, generation: runtime.catalog.generation };
		this.channels.set(channelId, channel);
		try {
			await this.send({ type: "opened", id, channelId });
		} catch (error) {
			this.channels.delete(channelId);
			void this.disposeChannel(channel);
			throw error;
		}
	}

	private disposeChannel(channel: Channel): Promise<void> {
		const existing = this.channelDisposals.get(channel);
		if (existing) return existing;
		const disposal = (async () => {
			await channel.protocol.disconnect().catch(() => undefined);
			await channel.runtime.dispose().catch(() => undefined);
		})();
		this.channelDisposals.set(channel, disposal);
		this.pendingDisposals.add(disposal);
		void disposal.then(
			() => this.pendingDisposals.delete(disposal),
			() => this.pendingDisposals.delete(disposal),
		);
		return disposal;
	}

	async disconnect(): Promise<void> {
		this.closed = true;
		const channels = [...this.channels.values()];
		this.channels.clear();
		await Promise.allSettled([...channels.map((channel) => this.disposeChannel(channel)), ...this.pendingDisposals]);
	}
}
