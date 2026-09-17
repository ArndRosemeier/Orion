/**
 * The render scheduler: passes, tiles, cancellation.
 *
 * Rendering a view is not one call. It is a *coarse pass* at a fraction of the
 * resolution — enough to put a recognisable image on screen almost immediately —
 * followed by a full-resolution pass, both cut into tiles so that work can be
 * abandoned the moment the view changes. `AbortSignal` is the seam for that: the
 * scheduler checks between tiles and returns what it managed to finish, rather
 * than pretending the abandoned work completed.
 *
 * Every pass is assembled into its own buffer, and every tile is checked for
 * exact coverage, so a gap or an overlap is a test failure rather than a visible
 * seam.
 */

import type { Palette } from "../color/palette";
import type { Quality } from "../ladder/plan";
import type { View } from "../view/view";
import {
  type FractalBackend,
  type TileRect,
  type TileTarget,
  makeTileResult,
} from "./backend";
import {
  type CachedTile,
  type TileCache,
  latticeView,
  sampleLatticeKey,
  splitIntoTiles,
  tileCacheKey,
} from "./tiles";

export type PassSpec = {
  readonly name: string;
  /** Sample every `step`-th device pixel. */
  readonly step: number;
  /** Tiles are cut at most this many samples across. */
  readonly samplesAcross: number;
};

/**
 * Two passes. The coarse one samples every 8th pixel — 64x less work — which is
 * enough to show where the structure is, and is what makes deep CPU rendering
 * usable at all.
 */
export const DEFAULT_PASSES: readonly PassSpec[] = [
  { name: "coarse", step: 8, samplesAcross: 64 },
  { name: "full", step: 1, samplesAcross: 64 },
];

export type PassImage = {
  readonly name: string;
  readonly step: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
};

export type RenderOutcome = {
  readonly passes: readonly PassImage[];
  /** True when a signal aborted the run; `passes` then holds partial images. */
  readonly cancelled: boolean;
  readonly tilesRendered: number;
  readonly tilesSkipped: number;
  /**
   * Tiles a backend wrote straight into the shared pass image, with no copy on
   * this thread. Observable because "zero-copy" is a claim, not a feeling.
   */
  readonly tilesDirect: number;
  /** Distinct backend stages actually used, e.g. `["direct-f32"]`. */
  readonly stages: readonly string[];
};

export type RenderViewOptions = {
  readonly backend: FractalBackend;
  readonly view: View;
  readonly maxIterations: number;
  readonly palette: Palette;
  readonly quality: Quality;
  readonly passes?: readonly PassSpec[];
  readonly signal?: AbortSignal;
  /** Called as soon as each pass is complete, so the caller can display it. */
  readonly onPass?: (image: PassImage) => void;
  /**
   * Ask the backend's capability before rendering, and fail loudly if it cannot
   * render this view rather than producing a blank image.
   */
  readonly requireCapability?: boolean;
  /**
   * How many tiles may be in flight at once.
   *
   * One by default, which is right for a GPU backend issuing draw calls. A
   * worker pool wants this set to its size; dispatching more than there are
   * workers is a scheduling error the pool reports rather than queues.
   */
  readonly concurrency?: number;
  /**
   * Share rendered tiles between views.
   *
   * With a cache, tiles are cut on an absolute lattice and the view is snapped
   * onto it, so a pan reuses every tile it did not uncover. Without one, tiles
   * are cut from the viewport and nothing is reused — the previous behaviour.
   */
  readonly tileCache?: TileCache;
};

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Render a view pass by pass, tile by tile.
 *
 * Returns every pass it completed; a cancelled run returns the partial passes it
 * got through, with `cancelled: true`. It never throws for cancellation — that is
 * a normal outcome of a user panning mid-render — but it does throw if the
 * backend cannot render the view at all.
 */
