/**
 * The WebGPU backend: the L0 engine as a compute shader.
 *
 * It exists for two reasons. First, the objective calls for both GPU backends
 * behind one seam, and until a *second* implementation goes through that seam the
 * seam is a design, not a fact. Second, compute shaders are the honest place for
 * this work: the WebGL2 path has to disguise a per-pixel kernel as a fragment
 * shader and read the framebuffer back, whereas here it is a storage buffer and a
 * dispatch.
 *
 * The WGSL kernel iterates exactly the recurrence `escapeDirectFloat` does, in
 * `f32`, so the same differential test that judges WebGL2 judges this — and the
 * same limitation applies: `f32` accumulation diverges from the oracle as
 * iterations grow, so this is a **preview** backend and refuses `exact`.
 *
 * The coordinate convention differs from the WebGL2 backend on purpose. A
 * fragment shader's `gl_FragCoord` is bottom-up and forces a flip; a compute
 * invocation is just an index, so this backend addresses output row 0 as the
 * *top* row and hands the shader a top-left origin with a downward-positive
 * imaginary step. Each backend derives its own origin and step from the one
 * shared view transform.
 */

import { fromFloat, mul, toFloat } from "../numeric/bigfixed";
import { computeConvergedReferenceOrbit } from "../engines/reference";
import { splitDouble } from "./doubleSingle";
import { REFUSED_COUNT, repairFlaggedPixels } from "./repair";
import { fromBigFixed } from "../numeric/floatexp";
import { WGSL_KERNEL, WGSL_PERTURB } from "./webgpu-shader";
import {
  type WebGpuConstants,
  type GpuBuffer,
  type GpuComputePipeline,
  type GpuDevice,
  webGpuAdapterRequester,
  webGpuConstants,
} from "./webgpu-types";
import { pixelSizeOf, pixelToComplex, scaleExponentOf } from "../view/view";
import {
  type Capability,
  type FractalBackend,
  type TileRequest,
  type TileResult,
  assertTileFitsView,
  tileOutputSize,
} from "./backend";

/** Plain `f32` reach: 24 significant bits. Preview quality stops here. */
export const WEBGPU_F32_PIXEL_EXPONENT_LIMIT = -20;

/**
 * Emulated-double reach.
 *
 * A `(hi, lo)` pair of `f32`s carries about 48 significant bits, so a pixel
 * offset stays representable roughly 24 bits deeper than plain `f32` allows.
 * The limit keeps a margin rather than running to the theoretical edge.
 */
export const WEBGPU_DS_PIXEL_EXPONENT_LIMIT = -40;

const WORKGROUP_SIZE = 8;
const UNIFORM_BYTES = 96;
const PALETTE_BYTES = 256 * 4;
const MAX_PALETTE_ENTRIES = 256;

type GpuState = {
  readonly device: GpuDevice;
  readonly constants: WebGpuConstants;
  /** Plain f32 kernel: preview. */
  readonly single: GpuComputePipeline;
  /** Emulated double-precision kernel: exact. */
  readonly double: GpuComputePipeline;
  /** Perturbation kernel: any depth, preview quality. */
  readonly perturb: GpuComputePipeline;
  readonly uniformBuffer: GpuBuffer;
  readonly paletteBuffer: GpuBuffer;
  /** Palette currently uploaded, so it is only re-sent when it changes. */
  paletteName: string | null;
  countsBuffer: GpuBuffer;
  coloursBuffer: GpuBuffer;
  stagingBuffer: GpuBuffer;
  /** Samples the output buffers are sized for. */
  capacity: number;
  /** Reference orbit for the perturbation kernel, and what is currently in it. */
  orbitBuffer: GpuBuffer;
  orbitEntries: number;
  orbitKey: string | null;
};

/** Bytes per sample for the two output formats. */
const COUNT_BYTES = 4;
const COLOUR_BYTES = 4;

function bufferSize(samples: number): number {
  // Uniform/storage binding sizes must be non-zero and 4-byte aligned.
  return Math.max(4, samples * 4);
}

