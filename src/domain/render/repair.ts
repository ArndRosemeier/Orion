/**
 * Repairing the pixels a GPU kernel refused to answer for.
 *
 * Both GPU kernels can reach a pixel whose fast arithmetic cannot be trusted —
 * Pauldelbrot's cancellation for the perturbation paths, a format limit for the
 * direct ones. Neither of them may *guess*: they flag the pixel and the host
 * recomputes it with the exact direct engine, which iterates the point itself at
 * the view's precision. A repaired pixel is therefore correct by construction,
 * and how many were repaired is reported so the stage string can say it happened.
 *
 * One implementation, used by both WebGPU and WebGL2, because "the flagged pixel
 * is recomputed exactly" must not mean two slightly different things depending on
 * which GPU API the browser gave us.
 */

import { colourFor } from "../color/palette";
import { escapeDirect } from "../engines/direct";
import { pixelToComplex } from "../view/view";
import type { TileRequest, TileResult } from "./backend";

export type TileOutputSize = { readonly width: number; readonly height: number };

/**
 * Recompute every flagged pixel of a finished GPU tile, in place.
 *
 * `isFlagged` receives the pixel index (`row * width + column`) and the flat
 * component index, because the two output formats mark a refusal differently:
 * escape-count output writes `-2`, colour output writes a fully transparent
 * pixel.
 */
export function repairFlaggedPixels(
  request: TileRequest,
  into: TileResult,
  output: TileOutputSize,
  isFlagged: (index: number) => boolean,
): number {
  const { view, tile, step } = request;
  let repaired = 0;
  for (let row = 0; row < output.height; row++) {
    for (let column = 0; column < output.width; column++) {
      const index = row * output.width + column;
      if (!isFlagged(index)) continue;
      const point = pixelToComplex(view, tile.x + column * step, tile.y + row * step);
      const outcome = escapeDirect(point, request.maxIterations);
      repaired += 1;
      if (request.output === "escape-count") {
        into.escapeCounts[index] = outcome.escaped ? outcome.iterations : -1;
        continue;
      }
      const colour = colourFor(outcome, request.palette);
      into.pixels[index * 4] = colour.r;
      into.pixels[index * 4 + 1] = colour.g;
      into.pixels[index * 4 + 2] = colour.b;
      into.pixels[index * 4 + 3] = 255;
    }
  }
  return repaired;
}

/** The convention the perturbation kernels use to mark a pixel they could not answer. */
export const REFUSED_COUNT = -2;
