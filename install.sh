#!/usr/bin/env sh
# Install the checksummed, single-file Grip executable. No npm or sudo.
set -eu

fail() { printf 'grip install: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required'
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'supported systems: macOS and Linux' ;; esac
[ "$os" != linux ] || [ ! -f /etc/alpine-release ] || fail 'Alpine/musl needs a separately built binary; the Linux release targets glibc'
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail 'unsupported CPU architecture' ;; esac
asset="grip-$os-$arch"
version=${GRIP_VERSION:-}
if [ -n "$version" ]; then
  case "$version" in *[!a-zA-Z0-9.+-]*|'' ) fail 'invalid GRIP_VERSION' ;; esac
  case "$version" in v[0-9]*) ;; *) fail 'GRIP_VERSION must begin with v and a digit' ;; esac
fi
base=${GRIP_RELEASE_BASE_URL:-https://github.com/greppleai/grip/releases}
case "$base" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) fail 'release URL must be HTTPS (or loopback for tests)' ;; esac
case "$base" in *..*|*' '*|*'&'*|*'?'*|*'#'*|*'%'*) fail 'invalid release URL' ;; esac
base=${base%/}
if [ -n "$version" ]; then url="$base/download/$version"; else url="$base/latest/download"; fi

install_dir=${GRIP_INSTALL_DIR:-"$HOME/.local/bin"}
[ -d "$install_dir" ] || mkdir -p "$install_dir" || fail "cannot create $install_dir"
install_dir=$(cd "$install_dir" && pwd -P) || fail 'invalid install directory'
[ -L "$install_dir/grip" ] && fail 'refusing to replace a symlink'
[ ! -e "$install_dir/grip" ] || [ -f "$install_dir/grip" ] || fail 'refusing to replace a non-file'
work=$(mktemp -d "$install_dir/.grip-install.XXXXXXXX") || fail 'cannot create private download directory'
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl -fLsS --retry 2 "$url/$asset" -o "$work/$asset" || fail 'binary download failed; is this release published?'
curl -fLsS --retry 2 "$url/$asset.sha256" -o "$work/$asset.sha256" || fail 'checksum download failed'
expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name {print $1}' "$work/$asset.sha256")
case "$expected" in
  *[!a-fA-F0-9]*|'') fail 'missing or invalid SHA-256 checksum' ;;
esac
[ "${#expected}" -eq 64 ] || fail 'invalid SHA-256 length'
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/$asset" | awk '{print $1}')
else
  fail 'sha256sum or shasum is required to verify the release'
fi
[ "$actual" = "$expected" ] || fail 'SHA-256 mismatch; installation aborted'
chmod 755 "$work/$asset"
# Downloaded into the destination filesystem; rename only after successful verification.
mv -f "$work/$asset" "$install_dir/grip"
printf 'Installed %s\n' "$install_dir/grip"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    if [ "$install_dir" = "$HOME/.local/bin" ]; then
      case "${SHELL:-}" in */zsh) profile="$HOME/.zprofile" ;; */bash) profile="$HOME/.bashrc" ;; *) profile="$HOME/.profile" ;; esac
      if [ -f "$profile" ] && [ ! -w "$profile" ]; then
        printf 'Add %s to PATH manually (cannot write %s).\n' "$install_dir" "$profile"
      elif ! grep -F '# Grip binary installer PATH' "$profile" >/dev/null 2>&1; then
        printf '\n# Grip binary installer PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
        printf 'Added %s to PATH in %s. Open a new shell.\n' "$install_dir" "$profile"
      fi
    else
      printf 'Add %s to PATH to use grip in new shells.\n' "$install_dir"
    fi
    ;;
esac
resolved=$(command -v grip 2>/dev/null || true)
if [ -n "$resolved" ] && [ "$resolved" != "$install_dir/grip" ]; then
  printf 'Warning: grip currently resolves to %s, not %s. Put the install directory first in PATH or remove the older installation.\n' "$resolved" "$install_dir/grip" >&2
fi