async function initialise(): Promise<GpuState> {
  const requester = webGpuAdapterRequester();
  const constants = webGpuConstants();
  if (!requester || !constants) {
    throw new Error(
      "webgpu: this browser exposes no navigator.gpu — WebGPU is disabled or unimplemented",
    );
  }
  const adapter = await requester.requestAdapter();
  if (!adapter) {
    throw new Error(
      "webgpu: requestAdapter returned null — no compatible adapter (headless Chrome needs --enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader)",
    );
  }
  const device = await adapter.requestDevice();
  // One module, three entry points: the L0 kernels and the perturbation kernel
  // share the parameter struct and the output buffers, so the concatenation is
  // the whole of their relationship.
  const module = device.createShaderModule({
    code: `${WGSL_KERNEL}\n${WGSL_PERTURB}`,
    label: "orion-kernels",
  });
  // A shader that fails to compile yields a *valid-looking but inert* pipeline:
  // the dispatch becomes a no-op and the output buffer keeps whatever it held.
  // That is exactly the silent wrong answer this project refuses to ship, so
  // compilation is checked here and the WGSL error is raised verbatim.
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length > 0) {
    const detail = errors
      .map(
        (message) => `  line ${message.lineNum}:${message.linePos} ${message.message}`,
      )
      .join("\n");
    throw new Error(`webgpu: WGSL failed to compile:\n${detail}`);
  }
  const single = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "single" },
    label: "orion-l0-single",
  });
  const double = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "double" },
    label: "orion-l0-double",
  });
  const perturb = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "perturb" },
    label: "orion-perturb",
  });
  const capacity = 1;
  return {
    device,
    constants,
    single,
    double,
    perturb,
    uniformBuffer: device.createBuffer({
      size: UNIFORM_BYTES,
      usage: constants.bufferUsage.UNIFORM | constants.bufferUsage.COPY_DST,
      label: "orion-params",
    }),
    paletteBuffer: device.createBuffer({
      size: PALETTE_BYTES,
      usage: constants.bufferUsage.STORAGE | constants.bufferUsage.COPY_DST,
      label: "orion-palette",
    }),
    paletteName: null,
    countsBuffer: device.createBuffer({
      size: bufferSize(capacity),
      usage:
        constants.bufferUsage.STORAGE |
        constants.bufferUsage.COPY_SRC |
        constants.bufferUsage.COPY_DST,
      label: "orion-counts",
    }),
    coloursBuffer: device.createBuffer({
      size: bufferSize(capacity),
      usage:
        constants.bufferUsage.STORAGE |
        constants.bufferUsage.COPY_SRC |
        constants.bufferUsage.COPY_DST,
      label: "orion-colours",
    }),
    stagingBuffer: device.createBuffer({
      size: bufferSize(capacity),
      usage: constants.bufferUsage.MAP_READ | constants.bufferUsage.COPY_DST,
      label: "orion-staging",
    }),
    capacity,
    // A zero-sized storage binding is invalid, so the orbit starts at one entry
    // and grows on the first perturbation render.
    orbitBuffer: device.createBuffer({
      size: 16,
      usage: constants.bufferUsage.STORAGE | constants.bufferUsage.COPY_DST,
      label: "orion-orbit",
    }),
    orbitEntries: 1,
    orbitKey: null,
  };
}

