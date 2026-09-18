#!/usr/bin/env bash
# with-browser-env.sh — source the machine-local browser environment, if one was
# produced by `scripts/setup-browser.sh`, then run the given command.
#
# The file only exists on a box that needed a rootless, managed browser; on a box
# with a usable system browser it is absent and this is a transparent pass-through.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.browser-env.sh" ]]; then
  # shellcheck disable=SC1091
  . "$ROOT/.browser-env.sh"
fi

exec "$@"
