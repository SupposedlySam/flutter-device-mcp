/**
 * Tizen SDK rootstrap precheck.
 *
 * `flutter-tizen build tpk` needs a device "rootstrap" (a Tizen SDK sysroot)
 * matching the app's `tizen-manifest.xml` `api-version`. When it is missing the
 * build fails deep inside flutter-tizen with a Dart stack trace ("The rootstrap
 * <name> could not be found"). This module lets the tool detect that condition
 * up front — deterministically, before the long build — and return an actionable
 * message: which Tizen SDK version is missing, where the SDK is, and exactly how
 * to install it (the VS Code "Tizen: Package Manager", which is flutter-tizen's
 * own recommended path) or how to retarget to an already-installed version.
 *
 * A rootstrap is a downloadable SDK PACKAGE, not something built here; the tool
 * does not install it (that path is a fragile, network + license-gated CLI).
 * Instead it verifies presence and guides — reliable and side-effect-free.
 *
 * Everything is pure over injected fs/env/home so it is unit-testable without a
 * real Tizen SDK on disk.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** Minimal fs surface this module needs (injectable for tests). */
export interface RootstrapFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf8"): string;
  readdirSync(p: string, opts: { withFileTypes: true }): fs.Dirent[];
}

const realFs: RootstrapFs = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
};

/** Expand a leading `~` to the home dir. */
function expandHome(p: string, homeDir: string): string {
  return p === "~" || p.startsWith("~/")
    ? path.join(homeDir, p.slice(1))
    : p;
}

/**
 * Candidate Tizen SDK data-dir locations (the dir that contains `platforms/`),
 * checked in order when none is configured and `$TIZEN_SDK` is unset.
 */
export function defaultTizenSdkPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, ".tizen-extension-platform", "server", "sdktools", "data"),
    path.join(homeDir, "tizen-studio", "data"),
    path.join(homeDir, "tizen-studio"),
    path.join(homeDir, "TizenStudio", "data"),
  ];
}

/**
 * Resolve the Tizen SDK data dir: explicit config → `$TIZEN_SDK` → common
 * install locations. Returns the first candidate that exists, else `undefined`.
 */
export function resolveTizenSdkPath(opts: {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fsImpl?: RootstrapFs;
}): string | undefined {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const fsi = opts.fsImpl ?? realFs;
  const tizenSdkEnv = env.TIZEN_SDK && env.TIZEN_SDK.trim();
  const candidates = [
    opts.configured && expandHome(opts.configured.trim(), homeDir),
    tizenSdkEnv && tizenSdkEnv.length > 0 ? tizenSdkEnv : undefined,
    ...defaultTizenSdkPaths(homeDir),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const c of candidates) {
    if (fsi.existsSync(c)) return c;
  }
  return undefined;
}

