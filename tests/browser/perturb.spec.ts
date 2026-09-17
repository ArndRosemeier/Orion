import { expect, test, type Page } from "playwright/test";
import type {
  HarnessViewConfig,
  OrionHarness,
  PerturbScenario,
} from "../../src/test-harness/render";

/**
 * The WASM delta kernel against the JavaScript one.
 *
 * The contract is **bit-identity**, so the comparison is exact equality of every
 * field — escape iteration, smooth count, glitch flag and glitch reason. A
 * tolerance here would hide exactly the class of bug a carrier swap can
 * introduce (an off-by-one, a lost normalisation, a rounding difference), and
 * those are the bugs that move pixels.
 *
 * It lives in the browser lane because that is where the module is loaded the
 * way the app loads it, and because the harness cannot be handed closures: the
 * scenarios below are plain data.
 */

/** A delta that starts at the given mantissa/exponent, for both parts. */
function request(
  dcRe: [number, number],
  dcIm: [number, number],
  startIteration = 1,
  startRe: [number, number] = dcRe,
  startIm: [number, number] = dcIm,
) {
  return { dcRe, dcIm, startRe, startIm, startIteration };
}

/** Run one scenario through both carriers, once. */
async function run(page: Page, scenario: PerturbScenario) {
  return page.evaluate((input: PerturbScenario) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.runPerturbationDifferential(input, 1);
  }, scenario);
}

test("the two carriers agree bit for bit across the whole dynamic range", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // An orbit that grows, shrinks, passes through zero and changes sign: the four
  // ways a delta can be amplified, damped, cancelled or inverted.
  const orbit: [number, number][] = [
    [0, 0],
    [0.7, 0],
    [-0.31, -1],
    [0.21, -8],
    [0.65, 1],
    [-0.9, -1],
    [0.1, -12],
    [0.5, 0],
    [-0.2, -1],
    [0.9, -1],
  ];
  const requests = [];
  for (let i = 0; i < 120; i++) {
    // Deterministic spread of exponents from 2^-40 to 2^20, so both the ordinary
    // path and the exponent-alignment path are exercised.
    const reExponent = -40 + (i % 61);
    const imExponent = -40 + ((i * 7) % 61);
    requests.push(
      request([0.5 + (i % 3) * 0.1, reExponent], [-(0.5 + (i % 5) * 0.05), imExponent]),
    );
  }
  const result = await run(page, { orbit, requests, maxIterations: 9 });
  expect(result.jsCarrier).toBe("js-floatexp");
  expect(result.wasmCarrier).toBe("wasm-floatexp");
  expect(result.mismatches).toEqual([]);
  expect(result.identical).toBe(true);
});

test("the two carriers agree on the glitch boundary, and the boundary is where we say", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // With `Z_1 = 0.5` and `dc = -(0.5 - d)` the sum is exactly `d`, so
  // `|z|^2 / |Z|^2` is exactly `4d^2`. The threshold is `2^-24`, so the flip is
  // exactly at `d = 2^-13` — and the comparison is strict, so `2^-13` itself
  // does not glitch while `2^-14` does. A kernel whose constant drifted by even
  // two bits would disagree here and nowhere else.
  const orbit: [number, number][] = [
    [0, 0],
    [0.5, 0],
    [0.25, 0],
    [0.5, -2],
  ];
  // `frexp(-(0.5 - d))`: the magnitude is just under 0.5, so the normalised
  // form is `-0.999... x 2^-1`.
  const at = (exponent: number): [number, number] => [-(0.5 - 2 ** exponent) * 2, -1];
  // The imaginary offset must be negligible, or it dominates |z|^2 and no
  // cancellation happens at all — which is exactly what the first version of
  // this scenario did, making the pin pass for the wrong reason.
  const requests = [-16, -15, -14, -13, -12, -11].map((exponent) =>
    request(at(exponent), [0.5, -81]),
  );
  const result = await run(page, { orbit, requests, maxIterations: 3 });
  expect(result.mismatches).toEqual([]);

  // The line seen from the JavaScript side, so this fails if the *threshold*
  // moves rather than only if the two carriers diverge.
  const glitched = result.js.map((entry) => entry.glitched);
  expect(glitched).toEqual([true, true, true, false, false, false]);
});

