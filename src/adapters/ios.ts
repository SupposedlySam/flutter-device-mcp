/**
 * iOS platform adapter.
 *
 * Drives a Flutter app on iOS behind the neutral {@link PlatformAdapter}
 * seam — the mobile counterpart of {@link TizenAdapter}. Where Tizen wraps
 * flutter-tizen + sdb, iOS drives the mobile toolchain directly:
 *   - `xcrun devicectl` for PHYSICAL devices (iPhone/iPad),
 *   - `xcrun simctl` for SIMULATORS,
 *   - `flutter` for builds and for the launch-that-captures-the-VM-service-URI.
 *
 * The launch reuses the SAME neutral launch core the Tizen adapter uses: it
 * feeds `flutter run` (pty-wrapped so it line-flushes the "Dart VM Service ...
 * available at:" line) + iOS failure signatures into
 * {@link neutralLaunchAndCaptureUri}. That is the single most valuable behavior:
 * it returns the `ws://…/ws` URI for Marionette to connect to.
 *
 * SCOPE: OS-level device control only. In-app gestures/taps are driven by the
 * separate Marionette MCP over the Dart VM service and are NOT reimplemented
 * here. Free-cursor pointer input has no meaning on a touch device, so the input
 * controller reports `{ supported: false }` for move/scroll (mirroring how the
 * Tizen adapter reports unsupported pointer ops).
 *
 * iOS-specific values the neutral launch core needs — the `flutter run` command
 * and the failure signatures — are defined HERE and passed IN, exactly as Tizen
 * does with flutter-tizen.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CommandResult,
  quote,
  resolveFlutterCommand,
  runShell,
  tail,
} from "../cli.js";
import {
  allocateControlFifo,
  buildPtyCaptureCommand,
  launchAndCaptureUri as neutralLaunchAndCaptureUri,
} from "../launchCapture.js";
import { logger } from "../logger.js";
import {
  IosDeviceKind,
  IosDeviceResolution,
  mergeFlutterIds,
  parseDevicectlDevices,
  parseFlutterIosDevices,
  parseSimctlDevices,
  resolveIosTarget,
} from "../iosDeviceTarget.js";
import {
  BuildOptions,
  BuildResult,
  DeviceResolution,
  InputController,
  InputMode,
  LaunchOutcome,
  Platform,
  UnsupportedInputError,
} from "../types.js";
import {
  AppLifecycle,
  DeviceTargetPreference,
  InstallOptions,
  PlatformAdapter,
  SystemPromptAction,
  SystemPromptController,
  SystemPromptResult,
} from "./platformAdapter.js";
import {
  chooseButton,
  detectSystemPrompt,
  parseAxElements,
} from "../iosSystemPrompt.js";
import { locateIdb } from "../idbLocate.js";
import { locatePymobiledevice3 } from "../pymobiledevice3Locate.js";
import {
  buildPymobiledevice3ScreenshotCommand,
  buildSimctlScreenshotCommand,
  defaultScreenshotPath,
  ScreenshotResult,
} from "../screenshot.js";
import {
  buildFfmpegFramesToGifCommands,
  buildFfmpegFramesToVideoCommand,
  buildFfmpegVideoToGifCommands,
  buildPymobiledevice3BurstFrameCommand,
  buildSimctlRecordVideoCommand,
  burstFrameName,
  defaultRecordingPath,
  RecordFormat,
  RecordResult,
} from "../recording.js";
import { locateFfmpeg } from "../ffmpegLocate.js";
import {
  cleanupDir,
  convertVideoToGif,
  runScreenshotBurst,
  runSequential,
  runTimedRecorder,
} from "../recordingRun.js";
import { diagnoseIosInstallFailure } from "../iosInstallFailure.js";
import {
  IOS_POD_DRIFT_SIGNATURES,
  IOS_POD_INSTALL_FAILED_MESSAGE,
  IOS_PROVISIONING_SIGNATURES,
  iosPodInstallEnv,
  isPodDrift,
} from "../iosBuildDiagnostics.js";

/**
 * The neutral system app used to background the app under test. Foregrounding
 * Apple Settings pushes the target app to the background WITHOUT killing it,
 * exercising its `didEnterBackground` lifecycle. This is the mobile equivalent
 * the appliance framework lacked.
 */
export const IOS_BACKGROUND_APP_ID = "com.apple.Preferences";

/**
 * Log signatures that mean an iOS launch failed and polling should stop early.
 *
 * These mirror the intent of the Tizen signatures but match `flutter run`'s iOS
 * output. As on Tizen, transient "waiting" lines must NOT match — only terminal
 * failures. A code-signing / provisioning failure is terminal and common on
 * physical devices, so it is included so the poll fails fast rather than hanging
 * for the full timeout.
 */
export const IOS_FAILURE_SIGNATURES: RegExp[] = [
  /No devices found/i,
  /No supported devices connected/i,
  /Unable to find bundle/i,
  /Could not build the (?:precompiled )?application/i,
  /Error launching application on/i,
  /Xcode build done\..*\n.*Error/i,
  /code sign(?:ing)? error/i,
  /requires a provisioning profile/i,
  /Verify that the Developer App certificate/i,
  /Unable to install/i,
  /flutter: command not found/i,
  // No space left on device is terminal for the full-pipeline install-at-launch —
  // stop polling fast so the deploy's ENOSPC recovery (uninstall + retry) fires.
  /No space left on device/i,
  // CocoaPods sandbox drift is terminal for the full `flutter run` build — it
  // fails before producing a bundle, so stop polling rather than wait the whole
  // timeout. (The deploy preflight fixes this before launch; this is the belt.)
  ...IOS_POD_DRIFT_SIGNATURES,
];

/**
 * Compose the `flutter run` launch and delegate the pty wrapping to
 * {@link buildPtyCaptureCommand} so the Flutter tool sees a pty and line-flushes
 * its VM-service URI (buffered under a plain pipe otherwise). This adapter owns
 * only the `flutter run` invocation; the cross-platform `script`/`/bin/sh -c`
 * wrapping is the shared helper's concern.
 */
export function buildIosPtyLaunchCommand(
  appDir: string,
  udid: string,
  flutterCommand = "flutter",
  platform: NodeJS.Platform = process.platform,
  controlFifoPath?: string
): string {
  // FULL `flutter run` pipeline — deliberately NOT --no-build (learned on-device):
  // the reliable iOS install+launch path is the full pipeline, which builds,
  // SIGNS (Xcode's automatic signing over the app's project), installs, then
  // launches + attaches. Splitting it into `flutter build ios --no-codesign`
  // (unsigned artifact) + `flutter install`/`flutter run --no-build` produced a
  // bad/absent signature and failed at install with a MISLEADING signing error.
  // Letting `flutter run` own the build+sign+install is what worked first-try.
  // --debug keeps the Dart VM service (and its URI) available for Marionette.
  // `udid` MUST be the FLUTTER id (ECID for a physical device), not the
  // devicectl UUID — the latter is not a valid `flutter run -d` target.
  const inner = `${flutterCommand} run --debug -d ${quote(udid)}`;
  return buildPtyCaptureCommand({ inner, cwd: appDir, platform, controlFifoPath });
}

