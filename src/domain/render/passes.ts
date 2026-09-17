/**
 * How a view is cut into passes, per backend kind.
 *
 * The pass list is not a constant: a tile is a unit of *work*, and what makes a
 * good unit depends on who does the work. A GPU renders the coarse pass in one
 * draw call and pays almost nothing for a large tile; a worker pool pays per
 * tile and — much worse — a single tile uses a single worker, so a pass cut into
 * one tile leaves the whole pool idle while one thread does all of it.
 *
 * That was measured, not assumed. On the app's coarse pass (a 120x80 sample grid
 * at step 8, 600 iterations, four workers):
 *
 * | samples per tile | tiles | wall time |
 * |---|---|---|
 * | 1024 (one tile) | 1 | 1316ms |
 * | 64 | 4 | 996ms |
 * | 32 | 12 | 586ms |
 *
 * So the pool gets tiles small enough to give every worker several waves, and the
 * GPU keeps its single-draw passes. Both are expressed here, in one place, so the
 * choice is testable rather than buried in a component.
 */

export type BackendKind = "gpu" | "pool";

export type PassPlan = {
  readonly name: string;
  readonly step: number;
  /** Samples per tile along each axis; a tile is this squared, in sample space. */
  readonly samplesAcross: number;
};

/** Samples per tile on a GPU, where a big tile is one cheap draw call. */
const GPU_COARSE_SAMPLES = 1024;
const GPU_FULL_SAMPLES = 256;

/**
 * Target waves of work per worker.
 *
 * Three is the compromise between two failure modes that were both measured:
 * too few tiles leaves workers idle at the end of a wave (one tile is the
 * degenerate case), and too many tiles pays the per-tile overhead — which
 * measured ~2.5ms per tile, and 2.5x worse per pixel at 8x8 tiles than at 32x32.
 */
const TARGET_TILES_PER_WORKER = 3;

/** Smallest and largest tile, in samples per axis. */
const MIN_SAMPLES_ACROSS = 8;
const MAX_SAMPLES_ACROSS = 1024;

function samplesAcrossFor(
  pixelWidth: number,
  pixelHeight: number,
  step: number,
  workers: number,
): number {
  const columns = Math.ceil(pixelWidth / step);
  const rows = Math.ceil(pixelHeight / step);
  const targetTiles = Math.max(1, workers * TARGET_TILES_PER_WORKER);
  // A tile is `span^2` samples, so the span that yields `targetTiles` of them is
  // the square root of the samples per tile.
  const ideal = Math.sqrt((columns * rows) / targetTiles);
  // Round to a power of two: the lattice and the tile cache both key on the span,
  // and powers of two keep tile edges aligned with the sample grid.
  const rounded = 2 ** Math.round(Math.log2(Math.max(1, ideal)));
  return Math.min(MAX_SAMPLES_ACROSS, Math.max(MIN_SAMPLES_ACROSS, rounded));
}

/**
 * The passes for a canvas, given who will render them.
 *
 * The coarse pass exists to put something on screen quickly, so its tiling is the
 * one that matters most; the full pass follows at the same tile size, which keeps
 * the tile cache useful across both.
 */
export function passesFor(
  kind: BackendKind,
  pixelWidth: number,
  pixelHeight: number,
  workers: number,
): PassPlan[] {
  if (
    !Number.isInteger(pixelWidth) ||
    pixelWidth < 1 ||
    !Number.isInteger(pixelHeight) ||
    pixelHeight < 1
  ) {
    throw new Error(
      `passesFor: canvas must be a positive integer size (got ${pixelWidth}x${pixelHeight})`,
    );
  }
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`passesFor: workers must be a positive integer (got ${workers})`);
  }
  if (kind === "gpu") {
    return [
      { name: "coarse", step: 8, samplesAcross: GPU_COARSE_SAMPLES },
      { name: "full", step: 1, samplesAcross: GPU_FULL_SAMPLES },
    ];
  }
  return [
    {
      name: "coarse",
      step: 8,
      samplesAcross: samplesAcrossFor(pixelWidth, pixelHeight, 8, workers),
    },
    {
      name: "full",
      step: 1,
      samplesAcross: samplesAcrossFor(pixelWidth, pixelHeight, 1, workers),
    },
  ];
}
