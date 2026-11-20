import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

function readBackendTestDbUrl(): string {
  if (process.env.TEST_DATABASE_URL?.trim()) {
    return process.env.TEST_DATABASE_URL.trim();
  }
  const envPath = path.resolve(process.cwd(), "backend/.env");
  if (!fs.existsSync(envPath)) return "";
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*TEST_DATABASE_URL\s*=\s*(.+)\s*$/);
    if (match) {
      return match[1].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return "";
}

const testDbUrl = readBackendTestDbUrl();

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm --prefix backend run start",
      url: "http://127.0.0.1:3011/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PORT: "3011",
        HOST: "127.0.0.1",
        CORS_ORIGIN: "http://127.0.0.1:4173",
        DATABASE_URL: testDbUrl,
        DISABLE_RATE_LIMIT: "true",
      },
    },
    {
      command: "npm --prefix frontend run dev -- --port 4173 --host 127.0.0.1 --strictPort",
      url: "http://127.0.0.1:4173/login",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: "http://127.0.0.1:3011",
      },
    },
  ],
});
