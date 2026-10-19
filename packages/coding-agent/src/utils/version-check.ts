import { PACKAGE_NAME } from "../config.ts";
import { getGripUserAgent } from "./grip-user-agent.ts";

const LATEST_VERSION_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}`;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestGripRelease {
	version: string;
	note?: string;
}

interface GripVersionCheckOptions {
	timeoutMs?: number;
}
interface NpmRegistryDistributionTags {
	latest?: unknown;
}

interface NpmRegistryPackageMetadata {
	"dist-tags"?: NpmRegistryDistributionTags;
	note?: unknown;
	version?: unknown;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestGripRelease(
	currentVersion: string,
	options: GripVersionCheckOptions = {},
): Promise<LatestGripRelease | undefined> {
	if (isTruthyEnvFlag(process.env.GRIP_SKIP_VERSION_CHECK) || isTruthyEnvFlag(process.env.GRIP_OFFLINE))
		return undefined;

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getGripUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as NpmRegistryPackageMetadata;
	const version =
		typeof data["dist-tags"]?.latest === "string" && data["dist-tags"].latest.trim()
			? data["dist-tags"].latest.trim()
			: typeof data.version === "string" && data.version.trim()
				? data.version.trim()
				: undefined;
	if (!version) {
		return undefined;
	}
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version,
		...(note ? { note } : {}),
	};
}

export async function getLatestGripVersion(
	currentVersion: string,
	options: GripVersionCheckOptions = {},
): Promise<string | undefined> {
	return (await getLatestGripRelease(currentVersion, options))?.version;
}

export async function checkForNewGripVersion(currentVersion: string): Promise<LatestGripRelease | undefined> {
	try {
		const latestRelease = await getLatestGripRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
