#!/usr/bin/env bash
# check-wasm.sh — fail if a committed WebAssembly artifact is not the one the
# committed Rust source produces.
#
# A checked-in binary that can drift from its source is a silent divergence: the
# tests would keep passing against a stale kernel. This rebuilds and compares
# every kernel the project ships.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO="${CARGO_BIN:-$HOME/.cargo/bin/cargo}"
TARGET="wasm32-unknown-unknown"

KERNELS=(
  "l0:src/domain/engines/l0.wasm"
  "perturb:src/domain/engines/perturb.wasm"
)

if [[ ! -x "$CARGO" ]]; then
  echo "check-wasm: cargo not found at $CARGO — the WASM kernels cannot be verified" >&2
  echo "  install the toolchain, or set CARGO_BIN to a cargo that can target $TARGET" >&2
  exit 1
fi

for entry in "${KERNELS[@]}"; do
  crate="${entry%%:*}"
  artifact="$ROOT/${entry#*:}"
  if [[ ! -f "$artifact" ]]; then
    echo "check-wasm: $artifact is missing — run scripts/build-wasm.sh" >&2
    exit 1
  fi

  RUSTFLAGS="-C target-feature=+simd128" "$CARGO" build \
    --release --target "$TARGET" --manifest-path "$ROOT/crates/$crate/Cargo.toml" >/dev/null

  built="$ROOT/crates/$crate/target/$TARGET/release/orion_${crate}.wasm"
  if ! cmp -s "$built" "$artifact"; then
    echo "check-wasm: ${artifact#"$ROOT/"} is NOT what crates/$crate produces" >&2
    echo "  run scripts/build-wasm.sh and commit the result" >&2
    exit 1
  fi
  echo "check-wasm: artifact matches crates/$crate ($(wc -c <"$artifact") bytes)"
done
