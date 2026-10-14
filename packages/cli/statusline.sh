#!/bin/sh
# Claude Code status line for das. Claude Code passes the status line JSON on stdin, which carries
# rate_limits (5-hour and weekly plan usage). This forwards it to the daemon at 127.0.0.1:$1/statusline,
# then prints the status line the user had before (base64 in $DAS_WRAP_B64), or the daemon's own short line.
port="$1"
input=$(cat)
url="http://127.0.0.1:$port/statusline"
if [ -n "$DAS_WRAP_B64" ]; then
  printf '%s' "$input" | curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- "$url" >/dev/null 2>&1 &
  cmd=$(printf '%s' "$DAS_WRAP_B64" | base64 -d 2>/dev/null)
  printf '%s' "$input" | "${SHELL:-/bin/sh}" -c "$cmd"
else
  printf '%s' "$input" | curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- "$url" 2>/dev/null
fi
exit 0
