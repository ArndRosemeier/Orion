/**
 * The Rust→WASM carrier for the perturbation (delta) recurrence.
 *
 * This is the deep-zoom hot loop: `iterations x pixels` evaluations of
 * `d -> 2*Z*d + d^2 + dc` in `Floatexp`. Measured on the JavaScript carrier at a
 * 2^-100 view, that is **~1.2 microseconds per iteration** — around 700
 * microseconds per pixel at a 600-iteration budget, which is minutes for one
 * screenful. The module does the same arithmetic in registers.
 *
 * The contract is the same one the L0 kernel keeps: **bit-identical** to the
 * JavaScript engine, not "close enough". Both were written to the same order of
 * operations, so a carrier swap cannot move a single pixel — which is what makes
 * the speedup safe to rely on rather than merely pleasant.
 *
 * The orbit is uploaded once per (orbit, capacity) pair and cached, because the
 * same reference serves every pixel of a view and every tile cut from it.
 *
 * Loading is explicit: `loadPerturbWasmEngine` throws with the reason if the
 * module cannot be loaded, so a caller that asked for the fast carrier is told it
 * is unavailable instead of silently receiving the slow one.
 */

import wasmUrl from "./perturb.wasm?url";
import { type Floatexp, fromFloat } from "../numeric/floatexp";
import type { FloatComplexArray } from "../numeric/floatexparray";
import type { BlaTable } from "./bla";
import type { DeltaCarrier, DeltaRequest, PerturbationResult } from "./perturbation";
import type { ReferenceOrbit } from "./reference";

type PerturbExports = {
  readonly memory: WebAssembly.Memory;
  batch_capacity(): number;
  orbit_capacity(): number;
  orbit_re_m_ptr(): number;
  orbit_re_e_ptr(): number;
  orbit_im_m_ptr(): number;
  orbit_im_e_ptr(): number;
  dc_m_ptr(): number;
  dc_e_ptr(): number;
  start_m_ptr(): number;
  start_e_ptr(): number;
  start_iter_ptr(): number;
  bla_m_ptr(): number;
  bla_e_ptr(): number;
  bla_index_capacity(): number;
  bla_level_capacity(): number;
  iterate_batch_bla(
    orbitLength: number,
    count: number,
    maxIterations: number,
    blockExponent: number,
  ): number;
  out_flags_ptr(): number;
  out_mag_ptr(): number;
  out_blocks_ptr(): number;
  errors(): number;
  reset_errors(): void;
  iterate_batch(orbitLength: number, count: number, maxIterations: number): number;
};

/** Why `iterate_batch` refused, mirroring the kernel's status codes. */
const STATUS_MESSAGES: Record<number, string> = {
  1: "the orbit length is outside the kernel's capacity",
  2: "the pixel batch is outside the kernel's capacity",
  3: "maxIterations must be a positive integer",
  4: "a non-finite value reached the kernel, which cannot represent one",
};

/**
 * The kernel as a carrier.
 *
 * Identical output to `jsDeltaCarrier`, by construction and by pin, so a caller
 * chooses between them for speed alone.
 */
export type PerturbWasmEngine = DeltaCarrier & {
  /** How many times the orbit has been uploaded; the cache is observable. */
  readonly orbitUploads: number;
  /**
   * Apply a view's BLA tables: the same jump loop as the JavaScript carrier, in
   * Rust, against coefficients composed on the host so both carriers apply
   * *identical* values and can be held to bit-identity.
   */
  blaCarrier(table: BlaTable): DeltaCarrier;
};

export type PerturbWasmOptions = {
  /** How the module bytes are obtained. Defaults to `fetch` on the module URL. */
  readonly loadBytes?: () => Promise<ArrayBuffer>;
};

