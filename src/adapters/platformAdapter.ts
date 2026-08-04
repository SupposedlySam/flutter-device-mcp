/**
 * The platform-adapter seam.
 *
 * The neutral server (guard/logging/JSON-envelope/tool-registration) resolves a
 * {@link PlatformAdapter} for the active platform and drives every device
 * operation through it. Each concrete adapter (Tizen today, webOS as a Stage-1
 * stub) encodes the per-platform CLI/device specifics behind this uniform
 * surface, so the server holds zero platform conditionals.
 */
import {
  BuildMode,
  BuildOptions,
  BuildResult,
  CommandResult,
  DeviceResolution,
  InputController,
  LaunchOutcome,
  Platform,
} from "../types.js";
import { ScreenshotResult } from "../screenshot.js";
import { DeviceGeometryReading } from "../deviceGeometry.js";
import { RecordFormat, RecordResult } from "../recording.js";

/**
 * Per-call device-selection preference (see {@link PlatformAdapter.discoverDevice}).
 *
 * Both fields are optional and additive; an adapter that does not model the
 * concept ignores them. On iOS: `kind` biases physical-vs-simulator (the primary
 * gap — a simulator UI walkthrough on a host with a paired iPhone), and `udid`
 * pins a specific target for this call only (no env pin, no host reload).
 */
export interface DeviceTargetPreference {
  /** Bias selection toward a device or a simulator (iOS today). */
  kind?: "device" | "simulator";
  /** Select a specific target by id (any id space the adapter understands). */
  udid?: string;
}

/** Options accepted by {@link PlatformAdapter.install}. */
export interface InstallOptions {
  /** Install only; do not launch. (Present for parity with future modes.) */
  noLaunch?: boolean;
  /**
   * The 3-way build mode of the artifact to reinstall. Reinstalls the existing
   * package of that mode (skipping the long rebuild) so a debug OR profile
   * build can be redeployed + relaunched for a driver. `mode` wins over the
   * legacy `debug` boolean. Inert on platforms where install does not
   * distinguish an artifact mode.
   */
  mode?: BuildMode;
  /**
   * Reinstall the DEBUG artifact rather than the default (release) one. Legacy
   * shorthand for `mode: "debug"`; `mode` wins when both are given. Inert on
   * platforms where install does not distinguish a debug artifact.
   */
  debug?: boolean;
  /**
   * `--dart-define` constants for this deploy. On the platforms where install
   * and launch are ONE `flutter run` (iOS/Android), this is threaded to
   * {@link PlatformAdapter.launchAndCaptureUri} so the defines reach the build
   * that actually runs. Platforms that launch a pre-built artifact apply them
   * at build time instead and ignore this.
   */
  dartDefine?: Record<string, string>;
}

/**
 * OS-level app-lifecycle control for a resolved device.
 *
 * Implemented by mobile adapters (iOS today) where backgrounding/foregrounding
 * the app under test is a first-class testing verb. All methods target the
 * adapter's own app; `device` is the resolved target from {@link
 * PlatformAdapter.discoverDevice}.
 */
export interface AppLifecycle {
  /** Terminate (force-quit) the running app. */
  terminate(device: string, appId: string): Promise<CommandResult>;
  /**
   * Send the app to the background WITHOUT killing it, by foregrounding a
   * neutral system app (e.g. the Settings/Preferences app). This drives the
   * app's `didEnterBackground` lifecycle path for testing.
   */
  background(device: string, appId: string): Promise<CommandResult>;
  /** Bring the app back to the foreground by relaunching its bundle id. */
  foreground(device: string, appId: string): Promise<CommandResult>;
}

/** The action a {@link SystemPromptController} performs. */
export type SystemPromptAction = "detect" | "tap" | "dismiss";

