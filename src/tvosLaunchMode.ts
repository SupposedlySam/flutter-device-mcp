/**
 * tvOS launch mode resolution and what each mode costs on each target class.
 *
 * The precedence matches the iOS adapter (see `iosLaunchMode.ts`):
 *   1. an explicit `mode` tool arg,
 *   2. the legacy explicit `debug` boolean (true → debug, false → release),
 *   3. the `FLUTTER_DEVICE_TVOS_LAUNCH_MODE` env var,
 *   4. the default, `debug`.
 *
 * The default is debug because it is the only mode with hot reload and
 * restart, and the only one where Marionette's screenshot works. Whether
 * Marionette is reachable in profile depends on how the app gates its
 * registration (an app gated on `kDebugMode` has none there), and even where it
 * is registered its render-surface capture fails under AOT on tvOS.
 *
 * A physical Apple TV runs debug only with lldb attached: the engine refuses to
 * create a debug FlutterEngine in an untraced process, and flutter-tvos attaches
 * lldb itself, so the adapter runs `flutter-tvos run` directly for every device
 * launch.
 */
import { BuildMode } from "./types.js";

export type TvosLaunchMode = BuildMode;

export const TVOS_DEFAULT_LAUNCH_MODE: TvosLaunchMode = "debug";

/**
 * Parse `FLUTTER_DEVICE_TVOS_LAUNCH_MODE`. Anything other than the three modes is
 * ignored rather than guessed at, so a typo falls back to the default.
 */
export function parseTvosLaunchModeEnv(
  raw: string | undefined
): TvosLaunchMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "debug" || value === "profile" || value === "release") {
    return value;
  }
  return undefined;
}

export function resolveTvosLaunchMode(opts: {
  explicitMode?: TvosLaunchMode;
  explicitDebug?: boolean;
  envMode?: TvosLaunchMode;
}): TvosLaunchMode {
  if (opts.explicitMode) return opts.explicitMode;
  if (opts.explicitDebug === true) return "debug";
  if (opts.explicitDebug === false) return "release";
  return opts.envMode ?? TVOS_DEFAULT_LAUNCH_MODE;
}

/**
 * What a launch gives up, stated on the deploy response. `null` when nothing is
 * given up.
 *
 * The simulator only runs the debug (JIT) build this adapter installs there, so
 * a profile or release request on a simulator is answered with a debug launch
 * and this caveat says so. That is the one place the requested and the launched
 * mode differ, and it is never silent.
 */
export function tvosLaunchModeCaveat(
  requested: TvosLaunchMode,
  launched: TvosLaunchMode
): string | null {
  if (requested !== launched) {
    return (
      `Requested --${requested}, launched --${launched}: the tvOS simulator only ` +
      "runs the debug (JIT) build. Use a physical Apple TV for profile or release."
    );
  }
  if (launched === "debug") return null;
  if (launched === "profile") {
    return (
      "Launched --profile: AOT with realistic timing and an open VM service. " +
      "If the app registers Marionette outside debug, taps and the element tree work, " +
      "but its take_screenshots fails under AOT on tvOS (use flutter_screenshot); an " +
      "app that gates Marionette on kDebugMode has none here. There is no hot reload " +
      "or restart. Redeploy without a mode for debug."
    );
  }
  return (
    "Launched --release: release compiles the VM service out, so there is no URI " +
    "and nothing can attach. This is the mode's design, not a launch failure."
  );
}

export const TVOS_RELEASE_NO_VM_SERVICE_REASON =
  "No Dart VM service URI: this launch is --release, which compiles the VM " +
  "service out. Redeploy in debug (the default) to drive the app.";

export const TVOS_PROFILE_NO_VM_SERVICE_REASON =
  "No Dart VM service URI: the --profile run came up resident without announcing " +
  "one, so there is nothing to attach to. Redeploy in debug (the default), or read " +
  "the launch log for why the forward never came up.";

/**
 * flutter-tvos prints the resident runner's key help once the run is attached.
 * Used to end the wait of a non-debug launch that announces no URI.
 */
export const TVOS_RESIDENT_SETTLE_SIGNATURES: RegExp[] = [
  /Flutter run key commands\./,
];

/**
 * How long a non-debug launch keeps looking for a URI after the key help. The
 * VM-service lookup on a network-paired Apple TV goes over Bonjour and can lag
 * the key help, so this is longer than the neutral 5s.
 */
export const TVOS_SETTLE_GRACE_MS = 30000;

/**
 * Terminal failures of a direct `flutter-tvos run --debug` on a physical Apple
 * TV, in flutter-tvos's own words (lib/tvos_device.dart).
 *
 * The Xcode-debugger fallback is listed on purpose. flutter-tvos takes it when
 * lldb does not attach, and it drives Xcode through AppleScript automation,
 * which needs a person to grant the automation prompt and a session nobody is
 * watching cannot answer. Matching its announcement ends the launch there, and
 * the adapter then tears the run down so the fallback never gets going.
 */
export const TVOS_DEVICE_DEBUG_FAILURE_SIGNATURES: RegExp[] = [
  /lldb debugging did not attach/i,
  /Could not attach a debugger to the app on this Apple TV/i,
  /Cannot create a FlutterEngine instance in debug mode/i,
  /Cannot start a debug session on this Apple TV/i,
  /Dart VM Service could not be reached within/i,
  /Dart VM Service was not found within the timeout/i,
  /App bundle not found at:/i,
  /Timed out waiting for .* to register on the device/i,
  /devicectl install failed/i,
];

/**
 * The device refused to launch an app because it is asleep. devicectl reports
 * it as "System is asleep" / a forbidden foreground launch.
 */
export const TVOS_ASLEEP_SIGNATURES: RegExp[] = [
  /System is asleep/i,
  /foreground app launch (?:is )?forbidden/i,
];

/**
 * CoreDevice dropped the connection mid-transfer. Seen on network-paired Apple
 * TVs during an install; a second attempt normally goes through.
 */
export const TVOS_CONNECTION_RESET_PATTERN = /Connection reset by peer/i;

export function isTvosAsleepFailure(text: string): boolean {
  return TVOS_ASLEEP_SIGNATURES.some((signature) => signature.test(text));
}

/**
 * The device launch timeout used when the caller passes none.
 *
 * Every device launch rebuilds (`flutter-tvos run` has no prebuilt-binary
 * path), and a debug launch adds lldb's attach (up to 180s by default) and the
 * Bonjour lookup of the VM service (up to 60s). The 180s the other platforms
 * default to cannot fit a cold device build. A run that dies early is still
 * reported at once, because the launch core watches the runner's exit.
 */
export const TVOS_DEVICE_LAUNCH_TIMEOUT_MS = 40 * 60 * 1000;
