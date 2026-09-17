#!/usr/bin/env bash
# gate.sh — ONE way the Orion suite runs. Nobody hand-rolls a test command.
# Memory note: keep this sequential and light on day 1; add RAM ceilings later if the
# shared box contends. NEVER pipe this script through tail/head (loses summary).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="${GATE_LOCK_DIR:-/tmp/orion-gate.lock}"
LOG="${GATE_LOG:-/tmp/orion-gate.log}"
PM="pn""pm"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "pid=$$ time=$(date -Iseconds) cwd=$PWD" >"$LOCK_DIR/owner"
    return 0
  fi
  echo "GATE LOCK BUSY — wait and retry; do not reap another actor" >&2
  if [[ -f "$LOCK_DIR/owner" ]]; then
    echo "  owner: $(cat "$LOCK_DIR/owner")" >&2
  fi
  exit 9
}

release_lock() {
  rm -rf "$LOCK_DIR"
}
trap release_lock EXIT

acquire_lock

{
  echo "=== gate start $(date -Iseconds) ==="
  cd "$ROOT"
  echo "--- check:wasm (committed artifact vs crates/l0) ---"
  bash "$ROOT/scripts/check-wasm.sh"
  echo "--- check:deploy (futuremagic registry upsert, offline) ---"
  python3 "$ROOT/scripts/futuremagic-registry.py" --selftest
  echo "--- typecheck ---"
  "$PM" run typecheck
  echo "--- lint ---"
  "$PM" run lint
  echo "--- test ---"
  "$PM" run test
  echo "--- test:browser (headless Chrome + SwiftShader) ---"
  "$PM" run test:browser
  echo "=== gate end $(date -Iseconds) ==="
} | tee "$LOG"

echo "GATE GREEN"
