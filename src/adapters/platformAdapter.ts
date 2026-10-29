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
 * concept ignores them. `kind` restricts the class — simulator/emulator vs
 * physical — and is never served by the other one; `udid` pins a specific
 * target for this call only (no env pin, no host reload). Either request that
 * cannot be met exactly fails rather than resolving somewhere else.
 *
 * `udid` is deliberately ONE field across platforms rather than a per-platform
 * name: each adapter reads it in its own id space (iOS/tvOS a flutter id,
 * devicectl id or device/simulator name; Android an adb serial or the model name
 * adb reports), and it overrides that platform's env pin for the one call. It is
 * the only escape hatch on a host with two usable targets attached — an emulator
 * beside a locked physical phone — where discovery alone always answers the same
 * way and only a host reload could change it.
 */
export interface DeviceTargetPreference {
  /** Restrict selection to real hardware or a simulator/emulator (iOS, tvOS, Android). */
  kind?: "device" | "simulator";
  /** Select a specific target by id (any id space the adapter understands). */
  udid?: string;
  /**
   * The call only reads (a local-backend host lookup, a diagnostic). Resolution
   * then does nothing to the device or the connection to it — on Tizen, no
   * `sdb connect` of a pinned device.
   */
  readOnly?: boolean;
}

/**
 * Which device a {@link PlatformAdapter.killStale} teardown is allowed to touch.
 *
 * A DISCRIMINATED UNION, not an object with an optional device, because the two
 * cases are opposites and the difference must be impossible to express by
 * omission: `{ device?: string }` made "kill only this device" and "kill every
 * session on the host" one keystroke apart, and a caller who left the field out
 * got the destructive one silently. Every adapter has to read `kind`, and a
 * caller has to say which it means.
 *
 * Separate from {@link DeviceTargetPreference} because this is not a selection
 * request — the device is already resolved by the time a teardown runs, and
 * re-resolving it could pick a DIFFERENT device than the one being installed to,
 * which is exactly the mismatch that let a deploy kill a bystander session.
 */
export type KillStaleScope =
  | { kind: "device"; device: string }
  | { kind: "all-devices" };

/**
 * Whether an adapter's {@link PlatformAdapter.killStale} can confine itself to
 * one device.
 *
 * `device` — its drivers are shared across devices (iOS/Android: every session
 * is a `flutter run` on this host), so ONLY the device distinguishes them and a
 * teardown without one could not help killing a bystander's session.
 *
 * `platform` — its drivers are named after its own toolchain (`flutter-tizen`,
 * `ares-launch`, `flutter-webos`, `flutter-tvos`) or identified another way
 * entirely (macOS, by process name), so they cannot belong to another platform
 * and one target is modelled. Such a teardown needs no device — which also
 * means it can run BEFORE device discovery, where a wedged driver may be the
 * reason discovery is failing.
 */
export type KillStaleScopeKind = "device" | "platform";

/** Options accepted by {@link PlatformAdapter.install}. */
export interface InstallOptions {
  /** Install only; do not launch. (Present for parity with future modes.) */
  noLaunch?: boolean;
  /**
   * The deploy will call {@link PlatformAdapter.launchAndCaptureUri} right after
   * this install. An adapter whose launch builds and installs by itself (tvOS
   * debug on a device) can then leave the install to it, rather than install an
   * artifact the launch replaces.
   */
  launchFollows?: boolean;
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
  /**
   * macOS ONLY: override the `.app` source to stage for this deploy — a local
   * path (`.app`, `.tar.gz`/`.tgz`, or `.dmg`) or a URL to fetch. Wins over the
   * adapter's configured FLUTTER_DEVICE_MACOS_APP_PATH/FLUTTER_DEVICE_MACOS_APP_URL
   * for this one call. Ignored by every other platform.
   */
  appPath?: string;
  /** macOS ONLY: see {@link appPath}; the URL form. Ignored elsewhere. */
  appUrl?: string;
  /**
   * Android: proceed even though the installed copy of the app came from the
   * Play Store. `flutter run` replaces an install signed by another key by
   * uninstalling it first, so installing a debug build over a store build
   * deletes the store build and its data. Refused unless this is set.
   */
  allowStoreAppRemoval?: boolean;
}

/** What the deploy knows when it authorizes a space-recovery uninstall. */
export interface RecoveryContext {
  /** The call named this device itself (a per-call id or a pin), confirmed online. */
  explicitDevice: boolean;
  /** The caller accepted removing a copy of the app installed from an app store. */
  allowStoreAppRemoval: boolean;
}

