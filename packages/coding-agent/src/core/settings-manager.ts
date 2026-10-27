import type {
	QueueMode,
	CompactionSettings as ResolvedCompactionSettings,
	ThinkingLevel,
} from "@greppleai/grip-agent-core";
import type { Api, Model, RetryPolicy, ThinkingBudgets, Transport } from "@greppleai/grip-ai";
import type { ScrollViewScrollbar, TuiMode } from "@greppleai/grip-tui";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, sep } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import type { SandboxCleanupBehavior } from "./sandbox/config.ts";

// grip-ignore noNearIdenticalDataStructures: Persisted overrides permit omitted fields so settings layering can apply defaults independently of the fully resolved harness runtime contract.
export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

export type FullscreenExitOutput = "transcript" | "resume-hint";

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export type ThinkingBudgetsSettings = ThinkingBudgets;

export type MermaidRenderingMode = "off" | "final" | "streaming";
export type DoubleEscapeAction = "fork" | "tree" | "none";
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: boolean | MermaidRenderingMode; // boolean values are accepted for fork settings migration
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type ToolSettings = Record<string, Record<string, unknown> | undefined>;
export type WebsearchSettingProvider = "duckduckgo" | "brave" | "firecrawl";

export interface SandboxSettings {
	limaBinary?: string; // default: limactl
	limaTemplate?: string; // default: template:docker-rootful
	limaInstanceNamePrefix?: string; // default: grip-sandbox
	workspaceMountPath?: string; // default: /workspace
	daemonPort?: number; // sandbox daemon port, default: 8787
	daemonHostBind?: string; // host bind address for daemon forwarding, default: 127.0.0.1
	cleanup?: SandboxCleanupBehavior; // default: stop
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			rules?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	compressionDetectionModel?: string | null; // trusted global/profile provider/model ID; null disables it
	defaultThinkingLevel?: ThinkingLevel;
	transport?: TransportSetting; // default: "auto"
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	rules?: string[]; // Array of local rule file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills and rules as /skill:name and /rule:name commands
	enableJobs?: boolean; // default: true - expose built-in job tools
	jobModel?: string | null; // trusted global/profile provider/model ID; null defers to environment or parent
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	modelProfiles?: Record<string, string[]>; // Legacy named model snapshots
	profiles?: Record<string, ProfileSettings>; // Named settings overlays; global only
	/** Obsolete persisted profile selection; ignored on startup and removed on the next manual switch. */
	activeProfile?: string;
	profileDirectories?: Record<string, string>; // Absolute directory prefix -> profile name; global only
	doubleEscapeAction?: DoubleEscapeAction; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: TreeFilterMode; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for user, assistant, and thinking output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	tools?: ToolSettings; // Per-tool configuration keyed by tool name (for example tools.websearch)
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	sandbox?: SandboxSettings;
	/** Canonical host directory -> existing named Lima VM; global settings only. */
	defaultSandboxes?: Record<string, string>;
	tuiMode?: TuiMode; // default: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // default: "transcript"; no effect in regular TUI mode
	fullscreenScrollbar?: ScrollViewScrollbar; // default: "auto"; no effect in regular TUI mode
}

/** Every ordinary setting may be overridden by a profile. Profile management stays global. */
export type ProfileSettings = Omit<
	Settings,
	"profiles" | "modelProfiles" | "activeProfile" | "profileDirectories" | "defaultSandboxes" | "lastChangelogVersion"
> & {
	/** Existing named Lima VM for this profile; only trusted user profiles may select it. */
	defaultSandbox?: string;
	/** Whether to connect the profile/default directory VM on startup; defaults to true. */
	autoConnectSandbox?: boolean;
};

export function isValidModelProfileName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

type ProfileModelSelection = Pick<Model<Api>, "provider" | "id">;
type TrustedModelSettingKey = "jobModel" | "compressionDetectionModel";

interface ProfileSandboxOptions {
	defaultSandbox?: string | undefined;
	autoConnectSandbox?: boolean;
}
type ProfileSandboxSettingKey = keyof ProfileSandboxOptions;
type ProfileField = keyof Settings | ProfileSandboxSettingKey;
type ProfileChanges = Map<string, Map<ProfileField, Set<string> | undefined>>;

