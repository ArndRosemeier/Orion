# Testing (Orion)

**What proves behaviour, and what was actually run.** Behaviour statements live in tests; this doc holds the matrix, pins, and per-landing evidence.

## Matrix

| Layer              | Tool                                     | Command (via gate)                    | Notes                                                                                                                           |
| ------------------ | ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Types              | tsc                                      | `pnpm run typecheck`                  | done-gate; `strict` + `noUncheckedIndexedAccess`                                                                                |
| Lint               | ESLint                                   | `pnpm run lint`                       | bans `any`                                                                                                                      |
| Unit — domain math | Vitest                                   | `pnpm run test`                       | `src/domain/**/*.test.ts`; compare in `BigFixed`, **never** in floats                                                           |
| Diagnostic probes  | Vitest (temporary, deleted)              | —                                     | For numeric claims: measure first, then write the pin. See landing 3                                                            |
| GPU correctness    | Playwright + headless Chrome/SwiftShader | `pnpm run test:browser` (in the gate) | `tests/browser/*.spec.ts`; escape counts compared **numerically** against the CPU L0 engine; correctness only, **never** timing |
| e2e / UI _(later)_ |                                          |                                       | Add when UI churn hurts                                                                                                         |

ONE suite entrypoint: `bash scripts/gate.sh` (typecheck → lint → test → test:browser). Do not hand-roll. The browser step adds ~50s because it starts Vite and Chrome; that is the price of the GPU pins actually running.

## Pins doctrine

- A pin is a statement that **goes red when broken**. Name the test after the property.
- Centralizations land with an **"exactly one"** pin when possible.
- **Mutation-check every pin before claiming it works** — break the code it guards, watch it go red, restore. A pin that cannot go red is decoration. Landing 2 evidence: 6/6 deliberate mutations caught.
- Day-1 example: `src/lib/clamp.test.ts` pins clamp behavior including min>max throw.
- Never assert across representations: the invariant belongs in the exact type (`BigFixed`), and a float projection is for display only.
- **Cover the sign and the extremes**, not just typical magnitudes. A mutation that only misbehaves for negative inputs or extreme exponent gaps will survive a suite built from ordinary values.
- **Do not pin a hand-derived numeric prediction.** Measure it with a throwaway diagnostic first, then pin the property that is actually true.

## Browser / GPU lane — measured capability of this box

Probed 2026-09-17 with Chrome 151.0.7922.169 (no `/dev/dri`, so software rasterization):

| Backend | Result    | Command evidence                                                                                                                                                                                 |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebGL2  | **works** | `--enable-unsafe-swiftshader`; renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, `EXT_color_buffer_float: true`, `MAX_TEXTURE_SIZE: 8192` |
| WebGPU  | **works** | `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader` → adapter **and** device obtained (Chrome bundles `libvk_swiftshader.so`)                                             |

A writable `--user-data-dir` is required, or Chrome exits with `Failed to create headless user data directory container`.

**Timing is meaningless under SwiftShader** (100–1000× slower than silicon). Frame-rate evidence must come from real hardware.

## Per-landing log

Append a short section per landing (or link a raw gate log path kept until verified):

### Landing row 1 — bootstrap

- Gate: run after install; see `/tmp/orion-gate.log`
- Arms / notes: scaffold only
- VOID probes: n/a

### Landing row 2 — S1a: precision substrate