/** Structured result of a {@link SystemPromptController} operation. */
export interface SystemPromptResult {
  /** True when a system prompt was detected on screen. */
  present: boolean;
  /** The prompt's title/message text lines, best-effort (context for the caller). */
  messages: string[];
  /** The tappable button labels on the prompt, in tree order. */
  buttons: string[];
  /**
   * For a `tap`/`dismiss`, the label of the button that was tapped. Undefined
   * when nothing was tapped (detect-only, or no matching button).
   */
  tapped?: string;
  /** The raw device-point coordinate tapped, when a tap occurred. */
  tappedAt?: { x: number; y: number };
  /**
   * A human-readable note when the operation could not complete as asked (idb
   * missing, no prompt present, requested button not found). Never thrown for
   * these expected conditions — surfaced here so the caller can react.
   */
  note?: string;
}

/**
 * Detect and act on SYSTEM-LEVEL UI prompts that live OUTSIDE the Flutter app's
 * view tree — SpringBoard alerts, permission dialogs, and "Open in <app>?"
 * confirmations. Marionette (which drives the app over the Dart VM service)
 * cannot see or tap these, so a human tap was previously the only unblock; this
 * capability removes that blocker for autonomous testing.
 *
 * OPTIONAL — implemented by iOS (via idb over the simulator/physical-device
 * accessibility tree). Appliance platforms (Tizen/webOS) and Android do not
 * implement it; absence is surfaced by the server as `{ supported: false }`.
 */
export interface SystemPromptController {
  /**
   * Detect whether a system prompt is present and, when `action` is `tap` or
   * `dismiss`, act on it. `buttonLabel` selects a button by label for `tap`
   * (case-insensitive, exact-then-substring); `dismiss` ignores it and taps the
   * negative/last action.
   *
   * TARGET SELECTION (iOS, verified live): `idb ui describe-all`/`idb ui tap` are
   * SIMULATOR-ONLY — on a physical device idb returns "Target doesn't conform to
   * FBSimulatorLifecycleCommands protocol". So, unlike the deploy/lifecycle verbs
   * (which prefer a physical device), this controller resolves its OWN target,
   * preferring a booted SIMULATOR. An explicit `udid` overrides that resolution;
   * when only a physical device is available it returns a structured note
   * (simulator-only) rather than failing. `udid` is therefore optional here — the
   * controller does not reuse the deploy path's resolved device.
   */
  handle(
    action: SystemPromptAction,
    buttonLabel?: string,
    udid?: string
  ): Promise<SystemPromptResult>;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  /** Device + environment status (never via `sdb shell` on Tizen). */
  info(): Promise<CommandResult>;

  /** Configure the device for development; may write a target file. */
  setup(opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }>;

  /** Build the native engine + app package. */
  build(opts: BuildOptions): Promise<BuildResult>;

  /**
   * Resolve the device to operate on (pin/discovery, stale-pin fallback).
   *
   * OPTIONAL `preference` lets a caller steer selection PER-CALL, without a
   * server-env pin or host reload — the iOS need surfaced live: with a paired
   * iPhone present, discovery is physical-first, so a simulator UI walkthrough
   * had no way to pick the booted simulator. `kind: "simulator" | "device"`
   * biases the class; `udid` selects a specific target (any id space the adapter
   * understands). Adapters that don't distinguish device kinds (Tizen/webOS)
   * ignore it; passing nothing preserves the prior behavior exactly.
   */
  discoverDevice(preference?: DeviceTargetPreference): Promise<DeviceResolution>;

  /** Install the already-built package on a resolved device. */
  install(device: string, opts: InstallOptions): Promise<CommandResult>;

  /**
   * True when a captured install output signals a recoverable install failure
   * (out-of-space or a failed install) the deploy path should react to by
   * uninstalling and retrying once. OPTIONAL — the deploy handler falls back to
   * the platform-neutral "No space left on device" / "Install failed" signatures
   * when an adapter does not implement it.
   *
   * webOS phrases the failure as "Failed to install" (ares) rather than Tizen's
   * "Install failed", so the webOS adapter overrides this to recognize its own
   * wording instead of hard-coding one platform's strings into the server.
   */
  isInstallFailure?(combined: string): boolean;

