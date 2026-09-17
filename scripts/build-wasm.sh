#!/usr/bin/env bash
# build-wasm.sh — compile the Rust kernels to WebAssembly and install them.
#
# The committed artifacts are binaries, so they can silently drift from the
# source that produced them. `scripts/check-wasm.sh` rebuilds and compares bytes,
# and the gate runs that check — this script is the way to make it pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO="${CARGO_BIN:-$HOME/.cargo/bin/cargo}"
TARGET="wasm32-unknown-unknown"

# crate directory -> installed artifact path. One row per kernel; the check
# script reads the same list, so a new kernel cannot be added to one and
# forgotten in the other.
KERNELS=(
  "l0:src/domain/engines/l0.wasm"
  "perturb:src/domain/engines/perturb.wasm"
)

if [[ ! -x "$CARGO" ]]; then
  echo "build-wasm: cargo not found at $CARGO (set CARGO_BIN to override)" >&2
  exit 1
fi

for entry in "${KERNELS[@]}"; do
  crate="${entry%%:*}"
  artifact="$ROOT/${entry#*:}"
  # +simd128 is not implied by the target, and both kernels' pair loops need it.
  RUSTFLAGS="-C target-feature=+simd128" "$CARGO" build \
    --release --target "$TARGET" --manifest-path "$ROOT/crates/$crate/Cargo.toml"

  built="$ROOT/crates/$crate/target/$TARGET/release/orion_${crate}.wasm"
  if [[ ! -f "$built" ]]; then
    echo "build-wasm: expected $built to exist after a successful build" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$artifact")"
  cp "$built" "$artifact"
  echo "build-wasm: installed $(wc -c <"$artifact") bytes into ${artifact#"$ROOT/"}"
done