function profilePatterns(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((pattern) => typeof pattern === "string") ? [...value] : undefined;
}

function canonicalProfileDirectory(path: string): string {
	const resolved = resolvePath(path);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function isDirectoryAncestor(path: string, cwd: string): boolean {
	const suffix = relative(path, cwd);
	return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

const GLOBAL_ONLY_PROFILE_SETTINGS = new Set<keyof Settings>([
	"profiles",
	"modelProfiles",
	"activeProfile",
	"profileDirectories",
	"defaultSandboxes",
	"lastChangelogVersion",
]);

const RECURSIVELY_MERGED_SETTINGS = new Set<keyof Settings>([
	"compaction",
	"branchSummary",
	"retry",
	"terminal",
	"images",
	"thinkingBudgets",
	"markdown",
	"warnings",
	"sandbox",
]);

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setOwnValue(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function setProfileField(
	profile: Record<string, unknown>,
	field: keyof Settings,
	value: unknown,
	nestedKey?: string,
): void {
	if (nestedKey && isMergeableObject(value)) {
		const next = { ...(isMergeableObject(profile[field]) ? profile[field] : {}) };
		setOwnValue(next, nestedKey, value[nestedKey]);
		setOwnValue(profile, field, next);
	} else
		setOwnValue(
			profile,
			field,
			(field === "jobModel" || field === "compressionDetectionModel") && value === undefined ? null : value,
		);
}

function collectModelProfiles(result: Record<string, string[]>, source: unknown, fullProfile: boolean): void {
	if (!isMergeableObject(source)) return;
	for (const [name, value] of Object.entries(source)) {
		const patterns = profilePatterns(fullProfile && isMergeableObject(value) ? (value.enabledModels ?? []) : value);
		if (isValidModelProfileName(name) && patterns) setOwnValue(result, name, patterns);
	}
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) continue;
		const baseValue = base[key];
		setOwnValue(
			result,
			key,
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue,
		);
	}
	return result;
}

function mergeToolSettings(baseValue: ToolSettings | undefined, overrideValue: ToolSettings): ToolSettings {
	const mergedTools: ToolSettings = isMergeableObject(baseValue) ? { ...baseValue } : {};
	for (const [toolName, toolOverride] of Object.entries(overrideValue)) {
		const baseTool = mergedTools[toolName];
		setOwnValue(
			mergedTools,
			toolName,
			isMergeableObject(baseTool) && isMergeableObject(toolOverride)
				? { ...baseTool, ...toolOverride }
				: toolOverride,
		);
	}
	return mergedTools;
}

function applySettingsOverride(
	result: Settings,
	base: Settings,
	key: keyof Settings,
	overrideValue: Settings[keyof Settings],
): void {
	const resultRecord = result as Record<string, unknown>;
	// Tool names merge, but each tool's configuration remains a shallow layer.
	if (key === "tools" && isMergeableObject(overrideValue)) {
		result.tools = mergeToolSettings(base.tools, overrideValue as ToolSettings);
		return;
	}
	if (overrideValue === undefined) return;
	const baseValue = base[key];
	setOwnValue(
		resultRecord,
		key,
		RECURSIVELY_MERGED_SETTINGS.has(key) && isMergeableObject(baseValue) && isMergeableObject(overrideValue)
			? deepMergeObjects(baseValue, overrideValue)
			: overrideValue,
	);
}

/** Merge settings according to each field's layering policy. */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };
	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		applySettingsOverride(result, base, key, overrides[key]);
	}
	return result;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

function mergeProfileChanges(
	before: unknown,
	after: unknown,
	changes: Map<ProfileField, Set<string> | undefined>,
): Record<string, unknown> {
	const original = isMergeableObject(before) ? before : {};
	const replacement = isMergeableObject(after) ? after : {};
	const updated = { ...original };
	for (const [key, subkeys] of changes) {
		const value = replacement[key];
		if (subkeys && isMergeableObject(value)) {
			const nested = { ...(isMergeableObject(original[key]) ? original[key] : {}) };
			for (const subkey of subkeys) setOwnValue(nested, subkey, value[subkey]);
			setOwnValue(updated, key, nested);
		} else if (value === undefined) delete updated[key];
		else setOwnValue(updated, key, value);
	}
	return updated;
}

