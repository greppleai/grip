import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { DAEMON_WEBSOCKET_PATH } from "../../daemon/config.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import { acquireSharedLimaOwnerLock, type SharedLimaOwnerLock } from "../remote-workspace-protocol/lima-owner-lock.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type {
	SandboxCommandOptions,
	SandboxCommandResult,
	SandboxConfig,
	SandboxConfigOverrides,
	SandboxContainer,
	SandboxListOptions,
	SandboxRunner,
	SandboxStartOptions,
	SandboxStartResult,
	SandboxStopOptions,
	SandboxStopResult,
} from "./config.ts";
import { allocateSandboxDaemonPort, redactSecrets, resolveSandboxConfig, SANDBOX_LABEL_PREFIX } from "./config.ts";
import { inspectLocalGuestBinary, installLocalGuestBinary, type LocalGuestBinary } from "./lima-guest-binary.ts";
import { resolveSharedLimaWorkspace, type SharedLimaWorkspaceBinding } from "./shared-lima-roots.ts";
import { stageSharedGuestBinary } from "./update-shared-guest-binary.ts";
export interface SharedLimaInstanceInspection extends SharedLimaWorkspaceBinding {
	instanceName: string;
	daemonUrl: string;
}

export interface SharedLimaInstanceOptions {
	instanceName: string;
	hostParent: string;
	hostRoot: string;
}

export interface ManagedLimaInstance {
	workspaceRoot: string;
	daemonPort: number;
	ownerId?: string;
	managed: boolean;
}

export interface LimaSandboxServiceOptions {
	settingsManager?: Pick<SettingsManager, "getSandboxSettings">;
	env?: NodeJS.ProcessEnv;
	runner?: SandboxRunner;
	portAllocator?: (host: string, preferredPort: number) => Promise<number>;
	readinessWaiter?: (host: string, port: number) => Promise<void>;
	managedInstances?: Map<string, ManagedLimaInstance>;
}

interface LimaMount {
	location?: string;
	mountPoint?: string;
	writable?: boolean;
}

interface LimaPortForward {
	guestPort?: number;
	hostPort?: number;
	hostIP?: string;
}

interface LimaConfig {
	mounts?: LimaMount[];
	portForwards?: LimaPortForward[];
}

interface LimaListRecord {
	name?: string;
	status?: string;
	arch?: string;
	vmType?: string;
	dir?: string;
	config?: LimaConfig;
}

interface KnownLimaRecord {
	record: LimaListRecord | undefined;
}

