#!/usr/bin/env bash
# board.sh — light reconciler stub for docs/ORCHESTRATION.md (Orion / OpenCode)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOARD="$ROOT/docs/ORCHESTRATION.md"
REQUIRED=(
  "$ROOT/docs/ORCHESTRATION.md"
  "$ROOT/docs/DECISION-LEDGER.md"
  "$ROOT/docs/ARCHITECTURE.md"
  "$ROOT/docs/TESTING.md"
  "$ROOT/docs/HOW_WE_DO_IT.md"
  "$ROOT/AGENTS.md"
)

missing=0
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "MISSING: $f" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "BOARD STALE — fix missing docs before dispatch" >&2
  exit 1
fi

if [[ ! -f "$BOARD" ]]; then
  echo "BOARD MISSING: $BOARD" >&2
  exit 1
fi

echo "BOARD STUB READY"
echo "  board=$BOARD"
echo "  root=$ROOT"
echo "  docs=present"
exit 0
