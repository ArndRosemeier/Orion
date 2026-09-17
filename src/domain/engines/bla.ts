/**
 * Bivariate linear approximation: jump many delta iterations at once.
 *
 * ## The idea
 *
 * The delta recurrence is `d_{n+1} = 2*Z_n*d_n + d_n^2 + dc`. Drop the quadratic
 * term and the map from `(d, dc)` to `d` is **linear**, so a whole block of
 * iterations collapses into two complex coefficients:
 *
 *     d_{n+m} ~= A(n, m) * d_n + B(n, m) * dc
 *
 * `A` is the derivative of the block along the reference orbit and `B` is its
 * sensitivity to the offset. Both are built once per view by composing blocks of
 * length `2^j`:
 *
 *     A(n, 2m) = A(n+m, m) * A(n, m)
 *     B(n, 2m) = A(n+m, m) * B(n, m) + B(n+m, m)
 *
 * A pixel then advances `m` iterations for the cost of two complex multiplies
 * instead of `m` full ones. At a 2^-300 view, where `|d|` stays around 2^-300
 * for the whole budget, the discarded term is utterly negligible and one jump
 * can cover thousands of iterations.
 *
 * ## Why the series approximation does not already do this
 *
 * The series accelerator (`series.ts`) expands `d_n` as a power series in `dc`
 * and skips a *prefix*, once. BLA is the complementary tool: it re-anchors at
 * every block boundary, so it keeps working long after the power series has been
 * left behind — which is exactly the regime where the series skip stops
 * validating. They compose: the series skips the prefix, BLA jumps the tail.
 *
 * ## Validate, do not extrapolate
 *
 * The block length is not derived from a formula. For sample offsets spanning the
 * view, the *chained* jump sequence is compared against exact delta iteration at
 * every block boundary, and the largest block whose worst relative error stays
 * inside tolerance is the one used. Chaining matters: one jump of 64 can look
 * excellent while ten in a row drift, because each re-anchors on an already
 * approximate delta.
 *
 * ## What is approximated, and what is therefore gated
 *
 * Every jump discards `d^2`, and the escape and glitch tests are only evaluated
 * at *block boundaries*. Escape is safe to test sparsely — `|z| > 2` is monotone,
 * so a pixel that escapes inside a block is still outside at its end — but its
 * *iteration count* is not exact, so the escaping block is re-iterated exactly
 * (`refined`) before reporting. A glitch wholly inside a block can be missed,
 * which is a real limitation of the approximation and the reason this carrier is
 * offered for `preview` only, exactly like the series accelerator.
 */

import {
  type Floatexp,
  cmp,
  div as feDiv,
  fromFloat,
  mul as feMul,
  toFloat,
} from "../numeric/floatexp";
import {
  allocateFloatComplexArray,
  type FloatComplexArray,
  readFloatComplex,
  writeFloatComplex,
} from "../numeric/floatexparray";
import {
  abs2FloatComplex,
  addFloatComplex,
  type FloatComplex,
  floatComplex,
  mulFloatComplex,
  subFloatComplex,
} from "../numeric/floatcomplex";
import { type DeltaCarrier, type DeltaRequest, deltaStep } from "./perturbation";
import type { ReferenceOrbit } from "./reference";
import { SERIES_RELATIVE_TOLERANCE, sampleOffsets } from "./series";

const ONE = fromFloat(1);
const ZERO = fromFloat(0);
const ESCAPE_THRESHOLD = fromFloat(4);
const TOLERANCE = fromFloat(SERIES_RELATIVE_TOLERANCE);
const GLITCH_THRESHOLD = fromFloat(2 ** -24);
const ONE_COMPLEX: FloatComplex = floatComplex(ONE, ZERO);
const ZERO_COMPLEX: FloatComplex = floatComplex(ZERO, ZERO);

/**
 * Largest block, as a power of two.
 *
 * 64 is a compromise: a longer block jumps further but re-anchors less often, and
 * both the per-view table cost and the missed-glitch window grow with it.
 */