function wrap(exports: PerturbExports): PerturbWasmEngine {
  const batchCapacity = exports.batch_capacity();
  const orbitCapacity = exports.orbit_capacity();
  if (batchCapacity < 1 || orbitCapacity < 2) {
    throw new Error("perturb wasm: module reports an unusable capacity");
  }

  const orbitReM = new Float64Array(
    exports.memory.buffer,
    exports.orbit_re_m_ptr(),
    orbitCapacity,
  );
  const orbitReE = new Int32Array(
    exports.memory.buffer,
    exports.orbit_re_e_ptr(),
    orbitCapacity,
  );
  const orbitImM = new Float64Array(
    exports.memory.buffer,
    exports.orbit_im_m_ptr(),
    orbitCapacity,
  );
  const orbitImE = new Int32Array(
    exports.memory.buffer,
    exports.orbit_im_e_ptr(),
    orbitCapacity,
  );
  const dcM = new Float64Array(
    exports.memory.buffer,
    exports.dc_m_ptr(),
    batchCapacity * 2,
  );
  const dcE = new Int32Array(
    exports.memory.buffer,
    exports.dc_e_ptr(),
    batchCapacity * 2,
  );
  const startM = new Float64Array(
    exports.memory.buffer,
    exports.start_m_ptr(),
    batchCapacity * 2,
  );
  const startE = new Int32Array(
    exports.memory.buffer,
    exports.start_e_ptr(),
    batchCapacity * 2,
  );
  const startIter = new Int32Array(
    exports.memory.buffer,
    exports.start_iter_ptr(),
    batchCapacity,
  );
  const outFlags = new Int32Array(
    exports.memory.buffer,
    exports.out_flags_ptr(),
    batchCapacity * 4,
  );
  const outMag = new Float64Array(
    exports.memory.buffer,
    exports.out_mag_ptr(),
    batchCapacity * 2,
  );

  const outBlocks = new Int32Array(
    exports.memory.buffer,
    exports.out_blocks_ptr(),
    batchCapacity * 2,
  );
  const blaIndexCapacity = exports.bla_index_capacity();
  const blaLevelCapacity = exports.bla_level_capacity();
  const blaM = new Float64Array(
    exports.memory.buffer,
    exports.bla_m_ptr(),
    (blaLevelCapacity + 1) * blaIndexCapacity * 4,
  );
  const blaE = new Int32Array(
    exports.memory.buffer,
    exports.bla_e_ptr(),
    (blaLevelCapacity + 1) * blaIndexCapacity * 4,
  );
  /** The tables currently in the module, so a view's coefficients cross once. */
  let uploadedBla: BlaTable | null = null;

  /**
   * Upload a view's BLA tables.
   *
   * Composed on the host by the same code the JavaScript carrier uses, so the
   * two carriers apply identical coefficients — which is what makes them
   * comparable bit for bit rather than only numerically.
   */
  const uploadBla = (table: BlaTable): void => {
    for (let level = 0; level < table.blocks.length; level++) {
      const a = table.blocks[level];
      const b = table.dcBlocks[level];
      if (!a || !b) continue;
      for (let index = 0; index < table.orbit.length; index++) {
        const base = (level * blaIndexCapacity + index) * 4;
        blaM[base] = a.reMantissa[index] as number;
        blaE[base] = a.reExponent[index] as number;
        blaM[base + 1] = a.imMantissa[index] as number;
        blaE[base + 1] = a.imExponent[index] as number;
        blaM[base + 2] = b.reMantissa[index] as number;
        blaE[base + 2] = b.reExponent[index] as number;
        blaM[base + 3] = b.imMantissa[index] as number;
        blaE[base + 3] = b.imExponent[index] as number;
      }
    }
    uploadedBla = table;
  };

  // The module has no allocator, so its memory never grows and these views stay
  // valid. Identified by length and first value rather than by identity: two
  // different arrays of the same shape are not interchangeable, and comparing
  // four numbers is cheaper than being wrong.
  let uploadedLength = -1;
  let uploadedFirstRe: Float64Array | null = null;
  let uploads = 0;

  const sameOrbit = (orbit: FloatComplexArray): boolean =>
    orbit.length === uploadedLength && orbit.reMantissa === uploadedFirstRe;

  const upload = (orbit: FloatComplexArray): void => {
    if (orbit.length < 2) {
      throw new Error(
        `perturb wasm: an orbit of ${orbit.length} values cannot be iterated (need at least 2)`,
      );
    }
    if (orbit.length > orbitCapacity) {
      throw new Error(
        `perturb wasm: orbit of ${orbit.length} exceeds the kernel's capacity of ${orbitCapacity}`,
      );
    }
    orbitReM.set(orbit.reMantissa);
    orbitReE.set(orbit.reExponent);
    orbitImM.set(orbit.imMantissa);
    orbitImE.set(orbit.imExponent);
    uploadedLength = orbit.length;
    uploadedFirstRe = orbit.reMantissa;
    uploads += 1;
  };

  /** Turn one batch of kernel outputs into carrier results. */
  const decodeBatch = (
    results: PerturbationResult[],
    count: number,
    withJumps = false,
  ): void => {
    for (let i = 0; i < count; i++) {
      // The jump kernel reports how much of the work was jumped and whether an
      // escaping block was re-iterated; the exact kernel reports zeros, so both
      // carriers expose the same fields.
      const jumpFields = {
        blocks: outBlocks[i * 2] as number,
        refined: outBlocks[i * 2 + 1] === 1,
      };
      const withAccounting = <T extends PerturbationResult>(result: T): T =>
        withJumps ? Object.assign(result, jumpFields) : result;
      const glitched = outFlags[i * 4] === 1;
      if (glitched) {
        const reason = outFlags[i * 4 + 1] === 2 ? "orbit-exhausted" : "precision";
        results.push(
          withAccounting({
            glitched: true,
            iterations: outFlags[i * 4 + 3] as number,
            reason,
          }),
        );
        continue;
      }
      const escaped = outFlags[i * 4 + 2] === 1;
      const iterations = outFlags[i * 4 + 3] as number;
      if (!escaped) {
        results.push(
          withAccounting({ glitched: false, escaped: false, iterations, smooth: null }),
        );
        continue;
      }
      // The smooth count is computed here, with the same `Math.log2` the
      // JavaScript engine uses, which is why the two agree bit for bit.
      const magnitude: Floatexp = {
        m: outMag[i * 2] as number,
        e: outMag[i * 2 + 1] as number,
      };
      const log2MagnitudeSquared = Math.log2(magnitude.m) + magnitude.e;
      results.push(
        withAccounting({
          glitched: false,
          escaped: true,
          iterations,
          smooth: iterations + 1 - Math.log2(0.5 * log2MagnitudeSquared),
        }),
      );
    }
  };

  return {
    name: "wasm-floatexp",
    kind: "wasm",

    get orbitUploads(): number {
      return uploads;
    },

    iterate(
      orbit: ReferenceOrbit,
      requests: readonly DeltaRequest[],
      maxIterations: number,
    ): PerturbationResult[] {
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        throw new Error(
          `perturb wasm: maxIterations must be a positive integer (got ${maxIterations})`,
        );
      }
      if (requests.length === 0) return [];
      if (!sameOrbit(orbit)) upload(orbit);

      const results: PerturbationResult[] = [];
      for (let from = 0; from < requests.length; from += batchCapacity) {
        const count = Math.min(batchCapacity, requests.length - from);
        for (let i = 0; i < count; i++) {
          const request = requests[from + i];
          if (!request) throw new Error(`perturb wasm: missing request at ${from + i}`);
          if (
            !Number.isInteger(request.startIteration) ||
            request.startIteration < 1 ||
            request.startIteration > maxIterations
          ) {
            throw new Error(
              `perturb wasm: startIteration ${request.startIteration} is outside [1, ${maxIterations}]`,
            );
          }
          dcM[i * 2] = request.dc.re.m;
          dcE[i * 2] = request.dc.re.e;
          dcM[i * 2 + 1] = request.dc.im.m;
          dcE[i * 2 + 1] = request.dc.im.e;
          startM[i * 2] = request.start.re.m;
          startE[i * 2] = request.start.re.e;
          startM[i * 2 + 1] = request.start.im.m;
          startE[i * 2 + 1] = request.start.im.e;
          startIter[i] = request.startIteration;
        }
        exports.reset_errors();
        const status = exports.iterate_batch(orbit.length, count, maxIterations);
        if (status !== 0) {
          throw new Error(
            `perturb wasm: iterate_batch refused (${STATUS_MESSAGES[status] ?? `status ${status}`})`,
          );
        }
        const errors = exports.errors();
        if (errors > 0) {
          throw new Error(
            `perturb wasm: ${errors} non-finite value(s) in this batch; the reference orbit or an offset is corrupt`,
          );
        }
        decodeBatch(results, count);
      }
      return results;
    },

    blaCarrier(table: BlaTable): DeltaCarrier {
      return {
        name: "wasm-floatexp-bla",
        kind: "wasm",
        iterate(
          orbit: ReferenceOrbit,
          requests: readonly DeltaRequest[],
          maxIterations: number,
        ) {
          if (orbit.length !== table.orbit.length) {
            throw new Error(
              `perturb wasm: BLA tables were built for an orbit of ${table.orbit.length} values, got ${orbit.length}`,
            );
          }
          if (table.blockExponent < 0 || table.blockExponent > blaLevelCapacity) {
            throw new Error(
              `perturb wasm: block exponent ${table.blockExponent} is outside the kernel's capacity 0..${blaLevelCapacity}`,
            );
          }
          if (orbit.length > blaIndexCapacity) {
            throw new Error(
              `perturb wasm: an orbit of ${orbit.length} values exceeds the BLA table capacity ${blaIndexCapacity}; the exact kernel covers this view`,
            );
          }
          if (requests.length === 0) return [];
          if (!sameOrbit(orbit)) upload(orbit);
          if (uploadedBla !== table) uploadBla(table);

          const results: PerturbationResult[] = [];
          for (let from = 0; from < requests.length; from += batchCapacity) {
            const count = Math.min(batchCapacity, requests.length - from);
            for (let i = 0; i < count; i++) {
              const request = requests[from + i];
              if (!request)
                throw new Error(`perturb wasm: missing request at ${from + i}`);
              dcM[i * 2] = request.dc.re.m;
              dcE[i * 2] = request.dc.re.e;
              dcM[i * 2 + 1] = request.dc.im.m;
              dcE[i * 2 + 1] = request.dc.im.e;
              startM[i * 2] = request.start.re.m;
              startE[i * 2] = request.start.re.e;
              startM[i * 2 + 1] = request.start.im.m;
              startE[i * 2 + 1] = request.start.im.e;
              startIter[i] = request.startIteration;
            }
            exports.reset_errors();
            const status = exports.iterate_batch_bla(
              orbit.length,
              count,
              maxIterations,
              table.blockExponent,
            );
            if (status !== 0) {
              throw new Error(
                `perturb wasm: iterate_batch_bla refused (${STATUS_MESSAGES[status] ?? `status ${status}`})`,
              );
            }
            decodeBatch(results, count, true);
          }
          return results;
        },
      };
    },
  };
}