function mergeModifiedNestedSetting(
	field: keyof Settings,
	original: Settings,
	snapshot: Settings,
	keys: Set<string>,
	profileChanges: ProfileChanges,
): Record<string, unknown> {
	const before = original[field];
	const after = snapshot[field];
	const oldValues = isMergeableObject(before) ? before : {};
	const newValues = isMergeableObject(after) ? after : {};
	const merged = { ...oldValues };
	for (const key of keys) {
		const value =
			field === "profiles" && profileChanges.has(key)
				? mergeProfileChanges(oldValues[key], newValues[key], profileChanges.get(key)!)
				: newValues[key];
		setOwnValue(merged, key, value);
	}
	return merged;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

interface SettingsLoadResult {
	settings: Settings;
	error: Error | null;
}

type ResolvedBranchSummarySettings = Required<BranchSummarySettings>;

type ResolvedProviderRetrySettings = Omit<ProviderRetrySettings, "maxRetryDelayMs"> &
	Required<Pick<ProviderRetrySettings, "maxRetryDelayMs">>;

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}
interface LegacySkillsSettings {
	enableSkillCommands?: boolean;
	customDirectories?: unknown;
}

function migrateLegacyQueueMode(settings: Record<string, unknown>): void {
	if (!("queueMode" in settings) || "steeringMode" in settings) return;
	settings.steeringMode = settings.queueMode;
	delete settings.queueMode;
}

function migrateLegacyWebsocketSetting(settings: Record<string, unknown>): void {
	if ("transport" in settings || typeof settings.websockets !== "boolean") return;
	settings.transport = settings.websockets ? "websocket" : "sse";
	delete settings.websockets;
}

function migrateLegacySkillsSetting(settings: Record<string, unknown>): void {
	if (!("skills" in settings) || !isMergeableObject(settings.skills)) return;
	const skillsSettings = settings.skills as LegacySkillsSettings;
	if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
		settings.enableSkillCommands = skillsSettings.enableSkillCommands;
	}
	if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
		settings.skills = skillsSettings.customDirectories;
	} else {
		delete settings.skills;
	}
}

