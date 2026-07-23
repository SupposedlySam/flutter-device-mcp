#!/usr/bin/env node
/**
 * Launcher for the flutter-device MCP server.
 *
 * `dist/` is gitignored, so it is never committed. This launcher makes the
 * source-only package self-building: it compiles when `dist/` is missing or
 * when the compiled sources no longer match, then execs `dist/index.js` over
 * stdio. Point your MCP client's server config at this script, so a fresh
 * checkout Just Works with no manual build.
 *
 * Staleness is CONTENT-based, not mtime-based: git does not preserve mtimes, so
 * a branch switch can leave a newer-on-disk-but-older-in-content dist/. Instead
 * we hash the build inputs (src/**\/*.ts + tsconfig + package-lock.json) into
 * dist/.build-hash after a successful build and rebuild whenever the stamp is
 * missing or differs. Dependency install is likewise gated on a lockfile stamp
 * so a changed package-lock.json reinstalls even when node_modules exists.
 * Node builtins only (crypto, fs) — no dependencies.
 */
import { spawnSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(scriptDir, "..");
const srcDir = path.join(pkgDir, "src");
const distDir = path.join(pkgDir, "dist");
const distEntry = path.join(distDir, "index.js");
const buildHashFile = path.join(distDir, ".build-hash");
const lockfile = path.join(pkgDir, "package-lock.json");
const depsHashFile = path.join(pkgDir, "node_modules", ".flutter-device-deps-hash");

/** Recursively collect files under `dir` matching `filter`, sorted for stability. */
function collectFiles(dir, filter) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full, filter));
    else if (filter(full)) found.push(full);
  }
  return found.sort();
}

/**
 * Hash the build inputs: every src/**\/*.ts file (path + contents) plus the
 * tsconfig(s) and the lockfile. Both the file path and its bytes go in, so a
 * rename, add, delete, or edit all change the stamp. Missing optional files are
 * folded in as an empty marker so their absence is still part of the identity.
 */
function computeBuildHash() {
  const hash = crypto.createHash("sha256");
  const srcFiles = collectFiles(srcDir, (f) => f.endsWith(".ts"));
  const extra = [
    path.join(pkgDir, "tsconfig.json"),
    path.join(pkgDir, "tsconfig.jest.json"),
    lockfile,
  ];
  for (const file of [...srcFiles, ...extra]) {
    hash.update(path.relative(pkgDir, file));
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update("<absent>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Read a stamp file, or an empty string when absent. */
function readStamp(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function needsBuild(expectedHash) {
  if (!fs.existsSync(distEntry)) return true;
  return readStamp(buildHashFile) !== expectedHash;
}

/** Hash the lockfile contents alone, for the dependency-install stamp. */
function computeDepsHash() {
  const hash = crypto.createHash("sha256");
  try {
    hash.update(fs.readFileSync(lockfile));
  } catch {
    hash.update("<no-lockfile>");
  }
  return hash.digest("hex");
}

function ensureDependencies() {
  const expected = computeDepsHash();
  const nodeModules = path.join(pkgDir, "node_modules");
  const upToDate =
    fs.existsSync(nodeModules) && readStamp(depsHashFile) === expected;
  if (upToDate) return;

  process.stderr.write("[flutter-device-mcp] installing dependencies (lockfile changed or node_modules missing)...\n");
  // Prefer the reproducible `npm ci` when a lockfile is present; fall back to
  // `npm install` when it is not (fresh source-only checkout without a lock).
  const useCi = fs.existsSync(lockfile);
  const install = spawnSync("npm", [useCi ? "ci" : "install"], {
    cwd: pkgDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (install.status !== 0) {
    process.stderr.write("[flutter-device-mcp] npm install failed\n");
    process.exit(install.status ?? 1);
  }
  try {
    fs.writeFileSync(depsHashFile, expected);
  } catch {
    // best effort — a missing stamp just means we reinstall next time
  }
}

function build(expectedHash) {
  process.stderr.write("[flutter-device-mcp] building (dist missing or source changed)...\n");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: pkgDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    process.stderr.write("[flutter-device-mcp] build failed\n");
    process.exit(result.status ?? 1);
  }
  try {
    fs.writeFileSync(buildHashFile, expectedHash);
  } catch {
    // best effort — a missing stamp just means we rebuild next time
  }
}

ensureDependencies();
const buildHash = computeBuildHash();
if (needsBuild(buildHash)) build(buildHash);

// Hand off stdio to the MCP server (it speaks the MCP protocol over stdio).
const child = spawn(process.execPath, [distEntry], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