/**
 * Load the WASM perturbation engine.
 *
 * Throws with the reason if the module cannot be fetched or instantiated.
 */
export async function loadPerturbWasmEngine(
  options: PerturbWasmOptions = {},
): Promise<PerturbWasmEngine> {
  if (typeof WebAssembly === "undefined") {
    throw new Error("perturb wasm: this environment has no WebAssembly");
  }
  const bytes = await (options.loadBytes ?? defaultLoadBytes)();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as unknown as PerturbExports;
  const required = [
    "iterate_batch",
    "batch_capacity",
    "orbit_capacity",
    "orbit_re_m_ptr",
    "orbit_re_e_ptr",
    "orbit_im_m_ptr",
    "orbit_im_e_ptr",
    "dc_m_ptr",
    "dc_e_ptr",
    "start_m_ptr",
    "start_e_ptr",
    "start_iter_ptr",
    "out_flags_ptr",
    "out_mag_ptr",
    "errors",
    "reset_errors",
  ] as const;
  for (const name of required) {
    if (typeof exports[name] !== "function") {
      throw new Error(`perturb wasm: the module does not export ${name}`);
    }
  }
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("perturb wasm: the module does not export its memory");
  }
  return wrap(exports);
}

/** The glitch threshold the kernel hard-codes, for the pin that keeps it honest. */
export const KERNEL_GLITCH_THRESHOLD: Floatexp = fromFloat(2 ** -24);

async function defaultLoadBytes(): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(
      `perturb wasm: fetch failed with ${response.status} ${response.statusText}`,
    );
  }
  return await response.arrayBuffer();
}