/**
 * The installed app's executable component, as it appears in a devicectl
 * running-process `executable` file URL (`…/Runner.app/Runner`). The iOS Runner
 * target's `CFBundleExecutable`/`PRODUCT_NAME` is `Runner`, so a running Flutter app
 * process's executable path always contains `/Runner.app/`. devicectl's
 * running-process entries carry NO bundle id, only the executable URL, so this
 * is what a pid lookup matches on (see {@link findIosProcessPid}).
 */
export const IOS_APP_EXECUTABLE_MARKER = "/Runner.app/";

/**
 * Shape of `xcrun devicectl device info processes --json-output -`.
 *
 * Verified against devicectl's JSON: the payload wraps the process list under
 * `result.runningProcesses`, each entry carrying an integer `processIdentifier`
 * and an `executable` file URL like
 * `file:///private/var/containers/Bundle/Application/<UUID>/Runner.app/Runner`.
 * There is NO bundle-id field on a process entry, so the app is matched by its
 * executable path. Fields are optional here because we parse defensively — a
 * shape drift must degrade to "no match" (a safe no-op), never throw.
 */
export interface DevicectlProcessInfo {
  result?: {
    runningProcesses?: Array<{
      processIdentifier?: number;
      executable?: string | null;
    }>;
  };
}

/**
 * Resolve the pid of the running app from devicectl's `info processes` JSON.
 *
 * devicectl's `process terminate` requires `--pid` (it does NOT accept
 * `--bundle-identifier`, unlike `process launch`), so terminate on a physical
 * device must look the pid up first. Running-process entries expose only an
 * `executable` file URL (no bundle id), so the match is on the app's executable
 * path component ({@link IOS_APP_EXECUTABLE_MARKER}, `/Runner.app/`). The bundle
 * id is accepted too and matched against the path as a belt-and-suspenders
 * fallback (some installs surface it in the container path). Returns the first
 * matching pid, or `undefined` when the app is not running — the caller treats
 * that as a successful no-op (nothing to terminate).
 */
export function findIosProcessPid(
  json: string,
  opts: { executableMarker?: string; bundleId?: string } = {}
): number | undefined {
  const marker = opts.executableMarker ?? IOS_APP_EXECUTABLE_MARKER;
  let parsed: DevicectlProcessInfo;
  try {
    parsed = JSON.parse(json) as DevicectlProcessInfo;
  } catch {
    return undefined; // Unparseable output → treat as "not running".
  }
  const processes = parsed?.result?.runningProcesses;
  if (!Array.isArray(processes)) return undefined;
  for (const proc of processes) {
    const exe = proc?.executable;
    if (typeof exe !== "string") continue;
    const matchesExecutable = exe.includes(marker);
    const matchesBundle = opts.bundleId ? exe.includes(opts.bundleId) : false;
    if (
      (matchesExecutable || matchesBundle) &&
      typeof proc.processIdentifier === "number"
    ) {
      return proc.processIdentifier;
    }
  }
  return undefined;
}

/** Configuration an IosAdapter needs from the server. */
export interface IosAdapterConfig {
  appDir: string;
  /** Optional pinned device/simulator UDID (env var). */
  device?: string;
  /** The iOS bundle identifier. */
  appId: string;
  /**
   * The flutter invocation to shell (e.g. "flutter" or "fvm flutter"). Optional;
   * defaults to the fvm-aware resolution over {@link IosAdapterConfig.appDir}.
   * Injectable so tests pin it deterministically regardless of the host's fvm.
   */
  flutterCommand?: string;
  /**
   * Locate the `idb` CLI, returning its absolute path or undefined when not
   * found. Optional; defaults to {@link locateIdb} (searches robust locations +
   * FLUTTER_DEVICE_IDB_PATH, re-run per call so a just-installed idb is picked up).
   * Injectable so tests pin idb presence deterministically regardless of the
   * host's real filesystem.
   */
  locateIdb?: () => string | undefined;
  /**
   * Locate the `pymobiledevice3` CLI, returning its absolute path or undefined
   * when not found. Optional; defaults to {@link locatePymobiledevice3} (searches
   * robust locations + FLUTTER_DEVICE_PYMOBILEDEVICE3, re-run per call so a
   * just-installed binary is picked up). Injectable so tests pin its presence
   * deterministically regardless of the host's real filesystem. Used by the
   * PHYSICAL-device screenshot path.
   */
  locatePymobiledevice3?: () => string | undefined;
}

export class IosAdapter implements PlatformAdapter {
  readonly platform: Platform = "ios";

  /** Cached input controller so its selected mode survives across tool calls. */
  private inputController: InputController | undefined;

  /**
   * The kind (device vs simulator) of the most recently resolved target. Cached
   * so lifecycle/uninstall verbs pick the right toolchain (devicectl vs simctl)
   * without re-listing. discoverDevice refreshes it.
   */
  private lastKind: IosDeviceKind = "device";

  /**
   * The most recently resolved target's devicectl id, keyed by its flutter id.
   * discoverDevice returns the FLUTTER id as `target` (the deploy/launch path's
   * id), and the neutral server threads that same string into
   * uninstall/lifecycle. Those verbs need the DEVICECTL id instead, so we cache
   * the flutter→devicectl mapping here and translate at the boundary. This keeps
   * the two-id-space detail inside the adapter, off the neutral seam.
   */
  private devicectlIdByTarget = new Map<string, string>();

  /** Resolved once: `fvm flutter` when the app dir is fvm-managed, else `flutter`. */
  private readonly flutter: string;

  constructor(private readonly config: IosAdapterConfig) {
    this.flutter =
      config.flutterCommand ??
      resolveFlutterCommand({
        fvmManaged: IosAdapter.isFvmManaged(config.appDir),
        fvmAvailable: IosAdapter.hasFvmOnPath(),
      });
  }

  /** True when the app dir carries fvm pinning (`.fvmrc` or `.fvm/`). */
  private static isFvmManaged(appDir: string): boolean {
    return (
      fs.existsSync(path.join(appDir, ".fvmrc")) ||
      fs.existsSync(path.join(appDir, ".fvm"))
    );
  }