export async function renderView(options: RenderViewOptions): Promise<RenderOutcome> {
  const { backend, view, maxIterations, palette, quality } = options;
  const passes = options.passes ?? DEFAULT_PASSES;
  const passes_out: PassImage[] = [];
  let tilesRendered = 0;
  let tilesSkipped = 0;
  let tilesDirect = 0;
  const stages = new Set<string>();

  if (options.requireCapability === true) {
    const plan = {
      stage: "perturbation" as const,
      quality,
      viewFracBits: view.width.fracBits,
      minOrbitFracBits: view.width.fracBits,
      maxIterations,
      estimatedWork: 0,
      options: [],
      reason: "capability probe",
    };
    const capability = backend.capability(view, plan);
    if (!capability.supported) {
      throw new Error(`${backend.name} cannot render this view: ${capability.why}`);
    }
  }

  for (const pass of passes) {
    let image: PassImage;
    if (aborted(options.signal)) {
      return {
        passes: passes_out,
        cancelled: true,
        tilesRendered,
        tilesSkipped,
        tilesDirect,
        stages: [...stages],
      };
    }
    {
      const columns = Math.ceil(view.pixelWidth / pass.step);
      const rows = Math.ceil(view.pixelHeight / pass.step);
      image = {
        name: pass.name,
        step: pass.step,
        width: columns,
        height: rows,
        pixels: allocatePassPixels(columns, rows),
      };
    }

    if (options.tileCache) {
      const latticed = latticeView(view, pass.step, pass.samplesAcross);
      const outcome = await renderLatticedPass({
        options,
        backend,
        pass,
        latticed,
        image,
        quality,
        maxIterations,
        palette,
      });
      tilesRendered += outcome.tilesRendered;
      tilesSkipped += outcome.tilesSkipped;
      for (const stage of outcome.stages) stages.add(stage);
      if (outcome.cancelled) {
        return {
          passes: passes_out,
          cancelled: true,
          tilesRendered,
          tilesSkipped,
          tilesDirect,
          stages: [...stages],
        };
      }
    } else {
      const grid = splitIntoTiles(
        view.pixelWidth,
        view.pixelHeight,
        pass.step,
        pass.samplesAcross,
      );
      const concurrency = Math.max(1, options.concurrency ?? 1);
      for (let start = 0; start < grid.tiles.length; start += concurrency) {
        if (aborted(options.signal)) {
          return {
            passes: passes_out,
            cancelled: true,
            tilesRendered,
            tilesSkipped,
            tilesDirect,
            stages: [...stages],
          };
        }
        const wave = grid.tiles.slice(start, start + concurrency);
        const rendered = await Promise.all(
          wave.map(async (tile) => {
            const result = makeTileResult(
              Math.ceil(tile.width / pass.step),
              Math.ceil(tile.height / pass.step),
              "colour",
              { shared: true },
            );
            await backend.render(
              {
                view,
                tile,
                step: pass.step,
                quality,
                maxIterations,
                palette,
                output: "colour",
                target: targetFor(
                  image,
                  tile.x / pass.step,
                  tile.y / pass.step,
                  result.width,
                  result.height,
                ),
              },
              result,
            );
            return { tile, result };
          }),
        );
        for (const { tile, result } of rendered) {
          if (result.writtenToTarget === true) {
            tilesDirect++;
          } else {
            blit(image, result, tile, pass.step);
          }
          stages.add(result.stage);
          tilesRendered++;
        }
      }
    }

    // A pass is only reported once it is complete. Dropping this check lets a
    // cancelled render hand back a finished-looking image, which is the one
    // thing cancellation must never do.
    if (aborted(options.signal)) {
      return {
        passes: passes_out,
        cancelled: true,
        tilesRendered,
        tilesSkipped,
        tilesDirect,
        stages: [...stages],
      };
    }
    passes_out.push(image);
    options.onPass?.(image);
  }

  return {
    passes: passes_out,
    cancelled: false,
    tilesRendered,
    tilesSkipped,
    tilesDirect,
    stages: [...stages],
  };
}

/**
 * Allocate a pass image's pixels, in shared memory when the page is isolated.
 *
 * A `SharedArrayBuffer` is what lets a worker write a tile *directly* into the
 * pass image: the buffer is shared by reference across the worker boundary, so
 * the pixels are never copied, cloned or transferred. Without isolation the same
 * array is allocated on the heap and the scheduler copies tiles in as before —
 * a different transport, not a different result.
 */
function allocatePassPixels(width: number, height: number): Uint8ClampedArray {
  const bytes = width * height * 4;
  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  if (isolated && typeof SharedArrayBuffer !== "undefined") {
    return new Uint8ClampedArray(new SharedArrayBuffer(bytes));
  }
  return new Uint8ClampedArray(bytes);
}

/**
 * The target rectangle for a tile whose samples land entirely inside the pass
 * image, or `null` when any of them would fall outside and the tile must come
 * back for the scheduler to clip.
 */
function targetFor(
  image: PassImage,
  originColumn: number,
  originRow: number,
  width: number,
  height: number,
): TileTarget | null {
  if (originColumn < 0 || originRow < 0) return null;
  if (originColumn + width > image.width || originRow + height > image.height) {
    return null;
  }
  const buffer = image.pixels.buffer;
  if (!(buffer instanceof SharedArrayBuffer)) return null;
  return {
    buffer,
    byteOffset: (originRow * image.width + originColumn) * 4,
    stride: image.width * 4,
  };
}

