/**
 * Android platform adapter.
 *
 * Drives a Flutter app on Android behind the neutral
 * {@link PlatformAdapter} seam — the mobile counterpart of {@link IosAdapter}.
 * Where iOS drives `xcrun devicectl`/`simctl` + flutter, Android drives the
 * standard mobile toolchain:
 *   - `adb` for device listing, uninstall, and OS-level lifecycle, and
 *   - `flutter` for builds and for the launch-that-captures-the-VM-service-URI.
 *
 * The launch reuses the SAME neutral launch core the iOS/Tizen adapters use: it
 * feeds `flutter run` (pty-wrapped so it line-flushes the "Dart VM Service ...
 * available at:" line) + Android failure signatures into
 * {@link neutralLaunchAndCaptureUri}. `flutter run` handles the adb install, the
 * VM-service port-forward, AND printing the URI, so the deploy is a single
 * `flutter run --profile -d <serial>` — left running to hold the VM service open
 * for Marionette, exactly like iOS.
 *
 * KEY SIMPLIFICATION vs iOS: the adb serial IS flutter's device id, so a
 * resolved target is a SINGLE id used by every verb (no ECID-vs-devicectl-UUID
 * translation layer). See {@link androidDeviceTarget}.
 *
 * SCOPE: OS-level device control only. In-app gestures/taps are driven by the
 * separate Marionette MCP over the Dart VM service and are NOT reimplemented
 * here — so the input controller reports `{ supported: false }` for key/pointer,
 * mirroring the iOS adapter. (FUTURE: adb `input tap`/`input keyevent` could back
 * a real key/pointer path if a non-Marionette input plane is ever wanted; it is
 * intentionally omitted for v1.)
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import {
  CommandResult,
  quote,
  resolveFlutterCommand,
  runShell,
  tail,
} from "../cli.js";
import {
  androidOpenUrlFailure,
  buildAdbOpenUrlCommand,
  invalidOpenUrlReason,
  OpenUrlResult,
} from "../openUrl.js";
import {
  allocateControlChannel,
  buildPtyCaptureCommand,
  ControlChannel,
  launchAndCaptureUri as neutralLaunchAndCaptureUri,
} from "../launchCapture.js";
import { logger } from "../logger.js";
import { resolveAndroidTarget } from "../androidDeviceTarget.js";
import {
  AndroidLaunchMode,
  ANDROID_DEFAULT_LAUNCH_MODE,
  flutterModeFlag,
  resolveAndroidLaunchMode,
} from "../androidLaunchMode.js";
import {
  AndroidInputController,
  parseWmSize,
} from "../input/androidInputController.js";
import {
  deriveAndroidGeometry,
  DeviceGeometryReading,
  parseWmDensity,
} from "../deviceGeometry.js";
import {
  buildAdbScreencapCommand,
  defaultScreenshotPath,
  ScreenshotResult,
} from "../screenshot.js";
import {
  androidRemoteRecordingPath,
  ANDROID_MAX_DURATION_SECONDS,
  buildAdbPullCommand,
  buildAdbRemoveCommand,
  buildAdbScreenrecordCommand,
  buildAdbStopScreenrecordCommand,
  buildFfmpegVideoToGifCommands,
  defaultRecordingPath,
  RecordFormat,
  RecordResult,
} from "../recording.js";
import { locateFfmpeg } from "../ffmpegLocate.js";
import {
  convertVideoToGif,
  runTimedRecorder,
} from "../recordingRun.js";
import {
  BuildMode,
  BuildOptions,
  BuildResult,
  DeviceResolution,
  InputController,
  LaunchOutcome,
  Platform,
} from "../types.js";
import { dartDefineArgs } from "../dartDefine.js";
import {
  AppLifecycle,
  DeviceTargetPreference,
  InstallOptions,
  PlatformAdapter,
} from "./platformAdapter.js";

/** Android KEYCODE_HOME — sent via `adb shell input keyevent` to background the app. */
export const ANDROID_KEYCODE_HOME = 3;