export const MAX_BLOCK_EXPONENT = 6;

/**
 * Shortest block worth validating: `2^2 = 4` iterations.
 *
 * A jump costs two complex multiplies in JavaScript — roughly what four
 * iterations of the WASM kernel cost — so shorter blocks are never taken and
 * must not be paid for during validation either. Exported so the backend's
 * threshold and the validator's starting point cannot drift apart.
 */
export const MIN_USEFUL_BLOCK_EXPONENT = 2;

export type BlaTable = {
  readonly orbit: ReferenceOrbit;
  /** `blocks[j]` holds `A(n, 2^j)`; `dcBlocks[j]` holds `B(n, 2^j)`. */
  readonly blocks: readonly FloatComplexArray[];
  readonly dcBlocks: readonly FloatComplexArray[];
  /**
   * Validated jump length as a power of two exponent. `0` means no jump
   * validated, i.e. BLA is unusable on this view and the exact path should be
   * used instead. Reported rather than silently ignored.
   */
  readonly blockExponent: number;
  /** Worst relative error of the chained jumps at that length. */
  readonly maxRelativeError: number;
};

export type BlaEscapeResult =
  | {
      readonly glitched: false;
      readonly escaped: boolean;
      readonly iterations: number;
      readonly smooth: number | null;
      /** Jumps taken; `iterations / blocks` is the average block length. */
      readonly blocks: number;
      /** True when the escaping block was re-iterated exactly. */
      readonly refined: boolean;
    }
  | {
      readonly glitched: true;
      readonly iterations: number;
      readonly reason: "precision" | "orbit-exhausted";
      readonly blocks: number;
      readonly refined: boolean;
    };

function assertTableInputs(orbit: ReferenceOrbit, maxBlockExponent: number): void {
  if (!Number.isInteger(maxBlockExponent) || maxBlockExponent < 0) {
    throw new Error(
      `bla: maxBlockExponent must be a non-negative integer (got ${maxBlockExponent})`,
    );
  }
  if (orbit.length < 2) {
    throw new Error(`bla: an orbit of ${orbit.length} values cannot be jumped`);
  }
}

/**
 * Build the block tables for a reference orbit.
 *
 * The `j = 0` table is the single-step linearisation: `A = 2*Z_n`, `B = 1`.
 * Higher tables are composed by doubling, so the whole table costs
 * `O(length * maxBlockExponent)` complex operations — paid once per view, like
 * the reference orbit itself.
 */
export function buildBlaTables(
  orbit: ReferenceOrbit,
  maxBlockExponent = MAX_BLOCK_EXPONENT,
): { blocks: FloatComplexArray[]; dcBlocks: FloatComplexArray[] } {
  assertTableInputs(orbit, maxBlockExponent);
  const length = orbit.length;
  const blocks: FloatComplexArray[] = [];
  const dcBlocks: FloatComplexArray[] = [];

  const single = allocateFloatComplexArray(length);
  const singleDc = allocateFloatComplexArray(length);
  for (let n = 0; n < length; n++) {
    // The last entry has no successor to jump to. Leaving it zero makes an
    // out-of-range jump visible as a zero rather than as a plausible value.
    if (n + 1 >= length) {
      writeFloatComplex(single, n, ZERO_COMPLEX);
      writeFloatComplex(singleDc, n, ZERO_COMPLEX);
      continue;
    }
    const zn = readFloatComplex(orbit, n);
    // d_{n+1} = 2*Z_n*d_n + 1*dc + d_n^2: the linear part is (2*Z_n, 1).
    writeFloatComplex(single, n, addFloatComplex(zn, zn));
    writeFloatComplex(singleDc, n, ONE_COMPLEX);
  }
  blocks.push(single);
  dcBlocks.push(singleDc);

  for (let j = 1; j <= maxBlockExponent; j++) {
    const half = 1 << (j - 1);
    const previousA = blocks[j - 1] as FloatComplexArray;
    const previousB = dcBlocks[j - 1] as FloatComplexArray;
    const a = allocateFloatComplexArray(length);
    const b = allocateFloatComplexArray(length);
    for (let n = 0; n + 2 * half < length; n++) {
      const a1 = readFloatComplex(previousA, n);
      const b1 = readFloatComplex(previousB, n);
      const a2 = readFloatComplex(previousA, n + half);
      const b2 = readFloatComplex(previousB, n + half);
      // Compose "first block, then second": z -> A2*(A1*z + B1) + B2. The
      // multiplication order is fixed, because complex multiplication in
      // floating point is not commutative and the pin compares against exact
      // iteration.
      writeFloatComplex(a, n, mulFloatComplex(a2, a1));
      writeFloatComplex(b, n, addFloatComplex(mulFloatComplex(a2, b1), b2));
    }
    blocks.push(a);
    dcBlocks.push(b);
  }
  return { blocks, dcBlocks };
}

