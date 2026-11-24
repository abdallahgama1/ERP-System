#!/usr/bin/env node
/**
 * Runs a test command (test, test:e2e, test:load) against the fast local
 * PostgreSQL 18 test container defined in docker-compose.test.yml by default.
 *
 * Explicit overrides:
 *  - Set TEST_DATABASE_URL in the environment (e.g. GitHub Actions CI or Neon URL)
 *    to bypass the local Docker container and run directly against that URL.
 *  - Set USE_REMOTE_TEST_DB=true to use TEST_DATABASE_URL from backend/.env (e.g. Neon).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const composeFile = path.resolve(repoRoot, "docker-compose.test.yml");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-with-local-test-db.mjs <command...>");
  process.exit(2);
}

function resolveDockerBin() {
  const candidates = [
    "docker",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "DockerDesktop",
      "resources",
      "bin",
      "docker.exe"
    ),
  ];
  for (const bin of candidates) {
    if (!bin) continue;
    const res = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (res.status === 0) return bin;
  }
  return null;
}

function runShellCommand(commandParts, env) {
  const cmdLine = commandParts.join(" ");
  const res = spawnSync(cmdLine, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: true,
  });
  return res.status ?? 1;
}

function readEnvFileVar(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`));
    if (match) {
      return match[1].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return "";
}

const useRemote = ["true", "1", "yes"].includes((process.env.USE_REMOTE_TEST_DB ?? "").trim().toLowerCase());
const explicitEnvUrl = (process.env.TEST_DATABASE_URL ?? "").trim();

let targetTestDbUrl = explicitEnvUrl;
if (useRemote && !targetTestDbUrl) {
  targetTestDbUrl = readEnvFileVar(path.resolve(repoRoot, "backend/.env"), "TEST_DATABASE_URL");
  if (!targetTestDbUrl) {
    console.error("USE_REMOTE_TEST_DB=true was set, but TEST_DATABASE_URL is missing in backend/.env.");
    process.exit(1);
  }
}

if (!targetTestDbUrl) {
  const dockerBin = resolveDockerBin();
  if (!dockerBin) {
    console.error(
      "Docker Desktop is not running. Start Docker Desktop for the fast local Postgres 18 test DB, " +
        "or pass TEST_DATABASE_URL=... / USE_REMOTE_TEST_DB=true to target an external database."
    );
    process.exit(1);
  }

  const testPort = (process.env.TEST_PG_PORT ?? "5439").trim();
  const upRes = spawnSync(
    dockerBin,
    ["compose", "-f", composeFile, "up", "-d", "--wait"],
    {
      cwd: repoRoot,
      env: { ...process.env, TEST_PG_PORT: testPort },
      stdio: "inherit",
    }
  );
  if (upRes.status !== 0) {
    process.exit(upRes.status ?? 1);
  }

  targetTestDbUrl = `postgresql://erp:erp_test_password@127.0.0.1:${testPort}/erp_test`;

  const migrateRes = spawnSync(
    "npm --prefix backend run db:migrate",
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: targetTestDbUrl,
        TEST_DATABASE_URL: targetTestDbUrl,
      },
      stdio: "inherit",
      shell: true,
    }
  );
  if (migrateRes.status !== 0) {
    process.exit(migrateRes.status ?? 1);
  }
}

const exitCode = runShellCommand(args, {
  ...process.env,
  TEST_DATABASE_URL: targetTestDbUrl,
});
process.exit(exitCode);