export function createWebGpuBackend(): FractalBackend {
  let pending: Promise<GpuState> | null = null;
  /**
   * The readback of the most recent render, if it has not finished.
   *
   * Every render shares this backend's buffers, so a new render must not touch
   * them until the previous one has finished reading back.
   */
  let inFlight: Promise<void> | null = null;

  const ensure = (): Promise<GpuState> => {
    pending ??= initialise();
    return pending;
  };

  return {
    name: "webgpu",

    capability(view, plan): Capability {
      const exponent = scaleExponentOf(view);
      if (!webGpuAdapterRequester() || !webGpuConstants()) {
        return {
          supported: false,
          why: "navigator.gpu is unavailable in this browser",
        };
      }
      if (plan.quality === "exact" && plan.stage !== "direct-f64") {
        // `exact` means the oracle's escape counts. The perturbation kernel is a
        // preview engine (f32 mantissas), so an exact deep view is the CPU's.
        return {
          supported: false,
          why: `exact quality at this depth needs the perturbation engine, and the compute kernel's is a preview engine (f32 mantissas, 24 bits against the CPU's 53)`,
        };
      }
      if (plan.quality === "exact") {
        // `exact` always takes the emulated-double kernel, which reaches about
        // 24 bits deeper than plain f32.
        if (exponent < WEBGPU_DS_PIXEL_EXPONENT_LIMIT) {
          return {
            supported: false,
            why: `pixel spacing 2^${exponent} is below the emulated-double limit 2^${WEBGPU_DS_PIXEL_EXPONENT_LIMIT}; needs the perturbation path`,
          };
        }
        return {
          supported: true,
          why: `L0 engine with emulated double precision (~48-bit), reach 2^${WEBGPU_DS_PIXEL_EXPONENT_LIMIT}`,
        };
      }
      if (exponent < WEBGPU_F32_PIXEL_EXPONENT_LIMIT) {
        // Below the direct limit the offset is not representable in f32 at all,
        // so the perturbation kernel takes over: the reference orbit is computed
        // once on the CPU and each pixel iterates only its delta.
        return {
          supported: true,
          why: `perturbation engine, preview quality (f32 mantissa deltas against a full-precision reference orbit)`,
        };
      }
      return {
        supported: true,
        why: `L0 engine in f32, preview reach 2^${WEBGPU_F32_PIXEL_EXPONENT_LIMIT}`,
      };
    },

    async render(request: TileRequest, into: TileResult): Promise<TileResult> {
      assertTileFitsView(request.view, request.tile, request.allowOutsideView ?? false);
      const output = tileOutputSize(request.tile, request.step);
      if (output.width !== into.width || output.height !== into.height) {
        throw new Error(
          `webgpu backend: result buffer is ${into.width}x${into.height}, but a ${request.tile.width}x${request.tile.height} tile at step ${request.step} is ${output.width}x${output.height}`,
        );
      }
      const state = await ensure();

      // A cancelled render still has GPU work queued behind it, and the staging
      // buffer can be mapped only once at a time. Submitting a copy into it while
      // a map is pending is a validation error — and, worse than an error, a
      // render that overwrote it mid-read would hand back the *previous* frame's
      // bytes as its own. So a render waits for the previous readback.
      const previous = inFlight;
      let readbackDone!: () => void;
      inFlight = new Promise<void>((resolve) => {
        readbackDone = resolve;
      });
      if (previous !== null) {
        try {
          await previous;
        } catch {
          // The previous render reports its own failure to its own caller.
        }
      }
      try {
        return await renderCompute(state, request, into, output);
      } finally {
        readbackDone();
      }
    },

    dispose(): void {
      if (pending === null) return;
      const state = pending;
      pending = null;
      void state.then((gpu) => {
        gpu.uniformBuffer.destroy();
        gpu.paletteBuffer.destroy();
        gpu.countsBuffer.destroy();
        gpu.coloursBuffer.destroy();
        gpu.stagingBuffer.destroy();
        gpu.device.destroy();
      });
    },
  };
}

/**
 * The GPU half of a render: dispatch, read back, fill `into`.
 *
 * Separate from `render` so that the serialization of the shared buffers is
 * visible in one place: the buffers belong to the backend, not to a render, and
 * the readback is what makes that observable.
 */
