# Orion

**A fractal explorer for arbitrarily deep zoom.** An adaptive _precision ladder_
picks the cheapest sufficient math for the current zoom stage — direct `f64`,
perturbation against a full-precision reference orbit, series approximation and
bivariate linear approximation, floatexp deltas with glitch detection and exact
repair, all on limb fixed point at a precision derived from the scale. Rendering
is GPU-first behind a single backend seam (WebGPU compute and WebGL2 fragment),
with a multithreaded CPU path — worker pool over `SharedArrayBuffer` and a
Rust→WASM SIMD core — that is the primary engine where floats die. Every kernel
is pinned against an arbitrary-precision oracle.

Product scope is directed — see `docs/DECISION-LEDGER.md` rows 2+. Do not invent scope.

## Humans / agents

- **Canonical agent rules:** [`AGENTS.md`](./AGENTS.md) (read this first).
- **Process docs:** `docs/` (ledger, architecture, orchestration board, testing, how-we-do-it).
- **Host:** DSH workspace at `/home/box/Harness/Orion` (not Cursor/Pyrion).

## Package manager

**`pnpm` only.** Do not use npm, yarn, or bun for installs/scripts here.

```bash
pnpm install
pnpm run dev
bash scripts/gate.sh
```

## Scripts

| Script                | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `dev`                 | Vite dev server                                                |
| `build`               | typecheck + production build                                   |
| `preview`             | preview production build                                       |
| `typecheck`           | `tsc --noEmit`                                                 |
| `lint`                | ESLint                                                         |
| `test` / `test:watch` | Vitest (math pins against the oracle)                          |
| `test:browser`        | Playwright: headless Chrome, GPU and CPU kernels differentially |
| `format`              | Prettier                                                       |
| `gate`                | **the one suite**: locked wasm-drift check + typecheck + lint + Vitest + Playwright |

The gate needs the Rust toolchain (`wasm32-unknown-unknown`) because it rebuilds
`crates/l0` and `crates/perturb` and byte-compares them against the committed
`.wasm` artifacts; the artifacts themselves are checked in, so the app builds
without Rust.

## Open in DSH

Point the harness at `/home/box/Harness/Orion`. Agents follow `AGENTS.md`.
