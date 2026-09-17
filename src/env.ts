import { z } from "zod";

const EnvSchema = z.object({
  VITE_APP_TITLE: z.string().default("Orion"),
  MODE: z.string(),
  DEV: z.boolean(),
  PROD: z.boolean(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

/** Parse Vite env at the boundary. Fail loud on invalid shape. */
export function loadEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid env: ${parsed.error.message}`);
  }
  return parsed.data;
}