test("the two carriers agree where an exponent gap underflows a term to zero", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // Gaps past 1074 bits are where `2^gap` becomes `0` rather than a subnormal and
  // the term disappears from the sum. Reachable at real depth; the boundary a
  // shift-based implementation gets wrong.
  const orbit: [number, number][] = [
    [0, 0],
    [0.5, -100],
    [0.5, 0],
    [0.25, 0],
  ];
  const requests = [
    request([0.5, -1122], [0.5, -1]),
    request([0.5, -1174], [0.5, -1]),
    request([0.5, -3000], [0.5, -1]),
  ];
  const result = await run(page, { orbit, requests, maxIterations: 3 });
  expect(result.mismatches).toEqual([]);
  // Non-degenerate: the gaps really are past the underflow point.
  expect(-3000 - -100).toBeLessThan(-1074);
});

test("the two carriers agree on the series path, where the loop starts late", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // A starting delta at iteration 5 that is *not* the offset: this is the shape
  // the series accelerator produces, and it is the path the app actually renders
  // in preview. An implementation that assumed `start === dc` would pass every
  // other pin and fail here.
  const orbit: [number, number][] = [
    [0, 0],
    [0.5, 0],
    [0.25, 0],
    [0.5, -1],
    [0.25, -1],
    [0.5, -2],
    [0.25, -2],
    [0.5, -3],
  ];
  const requests = [
    request([0.5, -20], [0.5, -21], 5, [0.5, -18], [-0.5, -19]),
    request([0.5, -20], [0.5, -21], 3, [0.5, -16], [0.5, -17]),
    request([0.5, -30], [0.5, -31], 1),
  ];
  const result = await run(page, { orbit, requests, maxIterations: 8 });
  expect(result.mismatches).toEqual([]);
  expect(result.js).toHaveLength(3);
});

test("the two carriers agree on orbit exhaustion and report the same iteration", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const orbit: [number, number][] = [
    [0, 0],
    [0.5, 0],
    [0.25, 0],
  ];
  const result = await run(page, {
    orbit,
    requests: [request([0.5, -2], [0.5, -2])],
    maxIterations: 40,
  });
  expect(result.mismatches).toEqual([]);
  expect(result.js[0]).toEqual({
    glitched: true,
    iterations: 3,
    reason: "orbit-exhausted",
  });
});

test("the kernel is measurably faster on a real deep view, and agrees with the JS carrier", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // 10^-60 (about 2^-199) across 32x24 pixels, 300 iterations: a deep view where
  // the ladder picks the perturbation engine, at a size the lane can afford. 512
  // fractional bits, because a 10^-60 width over 32 pixels needs ~269. This is
  // the number the landing rests on, so it is measured here rather than derived.
  const deep: HarnessViewConfig = {
    centerRe: "-0.743643887037151",
    centerIm: "0.13182590420533",
    width: `0.${"0".repeat(59)}1`,
    fracBits: 512,
    pixelWidth: 32,
    pixelHeight: 24,
    maxIterations: 300,
  };
  const report = await page.evaluate(async (config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.benchmarkPerturbation(config, 1);
  }, deep);

  expect(report.carrier).toBe("wasm-floatexp");
  expect(report.stage).toBe("perturbation");
  expect(report.mismatches).toEqual([]);
  expect(report.identical).toBe(true);
  expect(report.pixels).toBe(32 * 24);
  console.log(
    `perturbation carriers: js=${report.jsMs.toFixed(1)}ms wasm=${report.wasmMs.toFixed(1)}ms speedup=${report.speedup.toFixed(2)}x over ${report.pixels} px x ${report.iterations} iterations (orbit ${report.orbitLength} @ ${report.orbitFracBits} bits)`,
  );
  expect(report.speedup).toBeGreaterThan(1.5);
});

/**
 * BLA, measured against the two things it has to beat: the exact JavaScript
 * carrier (the reference for the approximation) and the WASM kernel (which is
 * what preview used to fall back on).
 */
