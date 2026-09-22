/**
 * iOS launch/build mode resolution.
 *
 * The iOS deploy launch (`flutter run`) and build (`flutter build ios`) each pick
 * one of three Flutter compilation modes. This module is the ONE place that
 * decision is made, so deploy-launch and build stay coherent and the precedence
 * is testable in isolation from the adapter. It is the iOS twin of
 * `androidLaunchMode.ts`; the shape (precedence, env pin, default, rationale) is
 * deliberately the same so a reader of one already knows the other.
 *
 * WHY the default is `debug` (not `profile`): Marionette is gated on `kDebugMode`
 * in the app (`bootstrapMarionette()` only runs in debug), so a profile/release
 * launch registers NO `ext.flutter.marionette.*` extension and the app cannot be
 * driven — and hot reload/restart don't apply to a cold (non-debug) run either. A
 * plain `flutter_deploy platform=ios` must therefore come up debug so it is
 * Marionette-drivable out of the box.
 *
 * Precedence (highest first):
 *   1. an explicit `mode` tool arg (`debug` | `profile` | `release`),
 *   2. the legacy explicit `debug` boolean (true → debug, false → release),
 *   3. the `FLUTTER_DEVICE_IOS_LAUNCH_MODE` env var (`debug` | `profile` | `release`),
 *   4. the default, `debug`.
 *
 * Step 2 is where iOS diverges from Android, which maps an explicit `debug:false`
 * to PROFILE. iOS already honored the 3-way `mode` arg on build, so `profile` is
 * directly nameable here and `debug:false` keeps the meaning it already had on
 * iOS and Tizen (see `resolveBuildMode` in types.ts) rather than silently
 * changing what shipped.
 */
import { BuildMode } from "./types.js";

/**
 * The three Flutter compilation modes the iOS adapter can launch/build. Same set
 * as {@link BuildMode}, aliased so the seam's `mode` argument threads through
 * without a cast.
 */
export type IosLaunchMode = BuildMode;

/** The launch/build default when nothing else selects a mode (Marionette-drivable). */
export const IOS_DEFAULT_LAUNCH_MODE: IosLaunchMode = "debug";

/** The `flutter` CLI flag for a given mode (`--debug`/`--profile`/`--release`). */
export function iosFlutterModeFlag(mode: IosLaunchMode): string {
  return `--${mode}`;
}

/**
 * Parse a `FLUTTER_DEVICE_IOS_LAUNCH_MODE` value into a mode. Trims + lower-cases;
 * an empty/whitespace/unset value yields `undefined` (so the caller falls through
 * to the default), and any other unrecognized value ALSO yields `undefined` (a
 * typo must not silently pin a surprising mode — it falls back to the default).
 */
export function parseIosLaunchModeEnv(
  raw: string | undefined
): IosLaunchMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "debug" || value === "profile" || value === "release") {
    return value;
  }
  return undefined;
}

/**
 * Resolve the effective iOS launch/build mode from the four precedence sources
 * documented in this module's header.
 */
export function resolveIosLaunchMode(opts: {
  explicitMode?: IosLaunchMode;
  explicitDebug?: boolean;
  envMode?: IosLaunchMode;
}): IosLaunchMode {
  if (opts.explicitMode) return opts.explicitMode;
  if (opts.explicitDebug === true) return "debug";
  if (opts.explicitDebug === false) return "release";
  return opts.envMode ?? IOS_DEFAULT_LAUNCH_MODE;
}

/** True when a launch in this mode can register `ext.flutter.marionette.*`. */
export function marionetteAvailableInMode(mode: IosLaunchMode): boolean {
  return mode === "debug";
}

/**
 * What a non-debug launch costs the caller, stated on the deploy response so the
 * tool never implies a drivability it cannot deliver. `null` for debug (nothing
 * is given up).
 *
 * The profile wording is deliberately specific about WHICH half is missing: the
 * `ws://…/ws` URI is real (`flutter run` enables the VM service for every mode
 * except release — `createDebuggingOptions` branches on `mode.isRelease` alone),
 * but the app's Marionette extension is not registered, so `connect` succeeds and
 * every `ext.flutter.marionette.*` call then fails. Saying only "not drivable"
 * would send a caller hunting for a broken URI.
 */
