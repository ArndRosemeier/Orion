/**
 * The precision ladder: choose the cheapest *sufficient* engine for a view.
 *
 * "Sufficient" is the load-bearing word. Every stage below is valid only inside
 * a range, and the range is set by the view's scale — the complex-plane distance
 * between adjacent pixels:
 *
 * | Stage | Valid while | Why the next one is needed |
 * |---|---|---|
 * | `direct-f64` | pixel spacing resolvable in a double | past ~2^-52 the offset from the centre stops being representable at all |
 * | `perturbation` | always (given enough orbit precision) | needs a high-precision reference orbit, so it is not worth its setup cost when direct iteration is still exact |
 * | `perturbation-series` | always, but **approximate** | skips a validated prefix for speed, at the measured cost of shifting escape counts near the boundary (ledger row 11) |
 *
 * The choice is therefore *validity first, cost second* — and the cost model is
 * deliberately structural rather than calibrated: this box has no GPU, so any
 * nanosecond figures would be fiction. Work is counted in bigint-iteration
 * equivalents, with a limb-count factor for the high-precision setup, so stages
 * can be compared against each other and against a real HUD later.
 */

import { fracBitsForScaleExponent } from "../numeric/precision";

/**
 * Below this pixel-spacing exponent, a double cannot resolve the offset of a
 * pixel from the view centre (a double carries 52 fraction bits plus the
 * implicit leading one), so direct f64 iteration cannot even express the view.
 */
export const F64_PIXEL_EXPONENT_LIMIT = -52;

/** Reference-orbit setup cost, in iteration-equivalents, per limb of precision. */
const LIMB_BITS = 53;

export type Quality = "preview" | "exact";

export type Stage = "direct-f64" | "perturbation" | "perturbation-series";

export type LadderRequest = {
  /** `log2` of the complex-plane distance between adjacent pixels. */
  readonly scaleExponent: number;
  readonly maxIterations: number;
  readonly pixelCount: number;
  /**
   * `exact` reproduces the oracle's escape counts; `preview` may use the series
   * accelerator, which is faster and measurably shifts some near-boundary
   * escape counts.
   */
  readonly quality: Quality;
  /**
   * Prefix length a previous render actually skipped on this view, if known.
   * The plan only uses it to price the series stage; it never assumes one.
   */
  readonly measuredSeriesSkip?: number;
};

export type StageOption = {
  readonly stage: Stage;
  readonly valid: boolean;
  /** Why it is or is not available — surfaced, never silent. */
  readonly why: string;
  /** Estimated work in bigint-iteration equivalents; `null` when invalid. */
  readonly estimatedWork: number | null;
};

export type LadderPlan = {
  readonly stage: Stage;
  /** The quality the plan was built for; backends gate themselves on it. */
  readonly quality: Quality;
  /** Fractional bits the per-pixel offsets need — the view's own precision. */
  readonly viewFracBits: number;
  /** Minimum fractional bits the reference orbit must be computed at. */
  readonly minOrbitFracBits: number;
  readonly maxIterations: number;
  readonly estimatedWork: number;
  /** Every option considered, so the choice can be audited rather than trusted. */
  readonly options: readonly StageOption[];
  readonly reason: string;
};

function limbFactor(fracBits: number): number {
  return Math.max(1, fracBits / LIMB_BITS);
}

function planOptions(request: LadderRequest): StageOption[] {
  const viewFracBits = fracBitsForScaleExponent(request.scaleExponent);
  const limb = limbFactor(viewFracBits);
  const pixels = request.pixelCount;
  const iterations = request.maxIterations;

  const directValid = request.scaleExponent >= F64_PIXEL_EXPONENT_LIMIT;
  const direct: StageOption = {
    stage: "direct-f64",
    valid: directValid,
    why: directValid
      ? "pixel spacing is resolvable in a double: no setup, exact"
      : `pixel spacing 2^${request.scaleExponent} is below the double limit 2^${F64_PIXEL_EXPONENT_LIMIT}`,
    estimatedWork: directValid ? pixels * iterations : null,
  };

  // Reference-orbit setup, paid once, at the orbit's precision.
  const setup = iterations * limb;
  const perturbation: StageOption = {
    stage: "perturbation",
    valid: true,
    why: "exact: matches the oracle's escape counts, needs a high-precision reference orbit",
    estimatedWork: setup + pixels * iterations,
  };

  const skip = request.measuredSeriesSkip ?? 0;
  const seriesValid = request.quality === "preview";
  const series: StageOption = {
    stage: "perturbation-series",
    valid: seriesValid,
    why: seriesValid
      ? "approximate: skips a validated prefix, so near-boundary escape counts may shift"
      : "rejected: quality is 'exact', and the series accelerator is not oracle-exact",
    estimatedWork: seriesValid
      ? setup + iterations * limb + pixels * Math.max(1, iterations - skip)
      : null,
  };

  return [direct, perturbation, series];
}

/**
 * Pick the stage for a view.
 *
 * Validity is checked before cost: a stage that cannot express the view is never
 * chosen however cheap it looks, and an approximation is never chosen when exact
 * output was asked for.
 */
export function planView(request: LadderRequest): LadderPlan {
  if (!Number.isInteger(request.maxIterations) || request.maxIterations < 1) {
    throw new Error(
      `planView: maxIterations must be a positive integer (got ${request.maxIterations})`,
    );
  }
  if (!Number.isInteger(request.pixelCount) || request.pixelCount < 1) {
    throw new Error(
      `planView: pixelCount must be a positive integer (got ${request.pixelCount})`,
    );
  }
  if (!Number.isFinite(request.scaleExponent)) {
    throw new Error(
      `planView: scaleExponent must be finite (got ${request.scaleExponent})`,
    );
  }

  const options = planOptions(request);
  let chosen: StageOption | null = null;
  for (const option of options) {
    if (!option.valid || option.estimatedWork === null) continue;
    if (chosen === null || (chosen.estimatedWork ?? Infinity) > option.estimatedWork) {
      chosen = option;
    }
  }
  if (chosen === null) {
    throw new Error("planView: no valid stage for this request");
  }

  const viewFracBits = fracBitsForScaleExponent(request.scaleExponent);
  return {
    stage: chosen.stage,
    quality: request.quality,
    viewFracBits,
    minOrbitFracBits: viewFracBits,
    maxIterations: request.maxIterations,
    estimatedWork: chosen.estimatedWork as number,
    options,
    reason: chosen.why,
  };
}
