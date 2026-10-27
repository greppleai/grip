import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	officialObject,
	officialText,
	validateOfficialDigest,
	validateOfficialId,
	validateOfficialVersion,
} from "./official-catalog.ts";

/** Observed state only: settings.packages is the sole desired-membership list. */
export interface OfficialInstalledVersion {
	version: string;
	sha256: string;
	directory: string;
}

export type OfficialOperation = "install" | "remove";
export interface OfficialPendingOperation {
	operation: OfficialOperation;
	target: OfficialInstalledVersion | null;
}

export interface OfficialFailure {
	code: string;
	message: string;
	at: number;
}

export interface OfficialInstallationState {
	schemaVersion: 1;
	id: string;
	active: OfficialInstalledVersion | null;
	pending: OfficialPendingOperation | null;
	failure: OfficialFailure | null;
}

export type OfficialStateReadResult =
	| { status: "missing"; state: null; error: null }
	| { status: "valid"; state: OfficialInstallationState; error: null }
	| { status: "corrupt"; state: null; error: string };

export function officialInstallationRoot(agentDir: string, id: string): string {
	return join(resolve(agentDir), "official", validateOfficialId(id));
}

export function officialVersionDirectory(version: string, sha256: string): string {
	return `versions/${validateOfficialVersion(version)}-${validateOfficialDigest(sha256)}`;
}

function parseInstalledVersion(value: unknown): OfficialInstalledVersion {
	const record = officialObject(value, "installed version");
	const version = validateOfficialVersion(record.version);
	const sha256 = validateOfficialDigest(record.sha256);
	const directory = officialVersionDirectory(version, sha256);
	if (record.directory !== directory) throw new Error("Invalid official version directory");
	return { version, sha256, directory };
}

export function parseOfficialState(value: unknown, expectedId: string): OfficialInstallationState {
	const record = officialObject(value, "installation state");
	if (record.schemaVersion !== 1) throw new Error("Unsupported official state schema");
	const id = validateOfficialId(record.id);
	if (id !== validateOfficialId(expectedId)) throw new Error("Official state ID mismatch");
	const active = record.active === null ? null : parseInstalledVersion(record.active);
	let pending: OfficialPendingOperation | null = null;
	if (record.pending !== null) {
		const transaction = officialObject(record.pending, "pending operation");
		if (transaction.operation !== "install" && transaction.operation !== "remove")
			throw new Error("Invalid official operation");
		const target = transaction.target === null ? null : parseInstalledVersion(transaction.target);
		if ((transaction.operation === "install") !== (target !== null))
			throw new Error("Invalid official operation target");
		pending = { operation: transaction.operation, target };
	}
	let failure: OfficialFailure | null = null;
	if (record.failure !== null) {
		const error = officialObject(record.failure, "failure");
		if (typeof error.at !== "number" || !Number.isSafeInteger(error.at) || error.at < 0)
			throw new Error("Invalid official failure timestamp");
		failure = {
			code: officialText(error.code, "failure code"),
			message: officialText(error.message, "failure message"),
			at: error.at,
		};
	}
	return { schemaVersion: 1, id, active, pending, failure };
}

export async function readOfficialState(agentDir: string, id: string): Promise<OfficialStateReadResult> {
	const path = join(officialInstallationRoot(agentDir, id), "state.json");
	try {
		return { status: "valid", state: parseOfficialState(JSON.parse(await readFile(path, "utf8")), id), error: null };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { status: "missing", state: null, error: null };
		}
		return { status: "corrupt", state: null, error: error instanceof Error ? error.message : String(error) };
	}
}
