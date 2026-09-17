/**
 * The ONE backend seam.
 *
 * Every renderer — CPU, WebGL2, WebGPU, and the worker pool that will drive
 * them — implements this interface and nothing else. A caller picks a backend by
 * *capability* and never by name, so adding a backend cannot change behaviour
 * anywhere except in the capability report.
 *
 * Two rules are encoded in the types rather than in prose:
 *
 *  - `capability()` must justify itself. A backend that cannot render a request
 *    says why, and the reason is surfaced — a silent downgrade to a slower or
 *    less precise path is exactly what this project does not do.
 *  - `render` writes into a caller-supplied buffer. Tiles are allocated once and
 *    reused across frames, which matters when a progressive render issues
 *    thousands of them.
 */

import type { Palette } from "../color/palette";
import type { LadderPlan, Quality } from "../ladder/plan";
import type { View } from "../view/view";

export type TileRect = {
  /** Device pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type TileRequest = {
  readonly view: View;
  readonly tile: TileRect;
  /**
   * Sample every `step`-th pixel; `1` is full resolution.
   *
   * Progressive rendering is resolution-first: a coarse pass samples sparsely and
   * is upscaled for display, so a first image appears in a fraction of the work.
   * The backends implement it by widening the per-pixel step, not by rendering
   * fewer tiles, so a coarse pass costs proportionally less everywhere.
   */
  readonly step: number;
  /**
   * What the caller needs from this render.
   *
   * A backend may implement `exact` with a more expensive kernel — the WebGPU
   * backend swaps `f32` for emulated double precision — and must refuse it when
   * it has no such kernel, rather than quietly returning approximation.
   */
  readonly quality: Quality;
  readonly maxIterations: number;
  readonly palette: Palette;
  /**
   * Render escape counts instead of colours, into a float buffer. Used by the
   * differential tests so GPU output can be compared against the oracle as
   * numbers rather than as colours.
   */
  readonly output: "colour" | "escape-count";
  /**
   * Permit a tile to extend past the viewport.
   *
   * Set by the tiled scheduler for cache-aligned tiles: those sit on an absolute
   * lattice, so the first and last may hang over the edge. The coordinates are
   * still well defined — pixels outside the viewport are simply not displayed.
   */
  readonly allowOutsideView?: boolean;
  /**
   * Where this tile's colour pixels belong in a larger image.
   *
   * When the page is cross-origin isolated the caller allocates the pass image
   * itself in a `SharedArrayBuffer` and hands each tile the offset and stride of
   * its rectangle within it. A backend that can write there — the worker pool
   * can, because a worker writes into shared memory with no clone — does so and
   * reports `writtenToTarget`, and the scheduler then has nothing to copy. The
   * pixels never cross a thread boundary.
   */
  readonly target?: TileTarget | null;
};

/** A rectangle's location inside a shared pass image. */
export type TileTarget = {
  readonly buffer: SharedArrayBuffer;
  /** Byte offset of the rectangle's first pixel. */
  readonly byteOffset: number;
  /** Bytes from one row's start to the next. */
  readonly stride: number;
};

export type TileResult = {
  /** RGBA bytes, row-major, `width * height * 4` long. */
  readonly pixels: Uint8ClampedArray;
  /**
   * Escape counts when `output` is `"escape-count"`: `-1` for interior points,
   * otherwise the integer iteration count. Empty for colour output.
   */
  readonly escapeCounts: Float32Array;
  readonly width: number;
  readonly height: number;
  /** Stage the backend actually used, which may be finer than the plan allowed. */
  stage: string;
  /**
   * True when the backend wrote the pixels straight into `request.target` and
   * `pixels` was left untouched. The scheduler skips its own blit for those
   * tiles — copying them again would be the very copy this exists to remove.
   */
  writtenToTarget?: boolean;
};

export type Capability = {
  readonly supported: boolean;
  /** Why, in either case. Never empty. */
  readonly why: string;
};

export type FractalBackend = {
  readonly name: string;
  /** Can this backend render this request at all? */
  capability(
    view: View,
    plan: LadderPlan,
    request?: Omit<TileRequest, "view" | "tile" | "palette">,
  ): Capability;
  render(request: TileRequest, into: TileResult): Promise<TileResult>;
  dispose(): void;
};

export function makeTileResult(
  width: number,
  height: number,
  output: TileRequest["output"],
  options: { readonly shared?: boolean } = {},
): TileResult {
  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  const bytes = width * height * 4;
  // A shared buffer lets a worker write this tile's pixels *here*, with no copy
  // and no transfer — the transport's zero-copy path needs the destination to be
  // shared, not the worker's own scratch.
  const pixels =
    options.shared === true && isolated && typeof SharedArrayBuffer !== "undefined"
      ? new Uint8ClampedArray(new SharedArrayBuffer(bytes))
      : new Uint8ClampedArray(bytes);
  return {
    pixels,
    escapeCounts:
      output === "escape-count"
        ? new Float32Array(width * height)
        : new Float32Array(0),
    width,
    height,
    stage: "unset",
  };
}

/**
 * Output dimensions for a tile rendered at `step`: one sample per `step` device
 * pixels, rounded up so a partial trailing sample is still represented.
 */
export function tileOutputSize(
  tile: TileRect,
  step: number,
): { width: number; height: number } {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`TileRequest: step must be a positive integer (got ${step})`);
  }
  return {
    width: Math.ceil(tile.width / step),
    height: Math.ceil(tile.height / step),
  };
}

export function assertTileFitsView(
  view: View,
  tile: TileRect,
  allowOutsideView = false,
): void {
  if (
    !Number.isInteger(tile.x) ||
    !Number.isInteger(tile.y) ||
    !Number.isInteger(tile.width) ||
    !Number.isInteger(tile.height) ||
    tile.width <= 0 ||
    tile.height <= 0
  ) {
    throw new Error(
      `TileRect: must be positive integers (got ${tile.x},${tile.y},${tile.width},${tile.height})`,
    );
  }
  if (
    !allowOutsideView &&
    (tile.x < 0 ||
      tile.y < 0 ||
      tile.x + tile.width > view.pixelWidth ||
      tile.y + tile.height > view.pixelHeight)
  ) {
    throw new Error(
      `TileRect: ${tile.x},${tile.y} ${tile.width}x${tile.height} does not fit a ${view.pixelWidth}x${view.pixelHeight} view`,
    );
  }
}
