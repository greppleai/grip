import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SandboxRunner } from "./config.ts";

function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface LocalGuestBinary {
	path: string;
	arch: string;
	sha256: string;
}

/** Refuse macOS executables in Linux VMs, even when the host CPU architecture matches. */
export async function inspectLocalGuestBinary(path: string): Promise<LocalGuestBinary> {
	const absolute = await realpath(resolve(path));
	const file = await stat(absolute);
	if (!file.isFile()) throw new Error("GRIP_SANDBOX_GUEST_BINARY must be a regular file");
	const handle = await open(absolute, "r");
	let header: Buffer;
	try {
		header = Buffer.alloc(20);
		if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20) throw new Error("Invalid Linux guest binary");
	} finally {
		await handle.close();
	}
	if (header.toString("hex", 0, 4) !== "7f454c46" || header[4] !== 2 || header[5] !== 1) {
		throw new Error("GRIP_SANDBOX_GUEST_BINARY must be a 64-bit Linux ELF executable");
	}
	const arch = { 62: "x86_64", 183: "aarch64" }[header.readUInt16LE(18)];
	if (!arch) throw new Error("Unsupported Linux guest binary architecture");
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(absolute)) digest.update(chunk);
	// Reject a file changed during validation rather than copying bytes with an unverified digest.
	const after = await stat(absolute);
	if (file.dev !== after.dev || file.ino !== after.ino || file.size !== after.size || file.mtimeMs !== after.mtimeMs) {
		throw new Error("Local guest binary changed during validation; rebuild and retry");
	}
	return { path: absolute, arch, sha256: digest.digest("hex") };
}

const noDaemon = (removeStalePid: boolean) =>
	[
		"test -r /proc/1/comm || exit 40",
		"for process in /proc/[0-9]*; do",
		'  test -d "$process" || continue',
		'  comm="$(cat "$process/comm" 2>/dev/null)" || { test ! -e "$process" || exit 40; continue; }',
		'  if test "$comm" = grip; then exit 41; fi',
		'  case "$comm" in node|bun) ;; *) continue;; esac',
		'  cmdline="$(tr "\\000" " " <"$process/cmdline" 2>/dev/null)" || { test ! -e "$process" || exit 40; continue; }',
		'  case "$cmdline" in *"/grip --daemon"*|*"/grip/dist/cli"*) exit 41;; esac',
		"done",
		'test ! -e "$HOME/.cache/grip/shared-lima" && test ! -L "$HOME/.cache/grip/shared-lima" || exit 42',
		'for marker in "$HOME/.cache/grip"/sandbox-daemon-*.pid; do',
		'  if test -e "$marker" || test -L "$marker"; then',
		'    test -f "$marker" && test ! -L "$marker" && test "$(stat -c %u "$marker")" = "$(id -u)" || exit 42',
		'    pid="$(cat "$marker")" || exit 42',
		'    case "$pid" in ""|0|*[!0-9]*) exit 42;; esac',
		'    test ! -e "/proc/$pid" || exit 42',
		"  fi",
		"done",
		...(removeStalePid
			? [
					'for marker in "$HOME/.cache/grip"/sandbox-daemon-*.pid; do',
					'  if test -e "$marker" || test -L "$marker"; then',
					'    test -f "$marker" && test ! -L "$marker" && test "$(stat -c %u "$marker")" = "$(id -u)" || exit 42',
					'    pid="$(cat "$marker")" || exit 42',
					'    case "$pid" in ""|0|*[!0-9]*) exit 42;; esac',
					'    test ! -e "/proc/$pid" || exit 42',
					'    rm -- "$marker" || exit 42',
					"  fi",
					"done",
				]
			: []),
	].join("\n");

/** Called only for explicitly requested local-development installs. No remote download or sudo. */
export async function installLocalGuestBinary(
	runner: SandboxRunner,
	limaBinary: string,
	name: string,
	local: LocalGuestBinary,
	version: string,
	assertOwner: () => Promise<void> = async () => {},
): Promise<void> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Invalid Lima instance name for local binary copy");
	const shell = async (script: string) => runner.run(limaBinary, ["shell", "--tty=false", name, "sh", "-lc", script]);
	await assertOwner();
	const probe = await shell(
		[
			"set -eu",
			'test "$(uname -s)" = Linux',
			`test "$(uname -m)" = ${quote(local.arch)}`,
			'target="$HOME/.local/bin/grip"',
			'if test ! -L "$HOME/.local" && test ! -L "$HOME/.local/bin" && test -f "$target" && test ! -L "$target"; then',
			`  if test "$(sha256sum "$target" | cut -d ' ' -f 1)" = ${quote(local.sha256)} && test "$("$target" --version)" = ${quote(version)}; then`,
			"    printf 'GRIP_GUEST_BINARY_MATCH\\n'",
			"    exit 0",
			"  fi",
			"fi",
			noDaemon(false),
		].join("\n"),
	);
	if (probe.exitCode !== 0)
		throw new Error(
			"Lima guest architecture or Grip daemon state is incompatible/uncertain; local binary was not copied",
		);
	if (probe.stdout.trim() === "GRIP_GUEST_BINARY_MATCH") {
		await assertOwner();
		return;
	}
	const stage = `/tmp/grip-guest-${randomBytes(12).toString("hex")}`;
	const created = await shell(`set -eu; umask 077; mkdir ${quote(stage)}; test ! -L ${quote(stage)}`);
	if (created.exitCode !== 0) throw new Error("Could not reserve a private guest binary staging directory");
	try {
		await assertOwner();
		const copied = await runner.run(limaBinary, ["copy", local.path, `${name}:${stage}/grip`]);
		if (copied.exitCode !== 0) throw new Error("Lima guest binary copy failed; installed binary was not changed");
		await assertOwner();
		const script = [
			"set -eu",
			"umask 077",
			`stage=${quote(stage)}`,
			'test -f "$stage/grip" && test ! -L "$stage/grip"',
			`test "$(sha256sum "$stage/grip" | cut -d ' ' -f 1)" = ${quote(local.sha256)}`,
			'chmod 700 "$stage/grip"',
			`test "$("$stage/grip" --version)" = ${quote(version)}`,
			'mkdir -p "$HOME/.cache/grip"',
			'mode_lock="$HOME/.cache/grip/daemon-mode.lock"',
			'mkdir "$mode_lock" || exit 43',
			"trap 'rmdir \"$mode_lock\" 2>/dev/null || true' EXIT",
			noDaemon(true),
			'mkdir -p "$HOME/.local/bin"',
			'test ! -L "$HOME/.local" && test ! -L "$HOME/.local/bin"',
			'target="$HOME/.local/bin/grip"',
			'test ! -L "$target" && { test ! -e "$target" || test -f "$target"; }',
			'tmp="$HOME/.local/bin/.grip-install-$(basename "$stage")"',
			'test ! -e "$tmp" && test ! -L "$tmp"',
			'cp "$stage/grip" "$tmp"; chmod 700 "$tmp"',
			`test "$(sha256sum "$tmp" | cut -d ' ' -f 1)" = ${quote(local.sha256)}`,
			'mv -f "$tmp" "$target"',
		].join("\n");
		const installed = await shell(script);
		if (installed.exitCode !== 0)
			throw new Error("Lima guest binary install failed or is uncertain; inspect guest state before retrying");
	} finally {
		// Never remove an uncertain target; the private staging directory is the only cleanup target.
		await shell(`test -d ${quote(stage)} && rm -f ${quote(`${stage}/grip`)} && rmdir ${quote(stage)}`).catch(
			() => undefined,
		);
	}
}
