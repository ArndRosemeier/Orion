/**
 * Backend selection: GPU-first, with every refusal reported.
 *
 * Candidates are tried in order and the first one that says it can render the
 * view wins. If none can, the caller gets *every* reason rather than a generic
 * failure — "WebGPU is unavailable" and "this view is below what f32 can express"
 * are different problems with different fixes, and collapsing them into one
 * message is how a capability system becomes useless.
 *
 * Ordering is the caller's, not this module's: it encodes policy (try the
 * compute backend first, fall back to the fragment-shader one), while this
 * function only enforces that a refusal is never silent.
 */

import type { LadderPlan } from "../ladder/plan";
import type { View } from "../view/view";
import type { FractalBackend } from "./backend";

export type BackendCandidate = {
  readonly name: string;
  /**
   * What kind of renderer this is, which decides how a pass is tiled.
   *
   * A GPU wants one draw call for the coarse pass; a worker pool needs the pass
   * cut small enough to fill its workers, because one tile means one worker.
   */
  readonly backendKind: "gpu" | "pool";
  readonly backend: FractalBackend;
  /**
   * Tiles this backend can usefully have in flight at once.
   *
   * A GPU backend issues one draw at a time, so one. A worker pool wants as many
   * as it has workers; the scheduler uses this to size its dispatch wave.
   */
  readonly concurrency?: number;
};

export type BackendRefusal = {
  readonly name: string;
  readonly why: string;
};

export type BackendChoice =
  | {
      readonly kind: "chosen";
      readonly name: string;
      readonly backendKind: "gpu" | "pool";
      readonly backend: FractalBackend;
      readonly why: string;
      /** Tiles the scheduler may keep in flight for this backend. */
      readonly concurrency: number;
      /** Candidates that refused, so the choice can be audited. */
      readonly refused: readonly BackendRefusal[];
    }
  | { readonly kind: "refused"; readonly reasons: readonly BackendRefusal[] };

export function chooseBackend(
  candidates: readonly BackendCandidate[],
  view: View,
  plan: LadderPlan,
): BackendChoice {
  if (candidates.length === 0) {
    throw new Error("chooseBackend: at least one candidate is required");
  }
  const refused: BackendRefusal[] = [];
  for (const candidate of candidates) {
    const capability = candidate.backend.capability(view, plan);
    if (capability.supported) {
      return {
        kind: "chosen",
        name: candidate.name,
        backendKind: candidate.backendKind,
        backend: candidate.backend,
        why: capability.why,
        concurrency: Math.max(1, candidate.concurrency ?? 1),
        refused,
      };
    }
    refused.push({ name: candidate.name, why: capability.why });
  }
  return { kind: "refused", reasons: refused };
}