class ProcessLimaRunner implements SandboxRunner {
	run(command: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxCommandResult> {
		return new Promise((resolveCommand, reject) => {
			const child = spawnProcess(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...options.env },
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.once("error", reject);
			child.once("close", (exitCode) => resolveCommand({ exitCode, stdout, stderr }));
		});
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseLimaRecords(output: string): LimaListRecord[] {
	const text = output.trim();
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as unknown;
		return Array.isArray(parsed) ? (parsed as LimaListRecord[]) : [parsed as LimaListRecord];
	} catch {
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LimaListRecord);
	}
}

function ensureLimaSuccessful(binary: string, result: SandboxCommandResult, args: string[]): void {
	if (result.exitCode === 0) return;
	const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
	throw new Error(redactSecrets(`Lima command failed: ${binary} ${args.join(" ")}: ${detail}`));
}

function daemonConnectionHost(host: string): string {
	if (host === "0.0.0.0") return "127.0.0.1";
	if (host === "::") return "::1";
	return host;
}

function urlHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolveConnection) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (connected: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolveConnection(connected);
		};
		socket.setTimeout(250, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function waitForLimaDaemon(host: string, port: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await canConnect(daemonConnectionHost(host), port)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Lima sandbox daemon did not become reachable on ${daemonConnectionHost(host)}:${port}`);
}

function createInstanceName(
	config: SandboxConfig,
	workspaceRoot: string,
	sessionId: string,
	daemonPort: number,
): string {
	const clean = (value: string): string =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "workspace";
	const hash = createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 12);
	return `${clean(config.limaInstanceNamePrefix)}-${clean(basename(resolve(workspaceRoot)))}-${hash}-${clean(sessionId).slice(0, 8).replace(/-+$/, "")}-p${daemonPort}-${randomBytes(4).toString("hex")}`;
}

function findWorkspaceMount(record: LimaListRecord, workspaceMountPath: string): LimaMount | undefined {
	return record.config?.mounts?.find((mount) => mount.mountPoint === workspaceMountPath);
}

function findDaemonForward(record: LimaListRecord, preferredPort?: number): LimaPortForward | undefined {
	const namePort = Number(record.name?.match(/-p(\d+)-[a-f0-9]+$/)?.[1]);
	const daemonPort = Number.isInteger(namePort) && namePort > 0 ? namePort : preferredPort;
	const forwards = record.config?.portForwards?.filter(
		(forward) => forward.guestPort === forward.hostPort && forward.hostPort !== undefined,
	);
	return (
		forwards?.find((forward) => forward.guestPort === daemonPort) ??
		(forwards?.length === 1 ? forwards[0] : undefined)
	);
}

function toSandboxContainer(record: LimaListRecord, workspaceMountPath: string): SandboxContainer {
	const mount = findWorkspaceMount(record, workspaceMountPath);
	const forward = findDaemonForward(record);
	const daemonEndpoint = forward?.hostPort
		? `ws://${urlHost(daemonConnectionHost(forward.hostIP || "127.0.0.1"))}:${forward.hostPort}${DAEMON_WEBSOCKET_PATH}`
		: undefined;
	return {
		id: record.name ?? "",
		name: record.name ?? "",
		image: `lima:${record.vmType ?? "vm"}/${record.arch ?? "unknown"}`,
		status: record.status ?? "",
		state: record.status?.toLowerCase(),
		createdAt: undefined,
		workspaceRoot: mount?.location ? resolve(mount.location) : undefined,
		workspaceMountPath: mount?.mountPoint,
		daemonPort: forward?.guestPort,
		daemonEndpoint,
		labels: { [`${SANDBOX_LABEL_PREFIX}.runtime`]: "lima", [`${SANDBOX_LABEL_PREFIX}.version`]: VERSION },
	};
}

function selectLimaSandbox(instances: SandboxContainer[], target: string | undefined): SandboxContainer | undefined {
	if (!target) return instances.length === 1 ? instances[0] : undefined;
	return instances.find((instance) => instance.name === target || instance.id.startsWith(target));
}
type LegacyLimaGuestStateOperation = "attach" | "stop";

export class LimaSandboxService {
	private readonly settingsManager: Pick<SettingsManager, "getSandboxSettings"> | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly runner: SandboxRunner;
	private readonly portAllocator: (host: string, preferredPort: number) => Promise<number>;
	private readonly readinessWaiter: (host: string, port: number) => Promise<void>;
	private readonly managedInstances: Map<string, ManagedLimaInstance>;

	constructor(options: LimaSandboxServiceOptions = {}) {
		this.settingsManager = options.settingsManager;
		this.env = options.env ?? process.env;
		this.runner = options.runner ?? new ProcessLimaRunner();
		this.portAllocator = options.portAllocator ?? allocateSandboxDaemonPort;
		this.readinessWaiter = options.readinessWaiter ?? waitForLimaDaemon;
		this.managedInstances = options.managedInstances ?? new Map();
	}

	resolveConfig(overrides: SandboxConfigOverrides = {}): SandboxConfig {
		return resolveSandboxConfig(this.settingsManager?.getSandboxSettings(), this.env, overrides);
	}

	private async listRecords(config: SandboxConfig, name?: string): Promise<LimaListRecord[]> {
		const args = ["list", "--json", ...(name ? [name] : [])];
		try {
			const result = await this.runner.run(config.limaBinary, args);
			if (
				name &&
				result.exitCode !== 0 &&
				/unmatched|not found|does not exist/i.test(`${result.stderr}\n${result.stdout}`)
			) {
				return [];
			}
			ensureLimaSuccessful(config.limaBinary, result, args);
			return parseLimaRecords(result.stdout);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(redactSecrets(`Lima is unavailable or not reachable via ${config.limaBinary}: ${message}`));
		}
	}

	/** Read-only validation: no VM creation, daemon restart, token rotation or ownership claim. */
	async inspectSharedInstance(options: SharedLimaInstanceOptions): Promise<SharedLimaInstanceInspection> {
		const config = this.resolveConfig();
		const { instanceName } = options;
		if (!/^[a-z0-9][a-z0-9-]*$/.test(instanceName)) throw new Error("Invalid shared Lima instance name");
		if (config.daemonHostBind !== "127.0.0.1" && config.daemonHostBind !== "::1") {
			throw new Error("Shared Lima daemon forward must bind to loopback");
		}
		const binding = await resolveSharedLimaWorkspace(options.hostParent, config.workspaceMountPath, options.hostRoot);
		const records = await this.listRecords(config, instanceName);
		if (records.length !== 1 || records[0]?.name !== instanceName) {
			throw new Error(`Shared Lima instance ${instanceName} does not exist by exact name`);
		}
		const record = records[0];
		if (record.status?.toLowerCase() !== "running") {
			throw new Error(`Shared Lima instance ${instanceName} is not running`);
		}
		const mounts = record.config?.mounts?.filter((mount) => mount.mountPoint === binding.guestParent) ?? [];
		if (mounts.length !== 1 || !mounts[0]?.writable || !mounts[0].location) {
			throw new Error(`Shared Lima instance ${instanceName} requires one writable fixed parent mount`);
		}
		if ((await realpath(mounts[0].location)) !== binding.hostParent) {
			throw new Error(`Shared Lima instance ${instanceName} mounts a different host parent`);
		}
		const forwards =
			record.config?.portForwards?.filter(
				(forward) => forward.guestPort === config.daemonPort || forward.hostPort === config.daemonPort,
			) ?? [];
		if (
			forwards.length !== 1 ||
			forwards[0]?.guestPort !== config.daemonPort ||
			forwards[0].hostPort !== config.daemonPort ||
			forwards[0].hostIP !== config.daemonHostBind
		) {
			throw new Error(`Shared Lima instance ${instanceName} requires one matching loopback daemon forward`);
		}
		return {
			...binding,
			instanceName,
			daemonUrl: `ws://${urlHost(config.daemonHostBind)}:${config.daemonPort}${DAEMON_WEBSOCKET_PATH}`,
		};
	}
	/** Reinspect and reuse the supervised guest daemon under the exclusive named-VM owner lock. */
	async ensureSharedDaemon(
		options: SharedLimaInstanceOptions,
		owner: SharedLimaOwnerLock,
		updated = false,
	): Promise<string> {
		if (owner.instanceName !== options.instanceName) throw new Error("Shared Lima owner lock names a different VM");
		await owner.assertHeld();
		await this.inspectSharedInstance(options);
		const config = this.resolveConfig();
		const local = this.env.GRIP_SANDBOX_GUEST_BINARY
			? await inspectLocalGuestBinary(this.env.GRIP_SANDBOX_GUEST_BINARY)
			: undefined;
		const versionArgs = [
			"shell",
			"--tty=false",
			options.instanceName,
			"sh",
			"-lc",
			local || updated ? '"$HOME/.local/bin/grip" --version' : "grip --version",
		];
		const version = await this.runner.run(config.limaBinary, versionArgs);
		if (version.exitCode !== 0 || version.stdout.trim() !== VERSION) {
			throw new Error("Shared Lima grip version mismatch or binary missing; install the matching version manually");
		}
		await owner.assertHeld();
		const directory = "$HOME/.cache/grip/shared-lima";
		// /proc start time plus boot ID distinguishes a recycled PID or a rebooted guest.
		// kill -0 also succeeds for zombies, which must never be reused as a live daemon.
		const processStartTime = `awk '{ sub(/^.*\\) /, ""); if ($1 == "Z" || $1 == "X") exit 1; print $20 }'`;
		const script = [
			"set -eu",
			"umask 077",
			`directory="${directory}"`,
			// Both current modes reserve the guest transition; a crashed reservation is operator-owned.
			'mkdir -p "$HOME/.cache/grip"',
			'mode_lock="$HOME/.cache/grip/daemon-mode.lock"',
			'mkdir "$mode_lock" || exit 28',
			"trap 'rmdir \"$mode_lock\" 2>/dev/null || true' EXIT",
			// A legacy per-session daemon may own this VM or its port. Do not start a second daemon.
			'for legacy_file in "$HOME/.cache/grip"/sandbox-daemon-*.pid "$HOME/.cache/grip"/sandbox-daemon-*.log; do',
			'  if test -e "$legacy_file" || test -L "$legacy_file"; then exit 27; fi',
			"done",
			// A transient user service must outlive the Lima SSH session. Do not mutate
			// private state unless the guest manager is running and linger was enabled by an operator.
			"command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null || exit 29",
			'test "$(loginctl show-user "$(id -un)" --property=Linger --value)" = yes || exit 29',
			`mkdir -p "$directory"; test ! -L "$directory"; chmod 700 "$directory"`,
			'rmdir "$mode_lock" || exit 28',
			"trap - EXIT",
			`token_file="$directory/daemon-${config.daemonPort}.token"`,
			`pid_file="$directory/daemon-${config.daemonPort}.pid"`,
			`identity_file="$directory/daemon-${config.daemonPort}.identity"`,
			`log_file="$directory/daemon-${config.daemonPort}.log"`,
			`start_lock="$directory/daemon-${config.daemonPort}.starting"`,
			`unit="grip-shared-lima-${config.daemonPort}.service"`,
			'test ! -L "$token_file"; test ! -L "$pid_file"; test ! -L "$identity_file"; test ! -L "$log_file"',
			'if test -e "$log_file"; then test -f "$log_file" && test "$(stat -c %a "$log_file")" = 600 || exit 22; fi',
			'test ! -e "$start_lock" && test ! -L "$start_lock" || exit 26',
			'if test -e "$token_file" || test -e "$pid_file" || test -e "$identity_file"; then',
			'  test -f "$token_file" && test -f "$pid_file" && test -f "$identity_file" || exit 21',
			'  test "$(stat -c %a "$token_file")" = 600 || exit 22',
			'  test "$(stat -c %a "$pid_file")" = 600 || exit 22',
			'  test "$(stat -c %a "$identity_file")" = 600 || exit 22',
			'  pid="$(cat "$pid_file")"',
			"  case \"$pid\" in ''|*[!0-9]*) exit 23;; esac",
			'  kill -0 "$pid" || exit 24',
			`  start_time="$(${processStartTime} "/proc/$pid/stat")" || exit 25`,
			'  boot_id="$(cat /proc/sys/kernel/random/boot_id)" || exit 25',
			'  test -n "$start_time" && test -n "$boot_id" && test "$(cat "$identity_file")" = "$boot_id:$start_time" || exit 25',
			'  test "$(systemctl --user show -P MainPID "$unit")" = "$pid" && systemctl --user is-active --quiet "$unit" || exit 25',
			'  token="$(cat "$token_file")"',
			"else",
			'  mkdir "$start_lock" || exit 26',
			"  trap 'rmdir \"$start_lock\" 2>/dev/null || true' EXIT",
			"  token=\"$(head -c 32 /dev/urandom | base64 | tr -d '\\n')\"",
			'  printf \'%s\' "$token" >"$token_file"',
			'  chmod 600 "$token_file"',
			// The systemd user manager owns the process. It reads the private token file
			// inside the unit, never from a systemd-run argument or environment property.
			local
				? '  grip_bin="$HOME/.local/bin/grip"; test -x "$grip_bin"'
				: '  grip_bin="$(command -v grip)"; case "$grip_bin" in /*) ;; *) exit 25;; esac',
			`  systemd-run --user --unit="$unit" --property=Restart=no --property=KillMode=control-group -- sh -c 'set -eu; umask 077; GRIP_DAEMON_TOKEN="$(cat "$HOME/.cache/grip/shared-lima/daemon-${config.daemonPort}.token")"; test -n "$GRIP_DAEMON_TOKEN"; export GRIP_DAEMON_TOKEN; exec "$1" --daemon --daemon-host 127.0.0.1 --daemon-allow-insecure-transport --daemon-port ${config.daemonPort} --daemon-cwd "$2" --daemon-shared-parent "$2" --daemon-allow-root --daemon-allow-process-exec >"$HOME/.cache/grip/shared-lima/daemon-${config.daemonPort}.log" 2>&1 </dev/null' sh "$grip_bin" ${shellQuote(config.workspaceMountPath)} >/dev/null`,
			'  pid=""; attempts=0',
			'  while test "$attempts" -lt 50; do',
			'    pid="$(systemctl --user show -P MainPID "$unit")" || exit 25',
			'    case "$pid" in ""|0) sleep 0.1;; *[!0-9]*) exit 25;; *) break;; esac',
			"    attempts=$((attempts + 1))",
			"  done",
			'  case "$pid" in ""|0|*[!0-9]*) exit 25;; esac',
			'  systemctl --user is-active --quiet "$unit" || exit 25',
			'  printf \'%s\' "$pid" >"$pid_file"',
			'  chmod 600 "$pid_file"',
			`  start_time="$(${processStartTime} "/proc/$pid/stat")" || exit 25`,
			'  boot_id="$(cat /proc/sys/kernel/random/boot_id)" || exit 25',
			'  test -n "$start_time" && test -n "$boot_id" || exit 25',
			'  printf \'%s:%s\' "$boot_id" "$start_time" >"$identity_file"',
			'  chmod 600 "$identity_file"',
			'  rmdir "$start_lock" || exit 26',
			"  trap - EXIT",
			"fi",
			"printf 'GRIP_SHARED_TOKEN=%s\\n' \"$token\"",
		].join("\n");
		const args = ["shell", "--tty=false", options.instanceName, "sh", "-lc", script];
		const result = await this.runner.run(config.limaBinary, args);
		// Never include stdout/stderr from a credential-bearing shell in an error.
		if (result.exitCode !== 0)
			throw new Error("Shared Lima daemon state is uncertain; reconcile guest PID/token files manually");
		const token = result.stdout.match(/(?:^|\n)GRIP_SHARED_TOKEN=([A-Za-z0-9+/]{43}=)(?:\r?\n|$)/)?.[1];
		if (!token) throw new Error("Shared Lima daemon did not return a valid credential; reconcile manually");
		await this.readinessWaiter(config.daemonHostBind, config.daemonPort);
		// Readiness can outlive the owner. Never hand a guest credential to a lost owner.
		await owner.assertHeld();
		return token;
	}

	/** Update only a verified supervised daemon. Staging happens before disconnecting peers. */
	private async updateSharedDaemon(options: SharedLimaInstanceOptions, owner: SharedLimaOwnerLock): Promise<void> {
		await owner.assertHeld();
		await this.inspectSharedInstance(options);
		const config = this.resolveConfig();
		const name = options.instanceName;
		const port = config.daemonPort;
		if (!this.env.GRIP_SANDBOX_GUEST_BINARY && process.argv[1]?.endsWith("/packages/coding-agent/src/cli.ts")) {
			throw new Error(
				"Development sandbox update requires GRIP_SANDBOX_GUEST_BINARY pointing to a built Linux Grip executable",
			);
		}
		const local = this.env.GRIP_SANDBOX_GUEST_BINARY
			? await inspectLocalGuestBinary(this.env.GRIP_SANDBOX_GUEST_BINARY)
			: undefined;
		const shell = (script: string) =>
			this.runner.run(config.limaBinary, ["shell", "--tty=false", name, "sh", "-lc", script]);
		const directory = "$HOME/.cache/grip/shared-lima";
		const unit = `grip-shared-lima-${port}.service`;
		const verify = [
			"set -eu",
			`directory="${directory}"`,
			`unit=${shellQuote(unit)}`,
			'test -d "$directory" && test ! -L "$directory"',
			'test ! -e "$HOME/.cache/grip/daemon-mode.lock" && test ! -L "$HOME/.cache/grip/daemon-mode.lock"',
			`token_file="$directory/daemon-${port}.token"`,
			`pid_file="$directory/daemon-${port}.pid"`,
			`identity_file="$directory/daemon-${port}.identity"`,
			'for file in "$token_file" "$pid_file" "$identity_file"; do test -f "$file" && test ! -L "$file" && test "$(stat -c %a "$file")" = 600; done',
			'pid="$(cat "$pid_file")"; case "$pid" in ""|0|*[!0-9]*) exit 45;; esac',
			'kill -0 "$pid"',
			`start_time="$(awk '{ sub(/^.*\\) /, ""); if ($1 == "Z" || $1 == "X") exit 1; print $20 }' "/proc/$pid/stat")"`,
			'boot_id="$(cat /proc/sys/kernel/random/boot_id)"',
			'test -n "$start_time" && test "$(cat "$identity_file")" = "$boot_id:$start_time"',
			'test "$(systemctl --user show -P MainPID "$unit")" = "$pid" && systemctl --user is-active --quiet "$unit"',
			'case "$(systemctl --user show -P ExecStart "$unit")" in *"$HOME/.local/bin/grip"*) ;; *) exit 46;; esac',
		];
		const preflight = await shell(verify.join("\n"));
		if (preflight.exitCode !== 0) {
			throw new Error(
				"Shared Lima daemon identity or binary path is uncertain; update refused without disconnecting clients",
			);
		}
		const staged = await stageSharedGuestBinary(this.runner, config.limaBinary, name, unit, VERSION, local);
		try {
			await owner.assertHeld();
			const stop = await shell(
				[
					...verify,
					'mkdir "$HOME/.cache/grip/daemon-mode.lock" || exit 45',
					'trap \u0027rmdir "$HOME/.cache/grip/daemon-mode.lock" 2>/dev/null || true\u0027 EXIT',
					'systemctl --user stop "$unit"',
					'test "$(systemctl --user show -P MainPID "$unit")" = 0',
					'! kill -0 "$pid" 2>/dev/null',
				].join("\n"),
			);
			if (stop.exitCode !== 0)
				throw new Error("Shared daemon stop is uncertain; inspect the guest before retrying update");
			await owner.assertHeld();
			await staged.install();
			await owner.assertHeld();
			const restart = await shell(
				[
					"set -eu",
					`directory="${directory}"`,
					`unit=${shellQuote(unit)}`,
					'test -d "$directory" && test ! -L "$directory"',
					`token_file="$directory/daemon-${port}.token"`,
					`pid_file="$directory/daemon-${port}.pid"`,
					`identity_file="$directory/daemon-${port}.identity"`,
					'for file in "$token_file" "$pid_file" "$identity_file"; do test -f "$file" && test ! -L "$file" && test "$(stat -c %a "$file")" = 600; done',
					'test ! -e "$HOME/.cache/grip/daemon-mode.lock" && test ! -L "$HOME/.cache/grip/daemon-mode.lock"',
					'mkdir "$HOME/.cache/grip/daemon-mode.lock" || exit 45',
					'trap \u0027rmdir "$HOME/.cache/grip/daemon-mode.lock" 2>/dev/null || true\u0027 EXIT',
					'old_pid="$(cat "$pid_file")"; case "$old_pid" in ""|0|*[!0-9]*) exit 45;; esac',
					'! kill -0 "$old_pid" 2>/dev/null',
					`test "$("$HOME/.local/bin/grip" --version)" = ${shellQuote(VERSION)}`,
					'load="$(systemctl --user show -P LoadState "$unit" 2>/dev/null || true)"',
					'case "$load" in',
					'  loaded) test "$(systemctl --user show -P MainPID "$unit")" = 0; systemctl --user start "$unit" ;;',
					'  not-found|"")',
					`    systemd-run --user --unit="$unit" --property=Restart=no --property=KillMode=control-group -- sh -c 'set -eu; umask 077; GRIP_DAEMON_TOKEN="$(cat "$HOME/.cache/grip/shared-lima/daemon-${port}.token")"; test -n "$GRIP_DAEMON_TOKEN"; export GRIP_DAEMON_TOKEN; exec "$1" --daemon --daemon-host 127.0.0.1 --daemon-allow-insecure-transport --daemon-port ${port} --daemon-cwd "$2" --daemon-shared-parent "$2" --daemon-allow-root --daemon-allow-process-exec >"$HOME/.cache/grip/shared-lima/daemon-${port}.log" 2>&1 </dev/null' sh "$HOME/.local/bin/grip" ${shellQuote(config.workspaceMountPath)} >/dev/null ;;`,
					"  *) exit 45 ;;",
					"esac",
					'pid=""; attempts=0',
					'while test "$attempts" -lt 50; do',
					'  pid="$(systemctl --user show -P MainPID "$unit")" || exit 45',
					'  case "$pid" in ""|0) sleep 0.1;; *[!0-9]*) exit 45;; *) break;; esac',
					"  attempts=$((attempts + 1))",
					"done",
					'case "$pid" in ""|0|*[!0-9]*) exit 45;; esac',
					'kill -0 "$pid"; systemctl --user is-active --quiet "$unit"',
					`start_time="$(awk '{ sub(/^.*\\) /, ""); if ($1 == "Z" || $1 == "X") exit 1; print $20 }' "/proc/$pid/stat")"`,
					'boot_id="$(cat /proc/sys/kernel/random/boot_id)"',
					'test -n "$start_time" && test -n "$boot_id"',
					'printf "%s" "$pid" >"$pid_file"',
					'printf "%s:%s" "$boot_id" "$start_time" >"$identity_file"',
					'chmod 600 "$pid_file" "$identity_file"',
				].join("\n"),
			);
			if (restart.exitCode !== 0)
				throw new Error("Shared daemon restart is uncertain; inspect the guest before retrying update");
			await this.readinessWaiter(config.daemonHostBind, port);
			await owner.assertHeld();
		} finally {
			await staged.cleanup();
		}
	}

	private async startInstance(
		config: SandboxConfig,
		workspaceRoot: string,
		name: string,
		daemonPort: number,
	): Promise<void> {
		const mountExpression = `.mounts = [{"location":${JSON.stringify(workspaceRoot)},"mountPoint":${JSON.stringify(config.workspaceMountPath)},"writable":true}]`;
		const forwardExpression = `.portForwards += [{"guestPort":${daemonPort},"hostPort":${daemonPort},"hostIP":${JSON.stringify(config.daemonHostBind)}}]`;
		const args = [
			"start",
			"--tty=false",
			"--name",
			name,
			"--mount-none",
			"--set",
			mountExpression,
			"--set",
			forwardExpression,
			config.limaTemplate,
		];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	private async ensureGrip(
		config: SandboxConfig,
		name: string,
		managed: boolean,
		local?: LocalGuestBinary,
	): Promise<void> {
		if (local) {
			await installLocalGuestBinary(this.runner, config.limaBinary, name, local, VERSION);
			return;
		}
		const checkArgs = [
			"shell",
			"--tty=false",
			name,
			"sh",
			"-lc",
			'command -v grip >/dev/null || test -x "$HOME/.local/bin/grip"',
		];
		const check = await this.runner.run(config.limaBinary, checkArgs);
		if (check.exitCode === 0) return;
		if (!managed) {
			throw new Error(
				`Lima instance ${name} does not provide grip; install the matching Linux release in the VM first`,
			);
		}
		const script = `set -eu; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT; curl -fsSL -o "$tmp" https://raw.githubusercontent.com/greppleai/grip/main/install.sh; GRIP_VERSION=${shellQuote(`v${VERSION}`)} sh "$tmp"; test -x "$HOME/.local/bin/grip"`;
		const args = ["shell", "--tty=false", name, "sh", "-lc", script];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}
	/** A legacy named attach or stop must not rotate or kill a shared guest daemon. */
	private async assertNoSharedGuestState(
		config: SandboxConfig,
		name: string,
		operation: LegacyLimaGuestStateOperation = "attach",
	): Promise<void> {
		const script = 'test ! -e "$HOME/.cache/grip/shared-lima" && test ! -L "$HOME/.cache/grip/shared-lima"';
		const args = ["shell", "--tty=false", name, "sh", "-lc", script];
		const result = await this.runner.run(config.limaBinary, args);
		// A guest shell failure is ambiguous too; never guess that shared state is absent.
		if (result.exitCode !== 0) {
			throw new Error(`Lima named VM may host a shared daemon; legacy ${operation} refused; reconcile manually`);
		}
	}

	private async startDaemon(config: SandboxConfig, name: string): Promise<string> {
		const pidFile = `.cache/grip/sandbox-daemon-${config.daemonPort}.pid`;
		const logFile = `.cache/grip/sandbox-daemon-${config.daemonPort}.log`;
		const script = [
			"set -eu",
			"umask 077",
			`mkdir -p "$HOME/.cache/grip"`,
			'mode_lock="$HOME/.cache/grip/daemon-mode.lock"',
			'mkdir "$mode_lock" || exit 28',
			"trap 'rmdir \"$mode_lock\" 2>/dev/null || true' EXIT",
			'test ! -e "$HOME/.cache/grip/shared-lima" && test ! -L "$HOME/.cache/grip/shared-lima" || exit 29',
			`if test -f "$HOME/${pidFile}"; then old_pid="$(cat "$HOME/${pidFile}")"; kill "$old_pid" 2>/dev/null || true; fi`,
			`token="$(head -c 32 /dev/urandom | base64 | tr -d '\\n')"`,
			`nohup env GRIP_DAEMON_TOKEN="$token" "${this.env.GRIP_SANDBOX_GUEST_BINARY ? "$HOME/.local/bin/grip" : '$(command -v grip || printf %s "$HOME/.local/bin/grip")'}" --daemon --daemon-host 127.0.0.1 --daemon-allow-insecure-transport --daemon-port ${config.daemonPort} --daemon-cwd ${shellQuote(config.workspaceMountPath)} --daemon-allow-root --daemon-allow-process-exec >"$HOME/${logFile}" 2>&1 </dev/null &`,
			`echo $! >"$HOME/${pidFile}"`,
			'rmdir "$mode_lock" || exit 28',
			"trap - EXIT",
			`printf 'GRIP_SANDBOX_TOKEN=%s\\n' "$token"`,
		].join("\n");
		const args = ["shell", "--tty=false", "--workdir", config.workspaceMountPath, name, "sh", "-lc", script];
		const result = await this.runner.run(config.limaBinary, args);
		ensureLimaSuccessful(config.limaBinary, result, args);
		const token = result.stdout.match(/(?:^|\n)GRIP_SANDBOX_TOKEN=([^\r\n]+)/)?.[1];
		if (!token) throw new Error(`Lima instance ${name} started the daemon without returning an authentication token`);
		return token;
	}

	private async prepareExistingInstance(
		config: SandboxConfig,
		record: LimaListRecord,
		name: string,
		workspaceRoot: string,
	): Promise<void> {
		const mount = findWorkspaceMount(record, config.workspaceMountPath);
		if (!mount || resolve(mount.location ?? "") !== workspaceRoot || !mount.writable) {
			throw new Error(
				`Lima instance ${name} must mount ${workspaceRoot} read-write at ${config.workspaceMountPath}`,
			);
		}
		const status = record.status?.toLowerCase();
		if (status === "running") return;
		if (status !== "stopped") {
			throw new Error(`Lima instance ${name} is in an uncertain state; refusing to resume`);
		}
		const args = ["start", "--tty=false", name];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	private async findExactLegacyInstance(config: SandboxConfig, name?: string): Promise<LimaListRecord | undefined> {
		if (!name) return undefined;
		const records = await this.listRecords(config, name);
		if (records.length === 0) return undefined;
		if (records.length !== 1 || records[0]?.name !== name) {
			throw new Error("Lima instance lookup did not return one exact name; refusing to attach or create");
		}
		return records[0];
	}

	async start(options: SandboxStartOptions): Promise<SandboxStartResult> {
		const requestedName = options.name?.trim();
		if (!requestedName) {
			if (options.update) throw new Error("Sandbox update requires a named running shared VM");
			return this.startWithLegacyInstance(options);
		}
		// Coordinate VM resume/create as well as guest daemon launch with a named shared owner.
		// A stale lock is ambiguous, not permission to start an existing VM.
		const owner = await acquireSharedLimaOwnerLock(requestedName);
		try {
			const config = this.resolveConfig(options);
			const existing = await this.findExactLegacyInstance(config, requestedName);
			if (options.update && existing?.status?.toLowerCase() !== "running") {
				throw new Error("Sandbox update requires an existing running shared VM");
			}
			if (existing?.status?.toLowerCase() !== "running") {
				return await this.startWithLegacyInstance(options, { record: existing });
			}
			// Select the guest mode before any legacy setup. An unreadable or ambiguous
			// marker is not permission to start a per-session daemon in this VM.
			const probe = await this.runner.run(config.limaBinary, [
				"shell",
				"--tty=false",
				requestedName,
				"sh",
				"-lc",
				'if test -e "$HOME/.cache/grip/shared-lima" || test -L "$HOME/.cache/grip/shared-lima"; then if test -d "$HOME/.cache/grip/shared-lima" && test ! -L "$HOME/.cache/grip/shared-lima"; then printf "GRIP_SHARED_GUEST\\n"; else exit 42; fi; else printf "GRIP_LEGACY_GUEST\\n"; fi',
			]);
			if (probe.exitCode !== 0) throw new Error("Lima guest daemon mode is uncertain; refusing named attach");
			if (probe.stdout.trim() === "GRIP_LEGACY_GUEST") {
				if (options.update)
					throw new Error("Sandbox update requires a supervised shared guest; legacy guest is unchanged");
				return await this.startWithLegacyInstance(options, { record: existing });
			}
			if (probe.stdout.trim() !== "GRIP_SHARED_GUEST") {
				throw new Error("Lima guest daemon mode is uncertain; refusing named attach");
			}
			await owner.assertHeld();
			const mount = findWorkspaceMount(existing, config.workspaceMountPath);
			if (!mount?.location) throw new Error("Shared Lima instance mount is unavailable; refusing attach");
			const sharedOptions = {
				instanceName: requestedName,
				hostParent: resolve(mount.location),
				hostRoot: resolve(options.workspaceRoot),
			};
			const inspection = await this.inspectSharedInstance(sharedOptions);
			if (options.update) await this.updateSharedDaemon(sharedOptions, owner);
			const token = await this.ensureSharedDaemon(sharedOptions, owner, options.update);
			const daemonUrl = `grip+${inspection.daemonUrl}?root=${encodeURIComponent(inspection.guestRoot)}`;
			return {
				containerId: requestedName,
				containerName: requestedName,
				workspaceRoot: inspection.hostRoot,
				workspaceMountPath: inspection.guestRoot,
				daemonUrl,
				daemonUrlRedacted: inspection.daemonUrl,
				token,
				labels: { [`${SANDBOX_LABEL_PREFIX}.runtime`]: "lima", [`${SANDBOX_LABEL_PREFIX}.version`]: VERSION },
			};
		} finally {
			await owner.release();
		}
	}

	private async startWithLegacyInstance(
		options: SandboxStartOptions,
		known?: KnownLimaRecord,
	): Promise<SandboxStartResult> {
		const workspaceRoot = resolve(options.workspaceRoot);
		const local = this.env.GRIP_SANDBOX_GUEST_BINARY
			? await inspectLocalGuestBinary(this.env.GRIP_SANDBOX_GUEST_BINARY)
			: undefined;
		const config = this.resolveConfig(options);
		const requestedName = options.name?.trim();
		const managed = !requestedName;
		const existing = known ? known.record : await this.findExactLegacyInstance(config, requestedName);
		if (existing) await this.prepareExistingInstance(config, existing, requestedName!, workspaceRoot);
		const configuredForward = existing ? findDaemonForward(existing, config.daemonPort) : undefined;
		if (configuredForward && configuredForward.guestPort !== configuredForward.hostPort) {
			throw new Error(
				`Lima instance ${requestedName} must forward the sandbox daemon on the same guest and host port`,
			);
		}
		const daemonPort =
			configuredForward?.hostPort ?? (await this.portAllocator(config.daemonHostBind, config.daemonPort));
		const name =
			requestedName ?? createInstanceName(config, workspaceRoot, options.sessionId ?? "session", daemonPort);
		const effectiveConfig = { ...config, daemonPort };
		if (!existing) await this.startInstance(effectiveConfig, workspaceRoot, name, daemonPort);
		// A failed guest install/start can have changed state; never delete an uncertain VM.
		if (existing) await this.assertNoSharedGuestState(effectiveConfig, name);
		await this.ensureGrip(effectiveConfig, name, !existing, local);
		const token = await this.startDaemon(effectiveConfig, name);
		await this.readinessWaiter(config.daemonHostBind, daemonPort);
		// A failed readiness check is not proof that this daemon is ours to stop.
		// Leave uncertain guest state for explicit operator reconciliation.
		this.managedInstances.set(name, { workspaceRoot, daemonPort, ownerId: options.sessionId, managed });
		const daemonUrl = `ws://${urlHost(daemonConnectionHost(config.daemonHostBind))}:${daemonPort}${DAEMON_WEBSOCKET_PATH}`;
		return {
			containerId: name,
			containerName: name,
			workspaceRoot,
			workspaceMountPath: config.workspaceMountPath,
			daemonUrl,
			daemonUrlRedacted: daemonUrl,
			token,
			labels: { [`${SANDBOX_LABEL_PREFIX}.runtime`]: "lima", [`${SANDBOX_LABEL_PREFIX}.version`]: VERSION },
		};
	}

	async list(options: SandboxListOptions): Promise<SandboxContainer[]> {
		const config = this.resolveConfig();
		const workspaceRoot = resolve(options.workspaceRoot);
		return (await this.listRecords(config))
			.map((record) => toSandboxContainer(record, config.workspaceMountPath))
			.filter(
				(instance) => instance.workspaceRoot && (options.allWorkspaces || instance.workspaceRoot === workspaceRoot),
			);
	}

	private async stopDaemon(config: SandboxConfig, name: string, daemonPort: number): Promise<void> {
		const pidFile = `.cache/grip/sandbox-daemon-${daemonPort}.pid`;
		const script = `if test -f "$HOME/${pidFile}"; then pid="$(cat "$HOME/${pidFile}")"; kill "$pid" 2>/dev/null || true; rm -f "$HOME/${pidFile}"; fi`;
		const args = ["shell", "--tty=false", name, "sh", "-lc", script];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	async stop(options: SandboxStopOptions): Promise<SandboxStopResult> {
		const config = this.resolveConfig();
		const instances = await this.list({ workspaceRoot: options.workspaceRoot });
		const selected = selectLimaSandbox(instances, options.target ?? options.currentContainerId);
		if (!selected) return { status: "not-found", message: "No matching Grip Lima sandbox found" };
		if (instances.filter((instance) => instance.name === selected.name).length !== 1) {
			throw new Error("Lima sandbox identity is ambiguous; refusing to stop a VM or daemon");
		}
		const tracked = this.managedInstances.get(selected.name);
		// Names and Lima's list output do not establish ownership. In particular, a
		// shared named VM can have the ordinary sandbox prefix without being ours.
		// Only a VM started by this session may be stopped or have its daemon touched.
		if (!tracked || tracked.workspaceRoot !== selected.workspaceRoot || tracked.daemonPort !== selected.daemonPort) {
			throw new Error(
				"Lima sandbox ownership is unknown or daemon port changed; refusing to stop an untracked VM or daemon",
			);
		}
		// A shared guest must never lose its daemon or VM to a legacy
		// in-process record. Resolve the selected VM again under the host owner lock.
		const owner = await acquireSharedLimaOwnerLock(selected.name);
		try {
			const matches = (await this.list({ workspaceRoot: options.workspaceRoot })).filter(
				(instance) => instance.name === selected.name,
			);
			const current = matches[0];
			if (
				matches.length !== 1 ||
				!current ||
				current.id !== selected.id ||
				current.state !== selected.state ||
				current.workspaceRoot !== selected.workspaceRoot ||
				current.daemonPort !== selected.daemonPort
			) {
				throw new Error("Lima sandbox identity changed during stop; refusing to touch the VM or daemon");
			}
			return await this.stopTrackedInstance(config, current, tracked);
		} finally {
			await owner.release();
		}
	}

	private async stopTrackedInstance(
		config: SandboxConfig,
		selected: SandboxContainer,
		tracked: ManagedLimaInstance,
	): Promise<SandboxStopResult> {
		const ownsInstance = tracked.managed;
		if (selected.state !== "running") {
			if (ownsInstance && config.cleanup === "remove") {
				// An already stopped VM cannot be probed without resuming it. Its
				// in-memory record is not proof it was never repurposed externally.
				throw new Error("Lima sandbox is stopped; refusing to delete an unverifiable VM; reconcile manually");
			}
			this.managedInstances.delete(selected.name);
			return { status: "already-stopped", container: selected };
		}
		await this.assertNoSharedGuestState(config, selected.name, "stop");
		await this.stopDaemon(config, selected.name, tracked?.daemonPort ?? selected.daemonPort ?? config.daemonPort);
		if (ownsInstance) {
			const args = config.cleanup === "remove" ? ["delete", "--force", selected.name] : ["stop", selected.name];
			ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
		}
		this.managedInstances.delete(selected.name);
		return { status: ownsInstance && config.cleanup === "remove" ? "removed" : "stopped", container: selected };
	}

	async stopManagedInstances(): Promise<void> {
		const failures: unknown[] = [];
		for (const [name, instance] of [...this.managedInstances]) {
			try {
				await this.stop({ workspaceRoot: instance.workspaceRoot, target: name, currentContainerId: name });
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Failed to stop managed Lima sandbox instances");
	}
}