/** One jump: `d -> A*d + B*dc`. */
export function applyJump(
  a: FloatComplex,
  b: FloatComplex,
  d: FloatComplex,
  dc: FloatComplex,
): FloatComplex {
  return addFloatComplex(mulFloatComplex(a, d), mulFloatComplex(b, dc));
}

/** The exact deltas for one sample offset, so candidates share one reference. */
function exactDeltas(
  orbit: ReferenceOrbit,
  dc: FloatComplex,
  length: number,
): (FloatComplex | null)[] {
  const deltas: (FloatComplex | null)[] = new Array<FloatComplex | null>(length).fill(
    null,
  );
  let d = dc;
  deltas[1] = d;
  for (let n = 1; n + 1 < length; n++) {
    const z = addFloatComplex(readFloatComplex(orbit, n), d);
    // Past escape the delta grows without bound and `d*d` doubles its exponent
    // every step; the series validator stops here for the same reason.
    if (cmp(abs2FloatComplex(z), ESCAPE_THRESHOLD) > 0) break;
    d = deltaStep(readFloatComplex(orbit, n), d, dc);
    deltas[n + 1] = d;
  }
  return deltas;
}

/** Relative error of an approximation against the exact delta it stands for. */
function relativeError(exact: FloatComplex, approximate: FloatComplex): number {
  const exactMagnitude = abs2FloatComplex(exact);
  if (exactMagnitude.m === 0) return 0;
  const error = abs2FloatComplex(subFloatComplex(exact, approximate));
  const relative = toFloat(feDiv(error, exactMagnitude));
  return Number.isFinite(relative) ? relative : Infinity;
}

/**
 * The largest block length whose *chained* jumps stay inside tolerance.
 *
 * Returns `blockExponent: 0` when even a single-step block fails, which means
 * BLA earns nothing on this view; the caller then uses the exact path. A
 * single-step block is exact (the linearisation of one step is the step itself
 * minus `d^2`), so `0` is really "one-step blocks do not validate", i.e. the
 * quadratic term is already too large at this scale.
 */