/**
 * What an adapter wants done about a failed launch. An adapter never uninstalls
 * here itself: it asks, and runDeployCore authorizes the uninstall (named
 * device, confirmed package, installed copy safe to remove) and performs it, so
 * an adapter cannot skip those checks by forgetting to call them.
 */
export type LaunchRecovery =
  | { action: "none"; note?: string }
  /** The adapter already fixed the cause (iOS provisioning); retry the launch. */
  | { action: "retry"; note: string }
  /** Free space by uninstalling `packageId`, then retry — if authorized. */
  | { action: "uninstall-and-retry"; packageId: string; note: string };

/** A request to confirm an uninstall is safe before it runs. */
export interface UninstallCheck {
  /**
   * `space-recovery`: the deploy wants to free space, so the build being
   * installed must carry the package id that would be removed. `requested`: the
   * caller asked for the uninstall (flutter_uninstall).
   */
  purpose: "space-recovery" | "requested";
  /** The package that would be uninstalled. */
  packageId: string;
  allowStoreAppRemoval: boolean;
  /** The failed install/launch output, used to locate the build being installed. */
  buildLog?: string;
  /** Where {@link packageId} came from; a `build-tree` guess is checked harder. */
  appIdSource?: AppIdSource;
}

export type UninstallVerdict = { ok: true } | { ok: false; reason: string };

/**
 * How a package id was arrived at. `deployed`: flutter_deploy recorded the apk
 * it installed on that device. `device`: the device holds exactly one adb
 * install of the app. `build-tree`: what the checkout's build would produce now,
 * which is only a guess at what is installed. `configured`: the adapter's fixed id.
 */
export type AppIdSource = "deployed" | "device" | "build-tree" | "configured";

/**
 * The package a verb acts on for one device, or why it cannot be named. `note`
 * tells the caller how a guess was settled, so it is reported with the result.
 */
export type AppIdResolution =
  | { ok: true; appId: string; source: AppIdSource; note?: string }
  | { ok: false; reason: string };

/** A request to confirm a lifecycle verb may act on `appId`. */
export interface LifecycleCheck {
  /** `open_url` is the VIEW intent scoped to the app, held to the same checks. */
  verb: "terminate" | "foreground" | "open_url";
  appId: string;
  appIdSource: AppIdSource;
  /** Act on a copy that a store or tester distribution installed. */
  allowStoreApp: boolean;
}

/**
 * `nothing-to-do` is a success with nothing run (terminating an app that is not
 * installed); `refuse` means the verb must not run, and nothing was done.
 */
export type LifecycleVerdict =
  | { kind: "proceed" }
  | { kind: "nothing-to-do"; message: string }
  | { kind: "refuse"; reason: string };

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
  background(device: string): Promise<CommandResult>;
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

