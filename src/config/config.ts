/**
 * Configuration resolution — the single, ordered source of truth for "which app
 * and which device do I operate on, and how do I build it".
 *
 * Precedence (highest wins), applied per setting:
 *   1. an explicit value passed by a frontend (CLI flag / MCP arg),
 *   2. an environment variable,
 *   3. a `flutter-device.config.json` file (searched upward from the cwd),
 *   4. derivation from the Flutter project itself (nearest `pubspec.yaml`,
 *      `.fvmrc` → `fvm flutter`).
 *
 * The resolver is PURE over its inputs (cwd + env are injectable) so it is unit
 * testable without touching the real environment. It records the PROVENANCE of
 * the app dir so `flutter-device info` / the `info` MCP tool can show the user
 * exactly what was inferred and where to override it.
 */
import fs from "fs";
import path from "path";
import { Platform } from "../types.js";
import { AndroidLaunchMode, parseAndroidLaunchModeEnv } from "../androidLaunchMode.js";
import { findAppDir, isFlutterAppDir, isFvmManaged } from "./appDir.js";

/** Where a resolved value came from (for provenance in `info`/doctor output). */
export type ConfigSource =
  | "flag"
  | "env"
  | "config-file"
  | "derived"
  | "default";

/** Per-platform settings, all optional. */
export interface PlatformSettings {
  /** Device pin (id/name/address the adapter understands). */
  device?: string;
  /** App/bundle id, used for uninstall + lifecycle. */
  appId?: string;
  /**
   * Shell commands run (in order, cwd = appDir) BEFORE the platform build. The
   * fork-free extension point for app-specific build steps — e.g. compiling a
   * native engine before the Tizen package. A non-zero exit aborts the build.
   */
  preBuild?: string[];
  /** Tizen device profile passed to `flutter-tizen build` (default `tv`). */
  tizenProfile?: string;
  /** Tizen SDK data dir (contains `platforms/`) for the rootstrap precheck. */
  tizenSdkPath?: string;
  /** Tizen api-version to target (e.g. "8.0"); else read from the manifest. */
  tizenApiVersion?: string;
  /** Tizen security profile name to sign the TPK with (`-s`). */
  tizenSecurityProfile?: string;
  /** Android launch/build mode when a call passes no explicit `debug` arg. */
  androidLaunchMode?: AndroidLaunchMode;
  /** Directory holding the `flutter-tvos` bin, prepended to PATH for tvOS. */
  flutterTvosBinDir?: string;
}

/** The fully-resolved configuration handed to the runtime. */
export interface ResolvedConfig {
  /** Absolute path to the Flutter app (dir containing `pubspec.yaml`). */
  appDir: string;
  /** How `appDir` was determined. */
  appDirSource: ConfigSource;
  /** True when the app pins Flutter via fvm (prefer `fvm flutter`). */
  fvm: boolean;
  /** The platform used when a call omits `platform` (or passes `auto`). */
  defaultPlatform: Platform;
  /** How `defaultPlatform` was determined. */
  defaultPlatformSource: ConfigSource;
  /** Absolute path to the config file that was loaded, when one was found. */
  configFilePath?: string;
  /** Per-platform settings, always present for every platform (may be empty). */
  platforms: Record<Platform, PlatformSettings>;
}

/** The fallback default platform when nothing configures one. */
const FALLBACK_DEFAULT_PLATFORM: Platform = "ios";

/** Narrow an arbitrary string to a {@link Platform}, or `undefined`. */
function asPlatform(value: string | undefined): Platform | undefined {
  return value === "tizen" ||
    value === "webos" ||
    value === "ios" ||
    value === "android" ||
    value === "tvos"
    ? value
    : undefined;
}

/** The env-var prefix for every setting this tool reads. */
const ENV_PREFIX = "FLUTTER_DEVICE";

const ALL_PLATFORMS: Platform[] = ["tizen", "webos", "ios", "android", "tvos"];

/** Shape of the JSON config file (all fields optional). */
interface ConfigFile {
  appDir?: string;
  defaultPlatform?: string;
  idbPath?: string;
  platforms?: Partial<
    Record<
      Platform,
      {
        device?: string;
        appId?: string;
        preBuild?: string[];
        tizenProfile?: string;
        securityProfile?: string;
        sdk?: { dataPath?: string; apiVersion?: string };
        androidLaunchMode?: string;
        flutterTvosBinDir?: string;
      }
    >
  >;
}

/** Trim an env value to a non-empty string, or `undefined`. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  const value = raw?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Search upward from `start` for the named config file; return its path. */
function findConfigFile(start: string, fileName: string): string | undefined {
  let dir = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load + parse the config file, tolerating a missing/invalid file. */
function loadConfigFile(filePath: string | undefined): {
  config: ConfigFile;
  dir?: string;
} {
  if (!filePath) return { config: {} };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ConfigFile;
    return { config: parsed ?? {}, dir: path.dirname(filePath) };
  } catch {
    // A malformed config file must not crash the server; fall through to env +
    // derivation. (The `info` path surfaces that no file was loaded.)
    return { config: {} };
  }
}