  /**
   * OPTIONAL classification of an install failure into an ACTIONABLE message.
   * Returns human-readable guidance when the captured install output matches a
   * known failure class (e.g. iOS's unsigned-bundle install error), else `null`.
   *
   * Separate from {@link isInstallFailure} (which gates the ENOSPC
   * uninstall-and-retry recovery): this is purely for surfacing a clearer error
   * to the caller. Absent on platforms with nothing to add — the deploy handler
   * simply omits the field then.
   */
  installFailureDiagnostic?(combined: string): string | null;

  /**
   * Launch the app through a pty and capture the Dart VM Service URI for
   * Marionette. The launch process is left running to hold the URI open.
   *
   * OPTIONAL `mode` names the compilation mode to launch, for adapters whose
   * launch reuses an already-installed artifact (Tizen: `flutter-tizen run
   * --no-build --<mode>`, which must name the installed TPK's mode or it has
   * nothing to reuse). `debug` and `profile` both keep the VM service open, so
   * the URI is captured either way; a Tizen launch defaults to `debug` when
   * omitted, preserving the historical behavior. Adapters whose launch builds
   * from source and already carries its own mode ignore it.
   */
  launchAndCaptureUri(
    device: string,
    timeoutMs: number,
    mode?: BuildMode,
    dartDefine?: Record<string, string>
  ): Promise<LaunchOutcome>;

  /**
   * OPTIONAL reactive recovery for a FAILED launch. The deploy handler calls this
   * once when {@link launchAndCaptureUri} fails; if it returns `true`, the deploy
   * retries the launch exactly once. Returns `false` when it recognized nothing
   * to recover (the launch failure is then reported as-is).
   *
   * Implemented by iOS: a launch that failed on a provisioning/device-registration
   * signature triggers a one-shot provisioning-updating `xcodebuild` build (which
   * registers the device + mints the profile), enabling a first-time-device deploy
   * to succeed on retry. Other platforms don't implement it — absence means "no
   * launch-failure recovery" and the failure is reported directly.
   *
   * `logTail` is the captured launch output that failed (so the implementation
   * can classify WHY it failed); `device` is the resolved target.
   */
  recoverLaunchFailure?(
    device: string,
    logTail: string
  ): Promise<{ recovered: boolean; note?: string }>;

  /** Uninstall the app to free device space / reset state. */
  uninstall(device: string, appId: string): Promise<CommandResult>;

  /** Kill leftover driver processes that would wedge the device lock. */
  killStale(): Promise<Record<string, CommandResult>>;

  /**
   * OPTIONAL pre-connect environment diagnosis. Returns an actionable message
   * when the device's development environment is misconfigured in a way that
   * would make `connect`/deploy fail cryptically, or `null` when it looks fine.
   *
   * Implemented by Tizen (Samsung Developer Mode "Host PC IP" must point at this
   * Mac; a mismatch makes `sdb connect` fail with an opaque error). Other
   * platforms don't implement it — absence means "no environment pre-check".
   * Best-effort and non-throwing: a transient failure to inspect the environment
   * resolves to `null`, never an error, so it can't fail a deploy.
   *
   * `resolved` lets a caller that already discovered the device (the deploy path)
   * pass it in to avoid a redundant discovery round-trip (`sdb devices` + REST);
   * when omitted, the implementation discovers the device itself (the info path).
   */
  environmentDiagnostic?(resolved?: DeviceResolution): Promise<string | null>;

  /**
   * OS-level app-lifecycle control. OPTIONAL — appliance platforms (Tizen,
   * webOS) do not implement these; mobile (iOS) does, since lifecycle driving
   * (background/foreground the app under test) is a primary mobile use case.
   * Absence is surfaced by the server as `{ supported: false }`.
   *
   * These are OS-level only. In-app gestures/taps are driven separately by the
   * Marionette MCP over the Dart VM service and are NOT reimplemented here.
   */
  lifecycle?: AppLifecycle;

