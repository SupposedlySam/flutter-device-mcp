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
import {
  isOnline,
  parseAdbDevices,
  resolveAndroidTarget,
} from "../androidDeviceTarget.js";
import {
  buildDeviceIdentity,
  DeviceIdentity,
  FLUTTER_RUN_DRIVER_PATTERNS,
  killScopedLaunchDrivers,
} from "../killStaleScope.js";
import { findLaunch } from "../launchRegistry.js";
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
  KillStaleScope,
  KillStaleScopeKind,
  PlatformAdapter,
  LaunchRecovery,
  UninstallCheck,
  UninstallVerdict,
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
 * Installers that mean "put there by adb": `null` when adb installs directly,
 * `com.android.shell` on releases that record the shell as the installer. Only a
 * copy with one of these may be replaced by a development build without asking.
 * Everything else — the Play Store, the Galaxy Store, Firebase App Distribution
 * tester builds, a sideloaded release apk — is somebody's install, with data.
 */
export const ADB_INSTALLERS: ReadonlySet<string> = new Set(["null", "com.android.shell"]);

/** Printed by the device shell after `pm`, so `pm`'s own exit status is known. */
export const PM_EXIT_SENTINEL = "__pm_exit=";

/** Who installed the app on a device, as `pm list packages -i` reports it. */
export type InstalledCopy =
  | { kind: "absent" }
  | { kind: "installed"; installer: string }
  | { kind: "unknown"; detail: string };

/**
 * Read the installer of exactly `appId` from `pm list packages -i <appId>`
 * followed by the exit-status sentinel. The filter is a substring match, so
 * `com.example.app.debug` is listed for `com.example.app` and is skipped here.
 *
 * `absent` needs positive evidence: pm exited 0 and every line it printed was a
 * well-formed package line. Anything else — no sentinel, a non-zero exit, a line
 * that is not a package line — is `unknown`, which callers treat as a copy they
 * must not replace.
 */
export function parseInstalledCopy(output: string, appId: string): InstalledCopy {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const exit = lines.find((l) => l.startsWith(PM_EXIT_SENTINEL));
  if (!exit) return { kind: "unknown", detail: "pm reported no exit status" };
  if (exit !== `${PM_EXIT_SENTINEL}0`) {
    return { kind: "unknown", detail: `pm exited ${exit.slice(PM_EXIT_SENTINEL.length)}` };
  }
  let found: InstalledCopy = { kind: "absent" };
  for (const line of lines) {
    if (line === exit) continue;
    const m = line.match(/^package:(\S+)\s+installer=(\S+)$/);
    if (!m) return { kind: "unknown", detail: `unexpected pm output: ${line}` };
    if (m[1] === appId) found = { kind: "installed", installer: m[2] };
  }
  return found;
}

/**
 * The package id the app's build produces in `mode`, read from the tree: the
 * `applicationId` in android/app/build.gradle[.kts] (a literal, or a property
 * it names, looked up in android/gradle.properties) plus the build type's
 * `applicationIdSuffix`. This, not the configured app id, is what `flutter run`
 * installs — and replaces. Anything that cannot be attributed from here (several
 * `applicationId`s from flavors, a suffix outside the build type, an expression)
 * makes the id unknown rather than guessed.
 */
