/** Opt-in multiplex transport. V1 messages are validated *inside* a bound channel. */
import { type Static, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import {
	decodeRemoteWorkspaceMessage,
	parseRemoteWorkspaceClientMessage,
	parseRemoteWorkspaceServerMessage,
	type RemoteWorkspaceClientMessage,
	type RemoteWorkspaceProtocolLimits,
	type RemoteWorkspaceServerMessage,
	RemoteWorkspaceValidationError,
} from "./contract.ts";

export const SHARED_WORKSPACE_WEBSOCKET_PROTOCOL = "grip.workspace.v2";
const strict = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" });
const ChannelId = Type.String({ minLength: 24, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });

const Hello = Type.Object({ type: Type.Literal("hello"), id: Id, version: Type.Literal(2) }, strict);
const HelloAck = Type.Object(
	{
		type: Type.Literal("hello_ack"),
		id: Id,
		version: Type.Literal(2),
		epoch: ChannelId,
		daemonVersion: Type.String({ minLength: 1, maxLength: 128 }),
	},
	strict,
);
const Open = Type.Object(
	{ type: Type.Literal("open"), id: Id, root: Type.String({ minLength: 1, maxLength: 32_768 }) },
	strict,
);
const Opened = Type.Object({ type: Type.Literal("opened"), id: Id, channelId: ChannelId }, strict);
const Close = Type.Object({ type: Type.Literal("close"), channelId: ChannelId }, strict);
const Closed = Type.Object(
	{
		type: Type.Literal("closed"),
		channelId: ChannelId,
		// Absent for an acknowledged client detach; present for an unsolicited protocol failure.
		reason: Type.Optional(
			Type.Object(
				{
					code: Type.Union([
						Type.Literal("protocol_error"),
						Type.Literal("invalid_payload"),
						Type.Literal("message_too_large"),
						Type.Literal("policy_violation"),
						Type.Literal("normal"),
					]),
					message: Type.String({ minLength: 1, maxLength: 120 }),
				},
				strict,
			),
		),
	},
	strict,
);
const ControlError = Type.Object(
	{
		type: Type.Literal("control_error"),
		id: Id,
		code: Type.Union([Type.Literal("invalid_root"), Type.Literal("limit_exceeded"), Type.Literal("invalid_request")]),
		message: Type.String({ minLength: 1, maxLength: 1024 }),
	},
	strict,
);
const Channel = Type.Object({ type: Type.Literal("channel"), channelId: ChannelId, payload: Type.Unknown() }, strict);

const ClientFrame = Type.Union([Hello, Open, Close, Channel]);
const ServerFrame = Type.Union([HelloAck, Opened, Closed, ControlError, Channel]);
const clientValidator = Compile(ClientFrame);
const serverValidator = Compile(ServerFrame);
export type SharedWorkspaceClientChannelFrame = Omit<Static<typeof Channel>, "payload"> & {
	payload: RemoteWorkspaceClientMessage;
};
export type SharedWorkspaceServerChannelFrame = Omit<Static<typeof Channel>, "payload"> & {
	payload: RemoteWorkspaceServerMessage;
};
export type SharedWorkspaceClientFrame =
	| Exclude<Static<typeof ClientFrame>, { type: "channel" }>
	| SharedWorkspaceClientChannelFrame;
/** The daemon dispatches a valid outer envelope before parsing the inner message on its bound channel. */
export type SharedWorkspaceClientEnvelope = Static<typeof ClientFrame>;
export type SharedWorkspaceServerFrame =
	| Exclude<Static<typeof ServerFrame>, { type: "channel" }>
	| SharedWorkspaceServerChannelFrame;

function validateFrame<T extends { type: string }>(
	input: string | Uint8Array,
	limits: RemoteWorkspaceProtocolLimits,
	validator: Validator,
	parsePayload?: (value: unknown, limits: RemoteWorkspaceProtocolLimits) => unknown,
): T {
	const value = decodeRemoteWorkspaceMessage(input, limits);
	if (!validator.Check(value)) {
		const failure = validator.Errors(value)[0];
		throw new RemoteWorkspaceValidationError(
			`Invalid v2 frame: ${failure?.instancePath || "/"}: ${failure?.message ?? "schema mismatch"}`,
		);
	}
	const frame = value as T;
	if (frame.type === "channel" && parsePayload) {
		const channel = frame as T & { payload: unknown };
		parsePayload(channel.payload, limits);
	}
	return frame;
}

export function parseSharedWorkspaceClientFrame(
	input: string | Uint8Array,
	limits: RemoteWorkspaceProtocolLimits,
): SharedWorkspaceClientFrame {
	return validateFrame(input, limits, clientValidator, parseRemoteWorkspaceClientMessage);
}
export function parseSharedWorkspaceClientEnvelope(
	input: string | Uint8Array,
	limits: RemoteWorkspaceProtocolLimits,
): SharedWorkspaceClientEnvelope {
	return validateFrame(input, limits, clientValidator);
}

export function parseSharedWorkspaceServerFrame(
	input: string | Uint8Array,
	limits: RemoteWorkspaceProtocolLimits,
): SharedWorkspaceServerFrame {
	return validateFrame(input, limits, serverValidator, parseRemoteWorkspaceServerMessage);
}
