/**
 * The subset of WebGPU this project uses, plus the two runtime handles it needs.
 *
 * TypeScript's DOM library does not ship WebGPU types, and `@webgpu/types` would
 * be a new dependency for a few hundred lines of surface. Declaring the subset
 * here keeps the dependency budget at zero, and the browser lane validates that
 * the declarations match the real API — a wrong signature fails a GPU test
 * rather than silently miscompiling.
 *
 * These are *module* types, imported explicitly, rather than ambient globals:
 * with `moduleDetection: "force"` an ambient declaration file is not reliably
 * part of the program, and a compile-time-only global would not fail loudly if
 * it silently went missing.
 */

export interface GpuAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

export interface GpuAdapter {
  readonly features: { has(name: string): boolean };
  readonly info?: GpuAdapterInfo;
  requestDevice(descriptor?: { label?: string }): Promise<GpuDevice>;
}

export interface GpuCompilationMessage {
  readonly type: string;
  readonly message: string;
  readonly lineNum: number;
  readonly linePos: number;
}

export interface GpuShaderModule {
  readonly label?: string;
  getCompilationInfo(): Promise<{
    readonly messages: readonly GpuCompilationMessage[];
  }>;
}

export interface GpuBindGroupLayout {
  readonly label?: string;
}

export interface GpuBindGroup {
  readonly label?: string;
}

export interface GpuComputePipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}

export interface GpuCommandBuffer {
  readonly label?: string;
}

export interface GpuBuffer {
  readonly size: number;
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface GpuQueue {
  writeBuffer(
    buffer: GpuBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset?: number,
    size?: number,
  ): void;
  submit(commandBuffers: readonly GpuCommandBuffer[]): void;
}

export interface GpuComputePassEncoder {
  setPipeline(pipeline: GpuComputePipeline): void;
  setBindGroup(index: number, bindGroup: GpuBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

export interface GpuCommandEncoder {
  beginComputePass(descriptor?: { label?: string }): GpuComputePassEncoder;
  copyBufferToBuffer(
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): GpuCommandBuffer;
}

export interface GpuBindGroupEntry {
  binding: number;
  resource: { buffer: GpuBuffer; offset?: number; size?: number };
}

export interface GpuDevice {
  readonly queue: GpuQueue;
  readonly lost: Promise<{ reason: string; message: string }>;
  createShaderModule(descriptor: { code: string; label?: string }): GpuShaderModule;
  createComputePipeline(descriptor: {
    layout: "auto" | GpuBindGroupLayout;
    compute: { module: GpuShaderModule; entryPoint: string };
    label?: string;
  }): GpuComputePipeline;
  createBuffer(descriptor: {
    size: number;
    usage: number;
    mappedAtCreation?: boolean;
    label?: string;
  }): GpuBuffer;
  createBindGroup(descriptor: {
    layout: GpuBindGroupLayout;
    entries: readonly GpuBindGroupEntry[];
    label?: string;
  }): GpuBindGroup;
  createCommandEncoder(descriptor?: { label?: string }): GpuCommandEncoder;
  pushErrorScope(filter: "validation" | "out-of-memory" | "internal"): void;
  popErrorScope(): Promise<{ readonly message: string } | null>;
  destroy(): void;
}

export type GpuAdapterRequester = {
  requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapter | null>;
};

/** The GPU entry point, or `null` when the browser does not expose one. */
export function webGpuAdapterRequester(): GpuAdapterRequester | null {
  const nav = globalThis.navigator as unknown as
    { gpu?: GpuAdapterRequester } | undefined;
  return nav?.gpu ?? null;
}

export type WebGpuConstants = {
  readonly bufferUsage: {
    readonly MAP_READ: number;
    readonly COPY_SRC: number;
    readonly COPY_DST: number;
    readonly UNIFORM: number;
    readonly STORAGE: number;
  };
  readonly mapMode: { readonly READ: number };
};

/** The WebGPU constants, or `null` when WebGPU is not present at all. */
export function webGpuConstants(): WebGpuConstants | null {
  const globals = globalThis as unknown as {
    GPUBufferUsage?: WebGpuConstants["bufferUsage"];
    GPUMapMode?: WebGpuConstants["mapMode"];
  };
  if (!globals.GPUBufferUsage || !globals.GPUMapMode) return null;
  return { bufferUsage: globals.GPUBufferUsage, mapMode: globals.GPUMapMode };
}
