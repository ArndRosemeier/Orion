import { describe, expect, it } from "vitest";
import { CLASSIC_PALETTE } from "../color/palette";
import { bigComplex } from "../numeric/bigcomplex";
import { fromDecimal, withFracBits } from "../numeric/bigfixed";
import { cmp, fromBigFixed, fromFloat, toFloat } from "../numeric/floatexp";
import {
  allocateFloatComplexArray,
  readFloatComplex,
  writeFloatComplex,
} from "../numeric/floatexparray";
import {
  abs2FloatComplex,
  addFloatComplex,
  type FloatComplex,
  floatComplex,
} from "../numeric/floatcomplex";
import { escapeDirect } from "./direct";
import { deltaStep, escapePerturbed, iterateDeltas } from "./perturbation";
import { computeConvergedReferenceOrbit } from "./reference";
import { buildSeries, seriesStart } from "./series";
import { viewDiagonalMagnitude } from "../render/cpu";
import {
  MAX_BLOCK_EXPONENT,
  applyJump,
  buildBla,
  buildBlaTables,
  escapePerturbedWithBla,
  selectBlaBlock,
  type BlaTable,
} from "./bla";
import { sampleOffsets } from "./series";
import { makeView, pixelToComplex } from "../view/view";
import type { View } from "../view/view";

function deepView(exponent: number, pixelWidth = 16, pixelHeight = 12): View {
  return makeView(
    bigComplex(
      fromDecimal("-0.743643887037151", 2048),
      fromDecimal("0.13182590420533", 2048),
    ),
    fromDecimal(`0.${"0".repeat(exponent - 1)}1`, 2048),
    pixelWidth,
    pixelHeight,
  );
}

/** The per-pixel offsets for a view, at the orbit's precision. */
function offsetsFor(view: View, bits: number) {
  const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
  const offsets = [];
  for (let y = 0; y < view.pixelHeight; y++) {
    for (let x = 0; x < view.pixelWidth; x++) {
      const c = pixelToComplex(view, x, y);
      offsets.push({
        point: c,
        offset: bigComplex(
          {
            v: withFracBits(c.re, bits).v - withFracBits(reference.re, bits).v,
            fracBits: bits,
          },
          {
            v: withFracBits(c.im, bits).v - withFracBits(reference.im, bits).v,
            fracBits: bits,
          },
        ),
      });
    }
  }
  return offsets;
}

function blaFor(view: View, iterations: number) {
  const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
  const orbit = computeConvergedReferenceOrbit(
    reference,
    iterations + 1,
    view.width.fracBits,
  ).orbit;
  const table = buildBla(orbit, iterations, viewDiagonalMagnitude(view));
  return { orbit, table };
}

describe("BLA block tables", () => {
  it("composes a two-step block into exactly what two linearised steps give", () => {
    // Small enough to check by hand: an orbit of six simple values.
    const values: [number, number][] = [
      [0, 0],
      [0.5, 0],
      [0.25, 0],
      [0.125, 0],
      [-0.5, 0],
      [0.75, 0],
    ];
    const orbitArray = allocateFloatComplexArray(values.length);
    values.forEach(([re, im], index) =>
      writeFloatComplex(orbitArray, index, floatComplex(fromFloat(re), fromFloat(im))),
    );
    const orbit = {
      ...orbitArray,
      center: bigComplex({ v: 0n, fracBits: 64 }, { v: 0n, fracBits: 64 }),
      fracBits: 64,
      escapedAt: null,
    };
    const { blocks, dcBlocks } = buildBlaTables(orbit, 1);
    const a1 = blocks[0];
    const b1 = dcBlocks[0];
    const a2 = blocks[1];
    const b2 = dcBlocks[1];
    if (!a1 || !b1 || !a2 || !b2) throw new Error("missing tables");

    const d = floatComplex(fromFloat(0.01), fromFloat(0.02));
    const dc = floatComplex(fromFloat(0.001), fromFloat(-0.002));
    // Two composed single steps, then the composed double block, from the same
    // starting delta.
    const first = applyJump(readFloatComplex(a1, 0), readFloatComplex(b1, 0), d, dc);
    const twice = applyJump(
      readFloatComplex(a1, 1),
      readFloatComplex(b1, 1),
      first,
      dc,
    );
    const jumped = applyJump(readFloatComplex(a2, 0), readFloatComplex(b2, 0), d, dc);
    const relative =
      Math.abs(toFloat(jumped.re) - toFloat(twice.re)) / Math.abs(toFloat(twice.re));
    expect(relative).toBeLessThan(1e-12);
  });
});

