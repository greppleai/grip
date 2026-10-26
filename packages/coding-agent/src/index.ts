// Core session management

export type { TuiMode } from "@greppleai/grip-tui";
// Config paths
export { getAgentDir, VERSION } from "./config.ts";
export {
	type ActivateSandboxDaemonOptions,
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ConfigureRemoteSandboxOptions,
	type ExecuteBashOptions,
	type ForkableUserMessage,
	type ModelCycleResult,
	type NavigateTreeOptions,
	type NavigateTreeResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type QueuedMessages,
	type RecordBashResultOptions,
	type RegisterSessionToolOptions,
	type SendCustomMessageOptions,
	type SendUserMessageOptions,
	type SessionRuleRegistration,
	type SessionSkillRegistration,
	type SessionStats,
	type StructuredResponse,
	type StructuredResponseOptions,
} from "./core/agent-session.ts";
// Auth and model registry
export {
	type ApiKeyCredential,
	type AuthApiKeyLookupOptions,
	type AuthCredential,
	type AuthStatus,
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type OAuthCredential,
} from "./core/auth-storage.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "./core/compaction/branch-summarization.ts";
export {
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	shouldCompact,
} from "./core/compaction/compaction.ts";
export { type FileOperations, serializeConversation } from "./core/compaction/utils.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
export { createExtensionRuntime, discoverAndLoadExtensions } from "./core/extensions/loader.ts";
export { ExtensionRunner } from "./core/extensions/runner.ts";
// Extension system
export type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	AutocompleteProviderFactory,
	BashResult,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionHostCommandOptions,
	ExtensionHostProcessOptions,
	ExtensionNotificationType,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionToolBackendExecOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	JobToolCallEvent,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	MessageRenderer,
	MessageRenderOptions,
	ProviderConfig,
	ProviderModelConfig,
	ReadImageToolCallEvent,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionShutdownReason,
	SessionStartEvent,
	SessionTreeEvent,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolExecutionMode,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WebsearchToolCallEvent,
	WebsearchToolResultEvent,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
} from "./core/extensions/types.ts";
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isJobToolResult,
	isLsToolResult,
	isReadImageToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWebsearchToolResult,
	isWriteToolResult,
} from "./core/extensions/types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./core/extensions/wrapper.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export {
	type CreateGripAgentOptions,
	GripAgent,
	type GripAgentDiagnostic,
	type GripAgentHooksOptions,
	type GripAgentRuntimeHost,
	type GripAgentServices,
	type GripAgentSessionOptions,
	type ResolveGripAgentSessionOptionsContext,
	type ResolveGripAgentSessionOptionsResult,
} from "./core/grip-agent.ts";
export {
	formatInstructionResourcesForPrompt,
	type InstructionResource,
	type InstructionResourceFrontmatter,
	InstructionResourceLoader,
	type InstructionResourceLoaderConfig,
	type InstructionResourceLoaderOptions,
	type InstructionResourceLoaderWithOperationsOptions,
} from "./core/instruction-resource-loader.ts";
export { convertToLlm } from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export type { ScopedModel } from "./core/model-resolver.ts";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
export type { PromptTemplate } from "./core/prompt-templates.ts";
export type {
	ProjectContextFile,
	ResourceCollision,
	ResourceDiagnostic,
	ResourceLoader,
} from "./core/resource-loader.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
// Rules
export {
	formatRulesForPrompt,
	type LoadRulesFromDirOptions,
	type LoadRulesOptions,
	type LoadRulesResult,
	type LoadRulesWithOperationsOptions,
	loadRules,
	loadRulesFromDir,
	type Rule,
	type RuleFrontmatter,
	RuleLoader,
} from "./core/rules.ts";
export { CURRENT_SESSION_VERSION } from "./core/session/constants.ts";
export { buildSessionContext, getLatestCompactionEntry } from "./core/session/context.ts";
export { InMemorySessionManager } from "./core/session/in-memory-session-manager.ts";
export {
	JsonlDecodeError,
	type JsonlDecodeKind,
	type JsonlErrorPhase,
	JsonlSessionError,
	type JsonlSessionErrorCode,
	type JsonlWriteOutcome,
} from "./core/session/jsonl-errors.ts";
export { LocalSessionManager } from "./core/session/local-session-manager.ts";
export { migrateSessionEntries, parseSessionEntries } from "./core/session/migrations.ts";
export {
	type AppendRemoteSessionEntriesRequest,
	type CreateRemoteSessionRequest,
	type ForkRemoteSessionRequest,
	type ImportRemoteSessionJsonlRequest,
	RemoteSessionClient,
	RemoteSessionClientError,
	type RemoteSessionClientOptions,
	type RemoteSessionOperation,
	RemoteSessionProtocolError,
	type RemoteSessionSnapshot,
	type ReplaceRemoteSessionSnapshotRequest,
} from "./core/session/remote-session-client.ts";
export { RemoteSessionManager } from "./core/session/remote-session-manager.ts";
export type { SessionManager } from "./core/session/session-manager.ts";
export { SessionAlreadyExistsError } from "./core/session/stores/jsonl-session-store.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	ModelChangeEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionMessageEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "./core/session/types.ts";
export {
	type CompactionSettings,
	type FullscreenExitOutput,
	type ImageSettings,
	type MarkdownSettings,
	type MermaidRenderingMode,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
	type ToolSettings,
} from "./core/settings-manager.ts";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsOptions,
	type LoadSkillsResult,
	type LoadSkillsWithOperationsOptions,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
	SkillLoader,
} from "./core/skills.ts";
export type { SlashCommandInfo, SlashCommandSource } from "./core/slash-commands.ts";
export type { SourceInfo, SyntheticSourceInfoOptions } from "./core/source-info.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
// Tools
export {
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
	type LocalBashOperationsOptions,
} from "./core/tools/bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./core/tools/edit.ts";
export { withFileMutationQueue } from "./core/tools/file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./core/tools/find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./core/tools/grep.ts";
export { createCodingTools, createReadOnlyTools, type ToolsOptions } from "./core/tools/index.ts";
export {
	createJobTool,
	createJobToolDefinition,
	formatJobTaskPrompt,
	type JobDetails,
	type JobExecutionBackend,
	type JobExecutionContext,
	type JobMode,
	type JobResult,
	type JobRunner,
	type JobRunOutcome,
	type JobRunRequest,
	type JobStatus,
	type JobToolInput,
	type JobToolOptions,
	type JobUsageStats,
	jobParamsSchema,
} from "./core/tools/job.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./core/tools/ls.ts";
export {
	createRemoteToolOperations,
	DeferredRemoteToolOperations,
	type DeferredRemoteToolOperationsConnectOptions,
	LocalToolOperations,
	type LocalToolOperationsOptions,
	RemoteToolOperations,
	type RemoteToolOperationsConnectOptions,
	type ToolAccessMode,
	type ToolBackendInfo,
	type ToolExecOptions,
	type ToolExecResult,
	type ToolFileStat,
	type ToolGlobOptions,
	type ToolGrepMatch,
	type ToolGrepOptions,
	type ToolGrepResult,
	type ToolMkdirOptions,
	type ToolOperations,
} from "./core/tools/operations.ts";

