/**
 * The CPU worker pool.
 *
 * It implements the *same* `FractalBackend` interface as the single-threaded CPU
 * backend, so nothing downstream needs to know it is there: `chooseBackend` can
 * offer it as a candidate and the scheduler dispatches to it unchanged. What
 * changes is that the deep CPU path no longer blocks the main thread — which is
 * the difference between a renderer that appears frozen for seconds and one that
 * stays responsive.
 *
 * ## Transport
 *
 * When the page is cross-origin isolated, the pool owns a `SharedArrayBuffer`
 * per worker and a tile can be written straight into a shared target with no
 * copy. Otherwise the worker hands back a transferred `ArrayBuffer`. The pool
 * **reports** which one it is using rather than quietly doing something
 * different, and the browser lane asserts the isolated case is the one running.
 *
 * ## Failure
 *
 * Workers are created lazily on first use. If the environment has no `Worker`
 * (Node, or a browser with workers disabled) the pool throws with that reason —
 * it does not silently degrade to rendering on the main thread, because that
 * would be a different performance profile than the caller asked for.
 */

import { encodeView } from "../view/url";
import {
  type Capability,
  type FractalBackend,
  type TileRequest,
  type TileResult,
  tileOutputSize,
} from "./backend";
import { type WorkItem, type WorkResult, WorkResultSchema } from "./workerProtocol";

export type PoolTransport = "shared" | "transfer";

export type WorkerPoolStats = {
  readonly size: number;
  readonly transport: PoolTransport;
  readonly dispatched: number;
  readonly completed: number;
  readonly failed: number;
  /** Times a worker had to be recreated after an error. */
  readonly restarts: number;
};

export type WorkerPool = FractalBackend & {
  readonly size: number;
  readonly transport: PoolTransport;
  stats(): WorkerPoolStats;
};

export type WorkerPoolOptions = {
  /** Defaults to `navigator.hardwareConcurrency - 1`, clamped to [1, 8]. */
  readonly size?: number;
  /** Overrides cross-origin-isolated detection; used by tests. */
  readonly forceTransport?: PoolTransport;
};

type WorkerSlot = {
  worker: Worker;
  /** Shared scratch space used when the transport is `shared`. */
  scratch: SharedArrayBuffer | null;
  busy: boolean;
  nextId: number;
  /** Resolvers for the request currently in flight. */
  pending: {
    id: number;
    resolve: (result: WorkResult) => void;
    reject: (error: Error) => void;
  } | null;
};

function defaultSize(): number {
  const cores =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 2;
  return Math.max(1, Math.min(8, cores - 1));
}

function detectTransport(options: WorkerPoolOptions): PoolTransport {
  if (options.forceTransport) return options.forceTransport;
  const isolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  const hasShared = typeof SharedArrayBuffer !== "undefined";
  return isolated && hasShared ? "shared" : "transfer";
}

