import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.url().pipe(z.string().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol))),
  APP_ORIGIN: z.url().pipe(z.string().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && value === url.origin;
  })),
  SESSION_SECRET: z.string().min(32),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GROUP_SCHEDULER_TEST_CADENCE_MS: z.string().regex(/^\d+$/).refine((value) => Number(value) >= 1000 && Number(value) <= 60000).optional(),
});

export function loadConfig(env = process.env) {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid configuration: ${fields.join(", ")}`);
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    appOrigin: result.data.APP_ORIGIN,
    sessionSecret: result.data.SESSION_SECRET,
    nodeEnv: result.data.NODE_ENV,
    groupSchedulerTestCadenceMs: result.data.GROUP_SCHEDULER_TEST_CADENCE_MS ? Number(result.data.GROUP_SCHEDULER_TEST_CADENCE_MS) : null,
  };
}