/** Options for {@link resolveConfig}; all optional (cwd + env injectable). */
export interface ResolveConfigOptions {
  /** Explicit app dir from a CLI flag / MCP arg (highest precedence). */
  appDir?: string;
  /** Where to start searching (config file + derived app dir). Default cwd. */
  cwd?: string;
  /** Environment to read (default `process.env`). Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Explicit config-file path, overriding the upward search. */
  configFile?: string;
}

/**
 * Resolve the effective configuration. Throws only when no app dir can be found
 * by any means (explicit, env, file, or derivation) — every other setting is
 * optional and degrades gracefully.
 */
export function resolveConfig(opts: ResolveConfigOptions = {}): ResolvedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const configFilePath =
    opts.configFile ??
    envValue(env, `${ENV_PREFIX}_CONFIG`) ??
    findConfigFile(cwd, "flutter-device.config.json");
  const { config: file, dir: fileDir } = loadConfigFile(configFilePath);

  // ----- appDir (with provenance) -----
  const envAppDir = envValue(env, `${ENV_PREFIX}_APP_DIR`);
  let appDir: string | undefined;
  let appDirSource: ConfigSource = "derived";
  if (opts.appDir) {
    appDir = path.resolve(cwd, opts.appDir);
    appDirSource = "flag";
  } else if (envAppDir) {
    appDir = path.resolve(cwd, envAppDir);
    appDirSource = "env";
  } else if (file.appDir) {
    // A config-file appDir is resolved relative to the config file's location.
    appDir = path.resolve(fileDir ?? cwd, file.appDir);
    appDirSource = "config-file";
  } else {
    appDir = findAppDir(cwd);
    appDirSource = "derived";
  }

  if (!appDir) {
    throw new Error(
      "Could not locate a Flutter app (no pubspec.yaml found walking up from " +
        `${cwd}). Run from inside your Flutter project, set ${ENV_PREFIX}_APP_DIR, ` +
        "pass --app-dir, or add appDir to flutter-device.config.json."
    );
  }
  if (!isFlutterAppDir(appDir) && appDirSource !== "derived") {
    throw new Error(
      `Configured app dir "${appDir}" (${appDirSource}) has no pubspec.yaml — ` +
        "it is not a Flutter app."
    );
  }

  // ----- per-platform settings -----
  const platforms = {} as Record<Platform, PlatformSettings>;
  for (const p of ALL_PLATFORMS) {
    const P = p.toUpperCase();
    const fromFile = file.platforms?.[p] ?? {};
    const androidLaunchMode =
      p === "android"
        ? parseAndroidLaunchModeEnv(env[`${ENV_PREFIX}_ANDROID_LAUNCH_MODE`]) ??
          parseAndroidLaunchModeEnv(fromFile.androidLaunchMode)
        : undefined;
    platforms[p] = {
      device: envValue(env, `${ENV_PREFIX}_${P}_DEVICE`) ?? fromFile.device,
      appId: envValue(env, `${ENV_PREFIX}_${P}_APP_ID`) ?? fromFile.appId,
      preBuild: fromFile.preBuild,
      tizenProfile:
        p === "tizen"
          ? envValue(env, `${ENV_PREFIX}_TIZEN_PROFILE`) ?? fromFile.tizenProfile
          : undefined,
      tizenSdkPath:
        p === "tizen"
          ? envValue(env, `${ENV_PREFIX}_TIZEN_SDK_PATH`) ??
            fromFile.sdk?.dataPath
          : undefined,
      tizenApiVersion:
        p === "tizen"
          ? envValue(env, `${ENV_PREFIX}_TIZEN_API_VERSION`) ??
            fromFile.sdk?.apiVersion
          : undefined,
      tizenSecurityProfile:
        p === "tizen"
          ? envValue(env, `${ENV_PREFIX}_TIZEN_SECURITY_PROFILE`) ??
            fromFile.securityProfile
          : undefined,
      androidLaunchMode,
      flutterTvosBinDir:
        p === "tvos"
          ? envValue(env, `${ENV_PREFIX}_TVOS_FLUTTER_BIN`) ??
            fromFile.flutterTvosBinDir
          : undefined,
    };
  }

  // tvOS honors the community `APPLE_TV_DEVICE` pin as a fallback (the name the
  // flutter-tvos toolchain + Xcode already use), so a user who set it for other
  // tooling doesn't have to duplicate it under the FLUTTER_DEVICE_ prefix.
  if (!platforms.tvos.device) {
    platforms.tvos.device = envValue(env, "APPLE_TV_DEVICE");
  }

  // ----- default platform (with provenance) -----
  const envDefault = asPlatform(
    envValue(env, `${ENV_PREFIX}_DEFAULT_PLATFORM`)?.toLowerCase()
  );
  const fileDefault = asPlatform(file.defaultPlatform?.toLowerCase());
  let defaultPlatform: Platform;
  let defaultPlatformSource: ConfigSource;
  if (envDefault) {
    defaultPlatform = envDefault;
    defaultPlatformSource = "env";
  } else if (fileDefault) {
    defaultPlatform = fileDefault;
    defaultPlatformSource = "config-file";
  } else {
    defaultPlatform = FALLBACK_DEFAULT_PLATFORM;
    defaultPlatformSource = "default";
  }

  return {
    appDir,
    appDirSource,
    fvm: isFvmManaged(appDir),
    defaultPlatform,
    defaultPlatformSource,
    configFilePath,
    platforms,
  };
}
