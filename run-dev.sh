#!/usr/bin/env bash
# Run the checkout's Grip CLI with an explicit, locally built Linux guest binary.
# This script does not start a sandbox or alter a VM. Use /sandbox start inside Grip.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
build_guest=false
print_env=false
while (($#)); do
  case "$1" in
    --help)
      printf '%s\n' \
        'Usage: ./run-dev.sh [--build-guest] [--print-env] [--] [grip arguments...]' \
        'Runs checkout source via grip-test.sh with Lima sandbox variables exported.' \
        'Uses packages/coding-agent/binaries/grip-linux-{x64,arm64} by default.' \
        'Build first with --build-guest, or set GRIP_SANDBOX_GUEST_BINARY to an existing Linux ELF.' \
        'Set GRIP_SANDBOX_GUEST_ARCH=x64|arm64 if the guest architecture differs from the host.' \
        '--build-guest builds into a private temporary directory and removes it when Grip exits.' \
        '--print-env prints sandbox settings without launching Grip or Lima.' \
        'Pass -- before Grip arguments that overlap these script flags.'
      exit 0
      ;;
    --build-guest) build_guest=true; shift ;;
    --print-env) print_env=true; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

export GRIP_SANDBOX_RUNTIME="${GRIP_SANDBOX_RUNTIME:-lima}"
if [[ "$GRIP_SANDBOX_RUNTIME" != lima ]]; then
  printf 'run-dev.sh: only Lima supports a host-supplied guest binary; use ./grip-test.sh for Docker.\n' >&2
  exit 1
fi
export GRIP_SANDBOX_LIMA="${GRIP_SANDBOX_LIMA:-limactl}"
export GRIP_SANDBOX_LIMA_TEMPLATE="${GRIP_SANDBOX_LIMA_TEMPLATE:-template:docker-rootful}"
export GRIP_SANDBOX_LIMA_INSTANCE_PREFIX="${GRIP_SANDBOX_LIMA_INSTANCE_PREFIX:-grip-sandbox-dev}"
export GRIP_SANDBOX_WORKSPACE_MOUNT="${GRIP_SANDBOX_WORKSPACE_MOUNT:-/workspace}"
export GRIP_SANDBOX_DAEMON_PORT="${GRIP_SANDBOX_DAEMON_PORT:-8787}"
export GRIP_SANDBOX_DAEMON_HOST_BIND="${GRIP_SANDBOX_DAEMON_HOST_BIND:-127.0.0.1}"
export GRIP_SANDBOX_CLEANUP="${GRIP_SANDBOX_CLEANUP:-stop}"

if [[ -n "${GRIP_SANDBOX_GUEST_ARCH:-}" ]]; then
  guest_arch="$GRIP_SANDBOX_GUEST_ARCH"
else
  case "$(uname -m)" in
    x86_64|amd64) guest_arch=x64 ;;
    arm64|aarch64) guest_arch=arm64 ;;
    *) printf 'run-dev.sh: unknown host architecture; set GRIP_SANDBOX_GUEST_ARCH=x64 or arm64.\n' >&2; exit 1 ;;
  esac
fi
case "$guest_arch" in
  x64|arm64) ;;
  *) printf 'run-dev.sh: unsupported GRIP_SANDBOX_GUEST_ARCH: %s\n' "$guest_arch" >&2; exit 1 ;;
esac

build_dir=""
if [[ "$build_guest" == true ]]; then
  if [[ -n "${GRIP_SANDBOX_GUEST_BINARY:-}" ]]; then
    printf 'run-dev.sh: --build-guest conflicts with GRIP_SANDBOX_GUEST_BINARY; choose one.\n' >&2
    exit 1
  fi
  if [[ "$print_env" == true ]]; then
    printf 'run-dev.sh: --build-guest cannot be combined with --print-env.\n' >&2
    exit 1
  fi
  command -v bun >/dev/null 2>&1 || { printf 'run-dev.sh: Bun is required to build the guest executable.\n' >&2; exit 1; }
  build_dir="$(mktemp -d "${TMPDIR:-/tmp}/grip-guest-dev.XXXXXXXX")"
  # build-binaries.sh replaces its output directory; keep that beneath our private parent.
  trap 'rm -rf -- "$build_dir"' EXIT
  case " ${NODE_OPTIONS:-} " in
    *--import=tsx*)
      "$repo_root/scripts/build-binaries.sh" --skip-install --platform "linux-$guest_arch" --out "$build_dir/release" ;;
    *)
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=tsx" \
        "$repo_root/scripts/build-binaries.sh" --skip-install --platform "linux-$guest_arch" --out "$build_dir/release" ;;
  esac
  export GRIP_SANDBOX_GUEST_BINARY="$build_dir/release/grip-linux-$guest_arch"
else
  export GRIP_SANDBOX_GUEST_BINARY="${GRIP_SANDBOX_GUEST_BINARY:-$repo_root/packages/coding-agent/binaries/grip-linux-$guest_arch}"
fi

if [[ ! -f "$GRIP_SANDBOX_GUEST_BINARY" || ! -r "$GRIP_SANDBOX_GUEST_BINARY" || ! -x "$GRIP_SANDBOX_GUEST_BINARY" ]]; then
  printf 'run-dev.sh: missing/unreadable Linux guest binary: %s\n' "$GRIP_SANDBOX_GUEST_BINARY" >&2
  printf 'Build it with ./run-dev.sh --build-guest or set GRIP_SANDBOX_GUEST_BINARY to a compatible local build.\n' >&2
  exit 1
fi

if [[ "$print_env" == true ]]; then
  for key in GRIP_SANDBOX_RUNTIME GRIP_SANDBOX_LIMA GRIP_SANDBOX_LIMA_TEMPLATE \
    GRIP_SANDBOX_LIMA_INSTANCE_PREFIX GRIP_SANDBOX_WORKSPACE_MOUNT \
    GRIP_SANDBOX_DAEMON_PORT GRIP_SANDBOX_DAEMON_HOST_BIND GRIP_SANDBOX_CLEANUP \
    GRIP_SANDBOX_GUEST_BINARY; do
    printf 'export %s=%q\n' "$key" "${!key}"
  done
  exit 0
fi

# Preserve caller cwd as the workspace root. The guest binary is copied only
# when the user explicitly starts Lima and its no-running-Grip checks succeed.
if [[ -n "$build_dir" ]]; then
  "$repo_root/grip-test.sh" "$@"
else
  exec "$repo_root/grip-test.sh" "$@"
fi