# Orchestration board (Orion)

**One screen, overwritten in place.** Records that no longer describe the present belong in the ledger or nowhere.
Every record names something checkable (sha, branch, worktree, path). Prefer `field=value` one-liners so `grep` works.

## Vocabulary

| Prefix        | Means                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| `reconciled:` | commit/timestamp the board was last checked against                        |
| `SESSION`     | actor that may dispatch (DSH CoS / session)                                |
| `IN-FLIGHT`   | writer slice: row, worktree, branch, base, state, scope                    |
| `LANDED`      | verified landing: row, sha, **verifier's own** gate numbers, retired, note |
| `QUEUE`       | requests / debt not yet started (reserve ledger row if known)              |
| `TRAP`        | mistake that happened + the rule that prevents it                          |

Optional later: `PROBE`, `QUEUE-CLOSED`, `GUARD`, `RECOVERY`.

## DSH note

Session start = reconcile (`bash scripts/board.sh`) before dispatch when multi-agent.
Worktrees under `/tmp`; absolute paths in every brief; ≤2 writers; one gate at a time.

## Current board

```
reconciled: landing-14 (series accelerator wired in + coefficient cache) · no VCS (repo has no commits) · verify=gate green

SESSION | id=dsh | project=Orion | path=/home/box/Harness/Orion | state=active | role=chief-of-staff+writer

LANDED | row=2,3,4,5 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint tests green | retired=— | note=S1a precision substrate: bigfixed/bigcomplex/precision/view/direct-oracle; 9/9 mutation checks caught; COPIES 2→1 rounding rule folded
LANDED | row=6,7 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 108 tests green | retired=— | note=S1b floatexp (wide-range storage) + reference orbit at full precision, stored 53-bit; 9/9 mutation checks caught after closing 2 blind spots; escape index pinned equal to escapeDirect
LANDED | row=8,9 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 133 tests green | retired=— | note=S1c perturbation engine: delta iteration + isGlitched + repair by direct engine + fromDecimal; 11/11 mutation checks caught; escape counts equal the oracle on 5 views at up to 2^-35 with zero undetected glitches
LANDED | row=10,11 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 142 tests green | retired=— | note=S1d series approximation: coefficients pinned vs exactDelta (~1e-17 rel), skip validated not extrapolated, advertised bound never exceeded; 6/6 mutation checks caught; series path is opt-in because it shifts near-boundary escape counts
LANDED | row=12,13 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 168 tests green | retired=— | note=S1e verified orbit precision (F vs 2F agreement, never below input precision) + ladder stage selection (validity before cost, quality gates the series); 6/6 mutation checks caught; worst-case precision bound measured 12x pessimistic

LANDED | row=14,15 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 198 unit + 5 browser tests green | retired=— | note=S2a backend seam (FractalBackend), CPU renderer, WebGL2 preview renderer + shader, browser differential lane wired into the gate, app shell renders and zooms

LANDED | row=16,17 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 228 unit + 6 browser tests green | retired=— | note=S2b progressive/cancellable tiled rendering + reference-orbit cache (1 miss / 3 hits for 4 tiles); app rewired onto the scheduler with a coarse pass landing first

QUEUE | row=18 | note=S2d pan-aware tile reuse + series-coefficient caching (the LRU exists; the keys do not)
QUEUE | row=19 | note=S1f rebasing: recover glitches with a second reference instead of direct iteration
LANDED | row=18,19 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 232 unit + 10 browser tests green | retired=— | note=S2c WebGPU compute backend behind the same seam (exact vs the CPU engine at 8 iterations, same divergence bounds at 400) + GPU-first selection with every refusal reported; app now renders through webgpu

LANDED | row=20,21 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 232 unit + 13 browser tests green | retired=— | note=S3 emulated double precision in the WGSL kernel: exact quality matches the arbitrary-precision oracle exactly at 2^-24 where f32 cannot express the view; WGSL compile info + validation error scopes make a silent no-op impossible

LANDED | row=22,23 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 258 unit + 15 browser tests green | retired=— | note=S4 bit-exact shareable links (base36 exact + decimal for humans, Zod at the boundary) and exact `toDecimalString`; 6/6 mutation checks caught; app reads the link on load and keeps the address bar in step

LANDED | row=24,25 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint 259 unit + 17 browser tests green | retired=— | note=S5 CPU worker pool as a FractalBackend: 12 tiles across 4 workers bit-identical to the serial render; cross-origin isolation asserted (transport=shared); view crosses as a URL fragment; pool is the app's CPU candidate

LANDED | row=26,27 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint+wasm-check 259 unit + 19 browser tests green | retired=— | note=S5b Rust→WASM SIMD L0 carrier (no_std, no allocator, ~1.3KB): bit-identical to the JS kernel over 2048 px and 1.4-1.9x faster across runs; stage reports `direct-f64-simd`; artifact drift checked in the gate

LANDED | row=28 | sha=n/a (no commits yet) | verify=MY OWN: gate typecheck+lint+wasm 259 unit + 20 browser tests green | retired=— | note=series accelerator wired into the CPU preview path (exact never takes it) with a coefficient cache (1 miss / 3 hits); measured 1.3-1.5x and 2.15x on the perturbation stage; a short-circuit `&&` had silently skipped the exact render

LANDED | row=29 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check+typecheck+lint 262 unit + 21 browser tests green | retired=— | note=absolute-lattice tile caching: view snapped to the sample lattice so panning reuses tiles (key = spacing|bits|step|span|k|l); pinned against an analytic oracle cold and warm; the first pin was inert under a key mutation and five mutations now die

LANDED | row=30,31 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check+typecheck+lint 285 unit + 23 browser tests green | retired=— | note=the app's view state is fixed point with scale-derived precision: wheel/drag/deep links reach 2^-173+ (400 steps to 2^-400 in unit pins), the ladder refuses direct-f64 by name, links round-trip bit-exactly; found and fixed a WebGPU staging-buffer race where a cancelled render's pending map met the next render's submit

LANDED | row=32 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check (both kernels) + typecheck + lint 285 unit + 30 browser tests green | retired=— | note=Rust→WASM delta-recurrence carrier behind a DeltaCarrier seam: bit-identical to the JS engine, measured 3.31x on a real 2^-199 view (199.6ms → 60.3ms); the measurement showed the delta loop is ~100% of deep-render cost, and a zero-delta first benchmark nearly hid it

LANDED | row=35,36 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 32 browser tests green | retired=— | note=bivariate linear approximation as a DeltaCarrier: chained-validated power-of-two blocks, escaping blocks re-iterated for an exact count; measured 1.85x faster than the WASM exact kernel (22.0ms vs 40.8ms) with 0/432 counts differing. Exposed and fixed a squared-magnitude bug in the series validator (offsetMagnitude returned |z|^2), which had made the series' earlier speedups flattering — the honest figure on a 16-pixel view is 0.65x

LANDED | row=37 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 34 browser tests green | retired=— | note=GPU perturbation kernel in WGSL (f32-mantissa floatexp deltas against a full-precision reference orbit, flagged pixels repaired exactly on the host): the GPU now offers preview at ANY depth instead of refusing past 2^-40; escape counts exact against the oracle at 2^-24 (budgets 4-400) and 2^-40/-60/-100. A uniform-field type bug made the first version agree on 10/192; a budget sweep found it

LANDED | row=38 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 36 browser tests green | retired=— | note=WebGL2 perturbation shader (floatexp deltas in GLSL ES 3.00, reference orbit in an RGBA32F texture, bottom-up fragment convention handled, flag/repair shared with WebGPU): the broad-reach GPU path now renders preview at ANY depth instead of refusing past 2^-20; 192/192 escape counts exact against the oracle at 2^-24

LANDED | row=39 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 38 browser tests green | retired=— | note=WebGL2 emulated double precision via Veltkamp splitting (no fma in GLSL ES 3.00), own header with four split uniforms; both GPU backends now reach 2^-40 in exact, closing the last named piece of objective item 2. Measured: boundary view 19 distinct counts / 0 mismatches, 2^-24 view 192/192 exact. Two bugs caught by pins (shared header collapsed both axes to one coordinate; depth checked before quality)

LANDED | row=40 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 38 browser tests green | retired=— | note=f64x2 pairing in the WASM delta kernel (two pixels per instruction, reference-derived quantities shared per pair): measured A/B 172-205ms -> 77-95ms (~2x on the kernel), 7.2-8.5x vs the JS carrier, bit-identical on all seven differentials. Three bugs found by pins: unsigned i64x2 comparisons of negative exponents, reversed bitselect polarity in fe_add, and exhaustion tested with only the glitch mask

LANDED | row=44 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 309 unit + 41 browser tests green | retired=— | note=the ladder is fed by measurement: a render records the series prefix it validated against the view's shape and the next plan reads it, so the series stage is reachable at last. Measured on a 10^-60 view: skip 399/400, estimated work 174,823 -> 4,477 (39x). Pinned as a loop (plan -> render -> re-plan), not as arithmetic

LANDED | row=43 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 40 browser tests green | retired=— | note=tiles are written straight into a shared pass image (scheduler allocates it in a SharedArrayBuffer when isolated, hands each tile its rectangle, skips its blit; the cached path shares the tile buffer instead): pinned by a pooled colour render identical to serial with tilesDirect === tilesRendered. Exposed a latent overrun in the worker blit (rows*stride view is only right for a tile-sized buffer)

LANDED | row=42 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 39 browser tests green | retired=— | note=f64x2 pairing in the BLA jump loop (shared table read, per-lane last-block state, scalar refinement tail): jump-dominated view 5.4ms -> 3.6ms (~1.5x), 9.64x vs the JS carrier, bit-identical including blocks/refined; the refinement-dominated view is unchanged, as measured

LANDED | row=41 | sha=n/a (no commits yet) | verify=MY OWN: gate wasm-check + typecheck + lint 303 unit + 39 browser tests green | retired=— | note=BLA jump loop moved into the WASM kernel against tables composed on the host (identical coefficients, so bit-identity is testable): measured 8.34x and 7.88x over the JS jump carrier on two views, bit-identical on every field including blocks/refined. One bug found by the differential (JS reports refined=true whenever it re-iterates, not only on success)

QUEUE | debt | note=whether a 2-iteration BLA block would pay is still unmeasured; the validator starts at 4 iterations, and in the transition region (2^-20, 2^-15) the current threshold already beats the exact kernel by ~2x (the reference 2*Z_n is shared between pixels), a WASM carrier for the reference orbit, and writing tiles directly into a shared pass image
QUEUE | S3b | note=double-single for WebGL2 (needs Veltkamp splitting; GLSL ES 3.00 has no fma)
QUEUE | debt | note=the GPU perturbation kernel holds f32 mantissas: exact on every view measured, but a view whose pixels stay bounded for thousands of iterations is not covered
QUEUE | debt | note=GPU perf cannot be measured here — needs Arnd's hardware + in-app HUD
QUEUE | debt | note=wire `playwright` into the gate with system Chrome (channel) + pinned version
QUEUE | debt | note=orbit precision requirement measured but not yet a formula — ladder cannot size an orbit budget yet
QUEUE | debt | note=delta relative error reaches 6.2e-6 in the delta-dominated regime; harmless for escape counts, visible in the smooth count
QUEUE | debt | note=series skip changes escape counts on near-boundary pixels (8/36 at 2^-24, 1/36 at 2^-53) — gated behind quality=preview; rebasing may reduce it
QUEUE | debt | note=ladder cost model is structural and uncalibrated by construction — calibrate against the real HUD on Arnd's hardware
LANDED | row=39 | note=WebGL2 emulated double precision (Veltkamp splitting): both GPU backends reach 2^-40 in exact
LANDED | row=44 | note=the ladder is fed by measurement: a render records the validated series skip against the view shape and the next plan reads it (measured skip 399/400, estimated work 174,823 -> 4,477)
QUEUE | debt | note=the tile cache is per-lattice and bounded (512 tiles): a zoom change discards the lattice rather than migrating entries

QUEUE | S6 | note=a WASM reference orbit (still JavaScript bigint, computed once per worker per view — the main remaining latency on a new deep view)
QUEUE | S6 | note=f64x2 in the reference-orbit computation, once the orbit itself is in Rust
QUEUE | debt | note=whether a 2-iteration BLA block pays is still unmeasured; the validator starts at 4 iterations
QUEUE | debt | note=the ledger rows for landings 20-27 and TESTING landing 18 were written late (silent edit-anchor failures); all 44 rows and 27 landings are now present

# IN-FLIGHT | row=… | worktree=/tmp/… | branch=feat/… | base=<sha> | state=…
# TRAP | … | rule=…
```