async function renderCompute(
  state: GpuState,
  request: TileRequest,
  into: TileResult,
  output: { readonly width: number; readonly height: number },
): Promise<TileResult> {
  const samples = output.width * output.height;
  grow(state, samples, request.palette.size);
  uploadPalette(state, request);
  uploadParams(state, request, output);

  // `exact` always takes the emulated-double kernel: plain f32 diverges from
  // the oracle as iterations accumulate even at shallow depths, so there is
  // no depth at which single precision is "exact enough" to promise.
  const useDouble = request.quality === "exact";
  const exponent = scaleExponentOf(request.view);
  const limit = useDouble
    ? WEBGPU_DS_PIXEL_EXPONENT_LIMIT
    : WEBGPU_F32_PIXEL_EXPONENT_LIMIT;
  // Past the direct-iteration limit there is no f32 offset to iterate: the view
  // has to go through the perturbation kernel, which needs the reference orbit.
  const usePerturbation = exponent < limit;
  if (usePerturbation && useDouble) {
    throw new Error(
      `webgpu backend: pixel spacing 2^${exponent} is below the emulated-double limit 2^${WEBGPU_DS_PIXEL_EXPONENT_LIMIT}, and the perturbation kernel is a preview engine`,
    );
  }
  const pipeline = usePerturbation
    ? state.perturb
    : useDouble
      ? state.double
      : state.single;
  if (usePerturbation) {
    uploadOrbit(state, request);
  }

  const device = state.device;
  // `layout: "auto"` mints a *fresh* layout per pipeline, so the bind group
  // must be built from the chosen pipeline's layout, not from a sibling's.
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: state.uniformBuffer } },
      { binding: 1, resource: { buffer: state.countsBuffer } },
      { binding: 2, resource: { buffer: state.coloursBuffer } },
      { binding: 3, resource: { buffer: state.paletteBuffer } },
    ],
    label: "orion-bind",
  });
  // The perturbation kernel reads the orbit from its own bind group, which the
  // auto layout only asks for when the entry point uses it.
  const perturbBindGroup = usePerturbation
    ? device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: state.orbitBuffer } }],
        label: "orion-orbit-bind",
      })
    : null;

  const wantsCounts = request.output === "escape-count";
  const source = wantsCounts ? state.countsBuffer : state.coloursBuffer;
  const byteLength = samples * (wantsCounts ? COUNT_BYTES : COLOUR_BYTES);

  // WebGPU reports validation failures asynchronously and otherwise lets the
  // command buffer do nothing, leaving stale bytes in the output buffer. That
  // is a silent wrong answer, so every dispatch is checked.
  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder({ label: "orion-render" });
  const pass = encoder.beginComputePass({ label: "orion-l0" });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  if (perturbBindGroup) {
    pass.setBindGroup(1, perturbBindGroup);
  }
  pass.dispatchWorkgroups(
    Math.ceil(output.width / WORKGROUP_SIZE),
    Math.ceil(output.height / WORKGROUP_SIZE),
  );
  pass.end();
  encoder.copyBufferToBuffer(source, 0, state.stagingBuffer, 0, byteLength);
  device.queue.submit([encoder.finish()]);

  const validationError = await device.popErrorScope();
  if (validationError) {
    throw new Error(`webgpu: validation failed: ${validationError.message}`);
  }

  await state.stagingBuffer.mapAsync(state.constants.mapMode.READ, 0, byteLength);
  const mapped = state.stagingBuffer.getMappedRange(0, byteLength);
  if (wantsCounts) {
    const values = new Float32Array(mapped.slice(0));
    into.escapeCounts.set(values.subarray(0, samples), 0);
  } else {
    // pack4x8unorm writes r | g<<8 | b<<16 | a<<24, so the bytes are already
    // r, g, b, a in little-endian order — exactly the RGBA layout wanted.
    into.pixels.set(new Uint8Array(mapped.slice(0)), 0);
  }
  state.stagingBuffer.unmap();

  // Pixels the fast path could not be trusted on are recomputed exactly here,
  // by the same direct engine the CPU backend repairs with. The GPU never
  // guesses at a flagged pixel; it hands it back.
  const repaired = usePerturbation
    ? repairFlaggedPixels(request, into, output, (index) =>
        wantsCounts
          ? into.escapeCounts[index] === REFUSED_COUNT
          : into.pixels[index * 4 + 3] === 0,
      )
    : 0;

  into.stage = usePerturbation
    ? repaired > 0
      ? "perturbation-f32-compute+repair"
      : "perturbation-f32-compute"
    : useDouble
      ? "direct-ds-compute"
      : "direct-f32-compute";
  return into;
}

function grow(state: GpuState, samples: number, paletteSize: number): void {
  if (paletteSize > MAX_PALETTE_ENTRIES) {
    throw new Error(
      `webgpu backend: palette has ${paletteSize} entries; the shader's palette buffer holds ${MAX_PALETTE_ENTRIES}`,
    );
  }
  if (samples <= state.capacity) return;
  const { device } = state;
  for (const buffer of [state.countsBuffer, state.coloursBuffer, state.stagingBuffer]) {
    buffer.destroy();
  }
  const usage =
    state.constants.bufferUsage.STORAGE |
    state.constants.bufferUsage.COPY_SRC |
    state.constants.bufferUsage.COPY_DST;
  state.countsBuffer = device.createBuffer({
    size: bufferSize(samples),
    usage,
    label: "orion-counts",
  });
  state.coloursBuffer = device.createBuffer({
    size: bufferSize(samples),
    usage,
    label: "orion-colours",
  });
  state.stagingBuffer = device.createBuffer({
    size: bufferSize(samples),
    usage: state.constants.bufferUsage.MAP_READ | state.constants.bufferUsage.COPY_DST,
    label: "orion-staging",
  });
  state.capacity = samples;
}

function uploadPalette(state: GpuState, request: TileRequest): void {
  if (state.paletteName === request.palette.name) return;
  const packed = new Uint32Array(MAX_PALETTE_ENTRIES);
  for (let i = 0; i < request.palette.size; i++) {
    const colour = request.palette.at(i);
    packed[i] = (colour.r | (colour.g << 8) | (colour.b << 16) | (255 << 24)) >>> 0;
  }
  state.device.queue.writeBuffer(state.paletteBuffer, 0, packed);
  state.paletteName = request.palette.name;
}

/** Split a double into two floats that sum back to it: `hi` is the f32 nearest. */
function writeDouble(target: Float32Array, offset: number, value: number): void {
  const [hi, lo] = splitDouble(value);
  target[offset] = hi;
  target[offset + 1] = Math.fround(lo);
}

