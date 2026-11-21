import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(backendDir, "..");
const distDir = path.resolve(backendDir, "dist");
const sharedEntry = path.resolve(repoRoot, "packages/shared/src/index.ts");
const tsconfigPath = path.resolve(backendDir, "tsconfig.json");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const sharedBuildOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  tsconfig: tsconfigPath,
  packages: "external",
  alias: {
    "@erp/shared": sharedEntry,
  },
  logLevel: "info",
};

await Promise.all([
  build({
    ...sharedBuildOptions,
    entryPoints: [path.resolve(backendDir, "src/index.ts")],
    outfile: path.resolve(distDir, "server.mjs"),
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: [path.resolve(backendDir, "src/db/migrate.ts")],
    outfile: path.resolve(distDir, "migrate.mjs"),
  }),
]);
