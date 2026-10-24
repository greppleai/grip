import { posix, win32 } from "node:path";

export type PortablePathFlavor = "posix" | "windows";

type PathApi = typeof posix | typeof win32;

export function absolutePathFlavor(value: string): PortablePathFlavor | undefined {
	if (/^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)) return "windows";
	if (value.startsWith("/")) return "posix";
	return undefined;
}

export function pathFlavor(value: string, fallback: PortablePathFlavor = "posix"): PortablePathFlavor {
	return absolutePathFlavor(value) ?? fallback;
}

export function pathApi(flavor: PortablePathFlavor): PathApi {
	return flavor === "windows" ? win32 : posix;
}

export function normalizePortablePath(value: string, fallback?: PortablePathFlavor): string {
	return pathApi(pathFlavor(value, fallback)).normalize(value);
}

export function resolvePortablePath(baseDir: string, value: string): string {
	const absoluteFlavor = absolutePathFlavor(value);
	if (absoluteFlavor) return pathApi(absoluteFlavor).normalize(value);
	const baseFlavor = pathFlavor(baseDir);
	return pathApi(baseFlavor).resolve(baseDir, value);
}

export function joinPortablePath(basePath: string, ...parts: string[]): string {
	return pathApi(pathFlavor(basePath)).join(basePath, ...parts);
}

export function dirnamePortablePath(value: string, fallback?: PortablePathFlavor): string {
	return pathApi(pathFlavor(value, fallback)).dirname(value);
}

export function pathComparisonValue(value: string, flavor = pathFlavor(value)): string {
	const normalized = pathApi(flavor).normalize(value);
	return flavor === "windows" ? normalized.toLowerCase() : normalized;
}

export function relativePortablePath(from: string, to: string): string {
	const flavor = pathFlavor(from);
	if (absolutePathFlavor(to) !== flavor) return to;
	return pathApi(flavor).relative(from, to);
}

/** Compare with Windows case folding while deriving the suffix from the original normalized candidate. */
export function relativeWithin(root: string, candidate: string): string | undefined {
	const flavor = pathFlavor(root);
	if (absolutePathFlavor(candidate) !== flavor) return undefined;
	const api = pathApi(flavor);
	const normalizedRoot = api.normalize(root);
	const normalizedCandidate = api.normalize(candidate);
	const comparableRoot = pathComparisonValue(normalizedRoot, flavor);
	const comparableCandidate = pathComparisonValue(normalizedCandidate, flavor);
	if (comparableRoot === comparableCandidate) return "";
	const prefix = comparableRoot.endsWith(api.sep) ? comparableRoot : `${comparableRoot}${api.sep}`;
	if (!comparableCandidate.startsWith(prefix)) return undefined;
	return normalizedCandidate.slice(prefix.length);
}
