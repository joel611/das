#!/usr/bin/env bash
# Usage: verify.sh doctor
#        verify.sh run [spec.e2e.ts ...]   # no args = all e2e/*.e2e.ts; paths relative to packages/desktop
# Builds the e2e binary, runs WDIO against it in a sandbox, copies screenshots to $EVIDENCE_DIR.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
DESK="$ROOT/packages/desktop"
BIN="$DESK/src-tauri/target/debug/stack-chan-app"
EVIDENCE_DIR="${EVIDENCE_DIR:-$HOME/.cache/das-verify/$(date +%Y%m%d-%H%M%S)}"

doctor() {
  local bad=0
  chk() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; bad=1; fi; }
  chk "macOS (embedded WebDriver is the macOS path)" '[ "$(uname)" = Darwin ]'
  chk "bun on PATH" 'command -v bun'
  chk "cargo on PATH" 'command -v cargo'
  chk "deps installed (wdio cli)" "[ -d '$ROOT/node_modules/@wdio' ] || [ -d '$DESK/node_modules/@wdio' ]"
  chk "e2e binary built" "[ -x '$BIN' ]"
  chk "e2e binary newer than src/ and src-tauri/src/" "[ -x '$BIN' ] && [ -z \"\$(find '$DESK/src' '$DESK/src-tauri/src' -newer '$BIN' -type f -print -quit)\" ]"
  if pgrep -x stack-chan-app >/dev/null; then echo "WARN a stack-chan-app is already running (maybe the user's real tray app); do not kill it, e2e launches its own"; fi
  echo "evidence dir: $EVIDENCE_DIR"
  return $bad
}

run() {
  cd "$DESK"
  VITE_E2E=1 bunx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
  local specs=()
  for s in "$@"; do specs+=(--spec "$s"); done
  rm -f e2e/*.png
  local rc=0
  bunx wdio run e2e/wdio.conf.ts "${specs[@]}" || rc=$?
  mkdir -p "$EVIDENCE_DIR"
  cp e2e/*.png "$EVIDENCE_DIR"/ 2>/dev/null || echo "no screenshots produced"
  echo "evidence: $EVIDENCE_DIR"
  ls "$EVIDENCE_DIR"
  return $rc
}

case "${1:-}" in
  doctor) doctor ;;
  run) shift; run "$@" ;;
  *) sed -n 2,4p "$0"; exit 2 ;;
esac