/** A device this MCP process holds for itself (see simulatorClaim). */
export interface DeviceClaim {
  device: string;
  name?: string;
  note: string;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  /**
   * The device this process claimed for calls that name none, when it holds one.
   * Absent on platforms that do not claim.
   */
  deviceClaim?(): DeviceClaim | undefined;

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
   * Resolve the device to operate on. A named device (per-call `udid`, env
   * pin, target file) that is not online throws a RequestedDeviceUnavailableError
   * rather than resolving to another device.
   *
   * OPTIONAL `preference` lets a caller steer selection PER-CALL, without a
   * server-env pin or host reload — the iOS need surfaced live: with a paired
   * iPhone present, discovery is physical-first, so a simulator UI walkthrough
   * had no way to pick the booted simulator. `kind: "simulator" | "device"`
   * restricts the class; `udid` selects a specific target (any id space the adapter
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
   * OPTIONAL reactive recovery for a FAILED launch. The deploy calls this once
   * when {@link launchAndCaptureUri} fails and acts on the answer: `retry`
   * relaunches once, `uninstall-and-retry` relaunches once after runDeployCore
   * has authorized and performed the uninstall, `none` reports the failure.
   *
   * iOS answers `retry` after a one-shot provisioning-updating `xcodebuild`
   * (registering a first-time device), and iOS/Android ask for an uninstall when
   * the device rejected the install for space. Absence means "no launch-failure
   * recovery".
   *
   * `logTail` is the captured launch output that failed (so the implementation
   * can classify WHY it failed); `device` is the resolved target. An uninstall is
   * requested, never performed, here; see {@link LaunchRecovery}.
   */
  recoverLaunchFailure?(device: string, logTail: string): Promise<LaunchRecovery>;

  /**
   * OPTIONAL launch timeout for a deploy whose caller passed none, for the
   * device the last {@link discoverDevice} resolved. Undefined keeps the
   * deploy's own default. tvOS needs it: a device launch always rebuilds, which
   * the shared default cannot cover.
   */
  defaultLaunchTimeoutMs?(mode?: BuildMode): number | undefined;

  /**
   * OPTIONAL check that uninstalling `check.packageId` from `device` is safe.
   * Space recovery is refused on a platform without it, because a package id
   * that cannot be confirmed is never uninstalled.
   */
  verifyUninstallTarget?(
    device: string,
    check: UninstallCheck
  ): Promise<UninstallVerdict>;

  /**
   * OPTIONAL: the package the lifecycle verbs, uninstall and open-url act on for
   * `device`, when it is not simply {@link appId}. Android implements it because
   * the package `flutter run` installs depends on the checkout's build type, and
   * a verb aimed at the configured id instead lands on whatever else carries it
   * (a store install of the release app). Read it through `resolveAppIdFor`.
   */
  resolveAppId?(device: string): Promise<AppIdResolution>;

  /**
   * OPTIONAL: the package the build about to be installed carries, when it is
   * not simply {@link appId}. Space recovery during an install frees space by
   * removing that package, not whatever an earlier deploy left on the device.
   */
  installPackageId?(): AppIdResolution;

  /**
   * OPTIONAL check terminate, foreground and a scoped open-url run before acting on `check.appId`.
   * Android refuses a copy adb did not install, and a guessed id that is not
   * installed at all.
   */
  verifyLifecycleTarget?(device: string, check: LifecycleCheck): Promise<LifecycleVerdict>;

  /** Uninstall the app to free device space / reset state. */
  uninstall(device: string, appId: string): Promise<CommandResult>;

  /**
   * Kill leftover driver processes that would wedge the device lock.
   *
   * A `scope` of `{ kind: "device", device }` is the already-resolved target the
   * caller is about to deploy to; an adapter whose {@link killStaleScope} is
   * `"device"` MUST confine the teardown to it. A host with a phone and an
   * emulator attached runs two indistinguishable `flutter run` command lines, so
   * a teardown matched on the command string alone kills whichever session
   * someone else is using — which is why `device_udid` could select a target but
   * not protect the other one.
   *
   * `{ kind: "all-devices" }` is the deliberate host-wide hammer behind
   * `flutter_kill_stale`'s `all_devices`, and the only mode that sweeps
   * `frontend_server` processes belonging to nothing it killed.
   *
   * The parameter is declared by EVERY adapter, even the ones that ignore it
   * (`_scope`), and pinned by a type-level check in killStaleContract.ts: a
   * zero-parameter or optional-parameter implementation satisfies this signature
   * structurally, which is how a "required argument" guardrail here was worth
   * nothing on its own.
   */
  killStale(scope: KillStaleScope): Promise<Record<string, CommandResult>>;

  /**
   * Whether {@link killStale} can confine itself to one device. REQUIRED, so a
   * new adapter cannot omit it and be treated as either kind by accident — and
   * so the server reports the scope it actually applied rather than the one it
   * asked for. A Tizen teardown reporting `scope: <device>` while killing both
   * TVs is the same report-one-thing-about-another failure this change exists to
   * fix.
   */
  readonly killStaleScope: KillStaleScopeKind;

  /**
   * OPTIONAL pre-connect environment diagnosis. Returns an actionable message
   * when the device's development environment is misconfigured in a way that
   * would make `connect`/deploy fail cryptically, or `null` when it looks fine.
   *
   * Implemented by Tizen (Samsung Developer Mode "Host PC IP" must point at this
   * Mac; a mismatch makes `sdb connect` fail with an opaque error) and tvOS
   * (Xcode has not prepared debug symbols for the Apple TV's tvOS release, so a
   * debug launch fails after the build). Absence means "no environment pre-check".
   * Best-effort and non-throwing: a transient failure to inspect the environment
   * resolves to `null`, never an error, so it can't fail a deploy.
   *
   * `resolved` lets a caller that already discovered the device (the deploy path)
   * pass it in to avoid a redundant discovery round-trip (`sdb devices` + REST);
   * when omitted, the implementation discovers the device itself (the info path).
   */
  environmentDiagnostic?(resolved?: DeviceResolution): Promise<string | null>;

  /**
   * OPTIONAL: why a VM-service `reloadSources` cannot work on `device`, or
   * undefined when it might. The hot-reload fallback asks before connecting, so
   * a target that cannot recompile on-device is told to redeploy rather than
   * reported as reloaded.
   */
  vmServiceReloadRefusal?(device: string): Promise<string | undefined>;

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
   * the PNG bytes inline (base64) in addition to the saved path. `deviceUdid`
   * pins which target to capture for this call (see
   * {@link DeviceTargetPreference}); adapters that resolve their target another
   * way ignore it.
   */
  screenshot?(opts: {
    outPath?: string;
    includeBase64?: boolean;
    deviceUdid?: string;
    /**
     * Force the CLASS of target to capture where a platform has two (iOS/tvOS:
     * `device` = real hardware, `simulator` = a booted simulator). Without it
     * resolution is physical-first, matching deploy — so a capture lands on the
     * machine a deploy would have used. Ignored by platforms with one target
     * class.
     */
    target?: "device" | "simulator";
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
    /**
     * Pins which target to record for this call (see
     * {@link DeviceTargetPreference}); adapters that resolve their target
     * another way ignore it.
     */
    deviceUdid?: string;
    /** Force the class of target to record, as for {@link PlatformAdapter.screenshot}. */
    target?: "device" | "simulator";
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
   * Open a URL ON the device, exactly as tapping a link would — the deep-link
   * / universal-link plane.
   *
   * OPTIONAL, and the per-platform reality is uneven for reasons outside this
   * codebase: Android opens any URL (`am start -a VIEW`); Apple SIMULATORS open
   * any URL (`simctl openurl`); Apple PHYSICAL devices have NO supported
   * automation path (devicectl exposes no url-open verb and idb's ui/open are
   * simulator-only), so those return `{supported:false}` with the reason rather
   * than a silent no-op. Tizen/webOS do not implement it — `sdb shell` is
   * disabled on Samsung devices, leaving no device-side launcher. Absence of
   * the seam is surfaced by the server as `{ supported: false }`.
   *
   * `packageOrBundleId` scopes the open to one app where the platform supports
   * it (Android). Passing it avoids a disambiguation chooser that an automated
   * run cannot answer.
   *
   * `preference` steers target selection exactly like {@link discoverDevice}.
   * It matters MORE here than elsewhere: Apple platforms support this verb on a
   * simulator and NOT on a physical device, and discovery is physical-first — so
   * without a way to ask for the simulator, a host with a paired iPhone could
   * never reach the path that actually works.
   */
  openUrl?(
    url: string,
    packageOrBundleId?: string,
    preference?: DeviceTargetPreference
  ): Promise<import("../openUrl.js").OpenUrlResult>;

  /**
   * Physical input controller. Real dual-mode input is implemented for TV
   * platforms; other platforms return a stub whose methods throw
   * NotImplementedError.
   *
   * `preference` steers WHICH device the returned controller sends to, exactly
   * like {@link discoverDevice} — a multi-device host has to be able to say
   * which target a key or tap is meant for. The controller itself is long-lived
   * (its mode and staged pointer position are session-sticky), so the preference
   * applies to the sends that follow this call rather than minting a new
   * controller and losing that state. Adapters whose controller holds no device
   * concept ignore it.
   */
  input(preference?: DeviceTargetPreference): InputController;

  /**
   * The device-resolution warning produced by the most recent `input()`-scoped
   * send (key/pointerMove/pointerClick/pointerScroll/text) — mirroring the
   * `deviceWarning` {@link discoverDevice} callers already get from
   * deploy/screenshot/geometry. Reset to `undefined` by every {@link input}
   * call, so a warning from one call is never reported against a later one.
   * Optional: only an adapter whose controller resolves the device lazily
   * per-send (Android) implements it — adapters with no per-call device concept
   * omit it, and callers must use the optional-call form.
   */
  inputDeviceWarning?(): string | undefined;

  /**
   * The app id this platform is configured with, for reporting. A verb that
   * acts on the app's package resolves it with `resolveAppIdFor` instead, which
   * consults {@link resolveAppId} where the adapter has one.
   */
  readonly appId: string;
}
