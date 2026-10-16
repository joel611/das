#!/bin/sh
port="$1"
input=$(cat)
url="http://127.0.0.1:$port/statusline"
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ -n "$DAS_WRAP_B64" ]; then
  printf '%s' "$input" | curl -s -m 1 -X POST -H 'Content-Type: application/json' -H "X-Claude-Config-Dir: $dir" --data-binary @- "$url" >/dev/null 2>&1 &
  cmd=$(printf '%s' "$DAS_WRAP_B64" | base64 -d 2>/dev/null)
  printf '%s' "$input" | sh -c "$cmd"
else
  printf '%s' "$input" | curl -s -m 1 -X POST -H 'Content-Type: application/json' -H "X-Claude-Config-Dir: $dir" --data-binary @- "$url" 2>/dev/null
fi
exit 0