/**
 * Log signatures that mean an Android launch failed and polling should stop
 * early. These mirror the intent of the iOS/Tizen signatures but match
 * `flutter run`'s Android output. Transient "waiting"/"installing" lines must
 * NOT match — only terminal failures.
 */
export const ANDROID_FAILURE_SIGNATURES: RegExp[] = [
  /No devices found/i,
  /No supported devices connected/i,
  /Error: No connected devices/i,
  /Gradle task .* failed/i,
  /Installation failed/i,
  /adb: failed to install/i,
  /INSTALL_FAILED_INSUFFICIENT_STORAGE/i,
  /Could not (?:install|build)/i,
  /device unauthorized/i,
  /flutter: command not found/i,
];

/**
 * Storage-exhaustion signature across the places Android surfaces it: the
 * package manager's INSTALL_FAILED_INSUFFICIENT_STORAGE (also seen as a bare
 * INSUFFICIENT_STORAGE in some adb wordings) and the generic filesystem
 * "No space left on device". Freeing space by uninstalling the app and retrying
 * once is the recovery for all of them.
 */
export const ANDROID_STORAGE_FAILURE_SIGNATURE =
  /INSTALL_FAILED_INSUFFICIENT_STORAGE|INSUFFICIENT_STORAGE|No space left on device/i;

/**
 * Compose the `flutter run` launch and delegate the pty wrapping to
 * {@link buildPtyCaptureCommand} so the Flutter tool sees a pty and line-flushes
 * its VM-service URI (buffered under a plain pipe otherwise). This adapter owns
 * only the `flutter run` invocation; the cross-platform `script`/`/bin/sh -c`
 * wrapping is the shared helper's concern.
 *
 * Unlike iOS, there is NO `--no-build`: on Android `flutter run` performs the
 * apk install + VM-service port-forward itself, so the deploy is a single
 * `flutter run --<mode> -d <serial>` (profile keeps the Dart VM service and its
 * URI available while behaving like a release build).
 *
 * The launch MODE is resolved by the deploy (see {@link resolveAndroidLaunchMode})
 * and passed in here. It matters because Marionette is gated on `kDebugMode` in
 * the app — a profile/release launch registers no `ext.flutter.marionette.*`
 * extension, so a Marionette-drivable deploy MUST launch `--debug` (mirrors how
 * the iOS adapter launches `--debug`, and why the Android default is `debug`).
 */
export function buildAndroidPtyLaunchCommand(
  appDir: string,
  serial: string,
  flutterCommand = "flutter",
  platform: NodeJS.Platform = process.platform,
  mode: AndroidLaunchMode = ANDROID_DEFAULT_LAUNCH_MODE,
  controlChannel?: ControlChannel,
  extraArgs: string[] = []
): string {
  // `extraArgs` carries already-quoted --dart-define tokens: on Android the
  // launch IS the build, so defines have to be spliced HERE to reach the apk
  // that actually runs.
  const suffix = extraArgs.length > 0 ? ` ${extraArgs.join(" ")}` : "";
  const inner =
    `${flutterCommand} run ${flutterModeFlag(mode)} -d ${quote(serial)}` +
    suffix;
  return buildPtyCaptureCommand({ inner, cwd: appDir, platform, controlChannel });
}

/** Configuration an AndroidAdapter needs from the server. */
export interface AndroidAdapterConfig {
  appDir: string;
  /** Optional pinned device serial or model name (env var). */
  device?: string;
  /** The Android applicationId. */
  appId: string;
  /**
   * The launch/build mode used when a deploy/build does NOT pass an explicit
   * `debug` flag — the resolved `FLUTTER_DEVICE_ANDROID_LAUNCH_MODE` env pin, or
   * `undefined` to use {@link ANDROID_DEFAULT_LAUNCH_MODE} (`debug`). An explicit
   * tool arg still overrides this (see {@link resolveAndroidLaunchMode}).
   */
  launchMode?: AndroidLaunchMode;
  /**
   * The flutter invocation to shell (e.g. "flutter" or "fvm flutter"). Optional;
   * defaults to the fvm-aware resolution over {@link AndroidAdapterConfig.appDir}.
   * Injectable so tests pin it deterministically regardless of the host's fvm.
   */
  flutterCommand?: string;
}