export {
	createReadImageTool,
	createReadImageToolDefinition,
	createReadTool,
	createReadToolDefinition,
	type ReadImageToolDefinition,
	type ReadImageToolInput,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOperations,
	type ReadToolOperationsSelection,
	type ReadToolOptions,
} from "./core/tools/read.ts";
export {
	createSessionEntryGetTool,
	createSessionEntryGetToolDefinition,
	createSessionSearchTool,
	createSessionSearchToolDefinition,
	type SessionEntryGetToolDetails,
	type SessionEntryGetToolInput,
	type SessionSearchMatch,
	type SessionSearchScope,
	type SessionSearchToolDetails,
	type SessionSearchToolInput,
} from "./core/tools/session-history.ts";

export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./core/tools/truncate.ts";
export {
	createWebsearchTool,
	createWebsearchToolDefinition,
	parseBraveSearchResponse,
	parseDuckDuckGoResponse,
	parseFirecrawlSearchResponse,
	parseWebsearchToolOptions,
	type WebsearchProvider,
	type WebsearchResultItem,
	type WebsearchSource,
	type WebsearchToolDetails,
	type WebsearchToolInput,
	type WebsearchToolOptions,
} from "./core/tools/websearch.ts";
export {
	WORKSPACE_TOOL_NAMES,
	type WorkspaceToolCatalogEntry,
	type WorkspaceToolDefinition,
	WorkspaceToolHost,
	type WorkspaceToolHostOptions,
	type WorkspaceToolInvocation,
	type WorkspaceToolName,
	type WorkspaceToolOptions,
} from "./core/tools/workspace-tool-host.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteToolInput,
	type WriteToolOptions,
} from "./core/tools/write.ts";
export type { WorkspaceIdentity } from "./core/workspace-identity.ts";
// Main entry point
export { type MainOptions, main } from "./main.ts";
// UI components for extensions
export { AssistantMessageComponent } from "./modes/interactive/components/assistant-message.ts";
export { BashExecutionComponent } from "./modes/interactive/components/bash-execution.ts";
export { BorderedLoader } from "./modes/interactive/components/bordered-loader.ts";
export { BranchSummaryMessageComponent } from "./modes/interactive/components/branch-summary-message.ts";
export { CompactionSummaryMessageComponent } from "./modes/interactive/components/compaction-summary-message.ts";
export { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
export { CustomMessageComponent } from "./modes/interactive/components/custom-message.ts";
export { type RenderDiffOptions, renderDiff } from "./modes/interactive/components/diff.ts";
export { DynamicBorder } from "./modes/interactive/components/dynamic-border.ts";
export { ExtensionEditorComponent } from "./modes/interactive/components/extension-editor.ts";
export { ExtensionInputComponent } from "./modes/interactive/components/extension-input.ts";
export { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
export { FooterComponent } from "./modes/interactive/components/footer.ts";
export { keyHint, keyText, rawKeyHint } from "./modes/interactive/components/keybinding-hints.ts";
export { LoginDialogComponent } from "./modes/interactive/components/login-dialog.ts";
export { ModelSelectorComponent } from "./modes/interactive/components/model-selector.ts";
export { OAuthSelectorComponent } from "./modes/interactive/components/oauth-selector.ts";
export { SessionSelectorComponent } from "./modes/interactive/components/session-selector.ts";
export {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "./modes/interactive/components/settings-selector.ts";
export { ShowImagesSelectorComponent } from "./modes/interactive/components/show-images-selector.ts";
export { SkillInvocationMessageComponent } from "./modes/interactive/components/skill-invocation-message.ts";
export { ThemeSelectorComponent } from "./modes/interactive/components/theme-selector.ts";
export { ThinkingSelectorComponent } from "./modes/interactive/components/thinking-selector.ts";
export {
	ToolExecutionComponent,
	type ToolExecutionDisplayResult,
	type ToolExecutionOptions,
} from "./modes/interactive/components/tool-execution.ts";
export { TreeSelectorComponent } from "./modes/interactive/components/tree-selector.ts";
export { UserMessageComponent } from "./modes/interactive/components/user-message.ts";
export { UserMessageSelectorComponent } from "./modes/interactive/components/user-message-selector.ts";
export { truncateToVisualLines, type VisualTruncateResult } from "./modes/interactive/components/visual-truncate.ts";
// Run modes for programmatic SDK usage
export { InteractiveMode, type InteractiveModeOptions } from "./modes/interactive/interactive-mode.ts";
// Theme utilities for custom tools and extensions
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.ts";
export type { JsonAgentSessionEvent } from "./modes/json-event.ts";
export { type PrintModeOptions, type PrintOutputMode, runPrintMode } from "./modes/print-mode.ts";
export {
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcDaemonSandboxOptions,
	type RpcEventListener,
	type RpcToolHandler,
} from "./modes/rpc/rpc-client.ts";
export { runRpcMode } from "./modes/rpc/rpc-mode.ts";
export type {
	RpcClientListSessionsResponse,
	RpcCommand,
	RpcInstructionDefinition,
	RpcListSessionsOptions,
	RpcListSessionsResponse,
	RpcResponse,
	RpcSessionState,
	RpcToolCallRequest,
	RpcToolDefinition,
} from "./modes/rpc/rpc-types.ts";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
// Shell utilities
export { getShellConfig } from "./utils/shell.ts";
