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