export function androidBuildPackageId(
  appDir: string,
  mode: string
): { ok: true; packageId: string } | { ok: false; reason: string } {
  const androidDir = path.join(appDir, "android");
  const gradleFile = ["build.gradle", "build.gradle.kts"]
    .map((f) => path.join(androidDir, "app", f))
    .find((f) => fs.existsSync(f));
  if (!gradleFile) {
    return { ok: false, reason: `No build.gradle under ${androidDir}/app.` };
  }
  const gradle = fs.readFileSync(gradleFile, "utf8");
  const base = gradleApplicationId(androidDir, gradleFile, gradle);
  if (!base.ok) return base;
  const suffixPattern = /applicationIdSuffix\s*=?\s*["']([^"']*)["']/g;
  const count = (text: string | undefined) =>
    text ? [...text.matchAll(suffixPattern)].length : 0;
  const types = braceBlock(gradle, /\bbuildTypes\s*\{/);
  const block = types ? braceBlock(types, new RegExp(`\\b${mode}\\s*\\{`)) : undefined;
  if (count(gradle) > count(types)) {
    return {
      ok: false,
      reason:
        `${gradleFile} declares an applicationIdSuffix outside buildTypes (a flavor ` +
        `or defaultConfig), so the package id this build produces cannot be read ` +
        `from the tree.`,
    };
  }
  const suffix = block ? [...block.matchAll(suffixPattern)][0]?.[1] : undefined;
  return { ok: true, packageId: base.packageId + (suffix ?? "") };
}

/**
 * The one `applicationId` a gradle file declares. A quoted literal is used as
 * is; `"$name"`, `"${name}"`, a bare `name` / `project.name` or
 * `property("name")` is looked up in android/gradle.properties.
 */
function gradleApplicationId(
  androidDir: string,
  gradleFile: string,
  gradle: string
): { ok: true; packageId: string } | { ok: false; reason: string } {
  const declarations = [...gradle.matchAll(/\bapplicationId\b\s*=?\s*([^\s;]+)/g)].map(
    (m) => m[1]
  );
  if (declarations.length !== 1) {
    return {
      ok: false,
      reason:
        `${gradleFile} declares ${declarations.length} applicationId values, so the ` +
        `package id this build produces cannot be read from the tree.`,
    };
  }
  const value = declarations[0];
  const literal = value.match(/^["']([^"'$]+)["']$/)?.[1];
  if (literal) return { ok: true, packageId: literal };
  const name =
    value.match(/^["']\$\{?([A-Za-z_][\w.]*)\}?["']$/)?.[1] ??
    value.match(/^(?:find)?[Pp]roperty\(["']([^"']+)["']\)$/)?.[1] ??
    value.match(/^(?:project\.)?([A-Za-z_]\w*)$/)?.[1];
  if (!name) {
    return {
      ok: false,
      reason: `${gradleFile} sets applicationId to ${value}, which cannot be read from the tree.`,
    };
  }
  let properties = "";
  try {
    properties = fs.readFileSync(path.join(androidDir, "gradle.properties"), "utf8");
  } catch {
    // No gradle.properties: the lookup below reports the property as missing.
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const resolved = properties.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(\\S+)\\s*$`, "m"))?.[1];
  if (!resolved) {
    return {
      ok: false,
      reason: `${gradleFile} takes applicationId from ${name}, which ${androidDir}/gradle.properties does not set.`,
    };
  }
  return { ok: true, packageId: resolved };
}

/** The first `<header> { ... }` block `opener` finds in `text`, by brace matching. */
function braceBlock(text: string, opener: RegExp): string | undefined {
  const open = text.search(opener);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = text.indexOf("{", open); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/** The apk a failed `flutter run` was installing, relative to the app dir. */
export function apkPathFromLaunchLog(log: string): string | undefined {
  return log.match(/Installing\s+(\S+\.apk)/)?.[1];
}

/**
 * Find `aapt2`, which reads the package id out of a built apk. FLUTTER_DEVICE_ANDROID_AAPT2
 * wins; otherwise the newest build-tools under ANDROID_HOME / ANDROID_SDK_ROOT /
 * the default macOS SDK location. Undefined when none is installed.
 */
export function locateAapt2(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.FLUTTER_DEVICE_ANDROID_AAPT2?.trim();
  if (explicit) return explicit;
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.HOME ? path.join(env.HOME, "Library", "Android", "sdk") : undefined,
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    const buildTools = path.join(root, "build-tools");
    let versions: string[];
    try {
      versions = fs.readdirSync(buildTools);
    } catch {
      continue;
    }
    const sorted = versions.sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true })
    );
    for (const v of sorted) {
      const candidate = path.join(buildTools, v, "aapt2");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

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
  /** The `aapt2` to read a built apk's package id with. Defaults to {@link locateAapt2}. */
  aaptCommand?: string;
}

export class AndroidAdapter implements PlatformAdapter {
  readonly platform: Platform = "android";

  /**
   * Every session on this host is a `flutter run`, so only the device tells them
   * apart: an unscoped teardown here could not help killing a session on a
   * device the caller never named. See {@link killStale}.
   */
  readonly killStaleScope: KillStaleScopeKind = "device";

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
   * each time it actually runs (`pointerMove` included, even though it sends no
   * adb event).
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
   * Resolve the Android target from `adb devices -l`. A named device (the
   * per-call `preference.udid`, else the `FLUTTER_DEVICE_ANDROID_DEVICE` pin) that is
   * not online is refused, never replaced. Throws an McpError when nothing is
   * listed at all.
   *
   * `preference.udid` is what makes a two-target host workable: discovery takes
   * the first ONLINE device, so a physical phone that is attached but unusable
   * (PIN locked, where Flutter stops building) wins every unnamed call.
   * `preference.kind` restricts the choice to emulators (`simulator`) or real
   * hardware (`device`).
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
    // A blank per-call id is no id: it must not hide the env pin.
    const callPin = preference.udid?.trim() || undefined;
    const resolution = resolveAndroidTarget(
      callPin ?? this.config.device,
      devicesOut.stdout,
      callPin ? "call" : "env",
      preference.kind
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
   *
   * It is also the last point before `flutter run` can delete somebody's
   * install: flutter_tools' installApp uninstalls the existing copy itself when
   * any install attempt fails (a signature mismatch, a downgrade, a full disk),
   * before this server sees the failure. So a copy of the package this build
   * produces that adb did not put there is refused here unless
   * `allowStoreAppRemoval` is set.
   */
  async install(device: string, opts: InstallOptions): Promise<CommandResult> {
    this.launchMode = resolveAndroidLaunchMode({
      explicitMode: opts.mode,
      explicitDebug: opts.debug,
      envMode: this.config.launchMode,
    });
    const allow = opts.allowStoreAppRemoval === true;
    const built = androidBuildPackageId(this.config.appDir, this.launchMode);
    const check: UninstallVerdict = built.ok
      ? await this.checkReplaceable(device, built.packageId, allow)
      : allow
        ? { ok: true }
        : {
            ok: false,
            reason:
              `${built.reason} Without the package id this build produces, the copy ` +
              `flutter run might replace cannot be checked, so nothing was done. Pass ` +
              `allow_store_app_removal: true to proceed anyway.`,
          };
    if (!check.ok) {
      return {
        code: 1,
        stdout: "",
        stderr: check.reason,
        combined: check.reason,
        success: false,
        timedOut: false,
      };
    }
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
   * Because the Android deploy installs at LAUNCH time, an out-of-storage
   * install failure surfaces as a FAILED launch. On a storage signature this
   * asks for the package this build produces to be uninstalled and the launch
   * retried; runDeployCore decides whether that is allowed. Any non-storage
   * failure is not recovered.
   */
  async recoverLaunchFailure(device: string, logTail: string): Promise<LaunchRecovery> {
    if (!ANDROID_STORAGE_FAILURE_SIGNATURE.test(logTail)) {
      return { action: "none" };
    }
    const built = androidBuildPackageId(this.config.appDir, this.launchMode);
    if (!built.ok) {
      return {
        action: "none",
        note: `${device} is out of storage. ${built.reason} Space recovery was not attempted.`,
      };
    }
    return {
      action: "uninstall-and-retry",
      packageId: built.packageId,
      note: `${device} is out of storage.`,
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

  /**
   * Confirm uninstalling `check.packageId` from `device` is safe. For space
   * recovery the apk being installed must carry that package id, read from the
   * apk itself; for any uninstall, a copy adb did not install is kept unless the
   * caller allowed its removal.
   */
  async verifyUninstallTarget(
    device: string,
    check: UninstallCheck
  ): Promise<UninstallVerdict> {
    if (check.purpose === "space-recovery") {
      const built = await this.builtApkPackageId(check.buildLog ?? "");
      if (!built.ok) return built;
      if (built.packageId !== check.packageId) {
        return {
          ok: false,
          reason:
            `The apk being installed carries ${built.packageId}, not ${check.packageId}, ` +
            `so uninstalling ${check.packageId} would free space by removing a ` +
            `different app. Not attempted.`,
        };
      }
    }
    return this.checkReplaceable(device, check.packageId, check.allowStoreAppRemoval);
  }

  /** Read the package id of the apk a launch is installing. */
  private async builtApkPackageId(
    buildLog: string
  ): Promise<{ ok: true; packageId: string } | { ok: false; reason: string }> {
    const relative =
      apkPathFromLaunchLog(buildLog) ??
      path.join("build", "app", "outputs", "flutter-apk", `app-${this.launchMode}.apk`);
    const apk = path.resolve(this.config.appDir, relative);
    const aapt = this.config.aaptCommand ?? locateAapt2();
    if (!aapt) {
      return {
        ok: false,
        reason:
          `Could not confirm the package id of ${apk}: aapt2 was not found (install ` +
          `Android build-tools, or set FLUTTER_DEVICE_ANDROID_AAPT2). An unconfirmed ` +
          `package id is never uninstalled.`,
      };
    }
    const result = await runShell(
      `${quote(aapt)} dump packagename ${quote(apk)}`,
      { timeoutMs: 30000 }
    );
    const packageId = result.stdout.trim().split("\n")[0]?.trim();
    if (!result.success || !packageId) {
      return {
        ok: false,
        reason:
          `Could not read the package id of ${apk} with aapt2: ` +
          `${tail(result.combined, 5)}. An unconfirmed package id is never uninstalled.`,
      };
    }
    return { ok: true, packageId };
  }

  /** Who installed `packageId` on `device`. */
  async installedCopy(device: string, packageId: string): Promise<InstalledCopy> {
    const result = await runShell(
      `adb -s ${quote(device)} shell ${quote(
        `pm list packages -i ${packageId}; echo ${PM_EXIT_SENTINEL}$?`
      )}`,
      { timeoutMs: 30000 }
    );
    if (!result.success) {
      return { kind: "unknown", detail: tail(result.combined, 5) };
    }
    return parseInstalledCopy(result.stdout, packageId);
  }

  /**
   * Refuse to replace or remove a copy of `packageId` that adb did not install,
   * unless allowed. Not knowing who installed it counts as such a copy.
   */
  private async checkReplaceable(
    device: string,
    packageId: string,
    allowStoreAppRemoval: boolean
  ): Promise<UninstallVerdict> {
    if (allowStoreAppRemoval) return { ok: true };
    const copy = await this.installedCopy(device, packageId);
    if (copy.kind === "installed" && !ADB_INSTALLERS.has(copy.installer)) {
      return {
        ok: false,
        reason:
          `${packageId} on ${device} was installed by ${copy.installer}, not by adb ` +
          `(a store, a tester distribution, or a sideloaded build). Replacing it with ` +
          `a development build uninstalls it and deletes its data, so nothing was ` +
          `done. Pass allow_store_app_removal: true only if that device's owner has agreed.`,
      };
    }
    if (copy.kind === "unknown") {
      return {
        ok: false,
        reason:
          `Could not tell who installed ${packageId} on ${device} ` +
          `(${copy.detail}), so it is treated as somebody's install and left alone. ` +
          `Pass allow_store_app_removal: true to proceed anyway.`,
      };
    }
    return { ok: true };
  }

  /** Uninstall the app to free device space / reset state via `adb uninstall`. */
  async uninstall(device: string, appId: string): Promise<CommandResult> {
    return runShell(`adb -s ${quote(device)} uninstall ${quote(appId)}`, {
      timeoutMs: 120000,
    });
  }

  /**
   * Capture the current screen via `adb -s <serial> exec-out screencap -p`,
   * redirecting the raw PNG bytes to disk. `exec-out` (not `shell`) avoids the
   * CRLF byte-mangling that corrupts a `shell screencap -p` redirect. Resolves
   * the device the normal way (per-call pin > env pin > discovery) so the
   * capture follows the same target as deploy/lifecycle — including the target a
   * caller pinned for this one call.
   */
  async screenshot(opts: {
    outPath?: string;
    includeBase64?: boolean;
    deviceUdid?: string;
    target?: "device" | "simulator";
  }): Promise<ScreenshotResult> {
    const resolution = await this.discoverDevice({
      udid: opts.deviceUdid,
      kind: opts.target,
    });
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
    target?: "device" | "simulator";
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

    const resolution = await this.discoverDevice({
      udid: opts.deviceUdid,
      kind: opts.target,
    });
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
   * Kill the launch drivers holding THIS device, and nothing else.
   *
   * Every Android session on the host is a `flutter run` with the same shape, so
   * the command line alone cannot tell them apart: a `pkill -f "flutter run
   * --debug"` aimed at the emulator killed the physical phone's session too, and
   * the `device_udid` that picked the emulator did nothing to protect it. So the
   * teardown attributes each driver process to a device (its `-d` argument, or
   * the `adb -s <serial>` child a live session keeps) and signals only the ones
   * on the resolved target, together with their children — which is what ties
   * `frontend_server` to a session at all, rather than killing every compiler on
   * the host including the IDE's. See killStaleScope.ts for the attribution.
   *
   * Deliberately NOT caught: a `flutter run` no device can be attributed to.
   * Its pid comes back in the result, because guessing is the defect above and
   * staying silent about a possibly-wedged session is the other way to break a
   * deploy.
   *
   * The launch MODE is no longer part of the match (it never discriminated
   * anything — iOS launches `flutter run --debug -d` too); the device does.
   */
  async killStale(
    scope: KillStaleScope
  ): Promise<Record<string, CommandResult>> {
    if (scope.kind === "all-devices") {
      return killScopedLaunchDrivers({
        driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
        driverKey: "flutterRun",
        // The host-wide hammer is the only mode that takes orphaned compilers,
        // matching what the previous blanket `pkill -f frontend_server` did.
        sweepOrphanCompilers: true,
      });
    }
    const identity = await this.deviceIdentityFor(scope.device);
    // A pid this MCP recorded for the device at launch is ownership PROOF, so it
    // is used ahead of anything inferred from a command line — and it is what
    // tears down our own session whose argv names no device at all.
    const recorded = findLaunch(this.platform, scope.device)?.pid;
    return killScopedLaunchDrivers({
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      driverKey: "flutterRun",
      identity,
      knownTargetPids: recorded ? [recorded] : [],
      deviceLabel: scope.device,
    });
  }

  /**
   * The target's identity for a teardown: which ids name it and it ALONE, which
   * name another attached device, and whether it is the only one attached.
   *
   * Read live from `adb devices -l` rather than cached, because the answer
   * decides what may be killed and a cache that has gone stale answers about a
   * host that no longer exists. A model/product name is only kept as the
   * target's when no other listed device reports the same one — two emulators
   * booted from one AVD image report identical `model`/`product`, so treating
   * either as an identity would let a teardown scoped to one kill the other.
   *
   * When adb cannot be read at all, only the serial names the target and nothing
   * is claimed about other devices: a session naming something else is then
   * reported rather than killed, which is the safe direction.
   */
  private async deviceIdentityFor(device: string): Promise<DeviceIdentity> {
    const listed = await runShell("adb devices -l", { timeoutMs: 15000 });
    const devices = parseAdbDevices(listed.stdout).map((d) => ({
      id: d.serial,
      aliases: [d.model, d.product],
      available: isOnline(d),
    }));
    return buildDeviceIdentity({ target: device, devices });
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
   * (per-call pin > env pin > the one online device), so a multi-device host
   * targets the same device as deploy/lifecycle. Cached so the selected mode survives across
   * tool calls.
   *
   * The staged pointer position a `move` sets and a `click` consumes does NOT
   * depend on that cache: it lives in the per-developer on-disk stage keyed by
   * device (see input/pointerStage.ts), because relying on this object outliving
   * both calls made coordinate tapping fail — with an error naming a
   * precondition the caller had already satisfied — after any server restart or
   * host reload.
   *
   * A per-call `preference.udid` is recorded on the adapter rather than baked
   * into a fresh controller so the pin changes the target without resetting the
   * plane (the selected input mode). Recording it here mirrors how the launch
   * mode is resolved at install time and read by the launch.
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