/**
 * Upload the reference orbit for a view, once.
 *
 * The orbit is computed on the CPU at full precision (it is the one thing in the
 * GPU path that cannot be done in f32) and stored as an `(re.m, im.m, re.e, im.e)`
 * quadruple per iteration — a floatexp with an f32 mantissa. Keyed on the view
 * geometry, because every tile of a view shares one reference point.
 */
function uploadOrbit(state: GpuState, request: TileRequest): void {
  const { view } = request;
  const key = `${view.width.v}|${view.pixelWidth}x${view.pixelHeight}|${request.maxIterations}`;
  if (state.orbitKey === key) return;

  const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
  const orbit = computeConvergedReferenceOrbit(
    reference,
    request.maxIterations + 1,
    view.width.fracBits,
  ).orbit;
  const entries = orbit.length;
  const bytes = entries * 16;
  if (bytes > state.orbitBuffer.size) {
    state.orbitBuffer.destroy();
    state.orbitBuffer = state.device.createBuffer({
      size: bytes,
      usage: state.constants.bufferUsage.STORAGE | state.constants.bufferUsage.COPY_DST,
      label: "orion-orbit",
    });
  }
  const packed = new Float32Array(entries * 4);
  for (let i = 0; i < entries; i++) {
    packed[i * 4] = orbit.reMantissa[i] as number;
    packed[i * 4 + 1] = orbit.imMantissa[i] as number;
    packed[i * 4 + 2] = orbit.reExponent[i] as number;
    packed[i * 4 + 3] = orbit.imExponent[i] as number;
  }
  state.device.queue.writeBuffer(state.orbitBuffer, 0, packed);
  state.orbitEntries = entries;
  state.orbitKey = key;
}

function uploadParams(
  state: GpuState,
  request: TileRequest,
  output: { width: number; height: number },
): void {
  const { view, tile, step } = request;
  // Row 0 is the *top* row here, so the origin is the tile's top-left sample and
  // the imaginary step increases downward, matching the view transform.
  const origin = pixelToComplex(view, tile.x, tile.y);
  const nextColumn = pixelToComplex(view, tile.x + step, tile.y);
  const nextRow = pixelToComplex(view, tile.x, tile.y + step);

  const bytes = new ArrayBuffer(UNIFORM_BYTES);
  const floats = new Float32Array(bytes);
  const ints = new Uint32Array(bytes);
  // Every complex quantity crosses as a (hi, lo) pair, so the emulated-double
  // kernel receives the full precision the CPU computed rather than a rounded
  // f32 — which is the entire point of splitting a double into two floats.
  writeDouble(floats, 0, toFloat(origin.re));
  writeDouble(floats, 2, toFloat(origin.im));
  writeDouble(floats, 4, toFloat(nextColumn.re) - toFloat(origin.re));
  writeDouble(
    floats,
    6,
    output.height > 1 ? toFloat(nextRow.im) - toFloat(origin.im) : 0,
  );
  ints[8] = request.maxIterations;
  ints[9] = request.output === "escape-count" ? 1 : 0;
  ints[10] = output.width;
  ints[11] = output.height;
  floats[12] = request.palette.cyclesPerUnit;
  ints[13] = request.palette.size;

  // Perturbation only. The step crosses as a floatexp — mantissa and exponent
  // separately — because at depth the step itself is far below the f32 range and
  // its *scale* is the whole reason the delta formulation works. `toFloat` would
  // round it to zero.
  // The *sample* spacing, which is the pixel spacing times the pass step: a
  // coarse pass steps over pixels, so its deltas are that much larger.
  const sampleStep = mul(pixelSizeOf(view), fromFloat(step, view.width.fracBits));
  const sampleFloatexp = fromBigFixed(sampleStep);
  floats[14] = sampleFloatexp.m;
  floats[15] = sampleFloatexp.m;
  // Written as *floats*: the uniform fields are `vec2<f32>`, and storing an
  // integer bit pattern in a float field makes the shader read a denormal and
  // truncate it to zero — which silently turns a 2^-24 step into a 0.5 one.
  floats[16] = sampleFloatexp.e;
  floats[17] = sampleFloatexp.e;
  // Tile-local: sample `gid.x` sits at view pixel `tile.x + gid.x*step`, and the
  // reference is the view centre, so the offset is `gid.x - (W/2 - tile.x)` in
  // sample units. Writing the centre alone would shift every tile but the first.
  floats[18] = view.pixelWidth / 2 - tile.x;
  floats[19] = view.pixelHeight / 2 - tile.y;

  state.device.queue.writeBuffer(state.uniformBuffer, 0, new Uint8Array(bytes));
}
