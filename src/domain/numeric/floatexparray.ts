/**
 * A contiguous array of `FloatComplex` values in structure-of-arrays form.
 *
 * This is the shape both deep-zoom consumers need: the reference orbit stores
 * one per iteration, and the series approximation stores one per (order,
 * iteration). Keeping a single accessor pair means the range handling and the
 * bounds checking exist once, and the whole array is directly uploadable to a
 * GPU buffer without a repack step.
 */

import type { FloatComplex } from "./floatcomplex";

export type FloatComplexArray = {
  readonly length: number;
  readonly reMantissa: Float64Array;
  readonly reExponent: Int32Array;
  readonly imMantissa: Float64Array;
  readonly imExponent: Int32Array;
};

/**
 * Allocate `length` complex values, initially zero. The arrays may be
 * over-allocated and trimmed later with `trimFloatComplexArray`.
 */
export function allocateFloatComplexArray(length: number): FloatComplexArray {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(
      `FloatComplexArray: length must be a non-negative integer (got ${length})`,
    );
  }
  return {
    length,
    reMantissa: new Float64Array(length),
    reExponent: new Int32Array(length),
    imMantissa: new Float64Array(length),
    imExponent: new Int32Array(length),
  };
}

/** View the first `length` entries, sharing the underlying buffers. */
export function trimFloatComplexArray(
  array: FloatComplexArray,
  length: number,
): FloatComplexArray {
  if (!Number.isInteger(length) || length < 0 || length > array.length) {
    throw new Error(
      `FloatComplexArray: cannot trim to ${length} of ${array.length} entries`,
    );
  }
  return {
    length,
    reMantissa: array.reMantissa.subarray(0, length),
    reExponent: array.reExponent.subarray(0, length),
    imMantissa: array.imMantissa.subarray(0, length),
    imExponent: array.imExponent.subarray(0, length),
  };
}

export function readFloatComplex(array: FloatComplexArray, n: number): FloatComplex {
  if (!Number.isInteger(n) || n < 0 || n >= array.length) {
    throw new Error(`FloatComplexArray: index ${n} out of range [0, ${array.length})`);
  }
  // Bounds checked above; typed-array lookups are typed as possibly undefined.
  return {
    re: {
      m: array.reMantissa[n] as number,
      e: array.reExponent[n] as number,
    },
    im: {
      m: array.imMantissa[n] as number,
      e: array.imExponent[n] as number,
    },
  };
}

export function writeFloatComplex(
  array: FloatComplexArray,
  n: number,
  value: FloatComplex,
): void {
  if (!Number.isInteger(n) || n < 0 || n >= array.length) {
    throw new Error(`FloatComplexArray: index ${n} out of range [0, ${array.length})`);
  }
  array.reMantissa[n] = value.re.m;
  array.reExponent[n] = value.re.e;
  array.imMantissa[n] = value.im.m;
  array.imExponent[n] = value.im.e;
}
