/**
 * The worker protocol, validated at both ends.
 *
 * A worker boundary is an I/O boundary: the bytes crossing it are not typed by
 * anything, so the work item is parsed with a schema in the worker and the reply
 * is parsed with a schema in the pool. A malformed message is a loud error in
 * both directions rather than a `undefined` that surfaces three layers later.
 *
 * The view crosses as a **URL fragment** — the codec built for shareable links
 * already carries a view at full precision, exactly, in ~200 characters. Reusing
 * it means the worker and the main thread cannot disagree about what a view is,
 * because there is only one definition of the format.
 *
 * A tile's pixels normally come back as a transferred `ArrayBuffer`. When the
 * page is cross-origin isolated the caller may instead supply a
 * `SharedArrayBuffer` target, and the worker writes the tile straight into the
 * shared image with no copy and no clone at all.
 */

import { z } from "zod";

export const RgbSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
});

export const PaletteSchema = z.object({
  name: z.string().min(1),
  stops: z.array(RgbSchema).min(2),
  size: z.number().int().min(2).max(256),
  cyclesPerUnit: z.number().positive(),
});

export const TileRectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});

/** The shape is checked; the buffer itself is shared by reference. */
export const SharedTargetSchema = z.object({
  buffer: z.instanceof(SharedArrayBuffer),
  byteOffset: z.number().int().min(0),
  stride: z.number().int().min(1),
});

export const WorkItemSchema = z.object({
  id: z.number().int().min(0),
  viewFragment: z.string().min(1),
  tile: TileRectSchema,
  step: z.number().int().min(1),
  quality: z.enum(["preview", "exact"]),
  maxIterations: z.number().int().min(1),
  palette: PaletteSchema,
  output: z.enum(["colour", "escape-count"]),
  target: SharedTargetSchema.nullable(),
});

export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WorkResultSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.number().int().min(0),
    ok: z.literal(true),
    stage: z.string(),
    /** Present when the worker had to hand pixels back rather than write in place. */
    pixels: z.instanceof(ArrayBuffer).nullable(),
    escapeCounts: z.instanceof(ArrayBuffer).nullable(),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  z.object({
    id: z.number().int().min(0),
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);

export type WorkResult = z.infer<typeof WorkResultSchema>;