  /** True when `fvm` resolves on the login-shell PATH. */
  private static hasFvmOnPath(): boolean {
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      try {
        if (fs.existsSync(path.join(dir, "fvm"))) return true;
      } catch {
        // ignore unreadable PATH entries
      }
    }
    return false;
  }

  /**
   * Translate the flutter id the neutral server threads through into the
   * devicectl id the lifecycle/uninstall verbs must use. Falls back to the id
   * as-given (covers simulators — where the two ids are equal — and a target
   * resolved before caching).
   */
  private devicectlIdFor(target: string): string {
    return this.devicectlIdByTarget.get(target) ?? target;
  }

  get appId(): string {
    return this.config.appId;
  }

  /**
   * Device + environment status: flutter tooling, physical devices (devicectl),
   * and simulators (simctl). Never assumes a device is present — an empty list
   * is a valid "no device connected" result, not an error.
   */
  async info(): Promise<CommandResult> {
    const command = [
      "echo '=== flutter (iOS toolchain) ==='",
      `${this.flutter} --version 2>&1 | head -n 3`,
      "echo '=== xcrun / Xcode ==='",
      "xcrun --version 2>&1 || echo 'xcrun unavailable'",
      "echo '=== physical devices (devicectl) ==='",
      "xcrun devicectl list devices 2>&1 || echo 'devicectl unavailable'",
      "echo '=== simulators (simctl, booted first) ==='",
      "xcrun simctl list devices booted 2>&1 || echo 'simctl unavailable'",
    ].join(" ; ");
    return runShell(command, { cwd: this.config.appDir, timeoutMs: 60000 });
  }

  /**
   * iOS has no `.tizen-target`-style connect step: physical devices attach over
   * USB/Wi-Fi via Xcode and simulators are managed by simctl. Setup reports the
   * discoverable targets so the caller can confirm the device is visible.
   */
  async setup(_opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }> {
    const result = await runShell(
      "xcrun devicectl list devices 2>&1 ; xcrun simctl list devices available 2>&1",
      { cwd: this.config.appDir, timeoutMs: 60000 }
    );
    // Nothing is written on iOS (no target file); wrote is left undefined.
    return { result };
  }

  /**
   * Build the app for iOS via `flutter build`. Flags mirror the appliance build
   * tool where they map: `debug` toggles debug/release; a `simulator` profile
   * builds for the simulator; `skip_flutter` short-circuits to a no-op success
   * (there is no separate Rust engine on the iOS app path — `skip_rust` is
   * accepted for interface parity and ignored).
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    if (opts.skip_flutter) {
      const result: CommandResult = {
        code: 0,
        stdout: "skip_flutter set — reusing existing iOS build artifact.",
        stderr: "",
        combined: "skip_flutter set — reusing existing iOS build artifact.",
        success: true,
        timedOut: false,
      };
      return {
        result,
        enospc: false,
        installFailed: false,
        launchedDisplay: false,
      };
    }

    const forSimulator = opts.profile === "simulator";
    const flags = ["build", forSimulator ? "ios --simulator" : "ios"];
    flags.push(opts.debug ? "--debug" : "--release");
    // `flutter build ios` does not code-sign by default; keep it that way for a
    // plain artifact build (install/run handle signing at deploy time).
    if (!forSimulator) flags.push("--no-codesign");

    const command = `${this.flutter} ${flags.join(" ")}`;
    const result = await runShell(command, {
      cwd: this.config.appDir,
      timeoutMs: 1800000, // 30 min — a clean iOS build can be slow.
    });

    const combined = result.combined;
    // flutter prints the built .app path on success ("Built ... .app").
    const appMatch = combined.match(/Built\s+(\S+\.app)/);
    return {
      result,
      artifactPath: appMatch ? appMatch[1] : undefined,
      enospc: /No space left on device/i.test(combined),
      installFailed:
        /Encountered error/i.test(combined) ||
        /Xcode build done\..*error/is.test(combined),
      launchedDisplay: false,
    };
  }

  /**
   * List and parse the connected physical devices and simulators once. Shared by
   * {@link discoverDevice} (the deploy/lifecycle path, physical-preferred) and the
   * system-prompt path (simulator-preferred), so both see the same device set from
   * the same command outputs.
   */
  private async listTargets(): Promise<{
    physical: ReturnType<typeof mergeFlutterIds>;
    simulators: ReturnType<typeof parseSimctlDevices>;
  }> {
    const [devicesOut, simOut, flutterOut] = await Promise.all([
      runShell("xcrun devicectl list devices 2>/dev/null", {
        timeoutMs: 20000,
      }),
      runShell("xcrun simctl list devices --json 2>/dev/null", {
        timeoutMs: 20000,
      }),
      // The authority for the FLUTTER id (`flutter run -d`) — run via the same
      // fvm-pinned flutter the deploy uses, from the app dir, so the id space
      // (and the visible device set) matches the deploy exactly.
      runShell(`${this.flutter} devices --machine 2>/dev/null`, {
        cwd: this.config.appDir,
        timeoutMs: 30000,
      }),
    ]);
    // Physical devices are filtered to iPhone/iPad (Apple TV excluded) and
    // merged with the flutter ids so the resolved `target` is a valid
    // `flutter run -d` id, while `devicectlId` drives lifecycle/uninstall.
    const physical = mergeFlutterIds(
      parseDevicectlDevices(devicesOut.stdout),
      parseFlutterIosDevices(flutterOut.stdout)
    );
    const simulators = parseSimctlDevices(simOut.stdout);
    return { physical, simulators };
  }

  /**
   * Resolve the iOS target across physical devices (devicectl) and simulators
   * (simctl). A pin self-heals to the first available target with a warning,
   * mirroring the Tizen stale-pin fallback. Throws an McpError when nothing is
   * usable. Records the resolved kind for later devicectl/simctl selection.
   */
  async discoverDevice(
    preference: DeviceTargetPreference = {}
  ): Promise<DeviceResolution> {
    const { physical, simulators } = await this.listTargets();
    const resolution = resolveIosTarget(
      this.config.device,
      physical,
      simulators,
      { kind: preference.kind, udid: preference.udid }
    );
    if (!resolution) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No iOS device or simulator found. Connect an iPhone/iPad (trust the Mac) " +
          "or boot a simulator (xcrun simctl boot <udid>). Set FLUTTER_DEVICE_IOS_DEVICE " +
          "to pin a specific UDID. (Apple TV / tvOS devices are intentionally " +
          "excluded — this adapter targets iPhone/iPad only.)"
      );
    }
    if (resolution.warning) {
      logger.warn("Stale FLUTTER_DEVICE_IOS_DEVICE pin", resolution);
    }
    this.lastKind = resolution.kind;
    // Cache the flutter→devicectl mapping so uninstall/lifecycle (handed the
    // flutter id by the neutral server) can translate to the devicectl id.
    this.rememberDevicectlId(resolution);
    return resolution;
  }

  /** Record the resolved target's flutter→devicectl id mapping for translation. */
  private rememberDevicectlId(resolution: IosDeviceResolution): void {
    if (resolution.devicectlId) {
      this.devicectlIdByTarget.set(resolution.target, resolution.devicectlId);
    }
  }

  /**
   * PREFLIGHT the environment for the full-pipeline launch — it does NOT itself
   * install the app.
   *
   * WHY (learned on-device): the reliable iOS install path is the full
   * `flutter run` pipeline (build + sign + install + launch in one shot), NOT
   * `flutter build ios --no-codesign` + a separate `flutter install` of the
   * unsigned artifact (that failed with a misleading signing error). So the
   * actual install happens in {@link launchAndCaptureUri}; this step instead
   * removes the two blockers that make that pipeline fail cryptically:
   *
   *   1. CocoaPods sandbox drift (common after a branch switch) — detected via a
   *      dry `pod install --deployment` check, and auto-repaired by running
   *      `pod install` with a UTF-8 locale (dodging the Ruby-4.0 homebrew
   *      Encoding::CompatibilityError crash). If `pod install` itself fails, this
   *      returns a FAILURE carrying that as the real blocker (never a misleading
   *      signing hint).
   *   2. First-time device provisioning — a device never registered with the
   *      team is registered + a profile minted by a one-shot provisioning
   *      `xcodebuild` build. Best-effort: a failure here is reported but does not
   *      hard-fail the preflight, because `flutter run`'s own automatic signing
   *      may still succeed.
   *
   * On success returns a synthetic ok result (nothing to install here). On a
   * blocking failure returns the failing CommandResult so the deploy handler
   * surfaces it + its diagnostic ({@link installFailureDiagnostic}).
   */
  async install(_device: string, _opts: InstallOptions): Promise<CommandResult> {
    // Simulators don't use CocoaPods signing/provisioning the same way and
    // `flutter run` handles them cleanly, so the preflight is a device-only
    // concern. On a simulator, report a clean no-op success.
    if (this.lastKind === "simulator") {
      return IosAdapter.okPreflight(
        "Simulator target — no pod/provisioning preflight needed; the full " +
          "flutter run pipeline installs + launches."
      );
    }

    const pods = await this.preparePods();
    if (!pods.success) return pods;

    // Provisioning is handled REACTIVELY (see recoverLaunchFailure): the slow
    // one-shot provisioning xcodebuild runs only when a launch actually fails on
    // provisioning, so the happy path stays fast. Nothing to do here beyond pods.
    return IosAdapter.okPreflight(pods.stdout);
  }

  /**
   * Detect + repair CocoaPods sandbox drift for the iOS Runner project.
   *
   * A dry `pod install --deployment` (from the app's `ios/`) fails fast and
   * non-destructively when `Pods/` is out of sync with `Podfile.lock`. On drift
   * (or any failure whose output carries the drift signature), we run a real
   * `pod install` with a UTF-8 locale ({@link iosPodInstallEnv}) to fix it. If
   * that real install fails, the returned result is a FAILURE carrying
   * {@link IOS_POD_INSTALL_FAILED_MESSAGE}'s cause — this is the true blocker, so
   * it must not be masked by the downstream signing diagnostic.
   */
  private async preparePods(): Promise<CommandResult> {
    const iosDir = path.join(this.config.appDir, "ios");
    // No CocoaPods project (unusual, but be defensive) → nothing to preflight.
    if (!fs.existsSync(path.join(iosDir, "Podfile"))) {
      return IosAdapter.okPreflight("No ios/Podfile — skipped pod preflight.");
    }

    // Cheap, non-destructive drift check: --deployment makes pod refuse to
    // mutate the lockfile and exit non-zero when the sandbox is out of sync.
    const check = await runShell("pod install --deployment 2>&1", {
      cwd: iosDir,
      timeoutMs: 300000,
    });
    if (check.success || !isPodDrift(check.combined)) {
      // Either in sync, or a failure unrelated to drift (leave it to the build's
      // own signatures — don't run a mutating install for an unrelated error).
      return IosAdapter.okPreflight(
        check.success
          ? "CocoaPods sandbox in sync."
          : "Pod check did not indicate sandbox drift; skipped pod install."
      );
    }

    // Drift confirmed → repair with a UTF-8-locale `pod install`.
    logger.warn("CocoaPods sandbox drift detected — running pod install", {
      iosDir,
    });
    const install = await runShell("pod install 2>&1", {
      cwd: iosDir,
      timeoutMs: 600000,
      env: iosPodInstallEnv,
    });
    if (!install.success) {
      return {
        ...install,
        // Surface the real blocker; the deploy handler pairs this with the
        // pod-install diagnostic instead of the misleading signing one.
        combined: `${IOS_POD_INSTALL_FAILED_MESSAGE}\n${install.combined}`,
      };
    }
    return IosAdapter.okPreflight(
      "Repaired CocoaPods sandbox drift via UTF-8-locale pod install."
    );
  }

  /**
   * Reactive first-time-provisioning fallback: run the one-shot
   * provisioning-updating `xcodebuild` build to register the device + mint the
   * profile, then the caller retries the launch. Invoked ONLY after a launch
   * failed with a provisioning signature, so the slow xcodebuild never runs on
   * the happy path.
   *
   * `device` is the FLUTTER id; xcodebuild's `-destination "platform=iOS,id=…"`
   * needs the raw hardware UDID (the devicectl id), so translate.
   */
  async provisioningFallback(device: string): Promise<CommandResult> {
    const hwUdid = this.devicectlIdFor(device);
    const workspace = path.join(this.config.appDir, "ios", "Runner.xcworkspace");
    const command =
      `xcodebuild -workspace ${quote(workspace)} -scheme Runner ` +
      `-configuration Debug ` +
      `-destination ${quote(`platform=iOS,id=${hwUdid}`)} ` +
      `-allowProvisioningUpdates -allowProvisioningDeviceRegistration build`;
    logger.warn("Running one-shot provisioning xcodebuild fallback", {
      hwUdid,
    });
    return runShell(command, {
      cwd: this.config.appDir,
      timeoutMs: 1800000, // a provisioning build can be slow.
    });
  }

  /** True when a captured launch output signals a provisioning failure. */
  isProvisioningFailure(combined: string): boolean {
    return IOS_PROVISIONING_SIGNATURES.some((re) => re.test(combined));
  }

  /**
   * Reactive launch-failure recovery (the {@link PlatformAdapter} seam).
   *
   * Because the iOS deploy installs at LAUNCH time (the full `flutter run`
   * pipeline), the two recoverable install-time failures are handled here rather
   * than at the install stage:
   *
   *   - ENOSPC ("No space left on device"): uninstall the app to free space, then
   *     retry the launch once — the mobile equivalent of the Tizen ENOSPC guard.
   *   - PROVISIONING/device-registration: run the one-shot provisioning
   *     `xcodebuild` to register the device + mint the profile, then retry.
   *
   * A simulator never hits provisioning; any other failure is not recovered.
   */
  async recoverLaunchFailure(
    device: string,
    logTail: string
  ): Promise<{ recovered: boolean; note?: string }> {
    // ENOSPC: free space by uninstalling, then retry (both device kinds).
    if (/No space left on device/i.test(logTail)) {
      await this.uninstall(device, this.appId);
      return {
        recovered: true,
        note: "Device was out of space — uninstalled the app to free space; retrying the launch.",
      };
    }

    if (this.lastKind === "simulator") return { recovered: false };
    if (!this.isProvisioningFailure(logTail)) return { recovered: false };
    const build = await this.provisioningFallback(device);
    return build.success
      ? {
          recovered: true,
          note:
            "Registered the device + minted a provisioning profile via a " +
            "one-shot provisioning xcodebuild; retrying the launch.",
        }
      : {
          recovered: false,
          note:
            "Provisioning xcodebuild fallback failed. Open ios/Runner.xcworkspace " +
            "in Xcode, select your team + this device, and run Product▸Run once to " +
            "register/sign, then redeploy.",
        };
  }

  /** A synthetic successful preflight CommandResult carrying a note. */
  private static okPreflight(note: string): CommandResult {
    return {
      code: 0,
      stdout: note,
      stderr: "",
      combined: note,
      success: true,
      timedOut: false,
    };
  }

  /**
   * Turn an iOS build/install failure into an actionable message (else null).
   * Now classifies pod-drift / provisioning / enospc BEFORE the unsigned-bundle
   * hint so the deploy never leads with a misleading signing message when the
   * real cause was pod-sandbox drift or an unregistered device. See
   * {@link diagnoseIosInstallFailure}.
   */
  installFailureDiagnostic(combined: string): string | null {
    return diagnoseIosInstallFailure(combined);
  }

  /**
   * Launch through a pty and capture the Dart VM Service URI — the mobile
   * equivalent of the Tizen deploy's URI capture, feeding the SAME neutral core
   * the iOS `flutter run` command + iOS failure signatures.
   */
  async launchAndCaptureUri(
    device: string,
    timeoutMs: number
  ): Promise<LaunchOutcome> {
    // Allocate a durable control FIFO so flutter_hot_reload/flutter_hot_restart
    // can drive `r`/`R` on this running daemon over the flutter tool's own stdin
    // (the authoritative reload/restart path). Undefined when mkfifo is
    // unavailable — the launch still proceeds; reload falls back to the VM service.
    const controlFifoPath = allocateControlFifo();
    // `device` is the FLUTTER id — the only id `flutter run -d` accepts.
    const command = buildIosPtyLaunchCommand(
      this.config.appDir,
      device,
      this.flutter,
      process.platform,
      controlFifoPath
    );
    return neutralLaunchAndCaptureUri(
      command,
      this.config.appDir,
      timeoutMs,
      IOS_FAILURE_SIGNATURES,
      controlFifoPath
    );
  }

  /**
   * Uninstall the app to free space / reset state. devicectl for a physical
   * device, simctl for a simulator — chosen from the last resolved kind.
   */
  async uninstall(device: string, appId: string): Promise<CommandResult> {
    // `device` is the flutter id; devicectl needs its own id (simctl reuses the
    // same UUID, so the translation is a no-op there).
    const ctlId = this.devicectlIdFor(device);
    const command =
      this.lastKind === "simulator"
        ? `xcrun simctl uninstall ${quote(ctlId)} ${quote(appId)}`
        : `xcrun devicectl device uninstall app --device ${quote(ctlId)} ${quote(appId)}`;
    return runShell(command, { timeoutMs: 120000 });
  }

  /**
   * Kill leftover launch drivers that would hold the device/URI or wedge a
   * subsequent deploy: the `flutter run` process and the Dart frontend/analysis
   * servers it spawns. Mirrors the Tizen "one deploy at a time" guardrail.
   */
  async killStale(): Promise<Record<string, CommandResult>> {
    // Match on the flutter-run subcommand regardless of the launcher prefix
    // (`flutter run` or `fvm flutter run`) so an fvm-wrapped launch is caught.
    const flutterRun = await runShell(`pkill -f ${quote("flutter run")}`, {
      timeoutMs: 10000,
    });
    const frontendServer = await runShell(
      `pkill -f ${quote("frontend_server")}`,
      { timeoutMs: 10000 }
    );
    return { flutterRun, frontendServer };
  }

  /**
   * OS-level lifecycle: terminate, background (foreground a neutral system app),
   * and foreground (relaunch the target). devicectl vs simctl is chosen from the
   * last resolved device kind. This is the appliance framework's key mobile gap.
   */
  readonly lifecycle: AppLifecycle = {
    // `device` is the flutter id threaded through by the neutral server; every
    // verb here drives devicectl/simctl, which need the devicectl id.
    terminate: (device, appId) => this.terminate(device, appId),
    background: (device) => {
      // Foreground the neutral system app; the app under test drops to the
      // background WITHOUT being killed (exercises didEnterBackground).
      const ctlId = this.devicectlIdFor(device);
      const command =
        this.lastKind === "simulator"
          ? `xcrun simctl launch ${quote(ctlId)} ${quote(IOS_BACKGROUND_APP_ID)}`
          : `xcrun devicectl device process launch --device ${quote(ctlId)} ${quote(IOS_BACKGROUND_APP_ID)}`;
      return runShell(command, { timeoutMs: 60000 });
    },
    foreground: (device, appId) => {
      const ctlId = this.devicectlIdFor(device);
      const command =
        this.lastKind === "simulator"
          ? `xcrun simctl launch ${quote(ctlId)} ${quote(appId)}`
          : `xcrun devicectl device process launch --device ${quote(ctlId)} ${quote(appId)}`;
      return runShell(command, { timeoutMs: 60000 });
    },
  };

  /**
   * System-prompt control over idb. Reads the SpringBoard accessibility tree
   * (`idb ui describe-all`) to detect an OS-level alert/permission/"Open in app"
   * prompt outside the Flutter view, and taps a button by label
   * (`idb ui tap <x> <y>` at the element's frame center) — the unblock
   * Marionette cannot perform because these prompts never reach the Dart VM.
   *
   * SIMULATOR-ONLY (verified live): `idb ui *` require the FBSimulatorLifecycle
   * protocol, which a physical device does not conform to (it returns "Target
   * doesn't conform to FBSimulatorLifecycleCommands protocol"). So this controller
   * resolves its own target preferring a booted simulator, and reports a
   * structured simulator-only note when only a physical device is available. When
   * idb is not installed the result reports `present: false` with an actionable
   * note to `brew install idb-companion` + `pip install fb-idb` rather than
   * throwing.
   */
  readonly systemPrompt: SystemPromptController = {
    handle: (action, buttonLabel, udid) =>
      this.handleSystemPrompt(action, buttonLabel, udid),
  };

  /**
   * Locate the `idb` CLI FRESH on every call (never cached), searching robust
   * install locations + honoring `FLUTTER_DEVICE_IDB_PATH`. Caching was the live bug:
   * an idb installed after server start never took effect. Returns the absolute
   * path to shell, or undefined when idb is not found. See {@link locateIdb}.
   */
  private idbBinary(): string | undefined {
    return (this.config.locateIdb ?? locateIdb)();
  }

  /**
   * Locate the `pymobiledevice3` CLI FRESH on every call (never cached), so a
   * binary installed after server start is picked up on the next tool call
   * (same rationale as {@link idbBinary}). Returns the absolute path to shell, or
   * undefined when not found. See {@link locatePymobiledevice3}.
   */
  private pymobiledevice3Binary(): string | undefined {
    return (this.config.locatePymobiledevice3 ?? locatePymobiledevice3)();
  }

  /**
   * Resolve the SIMULATOR to target for system-prompt handling.
   *
   * An explicit `udid` is honored as-is (the caller opted in — it may be a booted
   * sim the lists missed). Otherwise a booted simulator is preferred, then any
   * listed simulator. When NO simulator exists but a physical device does, returns
   * a structured `physicalOnly` marker so the caller emits a clear simulator-only
   * note instead of driving idb against a device (which fails the FBSimulator
   * protocol check). Returns `{}` when nothing usable is connected.
   */
  private async resolveSimulatorUdid(
    explicitUdid?: string
  ): Promise<{ udid?: string; physicalOnly?: boolean }> {
    if (explicitUdid && explicitUdid.trim().length > 0) {
      return { udid: explicitUdid.trim() };
    }
    const { physical, simulators } = await this.listTargets();
    const booted = simulators.find((s) => s.available);
    const anySim = booted ?? simulators[0];
    if (anySim) return { udid: anySim.udid };
    if (physical.length > 0) return { physicalOnly: true };
    return {};
  }

  /**
   * Detect/tap/dismiss a system prompt via idb, on a SIMULATOR. Resolves the
   * simulator target itself (booted-first) unless an explicit `udid` is given.
   * Every expected non-happy condition (idb missing, no simulator, physical-only,
   * no prompt, no matching button) returns a structured result with a note —
   * never a throw.
   */
  private async handleSystemPrompt(
    action: SystemPromptAction,
    buttonLabel?: string,
    explicitUdid?: string
  ): Promise<SystemPromptResult> {
    const idb = this.idbBinary();
    if (!idb) {
      return {
        present: false,
        messages: [],
        buttons: [],
        note:
          "idb was not found, so system prompts cannot be read/tapped. Install BOTH " +
          "the companion daemon and the CLI: `brew install idb-companion` and " +
          "`pip install fb-idb` (or `pipx install fb-idb`) — this tool shells the " +
          "`idb` CLI (`idb ui describe-all`/`idb ui tap`), which talks to " +
          "idb_companion. If idb IS installed but not on the server's PATH, set " +
          "FLUTTER_DEVICE_IDB_PATH to the absolute path of the `idb` binary " +
          "(e.g. /opt/homebrew/bin/idb). idb drives SIMULATORS and needs no macOS " +
          "Accessibility grant (unlike AppleScript UI-scripting).",
      };
    }

    const { udid, physicalOnly } = await this.resolveSimulatorUdid(explicitUdid);
    if (physicalOnly) {
      return {
        present: false,
        messages: [],
        buttons: [],
        note:
          "System-prompt handling via idb is SIMULATOR-ONLY: `idb ui describe-all`/" +
          "`idb ui tap` require the FBSimulatorLifecycle protocol, which a physical " +
          "device does not conform to (idb returns \"Target doesn't conform to " +
          'FBSimulatorLifecycleCommands protocol"). Only a physical iOS device is ' +
          "currently connected. Boot a simulator (`xcrun simctl boot <udid>`) and " +
          "retry, or pass an explicit simulator `udid`. NOTE: on a real device a " +
          "valid AASA usually opens the app directly (no 'Open in app' prompt), so " +
          "this path is primarily a simulator/Safari-navigation need.",
      };
    }
    if (!udid) {
      return {
        present: false,
        messages: [],
        buttons: [],
        note:
          "No iOS simulator found for system-prompt handling. Boot one with " +
          "`xcrun simctl boot <udid>` (then `open -a Simulator`) and retry, or pass " +
          "an explicit simulator `udid`.",
      };
    }
    const described = await runShell(
      `${quote(idb)} ui describe-all --udid ${quote(udid)} --json`,
      { timeoutMs: 30000 }
    );
    if (!described.success) {
      return {
        present: false,
        messages: [],
        buttons: [],
        note:
          "idb ui describe-all failed. Ensure idb_companion targets this SIMULATOR " +
          "(idb list-targets) and that it is booted — idb ui is simulator-only, so a " +
          `physical-device target will fail here. Output: ${tail(
            described.combined,
            20
          )}`,
      };
    }
    const elements = parseAxElements(described.stdout);
    const prompt = detectSystemPrompt(elements);
    const buttons = prompt.buttons.map((b) => b.label);

    if (action === "detect" || !prompt.present) {
      return {
        present: prompt.present,
        messages: prompt.messages,
        buttons,
        note: prompt.present
          ? undefined
          : "No system prompt detected on screen.",
      };
    }

    const chosen = chooseButton(prompt, action === "tap" ? buttonLabel : undefined);
    if (!chosen) {
      return {
        present: true,
        messages: prompt.messages,
        buttons,
        note:
          action === "tap"
            ? `No button matching ${JSON.stringify(buttonLabel)} on the prompt. ` +
              `Available: ${buttons.join(", ") || "(none)"}.`
            : "The prompt exposed no tappable button to dismiss.",
      };
    }

    const tap = await runShell(
      `${quote(idb)} ui tap --udid ${quote(udid)} ${chosen.center.x} ${chosen.center.y}`,
      { timeoutMs: 20000 }
    );
    return {
      present: true,
      messages: prompt.messages,
      buttons,
      tapped: tap.success ? chosen.label : undefined,
      tappedAt: tap.success ? chosen.center : undefined,
      note: tap.success
        ? undefined
        : `idb ui tap failed at (${chosen.center.x}, ${chosen.center.y}): ${tail(
            tap.combined,
            20
          )}`,
    };
  }

  /**
   * Terminate the running app.
   *
   * Simulator (simctl): `simctl terminate <udid> <bundleId>` — simctl DOES
   * terminate by bundle id.
   *
   * Physical device (devicectl): devicectl's `process terminate` requires
   * `--pid` and does NOT accept `--bundle-identifier` (unlike `process launch`),
   * so we first resolve the running app's pid from
   * `devicectl device info processes` (matching the app's executable path — the
   * process list carries no bundle id), then terminate by pid. If no matching
   * process is found the app is not running, so termination is a successful
   * no-op (never an error).
   */
  private async terminate(
    device: string,
    appId: string
  ): Promise<CommandResult> {
    const ctlId = this.devicectlIdFor(device);
    if (this.lastKind === "simulator") {
      return runShell(
        `xcrun simctl terminate ${quote(ctlId)} ${quote(appId)}`,
        { timeoutMs: 60000 }
      );
    }
    // Physical device: resolve the pid, then terminate by pid.
    const processes = await runShell(
      `xcrun devicectl device info processes --device ${quote(ctlId)} --json-output -`,
      { timeoutMs: 60000 }
    );
    const pid = findIosProcessPid(processes.stdout, { bundleId: appId });
    if (pid === undefined) {
      // App not running — nothing to terminate. Return a synthetic success so
      // the neutral server reports a clean no-op rather than a failure.
      const message = `No running process for ${appId} on ${ctlId}; nothing to terminate.`;
      return {
        code: 0,
        stdout: message,
        stderr: "",
        combined: message,
        success: true,
        timedOut: false,
      };
    }
    return runShell(
      `xcrun devicectl device process terminate --device ${quote(ctlId)} --pid ${pid}`,
      { timeoutMs: 60000 }
    );
  }

  /**
   * Capture the current screen.
   *
   * SIMULATOR: `xcrun simctl io <udid> screenshot <path>` — reliable, the
   * primary iOS screenshot path. Resolves the simulator target itself
   * (booted-first), so a walkthrough can screenshot the sim without an env pin.
   *
   * PHYSICAL device: `pymobiledevice3 developer dvt screenshot <path>` (verified
   * live on iOS 18.7) — it writes a real PNG over a no-root userspace tunnel on
   * iOS 17+ (no sudo), relying on the Developer Disk Image being mounted (Xcode
   * auto-mounts it). This supersedes the earlier dead ends (`idevicescreenshot`
   * needs the DDI's screenshotr service; `xcrun devicectl` has no screenshot
   * subcommand). Only when `pymobiledevice3` is NOT installed does this degrade to
   * a structured `{ supported: false }` with an install hint — the binary being
   * absent is not a hard failure. Marionette's take_screenshots over the VM
   * service remains an alternative for the FLUTTER view specifically.
   */
  async screenshot(opts: {
    outPath?: string;
    includeBase64?: boolean;
  }): Promise<ScreenshotResult> {
    const { udid, physicalOnly } = await this.resolveSimulatorUdid();
    // Only a physical iOS device is connected → use the pymobiledevice3 path.
    if (physicalOnly) {
      return this.screenshotPhysicalDevice(opts);
    }
    if (!udid) {
      return {
        captured: false,
        supported: false,
        reason:
          "No iOS simulator found to screenshot. Boot one with `xcrun simctl boot <udid>` " +
          "(then `open -a Simulator`) and retry.",
        hint: "Use a simulator for screenshot walkthroughs.",
      };
    }
    const outPath = opts.outPath ?? defaultScreenshotPath("ios");
    const result = await runShell(
      buildSimctlScreenshotCommand(udid, outPath),
      { timeoutMs: 30000 }
    );
    if (!result.success || !fs.existsSync(outPath)) {
      return {
        captured: false,
        reason: `simctl screenshot failed: ${tail(result.combined, 20)}`,
      };
    }
    return {
      captured: true,
      savedPath: outPath,
      base64: opts.includeBase64
        ? fs.readFileSync(outPath).toString("base64")
        : undefined,
    };
  }

  /**
   * Capture a PHYSICAL device's screen via `pymobiledevice3 developer dvt
   * screenshot`. Locates the CLI fresh (a GUI-launched server's PATH may omit
   * pipx/Homebrew bins); when it is absent this returns `{ supported: false }`
   * with an install hint rather than hard-failing. The device UDID (its flutter
   * id / ECID — what lockdown/pymobiledevice3 address by) is threaded through as
   * `--udid` so the right device is targeted when more than one is attached.
   */
  private async screenshotPhysicalDevice(opts: {
    outPath?: string;
    includeBase64?: boolean;
  }): Promise<ScreenshotResult> {
    const binary = this.pymobiledevice3Binary();
    if (!binary) {
      return {
        captured: false,
        supported: false,
        reason:
          "A physical iOS device is connected but `pymobiledevice3` was not found, so its " +
          "screen cannot be captured. (pymobiledevice3 is the working physical-device path: " +
          "`idevicescreenshot` needs the Developer Disk Image's screenshotr service and " +
          "`xcrun devicectl` has no screenshot subcommand.)",
        hint:
          "Install pymobiledevice3, e.g. `pipx install pymobiledevice3` (or a venv: " +
          "`python3 -m venv <dir> && <dir>/bin/pip install pymobiledevice3`). If it IS installed " +
          "but not on the server's PATH, set FLUTTER_DEVICE_PYMOBILEDEVICE3 to the absolute path of the " +
          "binary. The Developer Disk Image must be mounted (Xcode mounts it automatically). " +
          "Marionette take_screenshots over the VM service is an alternative for the Flutter view.",
      };
    }
    // The device UDID is its flutter id / ECID (what pymobiledevice3 addresses
    // by). Resolve the physical target so multi-device hosts get the right one.
    const udid = await this.resolvePhysicalUdid();
    const outPath = opts.outPath ?? defaultScreenshotPath("ios");
    const result = await runShell(
      buildPymobiledevice3ScreenshotCommand(binary, outPath, udid),
      { timeoutMs: 60000 }
    );
    if (!result.success || !fs.existsSync(outPath)) {
      return {
        captured: false,
        reason:
          `pymobiledevice3 screenshot failed: ${tail(result.combined, 30)}`,
        hint:
          "Ensure the Developer Disk Image is mounted (open the app once from Xcode, or run " +
          "`pymobiledevice3 mounter auto-mount`) and that the device is trusted/unlocked.",
      };
    }
    return {
      captured: true,
      savedPath: outPath,
      base64: opts.includeBase64
        ? fs.readFileSync(outPath).toString("base64")
        : undefined,
    };
  }

  /**
   * Record a bounded screen clip.
   *
   * SIMULATOR: `xcrun simctl io <udid> recordVideo` — native mp4, stopped by
   * SIGINT to the spawned process at `durationSeconds`. (NB: the app
   * currently crashes on the iOS simulator due to shaders —  — so this
   * path is generically correct but not yet usable for the app's own screens.)
   *
   * PHYSICAL device: no native recorder exists (pymobiledevice3 dvt has only
   * `screenshot`, devicectl has none), so this captures a screenshot BURST and
   * assembles it with ffmpeg. The device's ~0.3–1s screenshot latency caps the
   * REAL rate at ~1–3 fps, so the clip is choppy — this is a documented tradeoff,
   * not a bug. Requires ffmpeg; absent ffmpeg (or pymobiledevice3) it returns
   * `{ supported: false }`.
   *
   * `gif` always needs ffmpeg (native recorders emit mp4 only).
   */
  async record(opts: {
    outPath?: string;
    durationSeconds: number;
    fps: number;
    format: RecordFormat;
    deviceUdid?: string;
  }): Promise<RecordResult> {
    const { udid, physicalOnly } = await this.resolveSimulatorUdid(
      opts.deviceUdid
    );
    if (physicalOnly) {
      return this.recordPhysicalDevice(opts);
    }
    if (!udid) {
      return {
        recorded: false,
        supported: false,
        reason:
          "No iOS simulator found to record. Boot one with `xcrun simctl boot <udid>` " +
          "(then `open -a Simulator`) and retry.",
        hint: "Use a simulator for recording walkthroughs.",
      };
    }

    const wantGif = opts.format === "gif";
    const ffmpeg = wantGif ? locateFfmpeg() : undefined;
    if (wantGif && !ffmpeg) {
      return {
        recorded: false,
        supported: false,
        reason:
          "A gif was requested but `ffmpeg` was not found. The simulator records a native mp4 " +
          "with no ffmpeg; only the gif conversion needs it.",
        hint:
          "Install ffmpeg (`brew install ffmpeg`), or set FLUTTER_DEVICE_FFMPEG to its absolute path. " +
          "Request format 'mp4' to record without ffmpeg.",
      };
    }

    const duration = Math.max(1, opts.durationSeconds);
    const mp4Path = wantGif
      ? defaultRecordingPath("ios", "mp4")
      : opts.outPath ?? defaultRecordingPath("ios", "mp4");

    const run = await runTimedRecorder({
      command: buildSimctlRecordVideoCommand(udid, mp4Path),
      durationSeconds: duration,
      // recordVideo owns the capture and flushes on SIGINT to itself.
      stop: (child) => {
        child.kill("SIGINT");
      },
    });

    if (!fs.existsSync(mp4Path)) {
      return {
        recorded: false,
        reason: `simctl recordVideo produced no file: ${tail(run.output, 20)}`,
      };
    }

    if (!wantGif) {
      return {
        recorded: true,
        savedPath: mp4Path,
        format: "mp4",
        durationSeconds: duration,
      };
    }

    const gifPath = opts.outPath ?? defaultRecordingPath("ios", "gif");
    const ok = await convertVideoToGif({
      ffmpeg: ffmpeg as string,
      videoPath: mp4Path,
      fps: opts.fps,
      outPath: gifPath,
      buildCommands: buildFfmpegVideoToGifCommands,
    });
    if (!ok) {
      return { recorded: false, reason: "ffmpeg mp4→gif conversion failed." };
    }
    return {
      recorded: true,
      savedPath: gifPath,
      format: "gif",
      durationSeconds: duration,
    };
  }

  /**
   * Record a PHYSICAL device by BURST screenshots → ffmpeg assemble (the only
   * path — iOS hardware has no native recorder). Needs BOTH pymobiledevice3 (to
   * grab frames) and ffmpeg (to assemble); either missing → `{ supported: false }`
   * with an install hint. The achievable frame rate is well under `fps` because a
   * single dvt screenshot takes ~0.3–1s, so the returned `frameCount` reflects the
   * REAL (choppy) capture and a `note` states the caveat.
   */
  private async recordPhysicalDevice(opts: {
    outPath?: string;
    durationSeconds: number;
    fps: number;
    format: RecordFormat;
  }): Promise<RecordResult> {
    const binary = this.pymobiledevice3Binary();
    const ffmpeg = locateFfmpeg();
    if (!binary || !ffmpeg) {
      const missing = [
        !binary ? "pymobiledevice3 (to capture frames)" : null,
        !ffmpeg ? "ffmpeg (to assemble the clip)" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      return {
        recorded: false,
        supported: false,
        reason:
          `A physical iOS device has no native screen recorder, so recording uses a screenshot ` +
          `BURST assembled with ffmpeg — but ${missing} was not found.`,
        hint:
          "Install pymobiledevice3 (`pipx install pymobiledevice3`) and ffmpeg (`brew install " +
          "ffmpeg`); override paths with FLUTTER_DEVICE_PYMOBILEDEVICE3 / FLUTTER_DEVICE_FFMPEG. " +
          "Marionette take_screenshots over the VM service is an alternative for the Flutter view.",
      };
    }

    const duration = Math.max(1, opts.durationSeconds);
    const fps = Math.max(1, opts.fps);
    const udid = await this.resolvePhysicalUdid();

    const { framesDir, frameCount } = await runScreenshotBurst({
      fps,
      durationSeconds: duration,
      frameName: burstFrameName,
      captureFrame: async (framePath) => {
        const result = await runShell(
          buildPymobiledevice3BurstFrameCommand(binary, framePath, udid),
          { timeoutMs: 15000 }
        );
        return result.success && fs.existsSync(framePath);
      },
    });

    if (frameCount === 0) {
      cleanupDir(framesDir);
      return {
        recorded: false,
        reason:
          "No frames were captured from the physical device. Ensure it is trusted/unlocked and " +
          "the Developer Disk Image is mounted (open the app once from Xcode).",
      };
    }

    const wantGif = opts.format === "gif";
    const outPath =
      opts.outPath ?? defaultRecordingPath("ios", wantGif ? "gif" : "mp4");
    const note =
      `Physical-device recording is a screenshot burst (no native recorder): captured ` +
      `${frameCount} frames over ${duration}s (~${(frameCount / duration).toFixed(1)} fps ` +
      `effective). The clip is choppy — this is expected on iOS hardware.`;

    let ok: boolean;
    if (wantGif) {
      const palettePath = path.join(
        os.tmpdir(),
        `flutter-device-mcp-palette-${Date.now()}.png`
      );
      const [gen, use] = buildFfmpegFramesToGifCommands(
        ffmpeg,
        framesDir,
        fps,
        outPath,
        palettePath
      );
      const result = await runSequential([gen, use]);
      ok = result.ok && fs.existsSync(outPath);
      try {
        if (fs.existsSync(palettePath)) fs.rmSync(palettePath);
      } catch {
        // best-effort
      }
    } else {
      const cmd = buildFfmpegFramesToVideoCommand(
        ffmpeg,
        framesDir,
        fps,
        outPath
      );
      const result = await runShell(cmd, { timeoutMs: 120000 });
      ok = result.success && fs.existsSync(outPath);
    }
    cleanupDir(framesDir);

    if (!ok) {
      return { recorded: false, reason: "ffmpeg assembly of burst frames failed." };
    }
    return {
      recorded: true,
      savedPath: outPath,
      format: wantGif ? "gif" : "mp4",
      durationSeconds: duration,
      frameCount,
      note,
    };
  }

  /**
   * Resolve the connected PHYSICAL device's UDID for `pymobiledevice3 --udid`.
   *
   * Returns the resolved target's flutter id (ECID for a physical device — the
   * id lockdown/pymobiledevice3 address by). Returns undefined when a physical
   * device cannot be resolved (the caller then omits `--udid`, relying on the
   * single-device assumption). Never throws — a screenshot is best-effort.
   */
  private async resolvePhysicalUdid(): Promise<string | undefined> {
    try {
      const { physical } = await this.listTargets();
      const chosen = physical.find((d) => d.available) ?? physical[0];
      return chosen?.udid;
    } catch {
      return undefined;
    }
  }

  /**
   * iOS input controller. In-app taps/gestures are Marionette's job over the VM
   * service, so this MCP does not drive them; and a touch device has no free
   * cursor. Every send therefore reports unsupported (move/scroll throw
   * {@link UnsupportedInputError}, surfaced by the server as `{supported:false}`).
   * `mode` is tracked to satisfy the neutral interface shape.
   */
  input(): InputController {
    if (!this.inputController) {
      this.inputController = new IosInputStub();
    }
    return this.inputController;
  }
}