test("BLA jumps most of a deep view's iterations and still agrees with exact escape counts", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // 10^-30 over 24x18 pixels: deep enough that long blocks validate, small
  // enough that the lane can afford to run all three variants. Measured at
  // 2^-60, 2^-30 and 2^-20, the preview path beat the WASM kernel every time
  // (1.47x, 1.49x, 1.28x) with zero differing pixels.
  const deep: HarnessViewConfig = {
    centerRe: "-0.743643887037151",
    centerIm: "0.13182590420533",
    width: `0.${"0".repeat(29)}1`,
    fracBits: 512,
    pixelWidth: 24,
    pixelHeight: 18,
    maxIterations: 400,
  };
  const report = await page.evaluate(async (config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.benchmarkBla(config, 2);
  }, deep);

  console.log(
    `BLA bench: exact-js=${report.exactJsMs.toFixed(1)}ms (${report.exactJsStage}) exact-wasm=${report.exactWasmMs.toFixed(1)}ms (${report.exactWasmStage}) preview=${report.previewMs.toFixed(1)}ms (${report.previewStage}) differing=${report.differing}/${report.pixels} worstShift=${report.worstShift}`,
  );

  // The preview path must actually have taken BLA, and said so.
  expect(report.previewStage).toBe("perturbation+series+bla");
  expect(report.exactWasmStage).toBe("perturbation-wasm");
  expect(report.exactJsStage).toBe("perturbation");
  // Approximation contract: at this depth the deltas are small enough that the
  // discarded quadratic term never changes an escape count, so preview agrees
  // with exact for every pixel — measured, not assumed.
  expect(report.differing).toBe(0);
});

/**
 * The WASM jump kernel against the JavaScript one.
 *
 * Same algorithm, same coefficients — the tables are composed on the host by the
 * JavaScript code either way, so the two carriers must agree *exactly*, not
 * approximately. That is the contract that makes the speedup safe to rely on.
 */
test("the WASM jump kernel is bit-identical to the JavaScript carrier, and faster", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // Two views, because they exercise different paths: one where every pixel
  // escapes inside a jumped block (so the escaping block is re-iterated exactly)
  // and one deep interior view where the jumps cover the whole budget.
  const cases: HarnessViewConfig[] = [
    {
      centerRe: "-0.75",
      centerIm: "0.1",
      width: `0.${"0".repeat(23)}1`, // 10^-24
      fracBits: 256,
      pixelWidth: 16,
      pixelHeight: 12,
      maxIterations: 48,
    },
    {
      centerRe: "-0.743643887037151",
      centerIm: "0.13182590420533",
      width: `0.${"0".repeat(14)}1`, // 10^-15, interior at this budget
      fracBits: 256,
      pixelWidth: 16,
      pixelHeight: 12,
      maxIterations: 600,
    },
  ];

  for (const config of cases) {
    const report = await page.evaluate(async (cfg: HarnessViewConfig) => {
      const api = (window as unknown as { __orion?: OrionHarness }).__orion;
      if (!api) throw new Error("harness API missing");
      return api.benchmarkBlaCarriers(cfg, 3);
    }, config);
    console.log(
      `BLA carriers ${config.width.slice(-6)}: block=2^${report.blockExponent} js=${report.jsMs.toFixed(1)}ms wasm=${report.wasmMs.toFixed(1)}ms speedup=${report.speedup.toFixed(2)}x escaped=${report.jsEscaped}/${report.pixels} refined=${report.jsRefined} identical=${report.identical}`,
    );
    // The contract: same coefficients, same algorithm, same answers.
    expect(report.mismatches).toEqual([]);
    expect(report.identical).toBe(true);
    expect(report.blockExponent).toBeGreaterThan(0);
    expect(report.wasmEscaped).toBe(report.jsEscaped);
    expect(report.wasmRefined).toBe(report.jsRefined);
    // Non-degeneracy: the pixels escaped, and any escaping block that was jumped
    // was re-iterated by both carriers.
    if (report.jsEscaped === report.pixels) {
      expect(report.jsRefined).toBeGreaterThan(0);
    }
  }
});