export function selectBlaBlock(
  orbit: ReferenceOrbit,
  tables: {
    blocks: readonly FloatComplexArray[];
    dcBlocks: readonly FloatComplexArray[];
  },
  samples: readonly FloatComplex[],
  maxIterations: number,
  tolerance = TOLERANCE,
  minBlockExponent = MIN_USEFUL_BLOCK_EXPONENT,
): { blockExponent: number; maxRelativeError: number } {
  if (samples.length === 0) {
    throw new Error("selectBlaBlock: at least one sample offset is required");
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `selectBlaBlock: maxIterations must be a positive integer (got ${maxIterations})`,
    );
  }
  const length = Math.min(orbit.length, maxIterations + 1);
  const toleranceValue = toFloat(tolerance);
  const exacts = samples.map((dc) => exactDeltas(orbit, dc, length));
  // The exact deltas exist for indices `1..length-1`, so a jump may only land
  // inside that range to be judged. Landing one past it is not an escape — the
  // first version conflated the two and refused *every* candidate, which the
  // extreme-depth pin caught by expecting a long block to validate.
  const lastComparable = length - 1;

  let best = 0;
  let bestError = 0;
  // Blocks below the useful length are never taken, so validating them is pure
  // setup cost. Starting here rather than at 0 is worth about a third of the
  // validation on a 600-iteration view, measured as part of the preview setup.
  for (let j = minBlockExponent; j <= MAX_BLOCK_EXPONENT; j++) {
    const m = 1 << j;
    if (m > maxIterations) break;
    const a = tables.blocks[j];
    const b = tables.dcBlocks[j];
    if (!a || !b) break;

    let worst = 0;
    let survivors = 0;
    for (let s = 0; s < samples.length; s++) {
      const dc = samples[s] as FloatComplex;
      const exact = exacts[s] as (FloatComplex | null)[];
      let d = dc;
      let n = 1;
      let survived = true;
      while (n + m <= lastComparable && n <= maxIterations) {
        d = applyJump(readFloatComplex(a, n), readFloatComplex(b, n), d, dc);
        n += m;
        const reference = exact[n];
        if (reference === null || reference === undefined) {
          // This sample escaped inside the block, so it cannot judge the jump.
          survived = false;
          break;
        }
        const error = relativeError(reference, d);
        if (error > worst) worst = error;
      }
      if (survived) survivors += 1;
    }

    // A candidate that no sample survived proves nothing about the jumps, and a
    // candidate whose worst error exceeds tolerance is refused. Either way the
    // search stops here rather than continuing to a longer block.
    if (survivors === 0 || worst > toleranceValue) break;
    best = j;
    bestError = worst;
  }
  return { blockExponent: best, maxRelativeError: bestError };
}

/** Tables plus the validated block length: what a carrier needs. */
export function buildBla(
  orbit: ReferenceOrbit,
  maxIterations: number,
  maxOffset: Floatexp,
  maxBlockExponent = MAX_BLOCK_EXPONENT,
  tolerance = TOLERANCE,
): BlaTable {
  if (maxOffset.m <= 0) {
    throw new Error("buildBla: maxOffset must be positive");
  }
  const tables = buildBlaTables(orbit, maxBlockExponent);
  // Eight samples rather than the series' sixteen: the validation is chained and
  // therefore the most expensive part of the per-view setup, and the pins check
  // the result against every real pixel of several views.
  const validation = selectBlaBlock(
    orbit,
    tables,
    sampleOffsets(maxOffset, 4),
    maxIterations,
    tolerance,
  );
  return {
    orbit,
    blocks: tables.blocks,
    dcBlocks: tables.dcBlocks,
    blockExponent: validation.blockExponent,
    maxRelativeError: validation.maxRelativeError,
  };
}

/**
 * The BLA tables as a `DeltaCarrier`, so the backend chooses between it and the
 * exact carriers through the one seam.
 *
 * This carrier is JavaScript: the tables are complex `Floatexp` values and the
 * jump is two complex multiplies. It only pays when a jump is long enough that
 * `2` complex multiplies beat `m` iterations of the (WASM) exact kernel, which
 * is why the backend asks `1 << blockExponent` before switching to it.
 */
export function createBlaCarrier(table: BlaTable): DeltaCarrier {
  return {
    name: "js-bla",
    kind: "js",
    iterate(orbit, requests, maxIterations) {
      if (orbit.length !== table.orbit.length) {
        throw new Error(
          `bla carrier: table was built for an orbit of ${table.orbit.length} values, got ${orbit.length}`,
        );
      }
      return requests.map((request) =>
        escapePerturbedWithBla(table, request, maxIterations),
      );
    },
  };
}

/**
 * Iterate one pixel with jumps.
 *
 * The loop mirrors `iterateDeltas` step for step: at iteration `n` it forms
 * `z = Z_n + d_n` and applies the glitch and escape tests *before* advancing, so
 * a pixel that escapes at a block boundary is caught at the same iteration the
 * exact path would catch it.
 */
