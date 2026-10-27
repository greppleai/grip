#!/usr/bin/env bash
# Probe the same account-specific Codex model endpoint used by openai/codex.
# Run from the repository root; this is an internal endpoint and may change.
set -euo pipefail

for program in curl jq base64; do
  command -v "$program" >/dev/null || { printf 'Missing dependency: %s\n' "$program" >&2; exit 1; }
done
output=./models.json
if [[ -e "$output" || -L "$output" ]]; then
  printf 'Refusing to overwrite %s; move or remove it first.\n' "$output" >&2
  exit 1
fi
if [[ ! -t 0 ]]; then
  printf 'Run interactively in a terminal to enter the token without echo.\n' >&2
  exit 1
fi

# Codex appends its (whole) client version to the catalog URL. Override if needed.
client_version=${CODEX_CLIENT_VERSION:-}
if [[ -z "$client_version" ]]; then
  if metadata=$(curl -qfsSL --max-time 10 'https://registry.npmjs.org/@openai%2fcodex/latest'); then
    client_version=$(jq -r '.version // empty' <<<"$metadata")
  fi
fi
if [[ -z "$client_version" ]] && command -v codex >/dev/null; then
  installed=$(codex --version)
  if [[ "$installed" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    client_version=${BASH_REMATCH[1]}
  fi
fi
client_version=${client_version%%[-+]*}
if [[ ! "$client_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Cannot determine Codex version; run with CODEX_CLIENT_VERSION=0.x.y.\n' >&2
  exit 1
fi

umask 077
read -r -s -p 'Paste the Codex ChatGPT OAuth access token (not the ID token or API key): ' token
printf '\n'
# Disallow characters that could escape a curl config header value.
if [[ ! "$token" =~ ^[a-zA-Z0-9._~+/=-]+$ ]]; then
  unset token
  printf 'Invalid token characters; paste only the access token, without Bearer.\n' >&2
  exit 1
fi
# Grip/Codex access tokens carry the ChatGPT account ID in a JWT claim.
if [[ "$token" != *.*.* ]]; then
  unset token
  printf 'Token is not a JWT; this probe expects the Codex ChatGPT access token.\n' >&2
  exit 1
fi
payload=${token#*.}
payload=${payload%%.*}
payload=${payload//-/+}
payload=${payload//_/\/}
case $((${#payload} % 4)) in
  2) payload+='==' ;;
  3) payload+='=' ;;
  1) printf 'Malformed JWT payload.\n' >&2; exit 1 ;;
esac
if ! account_id=$(printf '%s' "$payload" | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; } |
  jq -er '."https://api.openai.com/auth".chatgpt_account_id | select(type == "string" and length > 0)' 2>/dev/null); then
  printf 'No ChatGPT account ID in token; confirm this is the Codex access token.\n' >&2
  exit 1
fi
unset payload
if [[ ! "$account_id" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  printf 'Invalid account ID in token.\n' >&2
  exit 1
fi

temporary=$(mktemp ./models.json.tmp.XXXXXX)
trap 'unset token; rm -f -- "$temporary"' EXIT
# Feed sensitive headers to curl on stdin; neither token nor account ID is written to disk.
if ! status=$(printf 'header = "Authorization: Bearer %s"\nheader = "ChatGPT-Account-ID: %s"\n' "$token" "$account_id" |
  curl -q --config - --silent --show-error --max-time 20 --write-out '%{http_code}' \
    --header 'Accept: application/json' --get --data-urlencode "client_version=$client_version" \
    --output "$temporary" 'https://chatgpt.com/backend-api/codex/models'); then
  printf 'Codex model request failed; no models.json was saved.\n' >&2
  exit 1
fi
unset token account_id
if [[ "$status" != 200 ]]; then
  printf 'Codex model endpoint returned HTTP %s; no models.json was saved.\n' "$status" >&2
  exit 1
fi
if ! jq -e '.models | type == "array"' "$temporary" >/dev/null; then
  printf 'Unexpected response (expected a JSON models array); no models.json was saved.\n' >&2
  exit 1
fi
# Hard-link publication refuses to overwrite if models.json appeared while fetching.
ln "$temporary" "$output"
printf 'Saved raw Codex response to %s (client_version=%s). Picker-visible models:\n' "$output" "$client_version"
jq -r '.models[] | select(.visibility == "list") | [.slug, .display_name] | @tsv' "$output"