export class AndroidAdapter implements PlatformAdapter {
  readonly platform: Platform = "android";

  /** Cached input controller so its selected mode survives across tool calls. */
  private inputController: InputController | undefined;

  /**
   * The device pin the current input call asked for, read by the cached
   * controller's lazy serial resolver. Set on every {@link input} call — to
   * `undefined` when the call named no device — so a pin never outlives the call
   * that supplied it.
   */
  private inputDevicePin: string | undefined;

  /**
   * The `deviceWarning` from the most recent device resolution the cached
   * controller's lazy resolver performed for the CURRENT {@link input} call —
   * read back by {@link inputDeviceWarning}. Reset to `undefined` on every
   * {@link input} call (same lifetime as {@link inputDevicePin}) so a warning
   * never outlives the call that produced it, and set by the resolver closure
   * each time it actually runs (`pointerMove` included — it resolves the device
   * purely to surface a stale-pin warning, even though it sends no adb event).
   */
  private lastInputDeviceWarning: string | undefined;

  /**
   * The launch mode the pending/last deploy resolved, captured from the deploy's
   * `install` step (which runs before {@link launchAndCaptureUri}). `flutter run`
   * takes no `--no-launch`, so the launch is the ONE place the mode can be
   * honored. Resolution follows {@link resolveAndroidLaunchMode}: an explicit
   * `debug` arg wins, else the `FLUTTER_DEVICE_ANDROID_LAUNCH_MODE` env pin, else the
   * default `debug` (so a plain deploy comes up Marionette-drivable — Marionette
   * is gated on `kDebugMode`). Initialized to the config/default mode so a launch
   * with no preceding install still uses the right default.
   */
  private launchMode: AndroidLaunchMode;

  /** Resolved once: `fvm flutter` when the app dir is fvm-managed, else `flutter`. */
  private readonly flutter: string;

