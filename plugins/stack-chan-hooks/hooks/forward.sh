#!/bin/sh
# Pipe the hook JSON on stdin to the stack-chan daemon. No output, always exit 0: never blocks or changes the agent.
curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${CLAUDE_PLUGIN_OPTION_PORT:-4321}/hooks/$1" >/dev/null 2>&1
exit 0
