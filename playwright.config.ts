import { defineConfig, devices } from "@playwright/test";

// Runs against the static export in out/: `npm run build:static` first (see README → Run Tests).
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4174",
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npm run serve:out",
    url: "http://localhost:4174",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