export function createWorkerPool(options: WorkerPoolOptions = {}): WorkerPool {
  const size = options.size ?? defaultSize();
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`worker pool: size must be a positive integer (got ${size})`);
  }
  const transport = detectTransport(options);
  const slots: WorkerSlot[] = [];
  let disposed = false;
  let dispatched = 0;
  let completed = 0;
  let failed = 0;
  let restarts = 0;

  const spawn = (): WorkerSlot => {
    if (typeof Worker === "undefined") {
      throw new Error(
        "worker pool: this environment has no Worker constructor, so tiles cannot be rendered off the main thread",
      );
    }
    const worker = new Worker(new URL("../../worker/tile.worker.ts", import.meta.url), {
      type: "module",
      name: "orion-tile",
    });
    const slot: WorkerSlot = {
      worker,
      scratch: null,
      busy: false,
      nextId: 1,
      pending: null,
    };
    worker.onmessage = (event: MessageEvent) => {
      const parsed = WorkResultSchema.safeParse(event.data);
      const pending = slot.pending;
      if (!pending) {
        failed++;
        return;
      }
      if (!parsed.success) {
        failed++;
        slot.pending = null;
        slot.busy = false;
        pending.reject(
          new Error(
            `worker pool: invalid reply (${parsed.error.issues
              .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
              .join("; ")})`,
          ),
        );
        return;
      }
      slot.pending = null;
      slot.busy = false;
      if (parsed.data.ok) completed++;
      else failed++;
      pending.resolve(parsed.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      restarts++;
      const pending = slot.pending;
      slot.pending = null;
      slot.busy = false;
      pending?.reject(
        new Error(`worker pool: worker error (${event.message || "unknown"})`),
      );
    };
    return slot;
  };

  const acquire = (): WorkerSlot => {
    for (const slot of slots) {
      if (!slot.busy) return slot;
    }
    if (slots.length < size) {
      const slot = spawn();
      slots.push(slot);
      return slot;
    }
    throw new Error("worker pool: every worker is busy; the scheduler over-dispatched");
  };

  const render = async (
    request: TileRequest,
    into: TileResult,
  ): Promise<TileResult> => {
    if (disposed) throw new Error("worker pool: disposed");
    if (request.output === "escape-count" && into.escapeCounts.length === 0) {
      throw new Error("worker pool: escape-count output needs a result built for it");
    }
    const output = tileOutputSize(request.tile, request.step);
    if (into.width !== output.width || into.height !== output.height) {
      throw new Error(
        `worker pool: result buffer is ${into.width}x${into.height}, but a ${request.tile.width}x${request.tile.height} tile at step ${request.step} is ${output.width}x${output.height}`,
      );
    }

    const slot = acquire();
    slot.busy = true;
    const id = slot.nextId++;

    // A shared target is only sound when the page is isolated; the transport
    // already encodes that decision, and the check is repeated here so a forced
    // transport in a test cannot smuggle a shared buffer into a non-isolated page.
    //
    // The caller's target — a rectangle inside the pass image — takes precedence
    // over the per-worker scratch: then the pixels are written where they belong
    // and never cross back at all.
    // Prefer the caller's pass image; failing that, the caller's own tile buffer
    // when it is shared, so the worker still writes where the pixels belong and
    // this pool copies nothing at all.
    const ownSharedTarget =
      transport === "shared" &&
      request.output === "colour" &&
      into.pixels.buffer instanceof SharedArrayBuffer &&
      into.pixels.byteLength === output.width * output.height * 4
        ? {
            buffer: into.pixels.buffer,
            byteOffset: 0,
            stride: output.width * 4,
          }
        : null;
    const callerTarget =
      transport === "shared" && request.output === "colour"
        ? (request.target ?? ownSharedTarget)
        : null;
    const writesCallersPassImage =
      callerTarget !== null && callerTarget === request.target;
    let target: WorkItem["target"] = null;
    if (callerTarget !== null) {
      target = {
        buffer: callerTarget.buffer,
        byteOffset: callerTarget.byteOffset,
        stride: callerTarget.stride,
      };
    } else if (transport === "shared" && request.output === "colour") {
      const bytes = output.height * output.width * 4;
      if (slot.scratch === null || slot.scratch.byteLength < bytes) {
        slot.scratch = new SharedArrayBuffer(bytes);
      }
      target = { buffer: slot.scratch, byteOffset: 0, stride: output.width * 4 };
    }

    const item: WorkItem = {
      id,
      viewFragment: encodeView(request.view),
      tile: request.tile,
      step: request.step,
      quality: request.quality,
      maxIterations: request.maxIterations,
      palette: {
        name: request.palette.name,
        stops: request.palette.stops.map((stop) => ({ ...stop })),
        size: request.palette.size,
        cyclesPerUnit: request.palette.cyclesPerUnit,
      },
      output: request.output,
      target,
    };

    dispatched++;
    const reply = await new Promise<WorkResult>((resolve, reject) => {
      slot.pending = { id, resolve, reject };
      slot.worker.postMessage(item);
    });

    if (!reply.ok) {
      throw new Error(`worker pool: ${reply.error}`);
    }

    if (callerTarget !== null && reply.pixels === null) {
      // The worker wrote straight into a shared destination: either the caller's
      // pass image (nothing more to do anywhere) or this tile's own buffer
      // (nothing for this pool to copy).
      if (writesCallersPassImage) {
        into.writtenToTarget = true;
      }
    } else if (reply.pixels !== null) {
      into.pixels.set(new Uint8ClampedArray(reply.pixels), 0);
    } else if (target !== null) {
      // The worker wrote into this pool's scratch, so it still has to cross into
      // the caller's buffer.
      const source = new Uint8ClampedArray(
        target.buffer,
        0,
        output.width * output.height * 4,
      );
      into.pixels.set(source, 0);
    }
    if (reply.escapeCounts !== null) {
      into.escapeCounts.set(new Float32Array(reply.escapeCounts), 0);
    }
    into.stage = reply.stage;
    return into;
  };

  return {
    name: "cpu-pool",
    size,
    transport,

    // The view is not consulted: the CPU backend handles any depth.
    capability(_view, plan): Capability {
      if (typeof Worker === "undefined") {
        return {
          supported: false,
          why: "this environment has no Worker constructor",
        };
      }
      return {
        supported: true,
        why: `${size} workers, ${transport} transport; plan selects ${plan.stage}`,
      };
    },

    render,

    dispose(): void {
      disposed = true;
      for (const slot of slots) slot.worker.terminate();
      slots.length = 0;
    },

    stats(): WorkerPoolStats {
      return { size, transport, dispatched, completed, failed, restarts };
    },
  };
}
