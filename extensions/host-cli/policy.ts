import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { parseDocument } from "yaml";

export const MAX_TEXT_ARGUMENT_LENGTH = 65536;

interface HostCliTextSlot {
	text: true;
}

type HostCliArgumentSlot = string[] | HostCliTextSlot;

interface HostCliOption {
	names: string[];
	value: HostCliArgumentSlot | null;
	required: boolean;
}

interface HostCliRule {
	args: HostCliArgumentSlot[];
	flags: string[];
	options: HostCliOption[];
	positionals: HostCliArgumentSlot[];
}

export interface HostCliCommand {
	name: string;
	timeoutMs: number;
	allow: "*" | HostCliRule[];
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

function parseSlots(value: unknown): HostCliArgumentSlot[] {
	if (!Array.isArray(value) || value.length > 64) throw new Error("Expected an array of at most 64 argument slots");
	return value.map(parseArgumentSlot);
}

function parseRule(rule: unknown): HostCliRule {
	const value = Array.isArray(rule) ? { args: rule } : record(rule, ["args", "flags", "options", "positionals"]);
	const args = parseSlots(value.args);
	const positionals = parseSlots(value.positionals === undefined ? [] : value.positionals);
	const rawFlags = value.flags === undefined ? [] : value.flags;
	if (!Array.isArray(rawFlags) || rawFlags.length > 256) throw new Error("Expected at most 256 flags");
	const flags = rawFlags.map(token);
	const flagName = /^--?[a-zA-Z0-9][a-zA-Z0-9-]*$/;
	if (flags.some((flag) => flag !== "*" && flag !== "--*" && !flagName.test(flag)))
		throw new Error('Flags must be standalone names or "*" / "--*"');
	const rawOptions = value.options === undefined ? [] : value.options;
	if (!Array.isArray(rawOptions) || rawOptions.length > 64) throw new Error("Expected at most 64 options");
	if ((rawOptions.length || positionals.length) && flags.some((flag) => flag === "*" || flag === "--*"))
		throw new Error("Wildcard flags cannot be combined with options or positionals");
	const names = new Set(flags);
	const options = rawOptions.map((entry: unknown): HostCliOption => {
		const option = record(entry, ["names", "value", "required"]);
		if (!Array.isArray(option.names) || !option.names.length || option.names.length > 16)
			throw new Error("Option names must contain 1–16 names");
		const optionNames = option.names.map(token);
		for (const name of optionNames) {
			if (!flagName.test(name) || names.has(name)) throw new Error("Invalid or duplicate option name");
			names.add(name);
		}
		const required = option.required === undefined ? false : option.required;
		if (typeof required !== "boolean") throw new Error("Option required must be boolean");
		return {
			names: optionNames,
			value: option.value === undefined ? null : parseArgumentSlot(option.value),
			required,
		};
	});
	return { args, flags, options, positionals };
}

export function parsePolicy(source: string): HostCliCommand[] {
	const document = parseDocument(source, { version: "1.2", uniqueKeys: true });
	if (document.errors.length || document.warnings.length) throw new Error("Invalid host CLI YAML");
	const root = record(document.toJS({ maxAliasCount: 100 }) as unknown, ["version", "commands"]);
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
		if (
			command.allow !== "*" &&
			(!Array.isArray(command.allow) || !command.allow.length || command.allow.length > 256)
		) {
			throw new Error('allow must be "*" or contain 1–256 argv rules');
		}
		const allow = command.allow === "*" ? "*" : command.allow.map(parseRule);
		return { name, timeoutMs, allow };
	});
}

/** Host-only policy; never resolve this file relative to the guest/workspace. */
export async function readPolicy(path: string): Promise<HostCliCommand[]> {
	let file: FileHandle;
	try {
		// Follow host-managed symlinks; validate the opened target below.
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
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

function matchesSlot(slot: HostCliArgumentSlot, arg: string): boolean {
	return Array.isArray(slot) ? slot.includes(arg) : arg.length <= MAX_TEXT_ARGUMENT_LENGTH && !arg.includes("\0");
}

function matchesFlag(flags: string[], arg: string): boolean {
	if (arg !== "*" && arg !== "--*" && flags.includes(arg)) return true;
	if (arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg) || !/^--?[a-zA-Z0-9]/.test(arg)) return false;
	return flags.includes("*") || (arg.startsWith("--") && flags.includes("--*"));
}

function consumeOption(option: HostCliOption, args: string[], index: number, seen: Set<HostCliOption>): number {
	if (seen.has(option)) return -1;
	if (option.value !== null) {
		// An empty required head must not re-enable implicit gh pushes/forks.
		if (index >= args.length || !args[index].length || !matchesSlot(option.value, args[index])) return -1;
		index++;
	}
	seen.add(option);
	return index;
}

function consumeOptions(rule: HostCliRule, args: string[], seen: Set<HostCliOption>): number {
	const optionsByName = new Map<string, HostCliOption>();
	for (const option of rule.options) {
		for (const name of option.names) optionsByName.set(name, option);
	}
	let index = rule.args.length;
	while (index < args.length) {
		if (args[index] === "--") return index;
		const arg = args[index++];
		const option = optionsByName.get(arg);
		if (option) {
			index = consumeOption(option, args, index, seen);
			if (index < 0) return -1;
		} else if (!matchesFlag(rule.flags, arg)) {
			return -1;
		}
	}
	return index;
}

function matchesRule(rule: HostCliRule, args: string[]): boolean {
	if (args.length < rule.args.length || !rule.args.every((slot, i) => matchesSlot(slot, args[i]))) return false;
	const seen = new Set<HostCliOption>();
	const index = consumeOptions(rule, args, seen);
	if (index < 0 || !rule.options.every((option) => !option.required || seen.has(option))) return false;
	if (!rule.positionals.length) return index === args.length;
	const positionals = args.slice(index + 1);
	return (
		args[index] === "--" &&
		positionals.length === rule.positionals.length &&
		rule.positionals.every((slot, i) => matchesSlot(slot, positionals[i]))
	);
}

export function authorize(command: HostCliCommand, input: unknown): string[] {
	if (!Array.isArray(input) || !input.every((arg): arg is string => typeof arg === "string")) {
		throw new Error("Expected an argv array of strings");
	}
	const args = [...input];
	if (
		args.length > 64 ||
		args.some((arg) => arg.length > MAX_TEXT_ARGUMENT_LENGTH || arg.includes("\0")) ||
		(command.allow !== "*" && !command.allow.some((rule) => matchesRule(rule, args)))
	) {
		throw new Error(`Denied by host CLI policy for ${command.name}: argv must match an allowed rule`);
	}
	return args;
}
