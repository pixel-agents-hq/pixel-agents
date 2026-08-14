#!/usr/bin/env bash
#
# web-agent.sh -- POST a hook event to the running Pixel Agents server's web
# (REST) provider, without manually copying the port/token from
# ~/.pixel-agents/server.json every time.
#
# Usage:
#   ./scripts/web-agent.sh '{"session_id":"demo-1","hook_event_name":"sessionStart","cwd":"'"$PWD"'"}'
#
# See docs/web-provider-plan.md (Phase 5/7) and server/manual-web-events.http
# for the full event vocabulary and an example lifecycle.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 '<json-payload>'" >&2
  echo "Example: $0 '{\"session_id\":\"demo-1\",\"hook_event_name\":\"sessionStart\",\"cwd\":\"'\"\$PWD\"'\"}'" >&2
  exit 1
fi

payload="$1"
server_json="${HOME}/.pixel-agents/server.json"

if [ ! -f "$server_json" ]; then
  echo "error: $server_json not found -- is Pixel Agents running? (npx pixel-agents / VS Code panel)" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  port=$(jq -r '.port' "$server_json")
  token=$(jq -r '.token' "$server_json")
else
  # Minimal fallback so this script doesn't hard-require jq.
  port=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$server_json" | grep -o '[0-9]*$')
  token=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$server_json" | sed -E 's/.*:\s*"([^"]*)"/\1/')
fi

if [ -z "$port" ] || [ -z "$token" ]; then
  echo "error: could not read port/token from $server_json" >&2
  exit 1
fi

curl -sS -X POST "http://127.0.0.1:${port}/api/hooks/web" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d "$payload"
echo