  constructor(private readonly config: AndroidAdapterConfig) {
    // Seed the pending-launch mode from the env pin (or the default) so a launch
    // that isn't preceded by an install still lands on the right default.
    this.launchMode = resolveAndroidLaunchMode({ envMode: config.launchMode });
    this.flutter =
      config.flutterCommand ??
      resolveFlutterCommand({
        fvmManaged: AndroidAdapter.isFvmManaged(config.appDir),
        fvmAvailable: AndroidAdapter.hasFvmOnPath(),
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

  get appId(): string {
    return this.config.appId;
  }

  /**
   * Device + environment status: adb version + connected devices, plus the
   * flutter Android toolchain summary. Never assumes a device is present — an
   * empty list is a valid "no device connected" result, not an error.
   */
  async info(): Promise<CommandResult> {
    const command = [
      "echo '=== adb ==='",
      "adb version 2>&1 || echo 'adb unavailable'",
      "echo '=== connected devices (adb devices -l) ==='",
      "adb devices -l 2>&1 || echo 'adb unavailable'",
      "echo '=== flutter (Android toolchain) ==='",
      `${this.flutter} doctor 2>&1 | grep -iE 'android|flutter' | head -n 8`,
    ].join(" ; ");
    return runShell(command, { cwd: this.config.appDir, timeoutMs: 60000 });
  }

  /**
   * Android has no `.tizen-target`-style connect step: devices attach over
   * USB/Wi-Fi and are enumerated by adb. Setup reports the discoverable devices
   * so the caller can confirm the device is visible (and authorized).
   */
  async setup(_opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }> {
    const result = await runShell("adb devices -l 2>&1", {
      cwd: this.config.appDir,
      timeoutMs: 30000,
    });
    // Nothing is written on Android (no target file); wrote is left undefined.
    return { result };
  }

  /**
   * Build the app for Android via `flutter build apk`. The mode follows the SAME
   * resolution as the deploy launch ({@link resolveAndroidLaunchMode}): an
   * explicit `debug` arg wins, else the `FLUTTER_DEVICE_ANDROID_LAUNCH_MODE` env pin,
   * else the default `debug` — so a plain `flutter_build platform=android`
   * produces a debug apk coherent with the debug launch a plain
   * `flutter_deploy` performs (never a profile artifact under a debug launch).
   * `skip_flutter` short-circuits to a no-op success (there is no separate Rust
   * engine on the Android app path — `skip_rust` is accepted for interface parity
   * and ignored).
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    if (opts.skip_flutter) {
      const message = "skip_flutter set — reusing existing Android build artifact.";
      const result: CommandResult = {
        code: 0,
        stdout: message,
        stderr: "",
        combined: message,
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

    // Mode precedence matches the launch: explicit `mode` > explicit `debug`
    // arg > env pin > default `debug`. A `simulator`-style profile has no
    // Android meaning, so only debug/profile/release are honored here.
    const mode = resolveAndroidLaunchMode({
      explicitMode: opts.mode,
      explicitDebug: opts.debug,
      envMode: this.config.launchMode,
    });
    const defines = dartDefineArgs(opts.dartDefine).map(quote).join(" ");
    const command =
      `${this.flutter} build apk ${flutterModeFlag(mode)}` +
      (defines ? ` ${defines}` : "");
    const result = await runShell(command, {
      cwd: this.config.appDir,
      timeoutMs: 1800000, // 30 min — a clean Android build can be slow.
    });

    const combined = result.combined;
    // flutter prints the built apk path on success ("Built build/.../app.apk").
    const apkMatch = combined.match(/Built\s+(\S+\.apk)/);
    return {
      result,
      artifactPath: apkMatch ? apkMatch[1] : undefined,
      enospc:
        /No space left on device/i.test(combined) ||
        /INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(combined),
      installFailed:
        /Gradle task .* failed/i.test(combined) ||
        /Installation failed/i.test(combined),
      launchedDisplay: false,
    };
  }

  /**
   * Resolve the Android target from `adb devices -l`. A pin self-heals to the
   * first online device with a warning, mirroring the Tizen/iOS stale-pin
   * fallback. Throws an McpError when nothing is listed at all.
   *
   * `preference.udid` pins a specific target for THIS call — on Android the adb
   * serial IS the id every consumer uses, so a serial (or model name) is matched
   * exactly like the `FLUTTER_DEVICE_ANDROID_DEVICE` pin it overrides, self-heal
   * and all. It is what makes a two-target host workable at all: discovery takes
   * the first ONLINE device, so a physical phone that is attached but unusable
   * (PIN locked, where Flutter stops building and no work can be driven) wins
   * every call, and the env pin that would redirect it cannot be changed without
   * a host reload. `preference.kind` has no Android meaning (there is no
   * device-vs-simulator id split here) and is ignored.
   */
  async discoverDevice(
    preference: DeviceTargetPreference = {}
  ): Promise<DeviceResolution> {
    const devicesOut = await runShell("adb devices -l", { timeoutMs: 15000 });
    // Distinguish "adb not installed" from "adb ran but found no devices": adb
    // missing fails to spawn (code null) or the shell reports command-not-found,
    // whereas a working adb with no devices exits 0 with just the header. Without
    // this check both surface as the same misleading "no devices" error.
    if (
      !devicesOut.success &&
      (devicesOut.code === null ||
        /command not found|not found|no such file/i.test(devicesOut.combined))
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "adb not found — install the Android platform-tools and ensure `adb` is " +
          "on your PATH, then retry. (Could not run `adb devices -l`.)"
      );
    }
    const resolution = resolveAndroidTarget(
      preference.udid ?? this.config.device,
      devicesOut.stdout,
      preference.udid ? "call" : "env"
    );
    if (!resolution) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No Android device found. Connect a device (enable USB debugging in " +
          "Developer options and accept the RSA prompt), or start an emulator. " +
          "Set FLUTTER_DEVICE_ANDROID_DEVICE to pin a specific serial or model name."
      );
    }
    if (resolution.warning) {
      logger.warn("Android device resolution warning", resolution);
    }
    return resolution;
  }

  /**
   * On Android the deploy is `flutter run` (which installs the apk itself), so a
   * standalone install step is a no-op success. Kept to satisfy the neutral
   * interface; the server's deploy calls install THEN launch, but for Android
   * the launch does the install, so install here reports a clean pass-through.
   *
   * It DOES resolve + record the launch mode: `flutter run` (the launch) is the
   * only step that can honor it, and the launch receives no options, so the mode
   * is resolved here (explicit `debug` arg > env pin > default `debug`) for
   * {@link launchAndCaptureUri} to pick up.
   */
  async install(device: string, opts: InstallOptions): Promise<CommandResult> {
    this.launchMode = resolveAndroidLaunchMode({
      explicitMode: opts.mode,
      explicitDebug: opts.debug,
      envMode: this.config.launchMode,
    });
    const message =
      `Android install is performed by 'flutter run' at launch time (it installs ` +
      `the apk on ${device} and sets up the VM-service port-forward), so the ` +
      `separate install step is a no-op.`;
    return {
      code: 0,
      stdout: message,
      stderr: "",
      combined: message,
      success: true,
      timedOut: false,
    };
  }

  /**
   * True when a captured install output signals an out-of-storage install
   * failure ({@link ANDROID_STORAGE_FAILURE_SIGNATURE}). On Android the real apk
   * install happens inside `flutter run` at LAUNCH time (install here is a
   * no-op), so the launch path — {@link recoverLaunchFailure} — is where this
   * signature actually fires; it is exposed on the install seam too so the
   * Android wording is recognized wherever install output is classified.
   */
  isInstallFailure(combined: string): boolean {
    return ANDROID_STORAGE_FAILURE_SIGNATURE.test(combined);
  }

  /**
   * Reactive launch-failure recovery (the {@link PlatformAdapter} seam).
   *
   * Because the Android deploy installs at LAUNCH time (`flutter run` performs
   * the apk install), an out-of-storage install failure surfaces as a FAILED
   * launch, never as a failed install step — which is why the deploy's own
   * ENOSPC retry, which only wraps the install call, can never fire here. When
   * the captured launch output carries a storage signature, uninstall the app to
   * free space and report `recovered: true` so the launch is retried once. If
   * the space-freeing uninstall ITSELF fails there is nothing left to free, so
   * the failure is reported as-is rather than burning a retry on the same wall.
   * Any non-storage failure is not recovered.
   */
  async recoverLaunchFailure(
    device: string,
    logTail: string
  ): Promise<{ recovered: boolean; note?: string }> {
    if (!ANDROID_STORAGE_FAILURE_SIGNATURE.test(logTail)) {
      return { recovered: false };
    }
    const uninstall = await this.uninstall(device, this.appId);
    if (!uninstall.success) {
      return {
        recovered: false,
        note:
          "Device is out of storage and the space-freeing `adb uninstall` failed, " +
          `so a launch retry would hit the same wall: ${tail(uninstall.combined, 5)}`,
      };
    }
    return {
      recovered: true,
      note: "Device was out of storage — uninstalled the app to free space; retrying the launch.",
    };
  }

  /**
   * Launch through a pty and capture the Dart VM Service URI — feeding the SAME
   * neutral core the Android `flutter run --<mode>` command + Android failure
   * signatures. `flutter run` installs the apk, port-forwards the VM service, and
   * prints the URI in one step. The mode is the one the deploy resolved
   * (recorded by {@link install}): `--debug` by default so Marionette (gated on
   * `kDebugMode`) can attach, or the explicit/env-pinned mode otherwise.
   */
  async launchAndCaptureUri(
    device: string,
    timeoutMs: number,
    _mode?: BuildMode,
    dartDefine?: Record<string, string>
  ): Promise<LaunchOutcome> {
    // Allocate a durable control channel (FIFO + pty bridge) so
    // flutter_hot_reload/flutter_hot_restart can drive `r`/`R` on this running
    // `flutter run` daemon over its own stdin — the authoritative reload/restart
    // path, and `flutter run` accepts the same interactive keys on Android as on
    // iOS. Undefined when the host can't provide both halves (no mkfifo, or no
    // usable python3): the launch still proceeds, reload falls back to the VM
    // service, and restart reports that it cannot be driven.
    const controlChannel = allocateControlChannel();
    // The launch mode is the one the deploy resolved and recorded in install()
    // (`_mode` is already folded into it there), so it is not re-read here.
    const command = buildAndroidPtyLaunchCommand(
      this.config.appDir,
      device,
      this.flutter,
      process.platform,
      this.launchMode,
      controlChannel,
      dartDefineArgs(dartDefine).map(quote)
    );
    return neutralLaunchAndCaptureUri(
      command,
      this.config.appDir,
      timeoutMs,
      ANDROID_FAILURE_SIGNATURES,
      controlChannel?.fifoPath
    );
  }

  /** Uninstall the app to free device space / reset state via `adb uninstall`. */
  /**
   * Open a URL on the device via `am start -a android.intent.action.VIEW`.
   *
   * Defaults the target package to this project's resolved application id: an
   * unscoped VIEW intent for an https link can raise a disambiguation chooser
   * (browser vs app) that an automated run cannot answer, and the call then
   * looks like a hang rather than a failure. Pass an explicit id to target
   * another app, or an empty string to deliberately go unscoped and let the OS
   * disambiguate the way a real user tap does.
   *
   * `am` reports a refused intent on STDOUT while still exiting 0, so the
   * output is classified rather than trusting the exit code.
   */
  async openUrl(
    url: string,
    packageOrBundleId?: string,
    preference?: DeviceTargetPreference
  ): Promise<OpenUrlResult> {
    const invalid = invalidOpenUrlReason(url);
    if (invalid) {
      return { opened: false, url, reason: invalid };
    }
    const resolution = await this.discoverDevice(preference);
    const pkg = packageOrBundleId ?? this.appId;
    const command = buildAdbOpenUrlCommand(
      resolution.target,
      url,
      pkg && pkg.length > 0 ? pkg : undefined
    );
    const result = await runShell(command, { timeoutMs: 30000 });
    const refusal = androidOpenUrlFailure(result.combined);
    if (!result.success || refusal) {
      return {
        opened: false,
        url,
        device: resolution.target,
        command,
        reason: refusal ?? `adb am start failed on ${resolution.target}.`,
        output: tail(result.combined, 20),
      };
    }
    return {
      opened: true,
      url,
      device: resolution.target,
      command,
      output: tail(result.combined, 10),
    };
  }

  async uninstall(device: string, appId: string): Promise<CommandResult> {
    return runShell(`adb -s ${quote(device)} uninstall ${quote(appId)}`, {
      timeoutMs: 120000,
    });
  }

  /**
   * Capture the current screen via `adb -s <serial> exec-out screencap -p`,
   * redirecting the raw PNG bytes to disk. `exec-out` (not `shell`) avoids the
   * CRLF byte-mangling that corrupts a `shell screencap -p` redirect. Resolves
   * the device the normal way (per-call pin > env pin > self-heal) so the
   * capture follows the same target as deploy/lifecycle — including the target a
   * caller pinned for this one call.
   */
  async screenshot(opts: {
    outPath?: string;
    includeBase64?: boolean;
    deviceUdid?: string;
  }): Promise<ScreenshotResult> {
    const resolution = await this.discoverDevice({ udid: opts.deviceUdid });
    const outPath = opts.outPath ?? defaultScreenshotPath("android");
    const result = await runShell(
      buildAdbScreencapCommand(resolution.target, outPath),
      { timeoutMs: 30000 }
    );
    if (!result.success || !fs.existsSync(outPath)) {
      return {
        captured: false,
        reason: `adb screencap failed on ${resolution.target}: ${tail(
          result.combined,
          20
        )}`,
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
   * Record a bounded screen clip via `adb shell screenrecord` — the best
   * recording path on this framework (smooth native mp4). The recorder runs
   * on-device for `durationSeconds`; we stop it with an on-device
   * `pkill -INT screenrecord` (SIGINT flushes the mp4 — a host-side kill of the
   * adb process would truncate it), pull the file, and rm the remote copy. A
   * `--time-limit` ceiling is also passed so a missed SIGINT can't run away.
   *
   * `gif` is produced by an ffmpeg mp4→gif pass; absent ffmpeg the gif request
   * degrades to `{ supported: false }` (the native mp4 path itself needs no
   * ffmpeg).
   */
  async record(opts: {
    outPath?: string;
    durationSeconds: number;
    fps: number;
    format: RecordFormat;
    deviceUdid?: string;
  }): Promise<RecordResult> {
    const wantGif = opts.format === "gif";
    const ffmpeg = wantGif ? locateFfmpeg() : undefined;
    if (wantGif && !ffmpeg) {
      return {
        recorded: false,
        supported: false,
        reason:
          "A gif was requested but `ffmpeg` was not found. Android records a native mp4 with no " +
          "ffmpeg; only the gif conversion needs it.",
        hint:
          "Install ffmpeg (`brew install ffmpeg`), or set FLUTTER_DEVICE_FFMPEG to its absolute path. " +
          "Request format 'mp4' to record without ffmpeg.",
      };
    }

    const resolution = await this.discoverDevice({ udid: opts.deviceUdid });
    const duration = Math.min(
      Math.max(1, opts.durationSeconds),
      ANDROID_MAX_DURATION_SECONDS
    );
    const remotePath = androidRemoteRecordingPath();
    const mp4Path = wantGif
      ? defaultRecordingPath("android", "mp4")
      : opts.outPath ?? defaultRecordingPath("android", "mp4");

    const run = await runTimedRecorder({
      command: buildAdbScreenrecordCommand(resolution.target, remotePath, {
        timeLimitSeconds: duration,
      }),
      durationSeconds: duration,
      // screenrecord runs ON-DEVICE behind adb; SIGINT it on-device to flush.
      stop: async () => {
        await runShell(buildAdbStopScreenrecordCommand(resolution.target), {
          timeoutMs: 10000,
        });
      },
    });

    // Pull the flushed clip off-device, then clean up the remote copy.
    const pull = await runShell(
      buildAdbPullCommand(resolution.target, remotePath, mp4Path),
      { timeoutMs: 60000 }
    );
    await runShell(buildAdbRemoveCommand(resolution.target, remotePath), {
      timeoutMs: 10000,
    });

    if (!pull.success || !fs.existsSync(mp4Path)) {
      return {
        recorded: false,
        reason:
          `screenrecord/pull failed on ${resolution.target}: ` +
          `${tail(run.output + "\n" + pull.combined, 20)}`,
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

    const gifPath = opts.outPath ?? defaultRecordingPath("android", "gif");
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
   * Kill leftover launch drivers that would hold the device/URI or wedge a
   * subsequent deploy: the host-side `flutter run` process and the Dart
   * frontend/analysis servers it spawns.
   *
   * Matches BOTH modes this adapter can spawn — `flutter run --profile` and
   * `flutter run --debug` (see {@link buildAndroidPtyLaunchCommand}) — so a stale
   * DEBUG deploy is torn down too, keeping the "one deploy at a time" guardrail
   * intact for debug launches (a `--profile`-only match would leak a wedged debug
   * session). The mode is not a reliable cross-platform discriminator (iOS also
   * launches `flutter run --debug -d`), so concurrent iOS+Android deploys on one
   * host are unsupported — but iOS's own killStale already tears down any
   * `flutter run`, so this is no more aggressive than the existing behavior.
   */
  async killStale(): Promise<Record<string, CommandResult>> {
    const flutterRunProfile = await runShell(
      `pkill -f ${quote("flutter run --profile")}`,
      { timeoutMs: 10000 }
    );
    const flutterRunDebug = await runShell(
      `pkill -f ${quote("flutter run --debug")}`,
      { timeoutMs: 10000 }
    );
    const frontendServer = await runShell(
      `pkill -f ${quote("frontend_server")}`,
      { timeoutMs: 10000 }
    );
    // Report the profile-kill under the generic `flutterRun` key the server's
    // summarizeKillStale handles; expose the debug-kill alongside it.
    return {
      flutterRun: flutterRunProfile,
      flutterRunDebug,
      frontendServer,
    };
  }

  /**
   * OS-level lifecycle over adb: terminate (force-stop), background (HOME
   * keyevent — sends the app to the background WITHOUT killing it, exercising
   * onPause/onStop), and foreground (relaunch by package via monkey). This is
   * the appliance framework's key mobile gap, matching the iOS lifecycle verbs.
   */
  readonly lifecycle: AppLifecycle = {
    terminate: (device, appId) =>
      runShell(
        `adb -s ${quote(device)} shell am force-stop ${quote(appId)}`,
        { timeoutMs: 60000 }
      ),
    background: (device) =>
      // KEYCODE_HOME (3) drops the current app to the background without killing
      // it — the app's onPause/onStop run and its VM service stays alive.
      runShell(
        `adb -s ${quote(device)} shell input keyevent ${ANDROID_KEYCODE_HOME}`,
        { timeoutMs: 60000 }
      ),
    foreground: (device, appId) =>
      // Relaunch the package via its LAUNCHER intent (monkey resolves the main
      // activity, so no activity name is needed).
      runShell(
        `adb -s ${quote(device)} shell monkey -p ${quote(appId)} ` +
          `-c android.intent.category.LAUNCHER 1`,
        { timeoutMs: 60000 }
      ),
  };

  /**
   * Report the screen geometry from `adb shell wm size` + `wm density`.
   *
   * Both are read against ONE resolved device — the same resolution every other
   * verb uses, honoring an explicit `preference.udid` — so the numbers describe
   * the target the caller meant rather than whichever device adb happens to
   * list first. `wm density` is what yields the device pixel ratio the pointer
   * plane needs but has never been able to state; its OVERRIDE line, when
   * present, is the density actually in force (on a device whose panel is 480
   * but whose override is 640, reading only the physical line would mis-scale
   * every tap by a third).
   *
   * Undefined when either command's output cannot be parsed: a half-known
   * geometry would just be a guess wearing a result's clothes.
   */
  async geometry(
    preference: DeviceTargetPreference = {}
  ): Promise<DeviceGeometryReading | undefined> {
    const resolution = await this.discoverDevice(preference);
    const serial = quote(resolution.target);
    const [sizeResult, densityResult] = await Promise.all([
      runShell(`adb -s ${serial} shell wm size`, { timeoutMs: 15000 }),
      runShell(`adb -s ${serial} shell wm density`, { timeoutMs: 15000 }),
    ]);
    const geometry = deriveAndroidGeometry(
      parseWmSize(sizeResult.combined),
      parseWmDensity(densityResult.combined)
    );
    if (!geometry) return undefined;
    return {
      ...geometry,
      device: resolution.target,
      deviceWarning: resolution.warning,
    };
  }

  /**
   * Android input controller: the OS-level `adb shell input` plane
   * ({@link AndroidInputController}) — keyevent for D-pad/remote keys, tap/swipe
   * for the pointer verbs, and text injection. Raw system input that bypasses
   * Flutter's gesture-arena semantics; a driver over the VM service remains the
   * primary in-app path, and this covers what it cannot reach: OS UI outside the
   * Flutter view, non-debug builds, and D-pad navigation (Android TV).
   *
   * The serial is resolved lazily per send through the normal device resolution
   * (per-call pin > env pin > self-heal), so a multi-device host targets the
   * same device as deploy/lifecycle. Cached so the selected mode and the staged
   * pointer position survive across tool calls.
   *
   * A per-call `preference.udid` is recorded on the adapter rather than baked
   * into a fresh controller, because a new controller would drop the staged
   * pointer position that a `move` sets and a `click` consumes — the pin has to
   * change the target without resetting the plane. Recording it here mirrors how
   * the launch mode is resolved at install time and read by the launch.
   */
  input(preference: DeviceTargetPreference = {}): InputController {
    this.inputDevicePin = preference.udid;
    this.lastInputDeviceWarning = undefined;
    if (!this.inputController) {
      this.inputController = new AndroidInputController(async () => {
        const resolution = await this.discoverDevice({
          udid: this.inputDevicePin,
        });
        this.lastInputDeviceWarning = resolution.warning;
        return resolution.target;
      });
    }
    return this.inputController;
  }

  /** See {@link PlatformAdapter.inputDeviceWarning}. */
  inputDeviceWarning(): string | undefined {
    return this.lastInputDeviceWarning;
  }
}