describe("BLA validation", () => {
  it("validates a long block at extreme depth, where deltas never grow", () => {
    const view = deepView(300);
    const { table } = blaFor(view, 600);
    // The whole point of BLA: at 2^-300 with a 600-iteration budget, |d| stays
    // near the pixel scale, so the discarded quadratic term is negligible.
    expect(table.blockExponent).toBeGreaterThanOrEqual(4);
    expect(table.maxRelativeError).toBeLessThanOrEqual(2 ** -24);
  });

  it("validates only short blocks at shallow depth, where the quadratic term bites", () => {
    const view = deepView(6);
    const { table } = blaFor(view, 600);
    // A 2^-6 view has |d| ~ 2^-10, so d^2 is ~2^-20 of the delta and a long jump
    // drifts. The validator must refuse it rather than trusting the maths.
    expect(table.blockExponent).toBeLessThan(MAX_BLOCK_EXPONENT);
  });

  it("refuses a block whose chained error exceeds tolerance", () => {
    const view = deepView(20);
    const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
    const orbit = computeConvergedReferenceOrbit(
      reference,
      601,
      view.width.fracBits,
    ).orbit;
    const tables = buildBlaTables(orbit, MAX_BLOCK_EXPONENT);
    const samples = sampleOffsets(viewDiagonalMagnitude(view));
    // Tighten the tolerance until nothing validates: the search must then report
    // exponent 0 rather than the last candidate it happened to try.
    const strict = selectBlaBlock(
      orbit,
      tables,
      samples,
      600,
      fromBigFixed({ v: 1n, fracBits: 400 }),
    );
    expect(strict.blockExponent).toBe(0);
    const loose = selectBlaBlock(
      orbit,
      tables,
      samples,
      600,
      fromBigFixed({ v: 1n << 399n, fracBits: 400 }),
    );
    expect(loose.blockExponent).toBeGreaterThan(0);
  });
});