export function escapePerturbedWithBla(
  table: BlaTable,
  request: DeltaRequest,
  maxIterations: number,
): BlaEscapeResult {
  const { orbit } = table;
  const dc = request.dc;
  const jump = 1 << table.blockExponent;
  let d = request.start;
  let n = request.startIteration;
  let blocks = 0;
  // The block that produced the current `d`, so an escape found *at* iteration
  // `n` can be placed exactly by re-iterating it.
  let lastStart = n;
  let lastDelta = d;
  let lastLength = 1;

  while (n <= maxIterations) {
    if (n >= orbit.length) {
      return {
        glitched: true,
        iterations: n,
        reason: "orbit-exhausted",
        blocks,
        refined: false,
      };
    }

    const zn = readFloatComplex(orbit, n);
    const z = addFloatComplex(zn, d);
    const magnitudeSquared = abs2FloatComplex(z);
    if (cmp(magnitudeSquared, feMul(abs2FloatComplex(zn), GLITCH_THRESHOLD)) < 0) {
      return {
        glitched: true,
        iterations: n,
        reason: "precision",
        blocks,
        refined: false,
      };
    }
    if (cmp(magnitudeSquared, ESCAPE_THRESHOLD) > 0) {
      return escapeAt(
        table,
        dc,
        n,
        magnitudeSquared,
        lastStart,
        lastDelta,
        lastLength,
        blocks,
      );
    }

    const remaining = maxIterations - n + 1;
    // The table holds power-of-two blocks, so a short remainder is stepped.
    const usable =
      jump > 1 && jump <= remaining && n + jump - 1 < orbit.length ? jump : 1;
    lastStart = n;
    lastDelta = d;
    lastLength = usable;
    if (usable === 1) {
      d = deltaStep(zn, d, dc);
    } else {
      const a = table.blocks[table.blockExponent];
      const b = table.dcBlocks[table.blockExponent];
      if (!a || !b) {
        throw new Error(`bla: no table for block exponent ${table.blockExponent}`);
      }
      d = applyJump(readFloatComplex(a, n), readFloatComplex(b, n), d, dc);
      blocks += 1;
    }
    n += usable;
  }

  return {
    glitched: false,
    escaped: false,
    iterations: maxIterations,
    smooth: null,
    blocks,
    refined: false,
  };
}

/**
 * Report an escape found at iteration `n`, re-iterating the block that led there
 * exactly when that block was a jump.
 *
 * Without this the count would be the block's end, which is wrong by up to a
 * block length for every escaping pixel; with it the count is exact for the
 * delta the jump produced, and only the jump's own (validated) error remains.
 */
function escapeAt(
  table: BlaTable,
  dc: FloatComplex,
  n: number,
  magnitudeSquared: Floatexp,
  lastStart: number,
  lastDelta: FloatComplex,
  lastLength: number,
  blocks: number,
): BlaEscapeResult {
  if (lastLength > 1) {
    let exactD = lastDelta;
    let exactN = lastStart;
    while (exactN < n) {
      const stepZn = readFloatComplex(table.orbit, exactN);
      const stepZ = addFloatComplex(stepZn, exactD);
      const stepMagnitude = abs2FloatComplex(stepZ);
      if (cmp(stepMagnitude, ESCAPE_THRESHOLD) > 0) {
        const log2MagnitudeSquared = Math.log2(stepMagnitude.m) + stepMagnitude.e;
        return {
          glitched: false,
          escaped: true,
          iterations: exactN,
          smooth: exactN + 1 - Math.log2(0.5 * log2MagnitudeSquared),
          blocks,
          refined: true,
        };
      }
      exactD = deltaStep(stepZn, exactD, dc);
      exactN += 1;
    }
  }
  const log2MagnitudeSquared = Math.log2(magnitudeSquared.m) + magnitudeSquared.e;
  return {
    glitched: false,
    escaped: true,
    iterations: n,
    smooth: n + 1 - Math.log2(0.5 * log2MagnitudeSquared),
    blocks,
    refined: lastLength > 1,
  };
}
