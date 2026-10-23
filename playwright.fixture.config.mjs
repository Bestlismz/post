import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/fixture-e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "/tmp/rental-radar-fixture-playwright-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3118",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "POC_MODE=fixture PORT=3118 STATE_DIR=/tmp/rental-radar-fixture-e2e-state-$PPID FIXTURE_OPERATIONAL_CLOCK_START=2026-10-22T20:30:01.000Z FIXTURE_OPERATIONAL_CLOCK_STEP_MS=31000 node src/fixture-server.mjs",
    url: "http://127.0.0.1:3118/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
