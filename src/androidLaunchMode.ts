/**
 * Android launch/build mode resolution.
 *
 * The Android deploy launch (`flutter run`) and build (`flutter build apk`) each
 * pick one of three Flutter compilation modes. This module is the ONE place that
 * decision is made, so deploy-launch and build stay coherent and the precedence
 * is testable in isolation from the adapter.
 *
 * WHY the default is `debug` (not `profile`): Marionette is gated on `kDebugMode`
 * in the app (`bootstrapMarionette()` only runs in debug), so a profile/release
 * launch registers NO `ext.flutter.marionette.*` extension and the app is
 * undrivable — and hot reload/restart don't work either. A plain
 * `flutter_deploy platform=android` must therefore come up debug so it is
 * Marionette-drivable out of the box, matching the iOS deploy (which launches
 * `--debug`).
 *
 * Precedence (highest first):
 *   1. an explicit 3-way tool arg (`flutter_deploy`/`flutter_build`'s `mode`),
 *   2. an explicit tool arg (`flutter_deploy`/`flutter_build`'s `debug` flag),
 *   3. the `FLUTTER_DEVICE_ANDROID_LAUNCH_MODE` env var (`debug` | `profile` | `release`),
 *   4. the new default, `debug`.
 */
import { BuildMode } from "./types.js";

/**
 * The three Flutter compilation modes the Android adapter can launch/build.
 *
 * An alias of the neutral {@link BuildMode} — Android does not have its own set
 * of modes, only its own DEFAULT (`debug`, so a plain deploy is Marionette-
 * drivable) and its own env pin. The name is kept because those two things are
 * Android policy; the mode vocabulary itself is not.
 */
export type AndroidLaunchMode = BuildMode;

/** The launch/build default when nothing else selects a mode (Marionette-drivable). */
export const ANDROID_DEFAULT_LAUNCH_MODE: AndroidLaunchMode = "debug";

/** The `flutter` CLI flag for a given mode (`--debug`/`--profile`/`--release`). */
export function flutterModeFlag(mode: AndroidLaunchMode): string {
  return `--${mode}`;
}

/**
 * Parse a `FLUTTER_DEVICE_ANDROID_LAUNCH_MODE` value into a mode. Trims + lower-cases;
 * an empty/whitespace/unset value yields `undefined` (so the caller falls through
 * to the default), and any other unrecognized value ALSO yields `undefined` (a
 * typo must not silently pin a surprising mode — it falls back to the default).
 */
export function parseAndroidLaunchModeEnv(
  raw: string | undefined
): AndroidLaunchMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "debug" || value === "profile" || value === "release") {
    return value;
  }
  return undefined;
}

/**
 * Resolve the effective Android launch/build mode from the precedence sources.
 *
 * `explicitMode` is the 3-way tool arg and wins outright when given — it is the
 * only input that can ask for `release`, and a caller that names a mode means it.
 *
 * `explicitDebug` is the legacy tri-state boolean: `true` → debug, `false` →
 * profile (an explicit non-debug request; via this input release is
 * unreachable), `undefined` → fall through to the env pin, then the default.
 */
export function resolveAndroidLaunchMode(opts: {
  explicitMode?: AndroidLaunchMode;
  explicitDebug?: boolean;
  envMode?: AndroidLaunchMode;
}): AndroidLaunchMode {
  if (opts.explicitMode) return opts.explicitMode;
  if (opts.explicitDebug === true) return "debug";
  if (opts.explicitDebug === false) return "profile";
  return opts.envMode ?? ANDROID_DEFAULT_LAUNCH_MODE;
}