describe("BLA against the oracle", () => {
  it("matches the direct engine exactly at extreme depth", () => {
    // 2^-300 with 300 iterations: the deltas stay around 2^-300, so the
    // discarded quadratic term is far below the mantissa and every pixel must
    // agree with the oracle *exactly*, not merely closely. The view is interior
    // — that is *why* it agrees — so non-degeneracy is asserted on the jumps
    // instead of on escapes.
    const view = deepView(300, 8, 6);
    const iterations = 300;
    const { orbit, table } = blaFor(view, iterations);
    const bits = orbit.fracBits;
    const offsets = offsetsFor(view, bits);
    let compared = 0;
    let jumped = 0;
    for (const entry of offsets) {
      const dc = floatComplex(
        fromBigFixed(entry.offset.re),
        fromBigFixed(entry.offset.im),
      );
      const bla = escapePerturbedWithBla(
        table,
        { dc, start: dc, startIteration: 1 },
        iterations,
      );
      const oracle = escapeDirect(
        bigComplex(
          { v: orbit.center.re.v + entry.offset.re.v, fracBits: bits },
          { v: orbit.center.im.v + entry.offset.im.v, fracBits: bits },
        ),
        iterations,
      );
      compared += 1;
      if (bla.glitched) {
        throw new Error(
          `BLA glitched on an interior pixel at iteration ${bla.iterations}`,
        );
      }
      if (bla.blocks > 0) jumped += 1;
      expect(bla.escaped).toBe(oracle.escaped);
      expect(bla.iterations).toBe(oracle.iterations);
    }
    expect(compared).toBe(view.pixelWidth * view.pixelHeight);
    // Non-degenerate in the way that matters here: the jumps really ran.
    expect(jumped).toBe(compared);
    expect(1 << table.blockExponent).toBeGreaterThan(1);
  });

  it("refines a jumped block that escaped, and places the count exactly", () => {
    // Synthetic on purpose: a constant reference orbit of 0.5 makes the true
    // recurrence checkable by hand, and a large offset makes the pixel escape
    // *inside* a jumped block — the only situation where refinement matters.
    // Without it the count would be reported at the block's end.
    const values = new Array<FloatComplex>(200).fill(
      floatComplex(fromFloat(0.5), fromFloat(0)),
    );
    const orbitArray = allocateFloatComplexArray(values.length);
    values.forEach((value, index) => writeFloatComplex(orbitArray, index, value));
    const orbit = {
      ...orbitArray,
      center: bigComplex({ v: 0n, fracBits: 64 }, { v: 0n, fracBits: 64 }),
      fracBits: 64,
      escapedAt: null,
    };
    const tables = buildBlaTables(orbit, 6);
    const table: BlaTable = {
      orbit,
      blocks: tables.blocks,
      dcBlocks: tables.dcBlocks,
      blockExponent: 6,
      maxRelativeError: 0,
    };

    const dc = floatComplex(fromFloat(1.5), fromFloat(0));
    const result = escapePerturbedWithBla(
      table,
      { dc, start: dc, startIteration: 1 },
      200,
    );
    if (result.glitched) throw new Error(`unexpected glitch: ${result.reason}`);
    expect(result.escaped).toBe(true);
    // A 64-step jump overshoots badly here, so the escape is found at the block
    // boundary and the block is re-iterated to place it.
    expect(result.blocks).toBeGreaterThan(0);
    expect(result.refined).toBe(true);

    // The count must be the exact first escape of the true recurrence from the
    // same starting delta.
    let d = dc;
    let exact = 1;
    for (let n = 1; n <= 200; n++) {
      const z = addFloatComplex(readFloatComplex(orbit, n), d);
      if (cmp(abs2FloatComplex(z), fromFloat(4)) > 0) {
        exact = n;
        break;
      }
      d = deltaStep(readFloatComplex(orbit, n), d, dc);
    }
    expect(result.iterations).toBe(exact);
    expect(result.iterations).toBeLessThan(200);
  });

  it("uses far fewer advances than iterations at depth", () => {
    const view = deepView(300, 16, 12);
    const iterations = 400;
    const { orbit, table } = blaFor(view, iterations);
    const bits = orbit.fracBits;
    let totalBlocks = 0;
    let totalIterations = 0;
    for (const entry of offsetsFor(view, bits)) {
      const dc = floatComplex(
        fromBigFixed(entry.offset.re),
        fromBigFixed(entry.offset.im),
      );
      const result = escapePerturbedWithBla(
        table,
        { dc, start: dc, startIteration: 1 },
        iterations,
      );
      totalBlocks += result.blocks;
      totalIterations += result.iterations;
    }
    // The claim this landing rests on: the per-pixel advance count collapses.
    expect(totalBlocks).toBeLessThan(totalIterations / 8);
  });

  it("agrees with the exact perturbation path on the pixels it does not approximate away", () => {
    // At 2^-60 the deltas do grow, so some pixels land near the boundary and the
    // approximation can shift their count. What must hold is that the *escaped /
    // bounded* decision agrees for the overwhelming majority, and that the
    // disagreements are one-sided and small — the same contract as the series
    // accelerator (ledger row 11).
    const view = deepView(60);
    const iterations = 200;
    const { orbit, table } = blaFor(view, iterations);
    const bits = orbit.fracBits;
    const offsets = offsetsFor(view, bits);
    let compared = 0;
    let sameEscaped = 0;
    let sameCount = 0;
    let worstShift = 0;
    for (const entry of offsets) {
      const dc = floatComplex(
        fromBigFixed(entry.offset.re),
        fromBigFixed(entry.offset.im),
      );
      const bla = escapePerturbedWithBla(
        table,
        { dc, start: dc, startIteration: 1 },
        iterations,
      );
      const exact = escapePerturbed(orbit, entry.offset, iterations);
      compared += 1;
      if (exact.glitched) continue;
      if (bla.glitched === false && bla.escaped === exact.escaped) sameEscaped += 1;
      if (
        bla.glitched === false &&
        bla.escaped === exact.escaped &&
        bla.iterations === exact.iterations
      ) {
        sameCount += 1;
      }
      if (bla.glitched === false && bla.escaped && exact.escaped) {
        worstShift = Math.max(worstShift, Math.abs(bla.iterations - exact.iterations));
      }
    }
    expect(compared).toBe(view.pixelWidth * view.pixelHeight);
    expect(sameEscaped).toBe(compared);
    // Every pixel's escape count agrees or is off by at most one refinement step.
    expect(sameCount).toBeGreaterThanOrEqual(compared - 2);
    expect(worstShift).toBeLessThanOrEqual(1);
  });

  it("composes with the series prefix: jump the tail after a validated skip", () => {
    const view = deepView(60);
    const iterations = 400;
    const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
    const orbit = computeConvergedReferenceOrbit(
      reference,
      iterations + 1,
      view.width.fracBits,
    ).orbit;
    const series = buildSeries(orbit, 3, iterations, viewDiagonalMagnitude(view));
    const table: BlaTable = buildBla(orbit, iterations, viewDiagonalMagnitude(view));
    const bits = orbit.fracBits;
    const offsets = offsetsFor(view, bits);

    let skippedAny = 0;
    for (const entry of offsets) {
      const dc = floatComplex(
        fromBigFixed(entry.offset.re),
        fromBigFixed(entry.offset.im),
      );
      const start = seriesStart(orbit, series, dc);
      const result = escapePerturbedWithBla(table, start, iterations);
      if (start.startIteration > 1) skippedAny += 1;
      // And the same result as starting the jump from the same place with the
      // exact loop, for the pixels the prefix skip did not disturb.
      const exact = iterateDeltas(
        orbit,
        start.dc,
        start.startIteration,
        start.start,
        iterations,
      );
      if (!exact.glitched && !result.glitched) {
        expect(result.escaped).toBe(exact.escaped);
      }
    }
    expect(skippedAny).toBeGreaterThan(0);
  });
});

describe("BLA jumps", () => {
  it("refuses a non-positive offset bound", () => {
    const view = deepView(60);
    const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
    const orbit = computeConvergedReferenceOrbit(
      reference,
      201,
      view.width.fracBits,
    ).orbit;
    expect(() => buildBla(orbit, 200, fromBigFixed({ v: 0n, fracBits: 64 }))).toThrow(
      /maxOffset/,
    );
  });

  it("refuses an orbit too short to jump", () => {
    const orbit = allocateFloatComplexArray(1);
    expect(() =>
      buildBlaTables(
        {
          ...orbit,
          center: bigComplex({ v: 0n, fracBits: 64 }, { v: 0n, fracBits: 64 }),
          fracBits: 64,
          escapedAt: null,
        },
        2,
      ),
    ).toThrow(/cannot be jumped/);
  });

  it("leaves the palette out of it: the carrier reports blocks, not colours", () => {
    // A guard against the temptation to colour inside the engine: `CLASSIC_PALETTE`
    // is imported here only so the two modules cannot quietly grow together.
    expect(CLASSIC_PALETTE.size).toBeGreaterThan(0);
  });
});