/** Read the `api-version` from an app's `tizen/tizen-manifest.xml`, or undefined. */
export function readManifestApiVersion(
  appDir: string,
  fsImpl: RootstrapFs = realFs
): string | undefined {
  const manifest = path.join(appDir, "tizen", "tizen-manifest.xml");
  if (!fsImpl.existsSync(manifest)) return undefined;
  let text: string;
  try {
    text = fsImpl.readFileSync(manifest, "utf8");
  } catch {
    return undefined;
  }
  const m = text.match(/api-version\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : undefined;
}

/**
 * List installed DEVICE rootstraps under a Tizen SDK, as `{ apiVersion, name }`.
 * Scans `<sdk>/platforms/tizen-<ver>/<profile>/rootstraps/<name>-device.core`.
 * (Only `-device.core` rootstraps build for real hardware; `-emulator.core` is
 * for the x86 emulator.) Never throws — an unreadable tree yields `[]`.
 */
export function installedDeviceRootstraps(
  sdkPath: string,
  fsImpl: RootstrapFs = realFs
): { apiVersion: string; name: string }[] {
  const out: { apiVersion: string; name: string }[] = [];
  const platforms = path.join(sdkPath, "platforms");
  const readDirs = (p: string): fs.Dirent[] => {
    try {
      return fsImpl.readdirSync(p, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const ver of readDirs(platforms)) {
    if (!ver.isDirectory()) continue;
    const apiMatch = ver.name.match(/^tizen-(.+)$/);
    if (!apiMatch) continue;
    const apiVersion = apiMatch[1];
    const verDir = path.join(platforms, ver.name);
    for (const prof of readDirs(verDir)) {
      if (!prof.isDirectory()) continue;
      const rsDir = path.join(verDir, prof.name, "rootstraps");
      for (const rs of readDirs(rsDir)) {
        if (rs.isDirectory() && rs.name.endsWith("-device.core")) {
          out.push({ apiVersion, name: rs.name });
        }
      }
    }
  }
  return out;
}

/** The result of a rootstrap precheck. */
export interface RootstrapCheck {
  /** True when a device rootstrap for the required api-version is installed. */
  ok: boolean;
  /** The resolved SDK data dir, or undefined when none was found. */
  sdkPath?: string;
  /** The app's manifest api-version (or the configured override). */
  requiredApiVersion?: string;
  /** Api-versions that DO have a device rootstrap installed. */
  installedApiVersions: string[];
  /** An actionable message when `ok` is false (or a note); undefined when fine. */
  message?: string;
}

/**
 * Check that a device rootstrap for the app's Tizen api-version is installed.
 *
 * `configuredApiVersion` (from config) overrides the manifest when set — use it
 * to target a version you know is installed. Returns `ok:false` with a precise,
 * copy-pasteable message when the SDK can't be found, the manifest can't be
 * read, or the required rootstrap is absent.
 */
export function checkTizenRootstrap(opts: {
  appDir: string;
  configuredSdkPath?: string;
  configuredApiVersion?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fsImpl?: RootstrapFs;
}): RootstrapCheck {
  const fsi = opts.fsImpl ?? realFs;
  const sdkPath = resolveTizenSdkPath({
    configured: opts.configuredSdkPath,
    env: opts.env,
    homeDir: opts.homeDir,
    fsImpl: fsi,
  });

  const installed = sdkPath ? installedDeviceRootstraps(sdkPath, fsi) : [];
  const installedApiVersions = [...new Set(installed.map((r) => r.apiVersion))].sort();

  if (!sdkPath) {
    return {
      ok: false,
      installedApiVersions,
      message:
        "Tizen SDK not found. Set platforms.tizen.sdk.dataPath in " +
        "flutter-device.config.json (or the TIZEN_SDK env var) to your Tizen SDK " +
        "data dir — the folder that contains `platforms/` (e.g. " +
        "~/tizen-studio/data or the VS Code Tizen extension's " +
        "~/.tizen-extension-platform/server/sdktools/data).",
    };
  }

  const requiredApiVersion =
    (opts.configuredApiVersion && opts.configuredApiVersion.trim()) ||
    readManifestApiVersion(opts.appDir, fsi);

  if (!requiredApiVersion) {
    return {
      ok: false,
      sdkPath,
      installedApiVersions,
      message:
        "Could not determine the Tizen api-version (no tizen/tizen-manifest.xml " +
        "with an api-version, and platforms.tizen.sdk.apiVersion is unset). Add a " +
        "tizen platform (`flutter-tizen create --platforms tizen .`) or set the " +
        "api-version in config.",
    };
  }

  const ok = installed.some((r) => r.apiVersion === requiredApiVersion);
  if (ok) {
    return { ok: true, sdkPath, requiredApiVersion, installedApiVersions };
  }

  const installedList =
    installedApiVersions.length > 0
      ? installedApiVersions.join(", ")
      : "(none)";
  return {
    ok: false,
    sdkPath,
    requiredApiVersion,
    installedApiVersions,
    message:
      `Tizen ${requiredApiVersion} device rootstrap is not installed (needed to ` +
      `build a TPK for a real device). Installed device rootstrap versions: ${installedList}. ` +
      `Fix EITHER by installing it — open the "Tizen: Package Manager" in VS Code and ` +
      `install "Tizen SDK ${requiredApiVersion}" (the platform's Native/.NET package + a ` +
      `device rootstrap) — OR by retargeting to an installed version: set ` +
      `platforms.tizen.sdk.apiVersion${installedApiVersions.length ? ` (e.g. "${installedApiVersions[installedApiVersions.length - 1]}")` : ""} ` +
      `and match your tizen/tizen-manifest.xml api-version to it. SDK: ${sdkPath}.`,
  };
}
