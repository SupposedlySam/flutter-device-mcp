/**
 * Locate the Flutter app directory — the folder containing `pubspec.yaml`.
 *
 * This is fully generic: any Flutter project has a `pubspec.yaml` at its root,
 * so we walk up from a starting directory to the nearest ancestor that contains
 * one. Callers may instead pass an explicit path
 * (from a CLI flag, MCP arg, env var, or config file), which is validated to
 * actually be a Flutter app.
 */
import fs from "fs";
import path from "path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/** True when `dir` looks like a Flutter app root (has a `pubspec.yaml`). */
export function isFlutterAppDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "pubspec.yaml"));
}

/**
 * Walk up from `start` to the first ancestor that contains a `pubspec.yaml`.
 * Returns the absolute path to that directory, or `undefined` when none is
 * found before the filesystem root.
 */
export function findAppDir(start: string): string | undefined {
  let dir = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isFlutterAppDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/**
 * True when `dir` is an fvm-managed app (pins Flutter via `.fvmrc` or the
 * `.fvm/flutter_sdk` symlink). When true and `fvm` is on PATH, callers should
 * prefer `fvm flutter` so device discovery matches the repo's pinned SDK.
 */
export function isFvmManaged(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, ".fvmrc")) ||
    fs.existsSync(path.join(dir, ".fvm", "flutter_sdk")) ||
    fs.existsSync(path.join(dir, ".fvm", "fvm_config.json"))
  );
}

/**
 * Validate a caller-supplied per-call app dir, returning its resolved absolute
 * path.
 *
 * Throws an InvalidParams {@link McpError} — a clean protocol error, not an
 * internal fault — when the path is missing, is not a directory, or is not a
 * Flutter app. A bad path must fail loudly: silently falling back to the
 * server's own app would run the whole request (device resolution, install,
 * VM-service capture) against a DIFFERENT project than the caller named, and
 * report success.
 */
export function validateExplicitAppDir(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `app_dir "${candidate}" does not exist.`
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `app_dir "${candidate}" is not a directory.`
    );
  }
  if (!isFlutterAppDir(resolved)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `app_dir "${candidate}" is not a Flutter app (no pubspec.yaml). Pass the ` +
        "directory containing pubspec.yaml."
    );
  }
  return resolved;
}

/** Injectable strategies backing {@link resolveAppDirWith}. */
export interface AppDirResolvers {
  /** Validate + resolve an explicit per-call override (may throw). */
  validateOverride: (candidate: string) => string;
  /** The process-wide fallback: env, then config file, then derivation. */
  fromConfig: () => string;
}

/**
 * Pure precedence core for per-call app-dir targeting:
 * **per-call override > env > config file > derived**. A non-blank `perCall`
 * short-circuits to `validateOverride`; otherwise `fromConfig` runs. Kept free
 * of process.env / filesystem access so the precedence is unit-testable with
 * fakes.
 */
export function resolveAppDirWith(
  perCall: string | undefined,
  resolvers: AppDirResolvers
): string {
  const override = perCall?.trim();
  if (override && override.length > 0) {
    return resolvers.validateOverride(override);
  }
  return resolvers.fromConfig();
}
