import type { RemoteWorkspaceClientMessage } from "./contract.ts";
import { GuestSharedUplink, type GuestUplinkChannel } from "./guest-shared-uplink.ts";
import type {
	RemoteWorkspaceClientProtocol,
	RemoteWorkspaceProtocolCloseReason,
	RemoteWorkspaceProtocolTransport,
} from "./session.ts";

/** A TUI owns its physical guest connection; the guest isolates its workspace channel. */
export class GuestSharedClientTransport implements RemoteWorkspaceProtocolTransport<RemoteWorkspaceClientMessage> {
	private readonly uplink: GuestSharedUplink;
	private readonly channel: GuestUplinkChannel;
	private protocol?: RemoteWorkspaceClientProtocol;
	private closed = false;
	readonly root: string;

	private constructor(uplink: GuestSharedUplink, channel: GuestUplinkChannel, root: string) {
		this.uplink = uplink;
		this.channel = channel;
		this.root = root;
	}

	static async attach(url: string, root: string, token: string): Promise<GuestSharedClientTransport> {
		const uplink = await GuestSharedUplink.connect(url, token);
		let transport: GuestSharedClientTransport | undefined;
		try {
			const channel = await uplink.open(
				root,
				(message) => {
					void transport?.protocol?.receive(Buffer.from(JSON.stringify(message))).catch(() => undefined);
				},
				(error) => {
					if (!transport?.closed) void transport?.protocol?.disconnect(error.message);
				},
			);
			transport = new GuestSharedClientTransport(uplink, channel, root);
			return transport;
		} catch (error) {
			uplink.dispose();
			throw error;
		}
	}

	bind(protocol: RemoteWorkspaceClientProtocol): void {
		if (this.closed || this.protocol) throw new Error("Guest shared protocol cannot be bound");
		this.protocol = protocol;
	}

	send(message: RemoteWorkspaceClientMessage): Promise<void> {
		if (this.closed || !this.protocol) return Promise.reject(new Error("Guest shared channel is closed"));
		return this.channel.send(message);
	}

	async close(_reason: RemoteWorkspaceProtocolCloseReason): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.channel.close();
		} finally {
			this.uplink.dispose();
		}
	}
}
