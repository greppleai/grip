import { randomBytes } from "node:crypto";
import type { SandboxRunner } from "./config.ts";
import type { LocalGuestBinary } from "./lima-guest-binary.ts";

function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface StagedSharedGuestBinary {
	install(): Promise<void>;
	cleanup(): Promise<void>;
}

export async function stageSharedGuestBinary(
	runner: SandboxRunner,
	limaBinary: string,
	name: string,
	unit: string,
	version: string,
	local?: LocalGuestBinary,
): Promise<StagedSharedGuestBinary> {
	const directory = `/tmp/grip-update-${randomBytes(12).toString("hex")}`;
	const shell = (script: string) => runner.run(limaBinary, ["shell", "--tty=false", name, "sh", "-lc", script]);
	const created = await shell(`set -eu; umask 077; mkdir ${quote(directory)}; test ! -L ${quote(directory)}`);
	if (created.exitCode !== 0) throw new Error("Could not create a private guest update staging directory");
	const cleanup = async () => {
		await shell(
			`test -d ${quote(directory)} && test ! -L ${quote(directory)} && rm -f ${quote(`${directory}/grip`)} ${quote(`${directory}/grip.sha256`)} && rmdir ${quote(directory)}`,
		).catch(() => undefined);
	};
	try {
		if (local) {
			const copied = await runner.run(limaBinary, ["copy", local.path, `${name}:${directory}/grip`]);
			if (copied.exitCode !== 0) throw new Error("Local guest binary copy failed before disconnecting clients");
		} else {
			const download = await shell(
				[
					"set -eu",
					`stage=${quote(directory)}`,
					'case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) exit 40;; esac',
					`url=https://github.com/greppleai/grip/releases/download/${quote(`v${version}`)}/grip-linux-$arch`,
					'curl -fLsS --retry 2 "$url" -o "$stage/grip"',
					'curl -fLsS --retry 2 "$url.sha256" -o "$stage/grip.sha256"',
					'expected="$(awk -v asset="grip-linux-$arch" \'$2 == asset || $2 == "*" asset {print $1}\' "$stage/grip.sha256")"',
					'case "$expected" in ""|*[!0-9a-fA-F]*) exit 41;; esac',
					'test "$(printf %s "$expected" | wc -c)" -eq 64',
					'actual="$(sha256sum "$stage/grip" | cut -d " " -f 1)"',
					'test "$actual" = "$expected"',
				].join("\n"),
			);
			if (download.exitCode !== 0)
				throw new Error("Pinned Grip release download or checksum verification failed; clients remain connected");
		}
		const validated = await shell(
			[
				"set -eu",
				`stage=${quote(directory)}`,
				'test "$(uname -s)" = Linux',
				...(local
					? [
							`test "$(uname -m)" = ${quote(local.arch)}`,
							`test "$(sha256sum "$stage/grip" | cut -d " " -f 1)" = ${quote(local.sha256)}`,
						]
					: []),
				'test -f "$stage/grip" && test ! -L "$stage/grip"',
				'chmod 700 "$stage/grip"',
				`test "$("$stage/grip" --version)" = ${quote(version)}`,
				'printf "GRIP_STAGE_SHA256=%s\\n" "$(sha256sum "$stage/grip" | cut -d " " -f 1)"',
			].join("\n"),
		);
		if (validated.exitCode !== 0)
			throw new Error("Staged Grip binary is incompatible or has the wrong version; clients remain connected");
		const digest = validated.stdout.match(/(?:^|\n)GRIP_STAGE_SHA256=([a-f0-9]{64})(?:\r?\n|$)/)?.[1];
		if (!digest || (local && digest !== local.sha256)) {
			throw new Error("Staged Grip binary digest is unavailable or changed; clients remain connected");
		}
		return {
			cleanup,
			install: async () => {
				const result = await shell(
					[
						"set -eu",
						"umask 077",
						`stage=${quote(directory)}`,
						`unit=${quote(unit)}`,
						'test "$(systemctl --user show -P MainPID "$unit")" = 0',
						'! systemctl --user is-active --quiet "$unit"',
						'mkdir "$HOME/.cache/grip/daemon-mode.lock" || exit 45',
						'trap \u0027rmdir "$HOME/.cache/grip/daemon-mode.lock" 2>/dev/null || true\u0027 EXIT',
						"for process in /proc/[0-9]*; do",
						'  test -d "$process" || continue',
						'  comm="$(cat "$process/comm" 2>/dev/null)" || { test ! -e "$process" || exit 45; continue; }',
						'  if test "$comm" = grip; then exit 45; fi',
						'  case "$comm" in node|bun) ;; *) continue;; esac',
						'  cmdline="$(tr "\\000" " " <"$process/cmdline" 2>/dev/null)" || { test ! -e "$process" || exit 45; continue; }',
						'  case "$cmdline" in *"/grip --daemon"*|*"/grip/dist/cli"*) exit 45;; esac',
						"done",
						'test -f "$stage/grip" && test ! -L "$stage/grip"',
						`test "$(sha256sum "$stage/grip" | cut -d " " -f 1)" = ${quote(digest)}`,
						'test ! -L "$HOME/.local" && test ! -L "$HOME/.local/bin"',
						'target="$HOME/.local/bin/grip"',
						'test ! -L "$target" && { test ! -e "$target" || test -f "$target"; }',
						'tmp="$HOME/.local/bin/.grip-update-$(basename "$stage")"',
						'test ! -e "$tmp" && test ! -L "$tmp"',
						'cp "$stage/grip" "$tmp"; chmod 700 "$tmp"',
						`test "$(sha256sum "$tmp" | cut -d " " -f 1)" = ${quote(digest)}`,
						`test "$("$tmp" --version)" = ${quote(version)}`,
						'mv -f "$tmp" "$target"',
					].join("\n"),
				);
				if (result.exitCode !== 0)
					throw new Error("Guest Grip binary install failed; daemon remains stopped for inspection");
			},
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