- Scope: `BigFixed` arbitrary-precision fixed point, `BigComplex`, working-precision derivation, viewport ↔ plane mapping, and the direct engine that doubles as the verification oracle. Ledger rows 2–5.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 66 tests green (see `/tmp/orion-gate.log`).
- Pins: exactness of dyadic construction up to 4096 fractional bits; the one rounding rule incl. ties; precision mismatch and division-by-zero throw; `floorLog2` exact at 2^-2000; precision derived from bit length not floats (`3·2^-1000` needs one bit fewer than `2^-1000`); **adjacent pixels resolve at zoom 2^-200 where doubles collapse to a single value**; a view that cannot resolve its own pixels is rejected at construction; known Mandelbrot escape times (c=1→3, c=2→2, c=−2.5→1) and bounded points (0, −1, 0.25, −0.75, −2, 1e−40); precision independence at 128 vs 1024 bits; escape time stable as the budget grows.
- Mutation check: 9/9 caught — broken tie rounding, `mul` dividing by the wrong power of two, `fromFloat` not decomposing exactly, `floorLog2` off-by-one, precision rounding down, removed view validation, `>=` instead of `>` escape test, wrong imaginary term, and sampling pixel corners instead of centres.
- COPIES: 2→1 — `roundShiftRight` and `divideRounded` were two implementations of the one rounding rule (found by the landing's own COPIES grep). Both folded into `divideRounded`; the rule is now pinned at **every** call site that can lose bits (construction, multiplication, division, ties on both signs), so no single path can drift.
- Two real bugs found by the pins themselves: (1) a view's required precision cannot be derived from the view — circular, fixed by deriving from the scale exponent and validating at construction; (2) `escapeDirect` compared a _rounded double_ magnitude against an exact threshold and threw a false failure — removed, and recorded as house rule 9 in `HOW_WE_DO_IT.md`.
- Not yet proven: anything GPU, anything rendering, performance.

### Landing row 3 — S1b: floatexp + reference orbit

- Scope: wide-range scalar storage (`Floatexp`), the fixed-point→floatexp bridge (`topBits`), and `computeReferenceOrbit` at full precision with escape stop. Ledger rows 6–7.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 108 tests green (see `/tmp/orion-gate.log`).
- Pins: normalisation invariant (`0.5 <= |m| < 1`, canonical zero); exact round-trip of every double incl. subnormals and `Number.MAX_VALUE`; arithmetic agreement with doubles over random values; **scale that doubles cannot carry** (`2^-600` squared is `2^-1200`, projected as `0` yet exact in floatexp); 53 significant bits preserved 1947 orders below the double range; sign preserved through fixed-point conversion; addition across an exponent gap wider than the double range; canonical zero on cancellation; orbit of `c=0` identically zero; exact `c=-1` 2-cycle; exact dyadic orbit of `c=-1.75`; `c=-2` pinned to the `|z|=2` boundary; **escape index equals `escapeDirect`'s iteration count at 12 points** (cross-engine pin); storage stops at escape; **precision buys iterations** (see below); index/budget validation throws.
- Mutation check: 9/9 caught. Two blind spots surfaced on the first pass and were closed with new pins — `add` aligning at the _smaller_ exponent (mathematically equivalent until the gap exceeds the double range) and `fromBigFixed` dropping the sign (no negative case existed). Recorded as house rule 10.
- **Measured, not derived:** the first draft of the precision pin asserted that an offset of `2^-200` makes the `-2 + 2^-200` orbit escape. A diagnostic run showed that point lies inside the set's real slice `[-2, 0.25]` and never escapes — the prediction was simply wrong. The pin was replaced with the property that is actually true and actually matters: 64 bits rounds the offset away and holds the fixed point forever, 512 bits holds it ~50 iterations and departs by ~150. Recorded as house rule 11.
- Bug found by the pins: `frexp` used mask `0x800fffff`, which _keeps_ the sign bit, so every negative value decomposed to a positive one. Caught by the exact-decomposition and orbit pins.
- Bug found while writing the module: `Floatexp.toFloat` applied the exponent in one step, so `2 ** 1024` overflowed to `Infinity` and finite values such as `Number.MAX_VALUE` reported as saturated. Now applied in two exact halves, pinned.
- COPIES: 1 — checked, no duplication (grepped `round|remainder|half` across `src/domain`): rounding still routes solely through `divideRounded`; `topBits` is a projection out of it, `frexp` is normalisation only, and neither restates the rule.
- Not yet proven: perturbation deltas, rebasing, glitch handling, the ladder cost model, anything GPU, anything rendering, performance.

### Landing row 4 — S1c: perturbation engine, glitches, decimal coordinates

- Scope: `escapePerturbed` / `escapeWithRepair` / `isGlitched`, the `FloatComplex` pair, `Floatexp.cmp`, and `fromDecimal`. Ledger rows 8–9.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 133 tests green (see `/tmp/orion-gate.log`).
- **The differential pin (the point of the landing):** five views rendered pixel-by-pixel through both engines, including depth `2^-35` with 3000-iteration orbits. Every pixel's escape **iteration count** matches `escapeDirect` exactly; zero mismatches after repair; and — the safety property — **zero undetected glitches**, meaning no pixel the engine trusted ever disagreed with the oracle. Degenerate passes are blocked: each view asserts escaping pixels and perturbation-trusted pixels actually occurred.
- Glitch paths pinned separately: the cancellation path via a view/offset construction where the centre pixel lands exactly on a total cancellation (`z_2 = 0` at `c = -1`), and the exhaustion path via a deliberately truncated orbit and via a reference point that escapes before its pixels do.
- Measurement discipline (house rule 11) earned its keep three times here:
  1. The famous seahorse coordinate is **inside** the set — the first differential survey had `escaped=0` and proved nothing. Replaced with a survey that first searched for views with real escapes.
  2. The forced glitch initially produced **zero** glitches because the view centre and the reference point were conflated; separating them (a legitimately distinct pair) produced the intended cancellation.
  3. The lone `smooth`-count discrepancy was traced rather than tolerated: from n=1000→1531 the delta grows past the reference (`log2|d|` −8 → +1.26) and its accumulated relative error reaches **6.2e-6**. The escape count is untouched; only the sub-iteration count moves, so the pin is `< 1e-4` with the mechanism recorded in `ARCHITECTURE.md` known debt. Not a blanket loosening — the exact iteration-count pin is unchanged.
- Mutation check: 11/11 caught. One blind spot surfaced and was fixed properly rather than papered over: **a rendered test whose worst case is an exact zero cannot pin a threshold**, because `0 < anything` fires under any positive threshold. Disabling the glitch threshold to `2^-900` stayed green. The criterion was extracted to `isGlitched` and pinned directly at `2^-25` (inside) and `2^-23` (outside), so both a disabled and a slightly-loosened threshold now go red. Recorded as house rule 12.
- COPIES: 1 — checked, no duplication (grepped `Math.max(a.e`, `round|remainder|half`, `mag2z`, `glitch`). `FloatComplex` mirrors `BigComplex` by design (different scalar, same operations, no shared logic to fold); the recurrence exists once, in `perturbation.ts`, and is the single definition every future GPU kernel will be pinned against.
- Not yet proven: series approximation / BLA, rebasing, the ladder cost model, caching, anything GPU, anything rendering, performance.

### Landing row 5 — S1d: series approximation

- Scope: power-series coefficients from the reference orbit, a validated skip point, `FloatComplexArray` (folded accessors), and `Floatexp.div` / `Floatexp.sqrt`. Ledger rows 10–11.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 142 tests green (see `/tmp/orion-gate.log`).
- Pins, positive: coefficients reproduce `exactDelta` to **~1e-17 relative** out to n=400 (so the recurrence and the Horner evaluation are correct); the series at n=1 is exactly `dc`; a deep view yields a substantial skip; **the advertised error bound is never exceeded by any pixel of the view** (0 violations, worst ratio ~0.23, i.e. 4–18× conservative); a tighter tolerance yields a shorter skip; a sample list that all escapes immediately yields **no** skip.
- Pins, honest limitation: the exact path matches the oracle 36/36 while the series path differs on a minority of near-boundary pixels — asserted as `> 0` and `<= 12`, both directions tripwired, with the ledger row cross-referenced in the test body.
- **A bound of the wrong shape cannot be rescued by a constant.** The first design estimated the truncated tail by assuming geometric coefficient decay. Measurement: coefficients _grow_ with order, and the estimate under-reported the true error by up to **7e25×**. No safety factor fixes that. It was replaced by validation against the exact delta on sampled offsets, which the sweep then confirmed sound. Recorded as house rule 15.
- Bugs found while building it: (1) the Horner evaluation returned a series in `dc^(k-1)` — it omitted one factor of `dc` and the validator correctly refused every skip; (2) `selectSeriesSkip` iterated the exact delta past escape, where `d*d` doubles the exponent each step, overflowing the floatexp exponent guard. Both were caught by measurement, not by review.
- Mutation check: 6/6 caught — linear recurrence missing the `dc` term, mispaired convolution indices, the `dc^(k-1)` Horner form, a skip that ignores tolerance, a sample ignoring its own escape, and a skip extending past unvalidated steps.
- COPIES: 2→1 — `ReferenceOrbit` and the series coefficient arrays had grown separate floatexp-array accessors; both now go through `floatexparray.ts`, and the delta recurrence has exactly one definition (`deltaStep`) shared by the escape loop, `exactDelta` and the skip validator.
- Not yet proven: bivariate linear approximation, rebasing, the ladder cost model, caching, anything GPU, anything rendering, performance.

### Landing row 6 — S1e: verified orbit precision + the ladder

- Scope: `computeConvergedReferenceOrbit`, `BigFixed.withFracBits`, and `src/domain/ladder/plan.ts`. Ledger rows 12–13.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 168 tests green (see `/tmp/orion-gate.log`).
- Pins: raising precision is exact and lowering it rounds by the one rule, on both signs; the orbit precision search raises until `F` and `2F` agree and reports how many attempts it took; the returned orbit is stable under a further 4x precision; the cap is a **loud** error rather than an under-precise orbit; the ladder never selects a stage that cannot express the view; `exact` quality never selects the series stage; every option carries a reason and a work estimate, and the reported estimate matches the chosen option.
- **Measurement overturned the formula.** The plan was to derive an orbit-precision formula (`53 + 2n`, two bits per iteration of amplification). Measurement: a **1500-iteration** orbit of the deep seahorse coordinate at **256 bits** already agrees with 512 bits, so the worst-case bound would have over-allocated by ~12x. Only a maximally-amplifying point (`-2 + 2^-200`, ~4x per step) actually forces a raise. Verification replaced derivation, because a formula tight enough to be useful would have been a guess.
- Two failures of my own test premises, both instructive: at 512 bits a 120-iteration orbit _has_ converged (my "needs more" expectation was wrong), and the famous point converged at 256 bits over 1500 iterations. The pins were re-aimed at a case that genuinely amplifies rather than at the value I assumed.
- Bug found by the pins: the search initially started at `minFracBits`, so for a 512-bit reference point it computed at 64 bits — rounding the user's coordinate away. The check could not detect this, because the coarse and fine computations then agreed _on the degraded point_. Fixed by never starting below the input's precision; recorded as house rule 18.
- Mutation check: 6/6 caught — truncating instead of rounding, dropping the sign when rescaling, starting below the input precision, a convergence check that accepts anything, an inverted f64-limit comparison, and offering the series under `exact`.
- COPIES: 1 — checked, no duplication (grepped `recentre`, `withFracBits`, `orbitsAgree`, `limbFactor`). One rescaling seam, one convergence predicate, one cost model.
- Not yet proven: bivariate linear approximation, rebasing, caching, anything GPU, anything rendering, performance — and the cost model is uncalibrated by construction.

### Landing row 7 — S2a: backend seam, CPU + WebGL2 renderers, browser lane

- Scope: `FractalBackend` (the ONE seam), `directFloat` (the L0 engine), `palette`, the CPU backend, the WebGL2 backend + shader, the browser harness, and the app shell. Ledger rows 14–15.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 198 unit tests + **5 browser tests** green, including the browser lane for the first time (see `/tmp/orion-gate.log`).
- **The GPU pins, and why there are two of them.** At an 8-iteration budget the f32 shader agrees with the f64 CPU engine on **all 3072 pixels** — that is the pin that would catch a flipped axis, an off-by-half-pixel origin, a transposed readback or a wrong step vector, all of which fail loudly there while a loose tolerance elsewhere would hide them. At 400 iterations 328 of 3072 differ, 89 by more than 50: f32 rounding accumulating until trajectories diverge. Both are pinned, so neither the correctness nor the limitation can regress unnoticed.
- Measurement overturned my assumption twice: I guessed a 2% divergence ceiling and measured 10.7%; then, suspecting a mapping bug, I measured at 64 iterations and still saw 8.8% — which looked systematic. Measuring at **8** iterations returned **0 mismatches**, proving the kernel is right and the divergence is accumulation. The low-budget pin exists because of that investigation.
- Consequence, encoded rather than described: `LadderPlan` now carries `quality`, and the WebGL2 backend refuses `exact` with the measurement as its reason. The GPU path is a preview engine; exact output routes to the CPU — the same shape as the series accelerator's gating in landing 5.
- Bugs found while wiring it: pixel coordinates had to be lifted to the orbit's (raised) precision before subtracting, which surfaced as a loud precision mismatch rather than a wrong image; Vite binds to `localhost` (IPv6) so a `127.0.0.1` health check never passed; and `page.evaluate` serialises only the callback, so a Node-side helper was `undefined` in the page.
- Mutation check: not run for this landing — the new code is mostly I/O shape rather than arithmetic, and the differential pins are behavioural. Recorded rather than glossed.
- COPIES: 1 — checked, no duplication (grepped `pixelToComplex`, `scaleExponentOf`, `escapeDirectFloat`, `colourFor`). One view transform (the shader receives an origin and a step derived from it), one scale derivation (moved into `view.ts` so both backends share it), one colour table both backends sample.
- Not yet proven: bivariate linear approximation, rebasing, tile scheduling, progressive refinement, caching, WebGPU, worker pool/WASM, shareable URLs — and the cost model is uncalibrated by construction.

### Landing row 8 — S2b: progressive, cancellable, tiled rendering

- Scope: `step` sampling in the backend seam and both backends, `splitIntoTiles`, a bounded LRU, `renderView` (passes + cancellation), the view-centre reference point, the reference-orbit cache, and the app rewired onto the scheduler. Ledger rows 16–17.
- Gate: `bash scripts/gate.sh` → typecheck + lint + **228 unit tests** + 6 browser tests green.
- Pins: exact per-pass sample coverage across 8 view/step/tile geometries (nothing missing, nothing sampled twice); every tile stays inside the view; the sample grid rounds up for views that are not a multiple of the step; the coarse pass is 13x9 where the full is 100x70; a full-resolution pass is cut into 12 tiles rather than one call; **no sample is left unwritten in either pass**; cancellation does no work on an already-aborted signal, stops mid-grid and returns what it finished, and never reports a pass it did not complete; a stub backend that claims incapacity is surfaced with its reason when capability is required, and is rendered anyway when it is not.
- Cache pin: four tiles of a deep view produce **1 orbit-cache miss and 3 hits**, so the high-precision setup runs once per view. The LRU pin is specifically that it evicts the least recently **used** entry, not the oldest written — touching `a` then inserting `c` must evict `b`.
- App wiring: the status line now reads `direct-f64 → direct-f32 · 2 passes · 13 tiles · preview`, which is the ladder's plan followed by the backend stages actually used. The browser smoke test asserts exactly that, so a scheduler that silently stopped running passes would fail it.
- Three test/runtime failures found by the browser lane rather than by review: the app legitimately has two canvases now (Playwright strict mode), the display canvas is a 2D surface rather than WebGL (so its pixel check must use `getImageData`), and `ImageData` will not accept a possibly-shared typed-array backing store.
- Mutation check: not run for this landing — the new code is scheduling and bookkeeping rather than arithmetic, and the pins are structural (coverage, cancellation, cache accounting). Recorded rather than glossed.
- COPIES: 1 — checked, no duplication (grepped `tileOutputSize`, `splitIntoTiles`, `createLruCache`, `aborted`). One coverage rule (sample space, one implementation), one cancellation predicate, one LRU.
- Not yet proven: bivariate linear approximation, rebasing, **pan-aware tile reuse**, coefficient caching, WebGPU, worker pool/WASM, shareable URLs — and the cost model is uncalibrated by construction.

### Landing row 9 — S2c: WebGPU compute backend + GPU-first selection

- Scope: a WGSL compute kernel mirroring `escapeDirectFloat`, the WebGPU backend, a locally-declared WebGPU type module, the harness extended to select a backend by name, and `chooseBackend` with the app wired to prefer the compute backend. Ledger rows 18–19.
- Gate: `bash scripts/gate.sh` → typecheck + lint + **232 unit tests** + **10 browser tests** green (4 of them WebGPU).
- **The seam earned its claim.** Until a second GPU implementation went through `FractalBackend`, "one backend seam" was a design. The WebGPU backend is judged by the _same_ differential as WebGL2 — same harness, same view construction, same comparison — so the only thing that can differ between the two results is the kernel. Measured: WebGPU matches the f64 CPU engine on **all 3072 pixels at an 8-iteration budget**, and stays inside the same divergence bounds at 400. Exact agreement where f32 cannot yet have drifted is what rules out a coordinate or readback bug in each kernel independently.
- Chrome needs four flags for this lane: `--enable-unsafe-swiftshader` for WebGL2 plus `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader` for a headless WebGPU adapter. Recorded here because a missing flag presents as "navigator.gpu is unavailable", which reads like a code bug.
- WebGPU types are declared locally in `webgpu-types.ts` (explicit module imports rather than ambient globals, because `moduleDetection: "force"` makes an ambient declaration file an unreliable part of the program). The browser lane is what validates them against the real API.
- Deliberate convention split: the WebGL2 shader receives a bottom-left origin because `gl_FragCoord` is bottom-up, while the compute kernel receives a top-left origin and a downward-positive imaginary step. Each derives both from the one shared view transform; the differential is what proves neither got it backwards.
- Mutation check: not run — the new code is API plumbing and a kernel already covered by a numeric differential against the oracle. Recorded rather than glossed.
- COPIES: 1 — checked, no duplication (grepped `pixelToComplex`, `scaleExponentOf`, `tileOutputSize`, `chooseBackend`). The recurrence exists once per language because a shader cannot import TypeScript — that is the irreducible duplication this project pins differentially rather than pretending away.
- Not yet proven: double-single precision on the GPU, bivariate linear approximation, rebasing, **pan-aware tile reuse**, coefficient caching, worker pool/WASM, shareable URLs — and the cost model is uncalibrated by construction.

### Landing row 10 — S3: emulated double precision in the GPU kernel

- Scope: a second WGSL kernel carrying each value as an unevaluated `(hi, lo)` pair of `f32`s, `quality` added to the tile request so a backend can choose its kernel, `(hi, lo)` uploads for origin and step, and error scopes around every dispatch. Ledger rows 20–21.
- Gate: `bash scripts/gate.sh` → typecheck + lint + 232 unit tests + **13 browser tests** green.
- **The result:** the double kernel reproduces the **arbitrary-precision oracle exactly** on a 2^-24 view — 192 of 192 pixels — where plain `f32` cannot represent the view at all and the capability now refuses preview outright with "ask for exact quality, which uses emulated double precision". It also agrees exactly with the f64 engine at a low budget. `exact` never falls back to single, because f32 diverges from the oracle as iterations accumulate even at shallow depths.
- Reference choice mattered: the first version of this test compared against the **f64** engine at 1500 iterations and reported 99.5% mismatch. At that depth and budget f64 is itself marginal, so the test was measuring two approximations against each other. Comparing against the oracle instead — and letting the oracle decide whether uniformity is correct — gave an exact result.
- Two false premises of mine, both corrected rather than accommodated: I asserted the 2^-24 view would be non-degenerate, and it is uniformly interior (the oracle agrees, so uniformity is correct); and I re-used a `replace` that hit two tests instead of one, adding a non-degeneracy assertion to a place where 8 iterations cannot produce varied counts. The surviving non-degeneracy guards are the ones that were already meaningful: escaped/interior counts in the differential tests, and distinct colours in the colour tests.
- **A silent no-op is a wrong answer.** The first double-precision run returned 3072/3072 wrong values and _no error_: WGSL requires a function to be declared before use, the module failed to validate, and an invalid pipeline makes the dispatch a no-op that leaves stale bytes in the output buffer — indistinguishable from a numerical result. Two fixes followed, both permanent: `getCompilationInfo()` is inspected and shader errors raise, and every dispatch runs inside a validation error scope whose result is raised. That is how the real cause surfaced (an `auto`-layout bind group built from a sibling pipeline), and it is house rule 23.
- Because the struct now has to satisfy uniform-address-space layout, the params struct carries explicit padding to a 16-byte multiple. That is a real constraint, not defensive noise.
- Mutation check: not run — the contract here is a numeric differential against the oracle, which is stronger than a mutation for this change. Recorded rather than glossed.
- COPIES: 1 — checked, no duplication (grepped `escapeDirectFloat`, `pixelToComplex`, `tileOutputSize`). The recurrence now exists once per GPU language plus the TypeScript original; that is irreducible, and the differential is what holds all three to one answer.
- Not yet proven: double-single for WebGL2, bivariate linear approximation, rebasing, **pan-aware tile reuse**, coefficient caching, worker pool/WASM, shareable URLs — and the cost model is uncalibrated by construction.

### Landing row 11 — S4: bit-exact shareable view links

- Scope: `toDecimalString` (exact decimal output), `encodeView` / `decodeView` / `viewUrl` with Zod at the boundary, and the app reading a link on load and keeping the address bar in step. Ledger rows 22–23.
- Gate: `bash scripts/gate.sh` → typecheck + lint + **258 unit tests** + **15 browser tests** green.
- Pins, unit: bit-exact round trip of a 33-digit deep coordinate and of a 256-bit dyadic centre; every pixel of a decoded view mapping to the same complex point as the original; a fragment under 220 characters; `toDecimalString` exact for 1/256 and for the one-rule rounding of 0.1 at 8 bits; 200 random doubles round-tripping through text with a bit-exact comparison; seven malformed links rejected with their reasons; a decimal field rejected when the format says base36; and a link whose declared precision cannot resolve its own pixel grid refused by `makeView`.
- Pins, browser: the app **opens a shared link** and shows that centre (not the default), the address bar still carries the view afterwards, and a malformed link renders a visible error instead of silently showing the default view.
- Mutation check: 6/6 caught — wrong base in the base36 decoder, a dropped sign, a missing width field, view validation skipped on decode, a widened format field, and the wrong power in the decimal expansion.
- Two encoding forms, chosen explicitly rather than guessed: base36 of the fixed-point integer (compact, bit-exact, what the app emits) and plain decimal (what a human can type). A `fmt` field decides which a string is, so no string is ambiguous.
- False premise found by a pin: I wrote a test for a 64-bit view and `makeView` refused it — the 128-bit floor from landing 1 is doing its job. The test now uses the real minimum, which is the lowest precision a link can legitimately carry.
- COPIES: 1 — checked, no duplication (grepped `fromDecimal`, `toBase36`, `makeView`, `toDecimalString`). One parser per format, one view constructor, and the URL layer restates neither.
- Not yet proven: double-single for WebGL2, bivariate linear approximation, rebasing, **pan-aware tile reuse**, coefficient caching, worker pool/WASM — and the cost model is uncalibrated by construction.

### Landing row 12 — S5: the CPU worker pool

- Scope: `workerProtocol.ts` (Zod at both ends), `src/worker/tile.worker.ts`, `createWorkerPool` as a `FractalBackend`, scheduler concurrency, COOP/COEP headers, and the pool wired into backend selection as the app's CPU candidate. Ledger rows 24–25.
- Gate: `bash scripts/gate.sh` → typecheck + lint + **259 unit tests** + **17 browser tests** green.
- **The pin:** a 32x24 view rendered as **12 tiles across 4 workers produces exactly the image the single-threaded backend produces as one tile** — `toEqual` on the assembled RGBA, not a tolerance. Comparing assembled images rather than tiles also proves the scheduler places every tile correctly: a gap or an overlap would show as a mismatch rather than as a plausible picture.
- Cross-origin isolation is asserted rather than assumed: the lane checks `isolated: true` and `transport: "shared"`, plus `dispatched === completed === 12` and `failed === 0`. A missing COOP/COEP header would fail this test rather than quietly changing the transport.
- Reuse paid off: the view crosses the worker boundary as a **URL fragment**, so the worker and the main thread cannot disagree about what a view is. Last round's shareable-link codec became this round's serialization seam with no new format.
- Deliberate refusal: when no `Worker` exists the pool throws rather than rendering on the main thread. That would be a different performance profile than the caller asked for, and silently substituting it is exactly the kind of fallback this project forbids.
- Two mechanical failures, both type-level rather than behavioural: `self` types as `Window` under the DOM lib (the worker now declares the two members it uses rather than adding the colliding `WebWorker` lib), and an unused `view` parameter in `capability`.
- Mutation check: not run. The contract is a whole-image differential against the serial path, which is stronger than a mutation for this change; recorded rather than glossed.
- COPIES: 1 — checked, no duplication (grepped `encodeView`, `decodeView`, `makeTileResult`, `tileOutputSize`). The worker runs the _same_ CPU backend rather than a reimplementation, and the protocol restates neither the view format nor the tile geometry.
- Not yet proven: the Rust/WASM SIMD core, writing tiles directly into a shared pass image, double-single for WebGL2, bivariate linear approximation, rebasing, pan-aware tile reuse, coefficient caching — and the cost model is uncalibrated by construction.

### Landing row 13 — S5b: the Rust→WASM SIMD L0 core

- Scope: `crates/l0` (~1.3 KB, `no_std`, no allocator, no dependencies), the `L0Engine` seam, `l0Wasm.ts`, the CPU backend rendering row-wise through the engine, the worker choosing the carrier, `scripts/build-wasm.sh`, and `scripts/check-wasm.sh` wired into the gate. Ledger rows 26–27.
- Gate: `bash scripts/gate.sh` → wasm-check + typecheck + lint + 259 unit tests + **19 browser tests** green.
- **Measured, in the browser lane:** the WASM carrier is **bit-identical** to the JavaScript kernel over **2048 pixels at 400 iterations** (0 mismatches), and **1.4-1.9x faster across runs** — samples `js=1.966ms` vs `wasm=1.054ms`, and `js=2.310ms` vs `wasm=1.683ms`. This is the one place in the project where a performance number is real: CPU work is measurable on this box, unlike the GPU, where SwiftShader makes timings meaningless.
- Bit-identity is not luck. Both carriers were written to the same order of operations, `fma` is deliberately **not** used (it would be more accurate and would break equality with the pinned reference), and `log2` is left to the host so both use the same libm. A carrier swap that moved a pixel would make the speedup unsafe to rely on.
- The carrier is observable end to end: the stage string is `direct-f64-simd`, and a browser test asserts it through a _pooled_ render, so a silent fall back to the JavaScript carrier fails the lane.
- A real bug the differential caught immediately: the SIMD pair loop kept squaring a lane after it escaped, until it overflowed and `inf - inf` turned the recorded magnitude into NaN. The scalar path cannot do that — it returns on the same step. Fixed by freezing each lane's magnitude on its escape step.
- Artifact drift is checked rather than trusted: `scripts/check-wasm.sh` rebuilds the crate and compares bytes. Verified by appending one byte to the committed `.wasm` — the check fails with the rebuild command, and passes again once rebuilt. A checked-in binary that can drift from its source is a silent divergence.
- Mutation check: not run. The contract is an exact differential against the JavaScript kernel plus a byte-comparison against the source, both stronger than a mutation for this change.
- COPIES: 1 — checked, no duplication _within a language_ (grepped `escapeDirectFloatDetailed`, `smoothCount`, `render_row`). The recurrence exists once in TypeScript and once in Rust; a `cdylib` cannot call into TypeScript, so that pair is irreducible — and it is pinned exactly rather than tolerantly.
- Not yet proven: a WASM carrier for the perturbation path, WASM threads, writing tiles directly into a shared pass image, double-single for WebGL2, bivariate linear approximation, rebasing, pan-aware tile reuse, coefficient caching — and the cost model is uncalibrated by construction.

### Landing row 14 — the series accelerator, wired in at last

- Scope: the CPU backend's `preview` path now calls `escapePerturbedWithSeries`, with a coefficient cache beside the orbit cache. Ledger row 28.
- Gate: `bash scripts/gate.sh` → wasm-check + typecheck + lint + 259 unit tests + **20 browser tests** green.
- **The gap this closed:** the series accelerator had been implemented and pinned since landing 5, and **no renderer called it**. Checking "who calls this?" is now part of the routine, and it found a whole landing's work sitting unused.
- Pins: `exact` reports stage `perturbation` and `preview` reports `perturbation+series`; coefficients are built once per view (**1 miss, 3 hits** across four tiles, mirroring the orbit cache); `exact` never touches the coefficient cache at all (0 misses, 0 hits); and the exact path is now compared **pixel by pixel against the arbitrary-precision oracle** at the backend level, which it was not before.
- Measured on the perturbation stage at 2^-56 with 3000 iterations and 4x4 pixels: **1.3-1.5x across runs** (samples 89.5ms → 59.6ms and 74.8ms → 56.2ms). A second view (1e-60, 6x6, 600 iterations) measured **2.15x**. Both are uniformly interior at their budget, so the figure speaks to skipped iterations rather than to a mixed image — stated rather than glossed.
- **A bug that a weaker assertion let through.** The wiring was first written as `quality === "preview" && renderPerturbation(...)`, which reads correctly and **short-circuits the call**: for `exact` the tile was never rendered, and the output was an untouched buffer of zeros. The existing test asserted every pixel was _finite_ — which zeros are — so it passed. The benchmark exposed it as an impossible `0.2ms` for 36 pixels of 3000-iteration BigFixed work. Fixed by making the call unconditional, and the test now compares against the oracle rather than against a property a blank buffer also satisfies. Two house rules came out of it (28, 29).
- Also caught by re-use of an existing guard: two test views in this landing were refused by `makeView` for insufficient precision (256 bits cannot resolve a 1e-60 view; 2^-30 is not deep enough for the ladder to choose perturbation). Both were my error, and both were caught before the assertion they were meant to support.
- COPIES: 1 — checked, no duplication (grepped `escapePerturbedWithSeries`, `buildSeries`, `orbitCacheKey`). The accelerator is called from exactly one place, and its caches are the same `createLruCache` the orbit uses.
- Not yet proven: a WASM carrier for the perturbation path, WASM threads, writing tiles directly into a shared pass image, double-single for WebGL2, bivariate linear approximation, rebasing, pan-aware tile reuse — and the cost model is uncalibrated by construction.

### Landing row 15 — absolute-lattice tile caching

- Scope: tiles are cut on an absolute _sample_ lattice and cached, so panning reuses whatever it did not uncover. Ledger row 29.
- Gate: `bash scripts/gate.sh` → wasm-check + typecheck + lint + **262 unit tests** + **21 browser tests** green.
- Pins (unit, `scheduler.test.ts`): a lattice-aligned view renders **exactly the analytic oracle** cold and warm; a pan that moves both the tile column and the tile row reports reuse (`warmSkipped > 0`, fewer tiles rendered, `hits` increased); cancellation still returns no pass it did not finish.
- Pins (browser, `tests/browser/render.spec.ts`): through the real CPU backend and the real view construction, a 3-pixel pan reuses tiles and the warm image is bit-identical to a cold one.
- **The first version of this pin was inert, and mutation-checking found it.** It compared a warm render to a cold render of the same view — a natural-looking assertion that runs the _same cache key function on both sides_. I mutated `tileCacheKey` to drop the row index (so every row of tiles would collide) and **all 13 tests stayed green**: both images were wrong in the same way, so the comparison could not see it. Five mutations were then run against the rewritten pin and all five died: key without `k`, key without `l`, snapping off by one sample, blit reading the wrong source row, blit shifted by one pixel. Two house rules came out of it (30, 31).
- Reuse is not free: the view is **snapped** onto the lattice, moving the image by at most half a sample — below the resolution of the pass being rendered. The `allowOutsideView` flag on `TileRequest` exists because a latticed tile legitimately reaches outside the viewport.
- Honest note on the series figure: a later gate run measured the series accelerator at **1.08-1.10x** on the landing-14 view (54.3ms vs 59.7ms; 67.3ms vs 72.7ms) where earlier runs measured 1.3-1.5x. The range is 1.08-2.15x across runs, and the low end is the honest one to plan with.
- COPIES: 1 — checked, no duplication (grepped `latticeView`, `tileCacheKey`, `createTileCache`). The cache lives in one module, is keyed in one function, and both the scheduler and the app go through `createTileCache`.
- Not yet proven: a WASM carrier for the perturbation path, WASM threads, writing tiles directly into a shared pass image, double-single for WebGL2, bivariate linear approximation, rebasing — and the cost model is uncalibrated by construction.

### Landing row 16 — the app navigates at arbitrary precision

- Scope: the app's view state is fixed point with a precision derived from the scale; wheel, drag and link handling all go through it. Two bugs fell out of it. Ledger rows 30, 31.
- Gate: `bash scripts/gate.sh` → wasm-check + typecheck + lint + **285 unit tests** + **23 browser tests** green.
- Pins (unit, `navigate.test.ts` + `label.test.ts`): the anchored pixel is held to ≤ 4 ulps on a single zoom; 400 zoom steps reach 2^-400 with the anchor drifting < 10^-3 px; `panByPixels` moves the image by exactly the pixels dragged; the link written at depth round-trips bit-exactly; the pixel-centre convention has one owner and `centreForPixel` is its exact inverse; a width its own precision cannot represent is refused loudly; the label keeps changing at a depth where a double's centre is frozen.
- Pins (browser): the real app, driven by six `mouse.wheel` events, moves deeper, writes a fragment that decodes to the view it reports and re-encodes to the identical string, and shows no error. Separately, 400 zoom steps through the harness reach 2^-173 (beyond the f64 limit by 120 bits), the ladder refuses `direct-f64` **by name**, and the final link round-trips.
- **Bug 1, found by the wheel pin.** Six-wheel zoom — the ordinary gesture, since each notch starts a render that the next notch cancels — made the WebGPU backend fail with `[Buffer "orion-staging"] used in submit while pending map`. A cancelled render still has GPU work queued, and the staging buffer is backend-owned, so the next render was submitting into a buffer mid-read. The error was _visible_ (every dispatch already runs inside a validation error scope, ledger row 21), but the silent variant is worse: a render that overwrote that buffer would have returned the previous frame's bytes as its own. Fixed by making a render wait for the previous readback; removing the wait brings the failure straight back.
- **Bug 2, found by the same pin, in the tests.** The layout believed the app's zoom figure was `2^9` while the old pin asserted a ten-decimal centre (`-0.5000000000`). The label now prints the exact decimal expansion truncated with a visible ellipsis, and that older pin was updated rather than the behaviour.
- Three of my own expectations in this landing were wrong and failed loudly against the code (depth on a 96-pixel grid, the bits 0.75^400 buys, and a `navigationFracBits` figure). House rule 32 came out of it: compute the expected number from the quantities the test uses.
- Honest cost: navigation rounds, so the anchor moves by a few ulps per step. That is measured and reported as a fraction of a pixel (≈0 to double precision after 400 steps), not claimed to be zero.
- COPIES: 1 — checked, no duplication (grepped `pixelOffset`, `centreForPixel`, `zoomAtPixel`, `describeView`). The `+0.5` pixel-centre convention lives in `pixelOffset` and is used by the renderer, the navigator and the label.
- Not yet proven: a WASM carrier for the perturbation path, WASM threads, writing tiles directly into a shared pass image, double-single for WebGL2, bivariate linear approximation, rebasing — and the cost model is uncalibrated by construction.

### Landing row 17 — the WASM perturbation carrier

- Scope: the delta recurrence — the deep-zoom hot loop — gets a Rust→WASM carrier behind a `DeltaCarrier` seam, bit-identical to the JavaScript one. Ledger row 32.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **285 unit tests** + **30 browser tests** green.
- **The measurement that redirected the plan.** The plan was to attack the reference-orbit setup. Measured at a 2^-100 view, one 64x48 tile: orbit setup **53ms**, per-pixel delta loop **2472ms** — the loop is ~100% of the cost, at ~700 microseconds per pixel (≈1.2 microseconds per _iteration_). Floatexp arithmetic in JavaScript allocates a `{m, e}` object per operation and normalises through a `DataView`; the kernel does the same arithmetic in registers.
- A first benchmark reported 0.02ms/px and nearly hid this: with zero deltas every multiplication short-circuits. House rule 35.
- Measured result: **3.31x** on a real 2^-199 view (768 px x 300 iterations, orbit 301 values at 1024 bits; JS 199.6ms → WASM 60.3ms), and **bit-identical**.
- Pins (browser lane, `tests/browser/perturb.spec.ts`): bit-identity across the dynamic range (exponents 2^-40 to 2^20), across the glitch boundary (the flip is exactly at `d = 2^-13` for that construction — strict comparison, so `2^-13` does not glitch and `2^-14` does), across the underflow boundary (exponent gaps past 1074 bits where a term becomes exactly zero), on the series path (a starting delta that is _not_ the offset, at iteration `skip`), and on orbit exhaustion. Plus: the orbit is uploaded once per orbit however many pixels use it, and an over-long orbit or a bad budget is refused with a reason.
- End-to-end pin (`render.spec.ts`): a deep view rendered through **four real workers** (WASM carrier) is bit-identical to the serial backend on the main thread (JavaScript carrier), and the pool reports `perturbation-wasm` — so a silent fall back to the slower carrier fails the lane instead of merely being slower.
- Mutation-checking found two inert pins and they were fixed: the glitch-boundary scenario had an imaginary offset of 0.25 that dominated `|z|^2`, so no cancellation happened and the pin passed with no glitch at all (house rule 36). After the fix, four of six mutations die; the two survivors are _equivalent_ mutants on a path proven unreachable through this ABI (the `frexp` subnormal rescale, and `pow2i` returning a denormal instead of zero below 2^-1074 — neither can change a result, because an aligned sum is either exactly cancelled or at least 0.5 in magnitude). Documented rather than papered over.
- The artifact drift check now covers both kernels from one shared list in `build-wasm.sh` / `check-wasm.sh`; it caught the stale perturbation artifact the moment the ABI grew (house rule 37).
- COPIES: 1 — checked, no duplication (grepped `deltaStep`, `iterateDeltas`, `seriesStart`, `DeltaCarrier`). There is one definition of the recurrence, one place that decides where a pixel's series iteration starts, and one loop that both carriers run.
- Not yet proven: f64x2 pairing inside the kernel (the reference `2*Z_n` is shared between pixels, so SIMD should pay); a WASM carrier for the reference orbit itself; writing tiles straight into a shared pass image; double-single for WebGL2; rebasing and bivariate linear approximation.

### Landing row 18 — pass tiling, and two measurements that changed the plan

- Scope: the pass list is chosen per backend kind, so a worker pool gets enough tiles to use its workers. Ledger row 33 and (for the deferred decision) row 34.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + 291 unit tests + 31 browser tests green at the time.
- **Measurement 1 — one tile is one worker.** The app's coarse pass (120x80 samples at step 8, 600 iterations, four workers) was a single 1024-sample tile, so the pass that exists to put something on screen quickly ran on one of eight workers. Measured: **1735ms one tile against 612ms with the planner's 16 tiles — 2.8x**, and 1332ms → 607ms in an earlier run. Pinned in `passes.test.ts` (a GPU keeps single-draw tiles; a pool gets `>= workers` and `<= 8x workers` tiles; the span stays `>= 16` because 8x8 tiles measured 2.5x worse per pixel) and in `render.spec.ts` (one tile versus planned, counts asserted, timings logged).
- **Measurement 2 — rebasing is not worth implementing here.** Ten views x 3072 pixels, up to 3000 iterations, spanning 2^-6…2^-300 interior regions, mini-set and spiral neighbourhoods and escaping edges: **zero** glitches and zero orbit exhaustions. A delta starts at the pixel scale and grows about one bit per iteration, and interior orbits have negative Lyapunov exponent, so deltas decay rather than diverge. Recorded in ledger row 34 as a deferred decision — including the fact that the control case (c = -1, whose orbit hits zero) did _not_ fire, so the detector is unproven rather than proven-good.
- **Measurement 3 — pool scaling is 2.2x on eight workers** (2284ms at one, 1042ms at eight) for a small view, where fixed per-tile and per-worker orbit-setup costs dominate; per-tile overhead measured ~2.5ms. Recorded on the board rather than fixed here.
- **A plausible optimisation measured as a no-op:** specialising `fe_mul`'s normalisation for products of normalised mantissas ran at 114.1ms against 115.3ms for the generic path. Reverted (rule 39).
- COPIES: 1 — checked, no duplication (grepped `passesFor`, `backendKind`, `samplesAcross`). One place decides tiling, and both the app and the harness call it.

### Landing row 19 — bivariate linear approximation, and a bug it exposed

- Scope: BLA as a `DeltaCarrier`, composing with the series skip; plus the fix for a squared-magnitude bug in the series' validation. Ledger rows 35, 36.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **32 browser tests** green.
- Pins (`bla.test.ts`, 12): a composed two-step block equals two composed single steps; a long block validates at 2^-300 and a short one at 2^-6 (where the quadratic term is ~2^-10 and the validator refuses even a 2-step jump); tightening the tolerance drives the validated exponent to 0 rather than leaving the last candidate in place; **every pixel of an extreme-depth view matches the direct oracle exactly**; the refinement places an escaped block's count exactly (checked against a hand-computed synthetic orbit); at depth there are at least 8x fewer advances than iterations; and the series prefix composes with the jumps.
- Measured (browser, `benchmarkBla`, 24x18 px at 2^-30, 400 iterations): exact JS **152.1ms**, exact WASM kernel **40.8ms**, preview (series + BLA) **22.0ms** — preview is **1.85x faster than the WASM kernel** and 6.9x faster than the JS baseline, with **0 of 432 escape counts differing**. At 2^-60 and 2^-20 preview also won (1.47x, 1.28x) with zero differences.
- **The bug this landing exposed.** `offsetMagnitude` returned `|z|^2` while its name, its caller and the validator's parameter all said magnitude. The series validator was therefore sampling the _square_ of the view's half-diagonal — a 2^-200 neighbourhood on a 2^-100 view — so its skip and error bound were validated against far easier pixels than production. Fixed by taking the square root, and the corrected radius immediately made the series' honest cost visible: on the lane's 16-pixel view preview is now **0.65x** exact, because coefficients and validation are per view and 16 pixels cannot amortise them. The pin now asserts equal escape counts (which it can prove) instead of a speedup (which depends on the view's size).
- Honest note on the earlier series figures: the "1.3-1.5x, 2.15x" recorded in landings 14 and 15 were measured with the wrong radius, so they were partly a validation artifact. On real tiles the combined preview path is 1.85x faster than the WASM kernel; on toy views it is a net loss. Both numbers are now in the record.
- COPIES: 1 — checked, no duplication (grepped `applyJump`, `selectBlaBlock`, `buildBla`, `createBlaCarrier`). One place composes blocks, one place validates them, and the backend's threshold and the validator's starting exponent share one constant.
- Not yet proven: f64x2 pairing in the kernel, BLA inside the WASM kernel (it is JavaScript today), a WASM reference orbit, tiles written straight into shared memory, double-single for WebGL2.

### Landing row 20 — the GPU renders deep views

- Scope: a WGSL perturbation kernel behind the existing backend seam, with the reference orbit uploaded once per view and flagged pixels repaired exactly on the host. Ledger row 37.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **34 browser tests** green.
- Pins: the capability now _offers_ preview at any depth and refuses `exact` with a reason (two stale pins that asserted the old refusal were updated — that refusal was the limitation being removed); the kernel's stage is `perturbation-f32-compute` (plus `+repair` when a pixel was flagged); and the differential against the **arbitrary-precision oracle**: 192/192 counts exact at 2^-24 for budgets 4…400, plus 48/48 exact at 2^-40, 2^-60 and 2^-100 at both 300 and 2000 iterations.
- **The bug that made this landing honest.** The first version agreed on **10/192** pixels. A budget sweep showed agreement was barely better than chance even at a _four-iteration_ budget — no rounding story explains that — which located the fault as structural rather than numerical: the step's exponent was written into a `vec2<f32>` uniform field as an integer bit pattern, so the shader read a denormal, and `i32()` truncated it to 0. A 2^-24 step arrived as 0.5. Fixed by writing it as a float, and every sweep has been exact since.
- Honest scope note: the kernel holds `f32` mantissas (24 bits) against the CPU's 53. Every view measured agrees exactly, but the views measured are ones where pixels escape within a few hundred iterations; a view whose pixels stay bounded for thousands of iterations amplifies the delta's relative error far more, and that case is **not** covered by these pins. The kernel is therefore offered for `preview` only, and `exact` at depth stays with the CPU.
- Not yet proven: f64x2 pairing in the WASM kernel, BLA inside the WASM kernel, a WASM reference orbit, tiles written into shared memory, WebGL2 double-single, GPU timings (SwiftShader cannot measure them).

### Landing row 21 — WebGL2 renders deep views too

- Scope: the perturbation engine ported to GLSL ES 3.00, with the reference orbit in a float texture and the flag/repair path shared with WebGPU. Ledger row 38.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **36 browser tests** green.
- Pins: **192/192 escape counts exact** against the arbitrary-precision oracle at 2^-24 (48 iterations, every pixel escaped, so the comparison is not a page of identical interior pixels); the stage is `perturbation-f32-fragment`; and the capability offers preview at any depth while refusing `exact` with the reason that WebGL2 has no emulated-double kernel. A stale pin that asserted the old refusal — and a matching one for WebGPU — now assert the _offer_ instead, since the refusal was the limitation being removed.
- Why this one matters more than it looks: WebGL2 is the only GPU path most browsers have. Before this landing a browser without WebGPU rendered every deep view on the CPU pool; now it renders them on the GPU in preview quality, and only `exact` at depth is left to the CPU.
- Honest note: this does **not** add emulated double precision to WebGL2, which the objective names. WebGL2 now reaches any depth for preview without it, and `exact` remains CPU-side there; the double-single kernel (which needs Veltkamp splitting, as GLSL ES 3.00 has no `fma`) stays on the board as debt.
- Not yet proven: f64x2 pairing in the WASM kernel, BLA inside the WASM kernel, a WASM reference orbit, tiles written into shared memory, WebGL2 double-single, GPU timings (SwiftShader cannot measure them).

### Landing row 22 — emulated double precision on WebGL2

- Scope: the double-single kernel for WebGL2, with the exact product built by Veltkamp splitting (GLSL ES 3.00 has no `fma`), plus a shared `splitDouble` for both backends. Ledger row 39.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **38 browser tests** green.
- Pins: a boundary view at 2^-7 with **19 distinct escape counts and 0 mismatches** against the oracle (so the claim is not satisfied by a collapsed render); a 2^-24 view that plain f32 cannot express with **192/192 counts exact**; the stage is `direct-ds`; and the capability refuses `exact` past 2^-40 with the reason. Both GPU backends now reach 2^-40 in `exact`, which is what objective item 2 asks for.
- **Two bugs, both caught by pins.** (1) The ds kernel shared the L0 header, so `cRe` and `cIm` were computed from the _same_ `uOrigin`/`uStep` and every pixel received one coordinate — the non-degeneracy assertion is what found it, since a collapsed render looks exactly like a uniform view. (2) Kernel selection checked depth before quality, so `exact` at 2^-24 was routed to the preview-only perturbation shader; the capability said the same wrong thing, and the pin asserting the _stage_ exposed both.
- Honest note on the algorithm: the WebGPU and WebGL2 ds kernels are **not** bit-identical — one uses `fma` and the other Veltkamp splitting. They are held to the oracle instead of to each other, which is the right contract for two implementations of the same precision class.
- Not yet proven: f64x2 pairing in the WASM kernel, BLA inside the WASM kernel, a WASM reference orbit, tiles written into shared memory, GPU timings (SwiftShader cannot measure them).

### Landing row 23 — f64x2 pairing in the WASM delta kernel

- Scope: two pixels per instruction in the perturbation kernel, with the reference-derived quantities computed once per pair. Ledger row 40.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **38 browser tests** green.
- **Measured A/B, same view, back to back** (768 px x 300 iterations, three repeats per round): scalar kernel **172-205ms**, paired kernel **77-95ms** — about **2x on the kernel**. Against the JavaScript carrier the range is now **7.2-8.5x**, up from 3.3x when the kernel landed. The pairing is bit-identical to the JavaScript carrier on all seven differentials, which is the contract.
- Pins: the existing seven browser differentials (bit-identity across the dynamic range, the glitch boundary, the underflow boundary, the series path, orbit exhaustion, plus the two benchmarks) all run through the paired path, because every scenario with an even pixel count is paired and every odd one exercises the scalar tail.
- **Three bugs, all found by pins, none by reading the code.**
  1. `i64x2_lt`/`i64x2_gt` compare **unsigned**, and every exponent here is negative, so the glitch test fired on every pixel at iteration 1. Fixed by biasing both sides above the exponent range.
  2. All four `v128_bitselect` calls in the paired `fe_add` had their arguments **reversed**, so any sum with a zero operand collapsed to zero — and the imaginary part of a real delta is zero, so that was nearly every sum.
  3. Orbit exhaustion set its own mask, but the write path consulted only the glitch mask, reporting unreachable pixels as _bounded_.
     A fourth was structural: the complex multiply used raw lane subtraction instead of the floatexp `fe_sub`, which is an exponent-alignment step rather than a subtraction.
     The technique that found them was **isolation scenarios**: crafted orbits where each operation has an obvious answer (zn=0.5 with a zero delta, zn=4 for escape, an orbit shorter than the budget), run through the existing differential, which reports both carriers' results side by side.
- Honest note: the A/B ratios move with machine load — the JavaScript side varied 575-823ms across rounds — so the _within-run_ ratio and the kernel-only milliseconds are the numbers to trust, and both are reported.
- Not yet proven: BLA inside the WASM kernel (it is JavaScript today), a WASM reference orbit, tiles written into shared memory, GPU timings (SwiftShader cannot measure them).

### Landing row 24 — BLA in the WASM kernel

- Scope: the jump loop moved into Rust, with the coefficient tables composed on the host and uploaded. Ledger row 41.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **39 browser tests** green.
- Pins: a new differential (`benchmarkBlaCarriers`) compares the JavaScript jump carrier against the WASM one applying the _same tables_, on two views — one where every pixel escapes inside a jumped block (so all 192 are re-iterated exactly) and one deep interior view where the jumps cover the whole budget. Bit-identity is asserted on every field, along with equal escape counts, equal refinement counts and a validated block length > 0. Measured **8.34x** and **7.88x**; probes at other depths measured 13-49x.
- **One bug, found by the differential rather than by review:** the JavaScript carrier reports `refined: true` whenever it _re-iterates_ a jumped block, even when the re-iteration finds no escape inside it. The Rust version set it only on success, so the two carriers differed on exactly the pixels whose escape was found at the block boundary. Fixed by matching the JavaScript semantics — and the fix is now pinned, because "refined" is part of what the caller sees.
- Also found: the WASM carrier initially reported neither `blocks` nor `refined`, which made _every_ pixel differ in a JSON comparison. The fix was to export the accounting from the kernel rather than to compare fewer fields (rule 53).
- Honest note on calibration: `MIN_USEFUL_BLOCK_EXPONENT` was chosen when the exact kernel was scalar and the jump carrier was JavaScript. Both have changed — the exact kernel is now 2x faster and the jump carrier 8x faster — so the crossover has moved and even a 2-iteration block may now pay. Recorded on the board to re-measure rather than tweaked on a hunch.
- Not yet proven: a WASM reference orbit, tiles written into shared memory, GPU timings (SwiftShader cannot measure them).

### Landing row 25 — the jump loop is paired

- Scope: f64x2 pairing in the BLA jump loop, so both the exact and the jump engine are SIMD. Ledger row 42.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **39 browser tests** green.
- Measured, jump-dominated view (10^-15 interior, 600 iterations): **5.4ms → 3.6ms, ~1.5x**, and 9.64x against the JavaScript carrier. On a refinement-dominated view (10^-24, where all 192 pixels escape inside a jumped block and then get re-iterated exactly) the time is **unchanged** — 5.9ms → 6.4ms, within noise — because those pixels are in the scalar re-iteration. Reported as measured rather than averaged into a single flattering number.
- Bit-identity with the JavaScript carrier is asserted on both views, including the `blocks` and `refined` fields.
- Crossover check in the transition region (2^-20 and 2^-15, where only short blocks validate): preview **11.6ms** and **8.8ms** against the exact kernel's **18.4ms** and **16.7ms**, with zero differing counts. So the current block-length threshold is fine there; whether a _shorter_ block would pay more is still unmeasured, and the validator still starts at 4 iterations.
- Two bugs of mine worth recording, both from the pairing work: a temporary debug build was accidentally left in place through a bisect (the differential showed the JS and WASM results differing only in fields the debug build did not write), and a stale Vite dev server from a temporary spec made one gate run fail with a port conflict — that was my process, not the code, and the gate was re-run clean.
- Not yet proven: a WASM reference orbit, tiles written into shared memory, GPU timings (SwiftShader cannot measure them).

### Landing row 26 — tiles are written into the shared pass image

- Scope: the pass image is allocated in a `SharedArrayBuffer` when the page is isolated, each tile is given its rectangle, and the scheduler skips its blit for tiles the worker wrote in place. Ledger row 43.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **303 unit tests** + **40 browser tests** green.
- Pin: a colour view rendered through four workers is **identical to the serial backend's**, and the outcome reports **every tile written directly** (`tilesDirect === tilesRendered`), with cross-origin isolation asserted rather than assumed. The claim being tested is exactly "these pixels never crossed a thread boundary, and the image is still right".
- **A latent bug the wiring exposed:** the worker's blit sized its destination view as `rows * stride`. That is correct only for a tile-sized scratch buffer starting at offset 0 — which is all it had ever seen. Once targets became rectangles inside a larger pass image, it overran the buffer for any tile near the right edge (`Invalid typed array length: 1024`). The extent is `(rows - 1) * stride + columns * 4` (rule 57).
- Design note worth recording: zero-copy and the tile cache pull in opposite directions — pixels written into the pass image are not available to store for reuse. Resolved by path: the uncached path writes into the pass image, the cached path shares the _tile's_ buffer, so both avoid a copy without either lying (rule 58).
- Honest note on what this does and does not buy: it removes both main-thread copies per tile and the per-tile allocations, on the pass-assembly thread. It does **not** materially change wall time for a deep frame, where the per-pixel work dominates by orders of magnitude; the value is that the claim "the pixels never cross a thread boundary" is now true and pinned.
- Not yet proven: a WASM reference orbit, GPU timings (SwiftShader cannot measure them), and whether a 2-iteration BLA block pays.

### Landing row 27 — the ladder is fed by measurement

- Scope: the series prefix a render validates is recorded against the view's shape and read by the next plan, so the ladder can choose the series stage. Ledger row 44.
- Gate: `bash scripts/gate.sh` → wasm-check (both kernels) + typecheck + lint + **309 unit tests** + **41 browser tests** green.
- Pins (`measurements.test.ts`, 6): a measurement is remembered per view shape and not shared across budgets or scales; two views a pixel apart _do_ share it; the store is bounded with oldest-first eviction; a malformed measurement is refused; and with a measured skip the plan selects the series stage with a strictly lower `estimatedWork`, while `exact` still refuses it.
- Pin (browser lane): the whole loop — plan, render, re-plan — asserted against a real deep view. Measured: `perturbation` (work 174,823) → a render that validates **399 of 400 iterations** → `perturbation-series` (work 4,477, **39x lower**), and the render's own stage string shows `perturbation+series+bla`.
- Why this mattered: the ladder had priced `measuredSeriesSkip` since it landed, and nothing ever produced one, so the series stage was unreachable in the product — a rung that could not be climbed. Every test of the pricing arithmetic passed the whole time (rule 59).