export function iosLaunchModeCaveat(mode: IosLaunchMode): string | null {
  if (mode === "debug") return null;
  if (mode === "profile") {
    return (
      "Launched --profile: AOT-compiled with realistic timing, and the Dart VM " +
      "service stays open, so the captured ws://…/ws URI is real. Marionette is " +
      "NOT available on it — the app gates bootstrapMarionette() on kDebugMode, so " +
      "no ext.flutter.marionette.* extension is registered and a Marionette tap/" +
      "enter_text will fail even though connect succeeds. Use the URI for DevTools/" +
      "timeline/ext.flutter.* work, or redeploy without a mode to get a drivable " +
      "debug launch. Hot reload/restart do not apply to a profile (cold) run."
    );
  }
  return (
    "Launched --release: there is no Dart VM service in release mode, so no URI " +
    "can be captured and neither Marionette nor hot reload/restart apply. This is " +
    "the mode's design, not a launch failure."
  );
}

/**
 * Why a release launch reports no VM-service URI. Carried on the launch result so
 * an empty URI field reads as a deliberate answer rather than a failed capture.
 */
export const IOS_RELEASE_NO_VM_SERVICE_REASON =
  "No Dart VM service URI: this launch is --release, which compiles the VM service " +
  "out entirely. Nothing can attach to a release build — not Marionette, not " +
  "DevTools, not `flutter attach`. Redeploy in debug (the default) to drive the app, " +
  "or in profile for realistic timing with the VM service still open.";

/**
 * Why a PROFILE launch that came up resident without printing a VM-service URI
 * gets no URI, and why the tool does not go looking for one by another route.
 *
 * Measured on a macOS host driving a USB-attached iPhone: a profile-mode Dart VM
 * Service is not advertised over Bonjour — an enumeration of every service type
 * on every interface, the `_apple-mobdev2`/`_rp-tunnel` USB-debug tunnels
 * included, never showed `_dartVmService._tcp` — and `flutter attach` against the
 * same device produced no output before timing out. So the `flutter run --profile`
 * pipeline this tool already owns is the ONLY path that can surface the URI, and a
 * fallback discovery step would be a step that cannot succeed. Rather than sit on
 * one, the launch reports the absence and says why.
 */
export const IOS_PROFILE_NO_VM_SERVICE_REASON =
  "No Dart VM service URI: the profile launch came up resident but printed no VM " +
  "service line. The tool does NOT fall back to Bonjour/`flutter attach` discovery — " +
  "measured on a macOS host, a profile-mode VM service is not advertised as " +
  "_dartVmService._tcp on any interface (USB-debug tunnels included) and `flutter " +
  "attach` finds nothing, so that step can only hang. The app IS running; redeploy " +
  "in debug (the default) if you need to drive it.";

/**
 * Log lines meaning the flutter runner came up resident. Used ONLY for a non-debug
 * launch, to end the URI wait at the moment it becomes answerable instead of
 * burning the caller's whole timeout on a URI that is not coming.
 *
 * `flutter run` prints this from `ResidentRunner.printHelp`, which prints the VM
 * service line a few lines LATER in the same synchronous burst — so a settle match
 * is never proof a URI is absent, only that the answer is imminent. The poll
 * therefore keeps looking for a grace window after matching (see
 * {@link IOS_SETTLE_GRACE_MS}).
 */
export const IOS_RESIDENT_SETTLE_SIGNATURES: RegExp[] = [
  /Flutter run key commands\./,
];

/**
 * How long to keep looking for the VM-service URI after a settle match. The URI
 * line follows the settle line within one synchronous print burst, so this only
 * has to cover log-flush lag — seconds, not minutes.
 */
export const IOS_SETTLE_GRACE_MS = 5000;