function migrateLegacyRetryDelaySetting(settings: Record<string, unknown>): void {
	if (!("retry" in settings) || !isMergeableObject(settings.retry)) return;
	const retrySettings = settings.retry;
	const providerSettings =
		typeof retrySettings.provider === "object" && retrySettings.provider !== null
			? (retrySettings.provider as Record<string, unknown>)
			: undefined;
	if (
		typeof retrySettings.maxDelayMs === "number" &&
		(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
	) {
		retrySettings.provider = {
			...(providerSettings ?? {}),
			maxRetryDelayMs: retrySettings.maxDelayMs,
		};
	}
	delete retrySettings.maxDelayMs;
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private runtimeOverrides: Settings = {};
	private settings: Settings = {};
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private readonly cwd: string;
	private sessionProfileOverride: string | null | undefined;
	private baseGlobalSettings: Settings;
	private modifiedProfileFields: ProfileChanges = new Map();
	private transientModelSelections = 0;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		cwd: string = process.cwd(),
	) {
		this.storage = storage;
		this.cwd = resolvePath(cwd);
		this.globalSettings = initialGlobal;
		this.baseGlobalSettings = structuredClone(initialGlobal);
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.recomputeSettings();
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, cwd);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, cwd: string = process.cwd()): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			cwd,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, cwd: string = process.cwd()): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, cwd);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(storage: SettingsStorage, scope: SettingsScope): SettingsLoadResult {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		migrateLegacyQueueMode(settings);
		migrateLegacyWebsocketSetting(settings);
		migrateLegacySkillsSetting(settings);
		migrateLegacyRetryDelaySetting(settings);
		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	/** Global settings with the selected profile, without project or runtime overrides. */
	getUserSettings(): Settings {
		const name = this.getActiveProfile();
		return structuredClone(deepMergeSettings(this.globalSettings, name ? (this.getProfile(name) ?? {}) : {}));
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.baseGlobalSettings = structuredClone(globalLoad.settings);
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProfileFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.recomputeSettings();
	}

	private recomputeSettings(): void {
		const name = this.getActiveProfile();
		const profile = name ? this.getProfile(name) : undefined;
		this.settings = deepMergeSettings(
			deepMergeSettings(deepMergeSettings(this.globalSettings, profile ?? {}), this.projectSettings),
			this.runtimeOverrides,
		);
	}

	/** Manual selection is session-only; directory rules select profiles on startup. */
	getActiveProfile(): string | undefined {
		if (this.sessionProfileOverride !== undefined) return this.sessionProfileOverride ?? undefined;
		return this.getDirectoryProfile();
	}

	private getDirectoryProfile(): string | undefined {
		const directories = this.globalSettings.profileDirectories;
		if (!isMergeableObject(directories)) return undefined;
		const cwd = canonicalProfileDirectory(this.cwd);
		let best: { name: string; length: number } | undefined;
		for (const [prefix, name] of Object.entries(directories)) {
			if (typeof name !== "string" || !isAbsolute(normalizePath(prefix)) || !this.getProfile(name)) continue;
			const path = canonicalProfileDirectory(prefix);
			if (isDirectoryAncestor(path, cwd) && (!best || path.length > best.length)) {
				best = { name, length: path.length };
			}
		}
		return best?.name;
	}

	getProfile(name: string): ProfileSettings | undefined {
		if (!isValidModelProfileName(name)) return undefined;
		const profiles = this.globalSettings.profiles;
		if (isMergeableObject(profiles) && Object.hasOwn(profiles, name) && isMergeableObject(profiles[name])) {
			const {
				profiles: _profiles,
				activeProfile: _active,
				profileDirectories: _directories,
				modelProfiles: _legacy,
				defaultSandboxes: _sandboxes,
				lastChangelogVersion: _changelog,
				...settings
			} = profiles[name] as Settings;
			return structuredClone(settings);
		}
		const legacy = this.globalSettings.modelProfiles;
		const patterns =
			isMergeableObject(legacy) && Object.hasOwn(legacy, name) ? profilePatterns(legacy[name]) : undefined;
		return patterns ? { enabledModels: patterns } : undefined;
	}

	useProfile(name: string): void {
		const profile = this.getProfile(name);
		if (!profile) throw new Error(`Unknown profile: ${name}`);
		this.globalSettings.profiles ??= {};
		let shouldSave = false;
		if (!Object.hasOwn(this.globalSettings.profiles, name)) {
			setOwnValue(this.globalSettings.profiles, name, profile);
			this.markModified("profiles", name);
			shouldSave = true;
		}
		// Discard an old persisted selection without writing the current selection back.
		if (Object.hasOwn(this.globalSettings, "activeProfile")) {
			delete this.globalSettings.activeProfile;
			this.markModified("activeProfile");
			shouldSave = true;
		}
		this.sessionProfileOverride = name;
		if (shouldSave) this.save();
		else this.recomputeSettings();
	}

	setProfileSandbox(name: string, vmName: string | undefined): void {
		this.setProfileSandboxOptions(name, { defaultSandbox: vmName });
	}

	setProfileSandboxAutoConnect(name: string, enabled: boolean): void {
		this.setProfileSandboxOptions(name, { autoConnectSandbox: enabled });
	}

	/** Apply both sandbox preferences in a single settings write. */
	setProfileSandboxOptions(name: string, options: ProfileSandboxOptions): void {
		if (options.defaultSandbox !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(options.defaultSandbox)) {
			throw new Error(
				"Profile sandbox must be an existing Lima VM name containing only lowercase letters, digits, or hyphens",
			);
		}
		const profile = this.getProfile(name);
		if (!profile) throw new Error(`Unknown profile: ${name}`);
		const changedKeys = Object.keys(options) as ProfileSandboxSettingKey[];
		if (changedKeys.length === 0) return;
		this.globalSettings.profiles ??= {};
		const promoted = !Object.hasOwn(this.globalSettings.profiles, name);
		for (const key of changedKeys) {
			const value = options[key];
			if (value === undefined) delete profile[key];
			else setOwnValue(profile, key, value);
		}
		setOwnValue(this.globalSettings.profiles, name, profile);
		if (promoted) this.markModified("profiles", name);
		else for (const key of changedKeys) this.markProfileEntryModified(name, key);
		this.save();
	}

	setProfileDirectory(prefix: string, name: string | undefined): void {
		const path = normalizePath(prefix);
		if (!isAbsolute(path)) throw new Error("Profile directory must be an absolute path");
		if (name !== undefined && !this.getProfile(name)) throw new Error(`Unknown profile: ${name}`);
		const canonical = canonicalProfileDirectory(path);
		const current = this.getActiveProfile();
		const directories = this.globalSettings.profileDirectories;
		if (directories !== undefined && !isMergeableObject(directories))
			throw new Error("Invalid profileDirectories setting");
		this.globalSettings.profileDirectories = { ...directories };
		this.sessionProfileOverride = current ?? null;
		if (name === undefined) delete this.globalSettings.profileDirectories[canonical];
		else setOwnValue(this.globalSettings.profileDirectories, canonical, name);
		this.markModified("profileDirectories", canonical);
		this.save();
	}

	getLoadError(scope: SettingsScope): Error | null {
		return scope === "global" ? this.globalSettingsLoadError : this.projectSettingsLoadError;
	}

	/** Apply cumulative runtime-only overrides on top of global and project settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
		this.recomputeSettings();
	}

	/** Existing setters write to the active profile; management and bookkeeping remain global. */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		const name = this.getActiveProfile();
		if (name && !GLOBAL_ONLY_PROFILE_SETTINGS.has(field)) {
			this.markProfileModified(name, field, nestedKey);
			return;
		}
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) this.modifiedNestedFields.set(field, new Set());
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	private markProfileModified(name: string, field: keyof Settings, nestedKey?: string): void {
		this.globalSettings.profiles ??= {};
		const profile = this.globalSettings.profiles[name] ?? {};
		const base = this.baseGlobalSettings as Record<string, unknown>;
		const global = this.globalSettings as Record<string, unknown>;
		const value = global[field];
		setProfileField(profile as Record<string, unknown>, field, value, nestedKey);
		setOwnValue(this.globalSettings.profiles, name, profile);
		if (Object.hasOwn(base, field)) setOwnValue(global, field, structuredClone(base[field]));
		else delete global[field];
		this.markProfileEntryModified(name, field, nestedKey);
	}

	private markProfileEntryModified(name: string, field: ProfileField, nestedKey?: string): void {
		let fields = this.modifiedProfileFields.get(name);
		if (!fields) {
			fields = new Map();
			this.modifiedProfileFields.set(name, fields);
		}
		const previous = fields.get(field);
		if (nestedKey && (!fields.has(field) || previous)) fields.set(field, new Set([...(previous ?? []), nestedKey]));
		else fields.set(field, undefined);
		this.modifiedFields.add("profiles");
		this.modifiedNestedFields.set("profiles", new Set(this.modifiedProfileFields.keys()));
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
		profileChanges: ProfileChanges = new Map(),
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				const next =
					modifiedNestedFields.has(field) && isMergeableObject(value)
						? mergeModifiedNestedSetting(
								field,
								currentFileSettings,
								snapshotSettings,
								modifiedNestedFields.get(field)!,
								profileChanges,
							)
						: value;
				setOwnValue(mergedSettings as Record<string, unknown>, field, next);
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.recomputeSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);
		const profileChanges = new Map(this.modifiedProfileFields);
		this.modifiedProfileFields = new Map();
		this.baseGlobalSettings = structuredClone(this.globalSettings);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings(
				"global",
				snapshotGlobalSettings,
				modifiedFields,
				modifiedNestedFields,
				profileChanges,
			);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.recomputeSettings();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getSandboxSettings(): SandboxSettings | undefined {
		return this.settings.sandbox ? structuredClone(this.settings.sandbox) : undefined;
	}

	getDefaultSandbox(cwd: string): string | undefined {
		const defaults = this.globalSettings.defaultSandboxes;
		if (!isMergeableObject(defaults)) return undefined;
		const path = realpathSync(cwd);
		const name = Object.hasOwn(defaults, path) ? defaults[path] : undefined;
		return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined;
	}

	/** Resolve startup auto-connection from trusted profile settings, then the legacy directory assignment. */
	getAutoConnectSandbox(cwd: string): string | undefined {
		const active = this.getActiveProfile();
		const profile = active ? this.getProfile(active) : undefined;
		if (profile?.autoConnectSandbox === false) return undefined;
		if (profile?.defaultSandbox !== undefined) {
			const name = profile.defaultSandbox;
			return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined;
		}
		return this.getDefaultSandbox(cwd);
	}

	setDefaultSandbox(cwd: string, name: string | undefined): void {
		if (name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
			throw new Error(
				"Default sandbox must be an existing Lima VM name containing only lowercase letters, digits, or hyphens",
			);
		}
		const path = realpathSync(cwd);
		const defaults = this.globalSettings.defaultSandboxes;
		if (defaults !== undefined && !isMergeableObject(defaults)) throw new Error("Invalid defaultSandboxes settings");
		this.globalSettings.defaultSandboxes = { ...defaults };
		if (name === undefined) delete this.globalSettings.defaultSandboxes[path];
		else setOwnValue(this.globalSettings.defaultSandboxes, path, name);
		this.markModified("defaultSandboxes", path);
		this.save();
	}

	getToolsSettings(): ToolSettings | undefined {
		return this.settings.tools ? structuredClone(this.settings.tools) : undefined;
	}

	getToolSettings(toolName: string): Record<string, unknown> | undefined {
		const value = this.settings.tools?.[toolName];
		return value ? structuredClone(value) : undefined;
	}

	/** Persist the selected web search engine without putting its API key in settings.json. */
	setWebsearchProvider(provider: WebsearchSettingProvider): void {
		const websearch: Record<string, unknown> = { ...this.globalSettings.tools?.websearch, provider };
		if (this.globalSettings.tools?.websearch?.provider !== provider) {
			// Old provider-specific credentials and endpoints must not carry over to a new engine.
			delete websearch.apiKey;
			delete websearch.baseUrl;
		}
		this.globalSettings.tools = { ...this.globalSettings.tools, websearch };
		this.markModified("tools", "websearch");
		this.save();
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getCompressionDetectionModel(): string | undefined {
		return this.getTrustedModelSetting("compressionDetectionModel");
	}

	setCompressionDetectionModel(reference: string | undefined): void {
		if (reference) this.globalSettings.compressionDetectionModel = reference;
		else delete this.globalSettings.compressionDetectionModel;
		this.markModified("compressionDetectionModel");
		this.save();
	}

	/** Switch the current session model without rewriting the selected profile's defaults. */
	async withTransientModelSelection(task: () => Promise<void>): Promise<void> {
		this.transientModelSelections++;
		try {
			await task();
		} finally {
			this.transientModelSelections--;
		}
	}

	setDefaultProvider(provider: string): void {
		if (this.transientModelSelections) return;
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		if (this.transientModelSelections) return;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		if (this.transientModelSelections) return;
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): QueueMode {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: QueueMode): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): QueueMode {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: QueueMode): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		if (this.transientModelSelections) return;
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): ResolvedCompactionSettings {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): ResolvedBranchSummarySettings {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): RetryPolicy {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getProviderRetrySettings(): ResolvedProviderRetrySettings {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getExternalEditorCommand(): string | undefined {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.packages = packages;
		this.markProjectModified("packages");
		this.saveProjectSettings(projectSettings);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.extensions = paths;
		this.markProjectModified("extensions");
		this.saveProjectSettings(projectSettings);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.skills = paths;
		this.markProjectModified("skills");
		this.saveProjectSettings(projectSettings);
	}

	getRulePaths(): string[] {
		return [...(this.settings.rules ?? [])];
	}

	setRulePaths(paths: string[]): void {
		this.globalSettings.rules = paths;
		this.markModified("rules");
		this.save();
	}

	setProjectRulePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.rules = paths;
		this.markProjectModified("rules");
		this.saveProjectSettings(projectSettings);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.prompts = paths;
		this.markProjectModified("prompts");
		this.saveProjectSettings(projectSettings);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.themes = paths;
		this.markProjectModified("themes");
		this.saveProjectSettings(projectSettings);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getEnableJobs(): boolean {
		return this.settings.enableJobs ?? true;
	}

	setEnableJobs(enabled: boolean): void {
		this.globalSettings.enableJobs = enabled;
		this.markModified("enableJobs");
		this.save();
	}
	private getTrustedModelSetting(key: TrustedModelSettingKey): string | undefined {
		const active = this.getActiveProfile();
		const profile = active ? this.getProfile(active) : undefined;
		const value =
			this.runtimeOverrides[key] !== undefined
				? this.runtimeOverrides[key]
				: profile?.[key] !== undefined
					? profile[key]
					: this.globalSettings[key];
		return typeof value === "string" && value.trim() ? value : undefined;
	}

	getJobModel(): string | undefined {
		return this.getTrustedModelSetting("jobModel");
	}

	setJobModel(model: string | undefined): void {
		if (model !== undefined && !model.trim()) throw new Error("A job model is required");
		if (model === undefined) delete this.globalSettings.jobModel;
		else this.globalSettings.jobModel = model;
		this.markModified("jobModel");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.GRIP_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}
	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getModelProfiles(): Record<string, string[]> {
		const profiles: Record<string, string[]> = {};
		collectModelProfiles(profiles, this.globalSettings.modelProfiles, false);
		collectModelProfiles(profiles, this.globalSettings.profiles, true);
		return profiles;
	}

	setModelProfile(name: string, patterns: string[], selectedModel?: ProfileModelSelection): void {
		if (!isValidModelProfileName(name)) throw new Error(`Invalid model profile name: ${name}`);
		if (!patterns.every((pattern) => typeof pattern === "string" && pattern.length > 0)) {
			throw new Error("Model profiles must contain only non-empty model patterns");
		}
		const {
			profiles: _profiles,
			modelProfiles: _legacy,
			activeProfile: _active,
			profileDirectories: _directories,
			defaultSandboxes: _sandboxes,
			lastChangelogVersion: _changelog,
			...settings
		} = this.settings;
		const active = this.getActiveProfile();
		const currentProfile = active ? this.getProfile(active) : undefined;
		// Sandbox selection is trusted user-only; do not snapshot project or runtime values.
		const {
			defaultSandbox: _untrustedSandbox,
			autoConnectSandbox: _untrustedAutoConnect,
			enabledModels: _inheritedModels,
			...ordinary
		} = settings as ProfileSettings;
		const profile: ProfileSettings = structuredClone(ordinary);
		if (patterns.length) profile.enabledModels = [...patterns];
		if (currentProfile?.defaultSandbox !== undefined) profile.defaultSandbox = currentProfile.defaultSandbox;
		if (currentProfile?.autoConnectSandbox !== undefined)
			profile.autoConnectSandbox = currentProfile.autoConnectSandbox;
		const trustedJobModel = this.getJobModel();
		const trustedDetectorModel = this.getCompressionDetectionModel();
		if (trustedJobModel) profile.jobModel = trustedJobModel;
		else if (this.globalSettings.jobModel) profile.jobModel = null;
		else delete profile.jobModel;
		if (trustedDetectorModel) profile.compressionDetectionModel = trustedDetectorModel;
		else if (this.globalSettings.compressionDetectionModel) profile.compressionDetectionModel = null;
		else delete profile.compressionDetectionModel;
		if (selectedModel) {
			profile.defaultProvider = selectedModel.provider;
			profile.defaultModel = selectedModel.id;
		}
		this.globalSettings.profiles ??= {};
		setOwnValue(this.globalSettings.profiles, name, profile);
		this.markModified("profiles", name);
		this.save();
	}
	getDoubleEscapeAction(): DoubleEscapeAction {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: DoubleEscapeAction): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): TreeFilterMode {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: TreeFilterMode): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.GRIP_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: number): void {
		this.globalSettings.outputPad = padding === 0 ? 0 : 1;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getMarkdownSettings(): MarkdownSettings {
		return { ...(this.settings.markdown ?? {}) };
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