  /**
   * System-prompt control (detect/tap/dismiss OS-level dialogs outside the app
   * view tree). OPTIONAL — implemented by iOS today; absence is surfaced by the
   * server as `{ supported: false }`. See {@link SystemPromptController}.
   */
  systemPrompt?: SystemPromptController;

  /**
   * Capture the current device/app screen to a PNG on disk. OPTIONAL — every
   * adapter implements it, but each platform's result reflects its capture
   * reality: iOS SIMULATOR + Android capture reliably; iOS PHYSICAL device,
   * Tizen, and webOS return `{ supported: false }` with a reason/hint rather than
   * inventing a capture path (e.g. no `sdb shell` on Samsung devices). Absence of
   * the seam is surfaced by the server as `{ supported: false }`.
   *
   * `outPath` is an optional caller-chosen destination; when omitted the adapter
   * writes to a predictable temp path and returns it. `includeBase64` asks for
   * the PNG bytes inline (base64) in addition to the saved path.
   */
  screenshot?(opts: {
    outPath?: string;
    includeBase64?: boolean;
  }): Promise<ScreenshotResult>;

  /**
   * Record a bounded screen clip (video/gif) to a file on disk. OPTIONAL — each
   * adapter reflects its recording reality: Android records a smooth native mp4
   * (`screenrecord` + pull, SIGINT'd on-device to flush); iOS SIMULATOR records
   * native mp4 (`simctl recordVideo`, SIGINT-stopped); iOS PHYSICAL device has NO
   * native recorder, so it captures a screenshot BURST then assembles it with
   * ffmpeg (realistically ~1–3 fps, choppy — documented, not a bug); tvOS, Tizen,
   * and webOS return `{ supported: false }`. `gif` always needs ffmpeg (native
   * recorders emit mp4 only); absent ffmpeg, gif + the iOS-device path degrade to
   * `{ supported: false }` with an install hint while native-mp4 paths still work.
   * Absence of the seam is surfaced by the server as `{ supported: false }`.
   *
   * DURATION-BOUNDED: the recorder runs `durationSeconds`, then stops cleanly.
   * `outPath` is an optional caller destination (temp path returned when omitted);
   * `fps` drives the iOS-device burst + gif frame rate; `format` selects the
   * container.
   */
  record?(opts: {
    outPath?: string;
    durationSeconds: number;
    fps: number;
    format: RecordFormat;
    /** Optional specific target id (iOS); adapters that ignore device kinds ignore it. */
    deviceUdid?: string;
  }): Promise<RecordResult>;

  /**
   * Report the device's real screen geometry — display size in device pixels,
   * the density-derived device pixel ratio, and the logical size that follows.
   *
   * OPTIONAL. Implemented by Android (`adb shell wm size` + `wm density`), the
   * only platform whose geometry has been exercised on-device; absence is
   * surfaced by the server as `{ supported: false }` rather than a guess.
   *
   * This exists because the pointer plane REQUIRES a device pixel ratio for
   * logical coordinates and refuses to assume one, while nothing here used to
   * report one — leaving a caller to eyeball a screenshot and guess. Returns
   * undefined when the device answered but the output could not be parsed.
   *
   * `preference` selects the target exactly like {@link discoverDevice} (which
   * an implementation is expected to delegate to): geometry differs per device,
   * so a multi-device host must be able to say which one it is asking about.
   */
  geometry?(
    preference?: DeviceTargetPreference
  ): Promise<DeviceGeometryReading | undefined>;

  /**
   * Physical input controller. Real dual-mode input is implemented for TV
   * platforms; other platforms return a stub whose methods throw
   * NotImplementedError.
   */
  input(): InputController;

  /** The default app id for this platform, used for uninstall. */
  readonly appId: string;
}