/** Copy a tile's samples into the pass image at the tile's sample-space origin. */
function blit(
  image: PassImage,
  tileResult: { pixels: Uint8ClampedArray; width: number; height: number },
  tile: TileRect,
  step: number,
): void {
  const originColumn = tile.x / step;
  const originRow = tile.y / step;
  for (let row = 0; row < tileResult.height; row++) {
    const destinationRow = originRow + row;
    if (destinationRow < 0 || destinationRow >= image.height) {
      throw new Error(
        `renderView: tile row ${destinationRow} falls outside the ${image.height}-row pass image`,
      );
    }
    const sourceOffset = row * tileResult.width * 4;
    const destinationOffset = (destinationRow * image.width + originColumn) * 4;
    image.pixels.set(
      tileResult.pixels.subarray(sourceOffset, sourceOffset + tileResult.width * 4),
      destinationOffset,
    );
  }
}

type LatticedPassOptions = {
  readonly options: RenderViewOptions;
  readonly backend: FractalBackend;
  readonly pass: PassSpec;
  readonly latticed: ReturnType<typeof latticeView>;
  readonly image: PassImage;
  readonly quality: Quality;
  readonly maxIterations: number;
  readonly palette: Palette;
};

/**
 * Render a pass as absolute-lattice tiles, reusing whatever the cache holds.
 *
 * A tile is fetched when its key is present and rendered otherwise; either way
 * only the part inside the viewport is copied into the pass image. The image is
 * therefore identical whether the cache was warm or cold — the property that
 * makes a cache safe, and it is pinned as such.
 */
async function renderLatticedPass(input: LatticedPassOptions): Promise<{
  tilesRendered: number;
  tilesSkipped: number;
  stages: string[];
  cancelled: boolean;
}> {
  const { options, backend, pass, latticed, image, quality, maxIterations, palette } =
    input;
  const cache = options.tileCache;
  if (!cache) throw new Error("renderLatticedPass: no tile cache");
  const lattice = sampleLatticeKey(latticed.view, pass.step);
  const span = latticed.samplesAcross;
  const stages: string[] = [];
  let tilesRendered = 0;
  let tilesSkipped = 0;

  for (let l = latticed.firstL; l <= latticed.lastL; l++) {
    for (let k = latticed.firstK; k <= latticed.lastK; k++) {
      if (aborted(options.signal)) {
        return { tilesRendered, tilesSkipped, stages, cancelled: true };
      }
      const key = tileCacheKey(lattice, span, k, l);
      let tile = cache.cache.get(key);
      if (tile === undefined) {
        // The tile's device rect may hang over the viewport edge, which is what
        // `allowOutsideView` is for; the coordinates stay well defined.
        const rect: TileRect = {
          x: Number((k * BigInt(span) - latticed.originK) * BigInt(pass.step)),
          y: Number((l * BigInt(span) - latticed.originL) * BigInt(pass.step)),
          width: span * pass.step,
          height: span * pass.step,
        };
        const result = makeTileResult(span, span, "colour", { shared: true });
        await backend.render(
          {
            view: latticed.view,
            tile: rect,
            step: pass.step,
            quality,
            maxIterations,
            palette,
            output: "colour",
            allowOutsideView: true,
          },
          result,
        );
        stages.push(result.stage);
        tile = { width: span, height: span, pixels: result.pixels };
        cache.cache.set(key, tile);
        tilesRendered++;
      } else {
        tilesSkipped++;
      }
      blitLatticed(image, tile, latticed, k, l);
    }
  }
  return { tilesRendered, tilesSkipped, stages, cancelled: false };
}

/** Copy the part of an absolute tile that lands inside the viewport. */
function blitLatticed(
  image: PassImage,
  tile: CachedTile,
  latticed: ReturnType<typeof latticeView>,
  k: bigint,
  l: bigint,
): void {
  const span = latticed.samplesAcross;
  const firstX = Number(k * BigInt(span) - latticed.originK);
  const firstY = Number(l * BigInt(span) - latticed.originL);
  const startX = Math.max(0, firstX);
  const startY = Math.max(0, firstY);
  const endX = Math.min(latticed.columns, firstX + span);
  const endY = Math.min(latticed.rows, firstY + span);
  if (endX <= startX || endY <= startY) return;

  const sourceX = startX - firstX;
  const width = endX - startX;
  for (let y = startY; y < endY; y++) {
    const source = ((y - firstY) * tile.width + sourceX) * 4;
    const destination = (y * image.width + startX) * 4;
    image.pixels.set(tile.pixels.subarray(source, source + width * 4), destination);
  }
}