/**
 * iOS input stub: physical-remote/cursor input is not the iOS driving model.
 * Navigation and taps are performed by Marionette over the Dart VM service, so
 * this controller intentionally reports every input path as unsupported rather
 * than duplicating Marionette. `mode` is tracked only for interface parity.
 */
class IosInputStub implements InputController {
  readonly platform: Platform = "ios";
  private _mode: InputMode = "dpad";
  get mode(): InputMode {
    return this._mode;
  }
  setMode(mode: InputMode): void {
    this._mode = mode;
  }
  async key(): Promise<void> {
    throw new UnsupportedInputError(
      "Remote/D-pad keys have no meaning on iOS. Drive the app with Marionette " +
        "(tap/enter_text/scroll) over the Dart VM service instead."
    );
  }
  async pointerMove(): Promise<void> {
    throw new UnsupportedInputError(
      "Free-cursor pointer move is unsupported on iOS (a touch device has no " +
        "cursor). Use Marionette tap-by-coordinate/element over the VM service."
    );
  }
  async pointerClick(): Promise<void> {
    throw new UnsupportedInputError(
      "Pointer click is unsupported on iOS. Use Marionette tap over the VM service."
    );
  }
  async pointerScroll(): Promise<void> {
    throw new UnsupportedInputError(
      "Free-cursor scroll is unsupported on iOS. Use Marionette scroll/swipe " +
        "over the VM service."
    );
  }
}
