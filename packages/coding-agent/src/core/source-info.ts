import type { PathMetadata } from "./package-manager.ts";
import type { WorkspaceIdentity } from "./workspace-identity.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";
type SourceBackend = "local" | "remote";

export interface OfficialPackageInfo {
	id: string;
	version: string;
}

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
	workspace?: WorkspaceIdentity;
	official?: OfficialPackageInfo;
}

export interface SyntheticSourceInfoOptions {
	source: string;
	scope?: SourceScope;
	origin?: SourceOrigin;
	baseDir?: string;
	workspace?: WorkspaceIdentity;
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
		workspace: metadata.workspace,
		official: metadata.official,
	};
}

export function createSyntheticSourceInfo(path: string, options: SyntheticSourceInfoOptions): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
		workspace: options.workspace,
	};
}

export function getSourceBackend(sourceInfo: SourceInfo | undefined): SourceBackend {
	return sourceInfo?.source === "remote" ? "remote" : "local";
}

export function getSourceBackendIcon(sourceInfo: SourceInfo | undefined): string {
	return getSourceBackend(sourceInfo) === "remote" ? "☁" : "🖥";
}
