import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { parseDocument } from "yaml";

export const MAX_TEXT_ARGUMENT_LENGTH = 65536;

interface HostCliTextSlot {
	text: true;
}

type HostCliArgumentSlot = string[] | HostCliTextSlot;

export interface HostCliCommand {
	name: string;
	timeoutMs: number;
	allow: HostCliArgumentSlot[][];
}

const reservedNames = new Set([
	"bash",
	"read",
	"write",
	"edit",
	"ls",
	"grep",
	"find",
	"job",
	"websearch",
	"session_search",
	"session_entry_get",
	"load_tool",
	"unload_tool",
	"load_skill",
	"generate_image",
	"read_image",
	"shepard_checkpoint",
	"shepard_finish",
]);

function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a mapping");
	const result = value as Record<string, unknown>;
	const allowedKeys = new Set(keys);
	if (Object.keys(result).some((key) => !allowedKeys.has(key))) throw new Error("Unknown host CLI policy key");
	return result;
}

function token(value: unknown): string {
	if (typeof value !== "string" || !value.length || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
		throw new Error(
			"Policy arguments must be non-empty strings without control characters (maximum 4096 characters)",
		);
	}
	return value;
}

function parseArgumentSlot(slot: unknown): HostCliArgumentSlot {
	if (Array.isArray(slot)) {
		if (!slot.length || slot.length > 256) throw new Error("Argument choices must contain 1–256 strings");
		return slot.map(token);
	}
	if (slot && typeof slot === "object") {
		const value = record(slot, ["text"]);
		if (value.text !== true) throw new Error("A text argument slot must be exactly {text: true}");
		return { text: true };
	}
	return [token(slot)];
}

export function parsePolicy(source: string): HostCliCommand[] {
	const document = parseDocument(source, { version: "1.2", uniqueKeys: true });
	if (document.errors.length || document.warnings.length) throw new Error("Invalid host CLI YAML");
	const root = record(document.toJS({ maxAliasCount: 0 }) as unknown, ["version", "commands"]);
	if (root.version !== 1 || !Array.isArray(root.commands) || root.commands.length > 32) {
		throw new Error("Expected version: 1 and commands array (maximum 32)");
	}
	const names = new Set<string>();
	return root.commands.map((entry: unknown) => {
		const command = record(entry, ["name", "timeoutMs", "allow"]);
		const name = token(command.name);
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || reservedNames.has(name) || names.has(name)) {
			throw new Error(`Invalid, reserved or duplicate tool name: ${name}`);
		}
		names.add(name);
		const timeoutMs = command.timeoutMs ?? 30000;
		if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
			throw new Error("timeoutMs must be an integer from 1 to 120000");
		}
		if (!Array.isArray(command.allow) || !command.allow.length || command.allow.length > 256) {
			throw new Error("allow must contain 1–256 complete argv templates");
		}
		const allow = command.allow.map((rule: unknown) => {
			if (!Array.isArray(rule) || rule.length > 64)
				throw new Error("Each argv template must be an array of at most 64 slots");
			return rule.map(parseArgumentSlot);
		});
		return { name, timeoutMs, allow };
	});
}

/** Host-only policy; never resolve this file relative to the guest/workspace. */
export async function readPolicy(path: string): Promise<HostCliCommand[]> {
	let file: FileHandle;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 256 * 1024)
			throw new Error("Host CLI policy must be a regular file of at most 256 KiB");
		if (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())) {
			throw new Error("Host CLI policy must be owned by the current user and not group/world-writable");
		}
		const buffer = Buffer.alloc(256 * 1024 + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 256 * 1024) throw new Error("Host CLI policy exceeds 256 KiB");
		return parsePolicy(buffer.subarray(0, bytesRead).toString("utf8"));
	} finally {
		await file.close();
	}
}

export function authorize(command: HostCliCommand, input: unknown): string[] {
	if (!Array.isArray(input) || !input.every((arg): arg is string => typeof arg === "string")) {
		throw new Error("Expected an argv array of strings");
	}
	const args = [...input];
	if (
		!command.allow.some(
			(rule) =>
				rule.length === args.length &&
				rule.every((slot, i) => {
					if (Array.isArray(slot)) return slot.includes(args[i]);
					return args[i].length <= MAX_TEXT_ARGUMENT_LENGTH && !args[i].includes("\0");
				}),
		)
	) {
		throw new Error(`Denied by host CLI policy for ${command.name}: argv must match a complete allowed template`);
	}
	return args;
}
