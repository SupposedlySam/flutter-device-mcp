/**
 * tvOS (Apple TV) platform adapter — EXPERIMENTAL.
 *
 * Drives a Flutter app on Apple TV behind the neutral {@link PlatformAdapter}
 * seam — the TV-family sibling of {@link IosAdapter}. It wraps the community
 * **flutter-tvos** toolchain for info/setup/build and for every launch on a
 * physical Apple TV, and drives `xcrun devicectl`/`simctl` directly for device
 * resolution, install, lifecycle, and uninstall.
 *
 * flutter-tvos is a community fork and is not verifiable on-device from this
 * project, so the command surface reconstructed here is a best effort. Each
 * flutter-tvos invocation a maintainer should confirm on real hardware carries a
 * `// NOTE:` comment.
 *
 * The `flutter-tvos` binary usually lives in a dir (default `~/flutter-tvos/bin`)
 * that only the user's shell profile adds to PATH. A GUI-spawned MCP server runs
 * a NON-login shell inheriting the GUI/launchd PATH, which omits that dir — so
 * every flutter-tvos invocation prepends the configured bin dir to PATH (see
 * {@link withFlutterTvosPath}). Device DISCOVERY does NOT depend on flutter-tvos:
 * it uses `xcrun devicectl`/`simctl` (always on the standard PATH), mirroring the
 * iOS adapter. Backing discovery on flutter-tvos made a paired Apple TV invisible
 * under the server and silently fell through to a simulator; devicectl reports
 * the same CoreDevice id used for install/launch, so nothing downstream changes.
 *
 * LAUNCH MODES (see `tvosLaunchMode.ts`). The default is debug, the only mode
 * with hot reload and a working Marionette screenshot:
 *  - debug, physical Apple TV: `flutter-tvos run -d <id> --debug` in the app
 *    dir. The engine refuses to run debug in an untraced process, so flutter-tvos
 *    builds, installs, launches the app stopped and attaches lldb before the
 *    Dart VM starts. The runner stays resident behind a control channel (hot
 *    reload/restart) and holds the VM-service forward open; flutter-tvos's
 *    Xcode-debugger fallback is treated as a failure, because it needs an
 *    automation prompt answered.
 *  - profile / release, physical Apple TV: `flutter-tvos run -d <id> --<mode>`.
 *    Profile has a VM service, without hot reload or Marionette screenshots;
 *    release has no VM service. Both say so on the response.
 *  - simulator: `simctl launch --console-pty` of the debug build, the only build
 *    a tvOS simulator runs. A profile/release request there is answered in debug
 *    with a caveat saying so.
 * A requested mode is never swapped for another without the response naming
 * both.
 *
 * GUARDRAILS encoded here:
 *  - Only Apple TV / tvOS targets are ever selected — an iPhone/iPad in the same
 *    device list is excluded (see {@link ../tvosDeviceTarget}).
 *  - A sleeping Apple TV refuses a foreground launch ("System is asleep"). The
 *    launch fails on that line instead of waiting out its timeout, and the
 *    recovery wakes the box with pyatv's `atvremote turn_on` when it is
 *    installed and paired, then retries once; without it the failure says how
 *    to wake it.
 *  - CoreDevice drops network-paired Apple TVs mid-transfer ("Connection reset
 *    by peer"). An install or launch that fails that way is retried once.
 *
 * INPUT: `flutter_key` sends Siri Remote presses through pyatv's `atvremote`
 * (Companion protocol) when it is installed and paired, see {@link ../atvRemote};
 * otherwise it reports `{supported:false}` with the setup steps. There is no
 * free cursor on tvOS, so pointer move/scroll is always unsupported, and taps go
 * through Marionette over the VM service.
 *
 * SCREENSHOTS: the simulator uses `simctl io screenshot`; a physical Apple TV
 * uses `pymobiledevice3 developer dvt screenshot --native`, addressed by its
 * hardware UDID (not the CoreDevice id).
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { TargetKind } from "../localBackend.js";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CommandResult,
  quote,
  RunOptions,
  runShell,
  tail,
} from "../cli.js";
import {
  appleDeviceOpenUrlUnsupported,
  buildSimctlOpenUrlCommand,
  invalidOpenUrlReason,
  OpenUrlResult,
} from "../openUrl.js";
import {
  allocateControlChannel,
  buildPtyCaptureCommand,
  ControlChannel,
  launchAndCaptureUri as neutralLaunchAndCaptureUri,
  SettleOptions,
} from "../launchCapture.js";
import {
  buildPymobiledevice3ScreenshotCommand,
  buildSimctlScreenshotCommand,
  defaultScreenshotPath,
  readPngDimensions,
  ScreenshotResult,
} from "../screenshot.js";
import { RecordResult } from "../recording.js";
import { logger } from "../logger.js";
import { parseAnnouncedVmServiceUri, parseVmServiceUri } from "../vmServiceUri.js";
import { KILL_STALE_EXIT, killScopedLaunchDrivers } from "../killStaleScope.js";
import { tvosDeviceSupportDiagnostic } from "../tvosDeviceSupport.js";
import {
  parseDevicectlAppleTvs,
  parseTvosSimulators,
  resolveTvosTarget,
  TvosDeviceKind,
  TvosDeviceResolution,
} from "../tvosDeviceTarget.js";
import {
  isTvosAsleepFailure,
  resolveTvosLaunchMode,
  TVOS_ASLEEP_SIGNATURES,
  TVOS_CONNECTION_RESET_PATTERN,
  TVOS_DEVICE_DEBUG_FAILURE_SIGNATURES,
  TVOS_DEVICE_LAUNCH_TIMEOUT_MS,
  TVOS_PROFILE_NO_VM_SERVICE_REASON,
  TVOS_RELEASE_NO_VM_SERVICE_REASON,
  TVOS_RESIDENT_SETTLE_SIGNATURES,
  TVOS_SETTLE_GRACE_MS,
  tvosLaunchModeCaveat,
  TvosLaunchMode,
} from "../tvosLaunchMode.js";
import {
  AtvRemoteInputController,
  AtvTarget,
  ATVREMOTE_INSTALL_HINT,
  buildAtvremoteCommand,
  describeAtvremoteFailure,
  resolveAtvremote,
} from "../atvRemote.js";
import {
  Pymobiledevice3Resolution,
  resolvePymobiledevice3,
} from "../pymobiledevice3Locate.js";
import { dartDefineArgs } from "../dartDefine.js";
import {
  BuildMode,
  BuildOptions,
  BuildResult,
  DeviceResolution,
  InputController,
  isLaunchFailure,
  LaunchOutcome,
  Platform,
} from "../types.js";
import {
  AppLifecycle,
  DeviceTargetPreference,
  InstallOptions,
  KillStaleScope,
  KillStaleScopeKind,
  LaunchRecovery,
  PlatformAdapter,
} from "./platformAdapter.js";

/**
 * The neutral system app foregrounded to background the app under test. tvOS has
 * no user-facing Settings deep-link as reliable as iOS's, but the built-in
 * `com.apple.TVSettings` (the tvOS Settings app) launches on-device and pushes
 * the app to the background WITHOUT killing it, exercising didEnterBackground.
 */
export const TVOS_BACKGROUND_APP_ID = "com.apple.TVSettings";

/**
 * Log signatures that mean a tvOS `flutter-tvos run` launch failed and polling
 * should stop early. Mirrors {@link IOS_FAILURE_SIGNATURES} but matches the
 * flutter-tvos run output. Transient "waiting"/"starting" lines must NOT match —
 * only terminal failures — so the poll fails fast on a real error rather than
 * hanging for the full timeout. A device debug launch and a missing flutter-tvos
 * are the common terminal tvOS failures.
 */
export const TVOS_FAILURE_SIGNATURES: RegExp[] = [
  /No devices found/i,
  /No supported devices connected/i,
  /No .*Apple TV.* found/i,
  /Unable to find bundle/i,
  /Could not build the (?:precompiled )?application/i,
  /Error launching application on/i,
  /code sign(?:ing)? error/i,
  /requires a provisioning profile/i,
  /Verify that the Developer App certificate/i,
  /Unable to install/i,
  /flutter-tvos:? (?:command )?not found/i,
  /Error: flutter-tvos not found/i,
];

/** Configuration a TvosAdapter needs from the server. */
export interface TvosAdapterConfig {
  /** Absolute path to the Flutter app (dir containing pubspec.yaml). */
  appDir: string;
  /** Apple TV device pin (name/udid), optional. */
  device?: string;
  /** Bundle id, for uninstall/lifecycle. */
  appId: string;
  /** Dir holding the flutter-tvos bin, prepended to PATH (default ~/flutter-tvos/bin). */
  flutterTvosBinDir?: string;
  /** Shell commands run in order (cwd=appDir) before build; non-zero exit aborts. */
  preBuild?: string[];
  /** `FLUTTER_DEVICE_TVOS_LAUNCH_MODE`: the mode used when a call names none. */
  launchMode?: TvosLaunchMode;
  /**
   * `FLUTTER_DEVICE_TVOS_ATV_ID`: pyatv's identifier for the Apple TV. Without it
   * atvremote addresses the box by the name devicectl reports.
   */
  atvId?: string;
  /** Injected for tests; defaults to {@link resolveAtvremote}. */
  resolveAtvremote?: () => string | undefined;
  /** Injected for tests; defaults to {@link resolvePymobiledevice3}. */
  resolvePymobiledevice3?: () => Pymobiledevice3Resolution;
  /** Injected for tests; defaults to Xcode's tvOS DeviceSupport directory. */
  deviceSupportRoot?: string;
  /** Wait between checks that a terminated app has gone; injected for tests. */
  terminatePollMs?: number;
}

/**
 * Command lines that identify a tvOS launch driver.
 *
 * `flutter-tvos` names the tvOS toolchain specifically, which is what keeps a
 * tvOS teardown off an iPhone/Android `flutter run` on the same host. It covers
 * `flutter-tvos run` and the PATH-guarded wrapper around it; the Dart snapshot
 * and compiler underneath are reached as their children, never by name.
 */
export const TVOS_RUN_DRIVER_PATTERNS: readonly RegExp[] = [/flutter-tvos/];

/**
 * A Dart `flutter_tools … run` snapshot is REPORTED, never killed, by the tvOS
 * teardown.
 *
 * The snapshot under a tvOS run is torn down as a child of the pattern above.
 * One whose parent is already gone is indistinguishable from an iPhone's or an
 * Android phone's session — matching it by name is how a tvOS deploy used to
 * kill those — so an orphan can only be named, which at least tells a caller
 * what may still be holding the device.
 */
const TVOS_REPORT_ONLY_PATTERNS: readonly RegExp[] = [
  /flutter_tools(?:\.snapshot)?\s+run(?:\s|$)/,
];

export class TvosAdapter implements PlatformAdapter {
  readonly platform: Platform = "tvos";

  /**
   * `flutter-tvos` names this toolchain and no other, and one Apple TV is
   * modelled, so the teardown identifies its own processes without a device —
   * see {@link killStale} for why device attribution is not used here.
   */
  readonly killStaleScope: KillStaleScopeKind = "platform";

  /** Cached input controller so its selected mode survives across tool calls. */
  private inputController: InputController | undefined;

  /**
   * The kind (device vs simulator) of the most recently resolved target. Cached
   * so launch/lifecycle/uninstall pick the right toolchain (devicectl vs simctl)
   * without re-listing. discoverDevice refreshes it.
   */
  private lastKind: TvosDeviceKind = "device";

  /**
   * The effective flutter-tvos bin dir: the configured value, else the
   * documented default (`~/flutter-tvos/bin`). Prepended to PATH for
   * flutter-tvos invocations so the fork resolves even when it is not on the
   * (often non-login) PATH the server inherited.
   */
  private readonly binDir: string;

  /** The full last resolution: its name addresses atvremote, its hardware UDID pymobiledevice3. */
  private lastResolution: TvosDeviceResolution | undefined;

  constructor(private readonly config: TvosAdapterConfig) {
    this.binDir =
      config.flutterTvosBinDir ?? defaultFlutterTvosBinDir(os.homedir());
  }

  get appId(): string {
    return this.config.appId;
  }

  private requestedMode(mode?: BuildMode, debug?: boolean): TvosLaunchMode {
    return resolveTvosLaunchMode({
      explicitMode: mode,
      explicitDebug: debug,
      envMode: this.config.launchMode,
    });
  }

  private atvremoteBinary(): string | undefined {
    return (this.config.resolveAtvremote ?? resolveAtvremote)();
  }

  private pymobiledevice3(): Pymobiledevice3Resolution {
    return (this.config.resolvePymobiledevice3 ?? resolvePymobiledevice3)();
  }

  /**
   * A device launch rebuilds, and a debug one also waits on lldb, so the 180s
   * every other platform defaults to cannot fit it.
   */
  defaultLaunchTimeoutMs(): number | undefined {
    return this.lastKind === "device" ? TVOS_DEVICE_LAUNCH_TIMEOUT_MS : undefined;
  }

  /**
   * Run a `flutter-tvos <subcommand> [args...]` invocation, prepending the
   * flutter-tvos bin dir to PATH when it exists (see {@link withFlutterTvosPath})
   * so the fork resolves under a GUI-spawned server's non-login-shell PATH.
   * Everything runs with `cwd: appDir`. Discovery does NOT go through here (it
   * uses devicectl/simctl directly).
   */
  private runFlutterTvos(
    subcommand: string,
    args: string[] = [],
    options: RunOptions = {}
  ): Promise<CommandResult> {
    const base = ["flutter-tvos", subcommand, ...args].join(" ");
    const command = withFlutterTvosPath(
      base,
      this.binDir,
      (dir) => fs.existsSync(dir)
    );
    return runShell(command, { cwd: this.config.appDir, ...options });
  }

  /**
   * Device + environment status: flutter-tvos's own view of the toolchain +
   * devices, combined with `xcrun devicectl list devices` for PHYSICAL Apple TVs
   * (devicectl is always on the standard PATH; flutter-tvos may miss a paired
   * device under a non-login-shell server, so both are shown).
   */
  async info(): Promise<CommandResult> {
    // NOTE: `flutter-tvos devices` mirrors `flutter devices`; verify the fork
    // exposes this subcommand and its output shape on real hardware.
    const flutterTvos = await this.runFlutterTvos("devices", [], {
      timeoutMs: 60000,
    });
    const devicectl = await runShell(
      "xcrun devicectl list devices 2>&1 || echo 'devicectl unavailable'",
      { cwd: this.config.appDir, timeoutMs: 30000 }
    );
    const combined =
      "=== flutter-tvos devices ===\n" +
      flutterTvos.combined +
      "\n=== physical Apple TVs (devicectl) ===\n" +
      devicectl.combined;
    return {
      code: flutterTvos.code,
      stdout: flutterTvos.stdout + "\n" + devicectl.stdout,
      stderr: flutterTvos.stderr + devicectl.stderr,
      combined,
      success: flutterTvos.success,
      timedOut: flutterTvos.timedOut || devicectl.timedOut,
    };
  }

  /**
   * Verify/prepare the tvOS toolchain via `flutter-tvos doctor`. There is no
   * `.tizen-target`-style file to write — Apple TVs pair over the network via
   * Xcode/devicectl and simulators are managed by simctl — so `wrote` stays
   * undefined.
   */
  async setup(_opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }> {
    // NOTE: `flutter-tvos doctor` mirrors `flutter doctor`; a maintainer should
    // confirm the fork ships `doctor`. `--version` is an equally valid toolchain
    // check if `doctor` is absent.
    const result = await this.runFlutterTvos("doctor", [], {
      timeoutMs: 120000,
    });
    return { result };
  }

  /**
   * Build the app for Apple TV via `flutter-tvos build tvos`.
   *
   * Any configured {@link TvosAdapterConfig.preBuild} shell commands run first
   * (in order, cwd=appDir); the first non-zero exit aborts the build and is
   * returned as the failing result.
   *
   * A `simulator` profile builds for the tvOS simulator, always debug (JIT).
   * Otherwise the build is for a PHYSICAL Apple TV in the resolved mode (debug by
   * default). A device DEBUG build is not done here: a debug app only runs with
   * lldb attached at launch, so `flutter_deploy` builds, installs and launches it
   * in one `flutter-tvos run --debug`. Building it separately would cost a full
   * build that the deploy then repeats. `skip_flutter` short-circuits to a no-op
   * success; `skip_rust` is accepted for interface parity and ignored (a Rust
   * engine, if any, builds inside Xcode via cargokit on tvOS, not as a separate
   * step).
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    if (opts.skip_flutter) {
      return succeeded("skip_flutter set — reusing existing tvOS build artifact.");
    }

    // Run pre-build shell commands (cwd=appDir); abort on the first failure.
    const preBuildFailure = await this.runPreBuild();
    if (preBuildFailure) {
      return {
        result: preBuildFailure,
        enospc: /No space left on device/i.test(preBuildFailure.combined),
        installFailed: false,
        launchedDisplay: false,
      };
    }

    const forSimulator = opts.profile === "simulator";
    const mode = this.requestedMode(opts.mode, opts.debug);
    // flutter-tvos ships a dedicated `build tvos` subcommand (verified on-device)
    // with a `--[no-]simulator` flag — NOT the `build ios` target.
    const flags: string[] = forSimulator ? ["tvos", "--simulator", "--debug"] : ["tvos"];
    if (!forSimulator) {
      if (mode === "debug") {
        return succeeded(
          "Nothing built: a physical Apple TV debug build is produced by flutter_deploy, " +
            "which runs `flutter-tvos run --debug` (build, install, launch, lldb attach) in one " +
            "step, and the app cannot start in debug without the debugger that run attaches. " +
            "Call flutter_deploy (mode debug, the default) directly."
        );
      }
      // A physical build must be CODE-SIGNED (installed via devicectl), which
      // `flutter-tvos build tvos` does using the Xcode project's development team
      // — so no --no-codesign.
      flags.push(`--${mode}`);
    }
    for (const token of dartDefineArgs(opts.dartDefine)) flags.push(quote(token));

    const result = await this.runFlutterTvos("build", flags, {
      timeoutMs: 2400000, // 40 min — flutter-tvos engine + Rust-in-Xcode can run long.
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
        /Build failed/i.test(combined) ||
        /Install failed/i.test(combined),
      launchedDisplay: false,
    };
  }

  /**
   * Run each configured pre-build shell command in order (cwd=appDir). Returns
   * the first FAILING result (so build() can abort and surface it), or undefined
   * when all succeeded / none were configured.
   */
  private async runPreBuild(): Promise<CommandResult | undefined> {
    for (const command of this.config.preBuild ?? []) {
      logger.info("tvOS pre-build step", { command });
      const result = await runShell(command, {
        cwd: this.config.appDir,
        timeoutMs: 1800000,
      });
      if (!result.success) return result;
    }
    return undefined;
  }

  /**
   * List and parse physical Apple TVs (devicectl) and tvOS simulators (simctl)
   * once. Shared by {@link discoverDevice} so both id spaces come from the same
   * command outputs.
   *
   * Physical discovery uses `xcrun devicectl list devices` — NOT `flutter-tvos
   * devices`. devicectl is always on the standard PATH; flutter-tvos is only on
   * PATH when the user's profile has been sourced, which a GUI-spawned MCP server
   * (non-login shell) does not do. Backing discovery on flutter-tvos made a paired
   * Apple TV invisible under the server and silently fell through to a simulator.
   * devicectl reports the SAME CoreDevice id used for install/launch, so nothing
   * downstream changes.
   *
   * `devicectl list devices --json-output <file>` writes JSON to a file (it does
   * not stream it to stdout the way a `-` sink would reliably across versions),
   * so a temp file is used and read back, then removed.
   */
  private async listTargets(): Promise<{
    physical: ReturnType<typeof parseDevicectlAppleTvs>;
    simulators: ReturnType<typeof parseTvosSimulators>;
  }> {
    const [devicectlJson, simOut] = await Promise.all([
      this.listPhysicalDevicectlJson(),
      runShell("xcrun simctl list devices --json 2>/dev/null", {
        timeoutMs: 20000,
      }),
    ]);
    return {
      physical: parseDevicectlAppleTvs(devicectlJson),
      simulators: parseTvosSimulators(simOut.stdout),
    };
  }

  /**
   * Run `xcrun devicectl list devices --json-output <tmpfile>` and return the
   * file's JSON body (empty string on any failure — the parser then yields no
   * physical devices). The temp file is always cleaned up.
   */
  private async listPhysicalDevicectlJson(): Promise<string> {
    const tmpFile = path.join(
      os.tmpdir(),
      `flutter-device-mcp-devicectl-${process.pid}-${Date.now()}.json`
    );
    try {
      const result = await runShell(
        `xcrun devicectl list devices --json-output ${quote(tmpFile)} 2>/dev/null`,
        { timeoutMs: 30000 }
      );
      if (!result.success) return "";
      try {
        return fs.readFileSync(tmpFile, "utf8");
      } catch {
        return "";
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Resolve the tvOS target across physical Apple TVs and simulators. A named
   * target (per-call `udid`, else APPLE_TV_DEVICE/FLUTTER_DEVICE_TVOS_DEVICE) that is
   * not available is refused, never replaced, and a requested `kind` is never
   * served by the other class. Only Apple TV / tvOS targets are ever considered
   * (iPhones/iPads are excluded by the parser). Throws an McpError when nothing
   * is usable. Records the resolved kind for later devicectl/simctl selection.
   */
  async discoverDevice(
    preference: DeviceTargetPreference = {}
  ): Promise<TvosDeviceResolution> {
    const { physical, simulators } = await this.listTargets();
    // Make the resolution order explicit and logged: a PHYSICAL paired Apple TV
    // (devicectl) is preferred over a simulator; a simulator is only chosen when
    // no physical Apple TV is available. This is where an earlier bug hid —
    // physical discovery returned nothing (flutter-tvos off PATH) and it silently
    // fell through to a shutdown sim. Logging the candidate sets makes that
    // visible.
    logger.info("tvOS device discovery", {
      physical: physical.map((d) => ({
        id: d.id,
        name: d.name,
        available: d.available,
      })),
      simulators: simulators.map((d) => ({
        id: d.id,
        name: d.name,
        available: d.available,
      })),
      pinned: this.config.device,
    });
    const resolution = resolveTvosTarget(this.config.device, physical, simulators, {
      udid: preference.udid,
      kind: preference.kind,
    });
    if (!resolution) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No Apple TV or tvOS simulator found. A physical Apple TV must be PAIRED " +
          "with this Mac to appear in `xcrun devicectl list devices` (pair once via " +
          "`xcrun devicectl manage pair`); or boot a tvOS simulator " +
          "(xcrun simctl boot <udid>). Set APPLE_TV_DEVICE (or FLUTTER_DEVICE_TVOS_DEVICE) " +
          "to pin a specific CoreDevice id / simulator UDID. (iPhone/iPad devices are " +
          "intentionally excluded — this adapter targets Apple TV / tvOS only.)"
      );
    }
    if (resolution.warning) {
      logger.warn("Stale APPLE_TV_DEVICE/FLUTTER_DEVICE_TVOS_DEVICE pin", resolution);
    }
    logger.info("tvOS resolved target", {
      target: resolution.target,
      kind: resolution.kind,
      source: resolution.source,
    });
    this.lastKind = resolution.kind;
    this.lastResolution = resolution;
    return resolution;
  }

  /**
   * Missing tvOS debug symbols for a physical Apple TV (see
   * {@link tvosDeviceSupportDiagnostic}). Null for a simulator, and null when
   * discovery fails, so it can never fail a deploy or an info call.
   */
  async environmentDiagnostic(
    resolved?: DeviceResolution
  ): Promise<string | null> {
    try {
      const resolution =
        (resolved as TvosDeviceResolution | undefined) ??
        (await this.discoverDevice({ readOnly: true }));
      if (resolution.kind !== "device") return null;
      return tvosDeviceSupportDiagnostic(resolution, this.config.deviceSupportRoot);
    } catch (error) {
      logger.warn("tvOS DeviceSupport diagnostic skipped", { error });
      return null;
    }
  }

  /**
   * A physical Apple TV debug app has no kernel compiler, so `reloadSources`
   * fails on every isolate with "Error while starting Kernel isolate task". Only
   * the flutter tool's `r`, which compiles on this Mac, can reload it. Only a
   * device devicectl names as a paired Apple TV is refused; anything else,
   * including a devicectl that could not be read, is left to try, and a reload
   * that then fails for want of a compiler is reported as not triggered.
   */
  async vmServiceReloadRefusal(device: string): Promise<string | undefined> {
    const physical = parseDevicectlAppleTvs(await this.listPhysicalDevicectlJson());
    if (!physical.some((tv) => tv.id === device)) return undefined;
    return (
      "A VM-service reload cannot work on a physical Apple TV: the debug app has no " +
      "on-device kernel compiler, so reloadSources fails on every isolate. Only the " +
      "flutter tool's `r` over the launch's control channel can reload it."
    );
  }

  /**
   * Install the already-built app on the resolved target.
   *
   * Physical Apple TV: `xcrun devicectl device install app` with the Runner.app
   * for the resolved mode (see {@link artifactPathFor}), retried once when
   * CoreDevice drops the connection mid-transfer. A debug deploy that goes on to
   * launch installs nothing here: `flutter-tvos run --debug` builds and installs
   * the debug app itself, and installing the last AOT build first would only put
   * the wrong binary on the box for the length of a build. Simulator:
   * `xcrun simctl install` with the `Debug-appletvsimulator` Runner.app. The
   * deploy calls install THEN launch, which keeps the ENOSPC uninstall-and-retry
   * seam uniform with the other adapters.
   */
  async install(device: string, opts: InstallOptions): Promise<CommandResult> {
    const mode = this.requestedMode(opts.mode, opts.debug);
    if (this.lastKind === "device" && mode === "debug" && opts.launchFollows) {
      return okResult(
        "Install deferred: the debug launch (`flutter-tvos run --debug`) builds and installs " +
          "the debug app itself."
      );
    }
    const appPath = this.artifactPathFor(this.lastKind, mode);
    if (this.lastKind === "device" && mode === "debug" && !fs.existsSync(appPath)) {
      const message =
        `No debug Apple TV build at ${appPath}. A device debug build only comes out of ` +
        "`flutter-tvos run --debug`; deploy with a launch (omit no_launch) to build, install " +
        "and attach in one step.";
      return {
        code: 1,
        stdout: "",
        stderr: message,
        combined: message,
        success: false,
        timedOut: false,
      };
    }
    if (this.lastKind === "simulator") {
      // A `simctl install` against a SHUTDOWN simulator fails with SimError 405
      // ("Unable to lookup in current state: Shutdown"). Boot it first (idempotent
      // — `simctl boot` on an already-booted sim exits non-zero, hence `|| true`)
      // so a resolved-but-shut-down sim never silently 405s the install. This is
      // the sim-side of the "no silent degrade to a shutdown/absent target" rule.
      const boot = await runShell(
        `xcrun simctl boot ${quote(device)} 2>/dev/null || true`,
        { timeoutMs: 120000 }
      );
      logger.info("tvOS simulator boot before install", {
        device,
        code: boot.code,
      });
      return runShell(
        `xcrun simctl install ${quote(device)} ${quote(appPath)}`,
        { timeoutMs: 300000 }
      );
    }
    const install = () =>
      runShell(
        `xcrun devicectl device install app --device ${quote(device)} ${quote(appPath)}`,
        { timeoutMs: 600000 }
      );
    const first = await install();
    if (first.success || !TVOS_CONNECTION_RESET_PATTERN.test(first.combined)) {
      return first;
    }
    logger.warn("tvOS install hit a connection reset; retrying once", { device });
    const second = await install();
    const note = "First install attempt failed with \"Connection reset by peer\"; retried once.\n";
    return { ...second, combined: note + second.combined };
  }

  /**
   * The built Runner.app path for a device kind and mode.
   *
   * A profile path of `Release-appletvos` reads as a mistake and is not one:
   * flutter-tvos derives the Xcode configuration from the Flutter build mode
   * alone — debug maps to `Debug`, EVERY other mode maps to `Release` — and
   * stages the product under `build/tvos/<configuration>-<sdk>/Runner.app`. The
   * Runner project defines a Profile configuration, but flutter-tvos never
   * selects it, so `Profile-appletvos` is never written. Read from the
   * flutter-tvos toolchain source (`lib/build_targets/application.dart`).
   * Simulator builds are always debug, hence `Debug-appletvsimulator`.
   *
   * Only the bundle {@link build} produces for that kind and mode is returned,
   * and nothing else on disk is discovered: a fallback could only find a bundle
   * this adapter did not build (a stale sibling from a manual Xcode run), and
   * installing that is worse than failing on the path the build should have
   * written.
   */
  private artifactPathFor(kind: TvosDeviceKind, mode: TvosLaunchMode): string {
    return path.join(this.config.appDir, "build", "tvos", tvosArtifactDir(kind, mode), "Runner.app");
  }

  /**
   * Launch and capture the Dart VM Service URI, in the resolved mode.
   *
   * PHYSICAL Apple TV: `flutter-tvos run -d <id> --<mode>` in the app dir,
   * through a pty so the announcement line flushes. In debug, flutter-tvos
   * builds, installs, launches the app stopped and attaches lldb, which the
   * engine requires before it will start a debug VM. The run is LEFT RUNNING: it
   * holds the VM-service forward open and, in debug, takes `r`/`R` over the
   * control channel. Only the "A Dart VM Service on <device> is available at:"
   * line is read, because the app's own console output reaches the same log
   * with the device-side URI, which is not connectable from this Mac.
   *
   * A device launch always builds, so `dartDefine` is passed to the run and the
   * app that starts is compiled with it.
   *
   * SIMULATOR: `simctl launch --console-pty` of the installed debug build, the
   * only build a tvOS simulator runs; a profile/release request there carries a
   * caveat naming both modes.
   */
  async launchAndCaptureUri(
    device: string,
    timeoutMs: number,
    mode?: BuildMode,
    dartDefine?: Record<string, string>
  ): Promise<LaunchOutcome> {
    const requested = this.requestedMode(mode);
    if (this.lastKind === "simulator") {
      const outcome = await this.launchSimulator(device, timeoutMs);
      return isLaunchFailure(outcome)
        ? outcome
        : {
            ...outcome,
            launchMode: "debug",
            launchModeCaveat: tvosLaunchModeCaveat(requested, "debug") ?? undefined,
          };
    }
    await this.wakeBestEffort();
    const outcome = await this.launchDevice(device, timeoutMs, requested, dartDefine);
    if (isLaunchFailure(outcome)) {
      if (requested === "debug") {
        // flutter-tvos answers a failed lldb attach by driving Xcode's debugger
        // through AppleScript, which waits on an automation prompt nobody is
        // there to answer. Ending the run here keeps it from starting.
        await this.killStale({ kind: "device", device });
      }
      return outcome;
    }
    return {
      ...outcome,
      launchMode: requested,
      launchModeCaveat: tvosLaunchModeCaveat(requested, requested) ?? undefined,
      reloadNeedsOwningRun: true,
    };
  }

  /**
   * A tvOS simulator is this machine, so loopback reaches a local backend; a
   * physical Apple TV needs a routable address. `lastKind` is set by
   * {@link discoverDevice}, so this answers for the target actually resolved.
   */
  targetKind(): TargetKind {
    return this.lastKind === "simulator" ? "simulator" : "device";
  }

  private async launchDevice(
    device: string,
    timeoutMs: number,
    mode: TvosLaunchMode,
    dartDefine?: Record<string, string>
  ): Promise<LaunchOutcome> {
    // A cold profile/release run has no reload or restart to drive, so only
    // debug gets a channel; one elsewhere would advertise an inner loop that
    // cannot exist.
    const controlChannel = mode === "debug" ? allocateControlChannel() : undefined;
    const command = buildTvosDeviceRunCommand({
      appDir: this.config.appDir,
      device,
      mode,
      extraArgs: dartDefineArgs(dartDefine),
      flutterTvosBinDir: this.binDir,
      dirExists: (dir) => fs.existsSync(dir),
      controlChannel,
    });
    return neutralLaunchAndCaptureUri(
      command,
      this.config.appDir,
      timeoutMs,
      tvosDeviceFailureSignatures(mode),
      controlChannel?.fifoPath,
      tvosSettleOptionsFor(mode),
      parseAnnouncedVmServiceUri
    );
  }

  /**
   * Wake the Apple TV before a launch, when pyatv's atvremote is installed. A
   * sleeping box refuses the launch only after the build, which on a device
   * takes minutes, so waking first saves that round trip. Any failure is
   * ignored here: the launch's own asleep signature and
   * {@link recoverLaunchFailure} report it with what to do.
   */
  private async wakeBestEffort(): Promise<void> {
    const binary = this.atvremoteBinary();
    const target = this.atvTarget();
    if (!binary || !target) return;
    const result = await runShell(buildAtvremoteCommand(binary, target, "turn_on"), {
      timeoutMs: 30000,
    });
    logger.info("tvOS pre-launch wake", { code: result.code, success: result.success });
  }

  /** The Apple TV atvremote addresses: the configured pyatv id, else the devicectl name. */
  private atvTarget(): AtvTarget | undefined {
    if (this.config.atvId) return { id: this.config.atvId };
    const name = this.lastResolution?.kind === "device" ? this.lastResolution.name : undefined;
    return name ? { name } : undefined;
  }

  /**
   * After a failed launch: a sleeping Apple TV is woken with atvremote and the
   * launch retried once; a connection reset is retried once. Anything else is
   * left to the caller.
   */
  async recoverLaunchFailure(_device: string, log: string): Promise<LaunchRecovery> {
    if (isTvosAsleepFailure(log)) {
      const binary = this.atvremoteBinary();
      const target = this.atvTarget();
      if (!binary || !target) {
        return {
          action: "none",
          note:
            "The Apple TV is asleep and refused the launch. Wake it (press a remote button, or " +
            "`atvremote turn_on`) and deploy again. To have deploys wake it themselves: " +
            ATVREMOTE_INSTALL_HINT,
        };
      }
      const wake = await runShell(buildAtvremoteCommand(binary, target, "turn_on"), {
        timeoutMs: 30000,
      });
      if (!wake.success) {
        return {
          action: "none",
          note: `The Apple TV is asleep and the wake failed. ${describeAtvremoteFailure(wake)}`,
        };
      }
      return { action: "retry", note: "The Apple TV was asleep; woke it with atvremote turn_on." };
    }
    if (TVOS_CONNECTION_RESET_PATTERN.test(log)) {
      return {
        action: "retry",
        note: "CoreDevice reset the connection to the Apple TV mid-launch; retrying once.",
      };
    }
    return { action: "none" };
  }

  /**
   * Simulator launch: `simctl launch --console-pty` prints the loopback VM
   * service URI (the sim shares the Mac's loopback), captured with the neutral
   * loopback parser.
   */
  private async launchSimulator(
    device: string,
    timeoutMs: number
  ): Promise<LaunchOutcome> {
    // --terminate-running-process replaces a prior instance; --console-pty makes
    // the app's stdout (incl. the "Dart VM Service … available at:" line) flow
    // back. simctl launch returns promptly with the pid; the URI is printed by
    // the app moments later, so bound the wait with the timeout.
    const launch = await runShell(
      `xcrun simctl launch --console-pty --terminate-running-process ${quote(device)} ${quote(this.appId)}`,
      { timeoutMs }
    );
    const uri = parseVmServiceUri(launch.combined);
    if (!uri) {
      return {
        failed: true,
        reason:
          "Launched on the tvOS simulator but did not observe a Dart VM Service " +
          "URI. Ensure the installed simulator build is a DEBUG build (the sim is " +
          "JIT-only and emits the loopback VM-service URI on launch).",
        logPath: "",
        pid: undefined,
        logTail: tailLines(launch.combined, 40),
      };
    }
    return {
      vmServiceUriWs: uri.ws,
      vmServiceUriHttp: uri.http,
      logPath: "",
      pid: undefined,
    };
  }

  /**
   * Open a URL on the resolved target — supported on a SIMULATOR only.
   *
   * `simctl openurl` drives the real URL-handling path (custom scheme or
   * universal link), so it exercises the app's link plumbing rather than
   * bypassing it. A physical Apple TV target has no equivalent: Apple ships no
   * url-open verb on `devicectl`, and idb's open/ui commands reject a physical
   * target. That returns `{supported:false}` with the reason, because a silent
   * no-op there would read as "the deep link is broken".
   *
   * `packageOrBundleId` is accepted for seam parity and ignored: simctl routes
   * the URL by scheme/association exactly as the OS would.
   */
  async openUrl(
    url: string,
    _packageOrBundleId?: string,
    preference?: DeviceTargetPreference
  ): Promise<OpenUrlResult> {
    const invalid = invalidOpenUrlReason(url);
    if (invalid) {
      return { opened: false, url, reason: invalid };
    }
    const resolution = await this.discoverDevice(preference);
    if (this.lastKind !== "simulator") {
      return {
        opened: false,
        supported: false,
        url,
        device: resolution.target,
        ...appleDeviceOpenUrlUnsupported("Apple TV"),
      };
    }
    const command = buildSimctlOpenUrlCommand(resolution.target, url);
    const result = await runShell(command, { timeoutMs: 30000 });
    if (!result.success) {
      return {
        opened: false,
        url,
        device: resolution.target,
        command,
        reason: `simctl openurl failed on ${resolution.target}.`,
        output: tail(result.combined, 20),
      };
    }
    return { opened: true, url, device: resolution.target, command };
  }

  async uninstall(device: string, appId: string): Promise<CommandResult> {
    const command =
      this.lastKind === "simulator"
        ? `xcrun simctl uninstall ${quote(device)} ${quote(appId)}`
        : `xcrun devicectl device uninstall app --device ${quote(device)} ${quote(appId)}`;
    return runShell(command, { timeoutMs: 120000 });
  }

  /**
   * Capture the current screen of the resolved target (the same resolution a
   * deploy uses, `device_udid` and `target` included).
   *
   * SIMULATOR: `xcrun simctl io <udid> screenshot`. PHYSICAL Apple TV:
   * `pymobiledevice3 developer dvt screenshot --native --udid <hardware UDID>`.
   * `--native` rides the tunnel macOS's own `remoted` already holds to a
   * network-paired Apple TV, so no root tunnel daemon is needed; pymobiledevice3
   * addresses the box by its hardware UDID, not the CoreDevice id devicectl
   * uses. The capture is the whole HDMI frame, not only the Flutter view.
   */
  async screenshot(opts: {
    outPath?: string;
    includeBase64?: boolean;
    deviceUdid?: string;
    target?: "device" | "simulator";
  }): Promise<ScreenshotResult> {
    const resolution = await this.discoverDevice({ udid: opts.deviceUdid, kind: opts.target });
    const identity: Pick<ScreenshotResult, "device" | "deviceName" | "deviceKind"> = {
      device: resolution.target,
      deviceName: resolution.name,
      deviceKind: resolution.kind,
    };
    const outPath = opts.outPath ?? defaultScreenshotPath("tvos");
    if (resolution.kind === "simulator") {
      const result = await runShell(
        buildSimctlScreenshotCommand(resolution.target, outPath),
        { timeoutMs: 30000 }
      );
      if (!result.success || !fs.existsSync(outPath)) {
        return {
          captured: false,
          via: "simctl",
          ...identity,
          reason: `simctl screenshot failed: ${tail(result.combined, 20)}`,
        };
      }
      return { captured: true, savedPath: outPath, via: "simctl", ...identity, ...describePng(outPath, opts.includeBase64) };
    }
    return this.screenshotPhysical(outPath, opts.includeBase64, resolution, identity);
  }

  private async screenshotPhysical(
    outPath: string,
    includeBase64: boolean | undefined,
    resolution: TvosDeviceResolution,
    identity: Pick<ScreenshotResult, "device" | "deviceName" | "deviceKind">
  ): Promise<ScreenshotResult> {
    const { binary, overrideWarning } = this.pymobiledevice3();
    const common = {
      via: "pymobiledevice3" as const,
      ...identity,
      ...(overrideWarning ? { pymobiledevice3Warning: overrideWarning } : {}),
    };
    if (!binary) {
      return {
        captured: false,
        supported: false,
        ...common,
        reason:
          `The capture target is the physical Apple TV ${resolution.target}, and capturing it ` +
          "needs pymobiledevice3, which was not found. devicectl has no screenshot verb.",
        hint:
          "Install it (`pipx install pymobiledevice3`) or set FLUTTER_DEVICE_PYMOBILEDEVICE3 to its " +
          "path. Marionette take_screenshots over the VM service captures the Flutter view " +
          "without it.",
      };
    }
    if (!resolution.hardwareUdid) {
      return {
        captured: false,
        ...common,
        reason:
          "devicectl did not report this Apple TV's hardware UDID, which pymobiledevice3 " +
          "addresses it by, so the capture cannot be routed to it.",
        hint: "Check `xcrun devicectl list devices` shows the Apple TV as paired and available.",
      };
    }
    const result = await runShell(
      buildPymobiledevice3ScreenshotCommand(binary, outPath, resolution.hardwareUdid, {
        native: true,
      }),
      { timeoutMs: 60000 }
    );
    if (!result.success || !fs.existsSync(outPath)) {
      return {
        captured: false,
        ...common,
        reason: `pymobiledevice3 screenshot failed: ${tail(result.combined, 30)}`,
        hint:
          "The Apple TV must be awake and its Developer Disk Image mounted (a deploy from " +
          "Xcode or flutter-tvos mounts it). A sleeping box drops off the native tunnel; " +
          "wake it (flutter_key HOME with atvremote paired) and retry.",
      };
    }
    return {
      captured: true,
      savedPath: outPath,
      ...common,
      ...describePng(outPath, includeBase64),
    };
  }

  /**
   * Screen RECORDING is not wired for tvOS. Unlike a still screenshot, there is
   * no validated recording path on this framework's tvOS targets today (the
   * physical Apple TV has no recorder at all, and the simulator recording path is
   * not exercised here), so recording reports `{ supported: false }` rather than
   * inventing an unverified path. Use Marionette take_screenshots over the VM
   * service to capture the Flutter view.
   */
  async record(): Promise<RecordResult> {
    return {
      recorded: false,
      supported: false,
      reason:
        "Screen recording is not available on tvOS: a physical Apple TV has no recorder, and no " +
        "recording path is wired for the tvOS simulator here.",
      hint:
        "Use flutter_screenshot (tvOS simulator) for stills, or Marionette take_screenshots over " +
        "the VM service to capture the Flutter view on the device.",
    };
  }

  /**
   * Kill the tvOS launch driver — the `flutter-tvos run` daemon — together with
   * its children.
   *
   * The children are how the Dart `flutter_tools` snapshot and `frontend_server`
   * get torn down now. They used to be matched by name, which on a Mac that also
   * drives an iPhone and an Android phone meant a tvOS deploy killed THEIR
   * sessions (every `flutter run` is a `flutter_tools` snapshot) and the IDE's
   * flutter daemon and compiler besides. `flutter-tvos` names this toolchain and
   * nothing else, so matching that and walking down from it confines the
   * teardown to tvOS.
   *
   * Not scoped to one Apple TV: a single tvOS target is modelled here, and the
   * `-d` value a `flutter-tvos run` carries is not necessarily the id discovery
   * resolves, so device attribution could refuse to kill the very session it
   * exists to clear. A second Apple TV on one host is the case this would have
   * to answer first.
   */
  async killStale(
    _scope: KillStaleScope
  ): Promise<Record<string, CommandResult>> {
    return killScopedLaunchDrivers({
      driverPatterns: TVOS_RUN_DRIVER_PATTERNS,
      driverKey: "flutterTvos",
      reportOnlyPatterns: TVOS_REPORT_ONLY_PATTERNS,
      deviceLabel: "tvOS",
    });
  }

  /**
   * OS-level lifecycle: terminate, background (foreground the tvOS Settings app),
   * and foreground (relaunch the target). devicectl vs simctl is chosen from the
   * last resolved kind. Matches the iOS/Android lifecycle verbs.
   */
  readonly lifecycle: AppLifecycle = {
    terminate: (device, appId) => this.terminate(device, appId),
    background: (device) => {
      // Foreground the neutral system app; the app under test drops to the
      // background WITHOUT being killed (exercises didEnterBackground).
      const command =
        this.lastKind === "simulator"
          ? `xcrun simctl launch ${quote(device)} ${quote(TVOS_BACKGROUND_APP_ID)}`
          : `xcrun devicectl device process launch --device ${quote(device)} ${quote(TVOS_BACKGROUND_APP_ID)}`;
      return runShell(command, { timeoutMs: 60000 });
    },
    foreground: (device, appId) => {
      const command =
        this.lastKind === "simulator"
          ? `xcrun simctl launch ${quote(device)} ${quote(appId)}`
          : `xcrun devicectl device process launch --device ${quote(device)} ${quote(appId)}`;
      return runShell(command, { timeoutMs: 60000 });
    },
  };

  /**
   * Terminate the running app.
   *
   * Simulator: `simctl terminate` by bundle id. Physical Apple TV: the app is
   * found by its installed bundle path, since every Flutter app's process is a
   * `Runner.app/Runner`. Its pids are read BEFORE the resident `flutter-tvos run`
   * is ended, because a debug app sits under that run's lldb and usually exits
   * with it; reading afterwards would report a running app as "not running".
   * Whatever is still alive is terminated with devicectl, and the result is the
   * process list read back afterwards, not the exit code of the terminate.
   */
  private async terminate(
    device: string,
    appId: string
  ): Promise<CommandResult> {
    if (this.lastKind === "simulator") {
      return runShell(`xcrun simctl terminate ${quote(device)} ${quote(appId)}`, {
        timeoutMs: 60000,
      });
    }
    const apps = await runShell(
      `xcrun devicectl device info apps --device ${quote(device)} --bundle-id ${quote(appId)} --json-output - 2>/dev/null`,
      { timeoutMs: 60000 }
    );
    const installed = parseDevicectlAppBundlePath(apps.stdout, appId);
    if (installed.kind === "unreadable") {
      return failedResult(
        `Could not read the apps installed on ${device} (devicectl exited ${apps.code}), so ` +
          `whether ${appId} is running is unknown. Nothing was terminated.`
      );
    }
    if (installed.kind === "absent") {
      const killed = await this.killStale({ kind: "device", device });
      return okResult(
        `${appId} is not installed on ${device}; nothing to terminate.${runnerNote(killed)}`
      );
    }

    const before = await this.readAppPids(device, installed.bundlePath);
    if (before === undefined) {
      return failedResult(
        `Could not read the processes on ${device}, so whether ${appId} is running is ` +
          "unknown. Nothing was terminated."
      );
    }
    const killed = await this.killStale({ kind: "device", device });
    if (before.length === 0) {
      return okResult(`${appId} was not running on ${device}.${runnerNote(killed)}`);
    }

    const afterRunner = await this.readAppPids(device, installed.bundlePath);
    if (afterRunner !== undefined && afterRunner.length === 0) {
      return okResult(
        `${appId} (pid ${before.join(", ")}) exited when its resident flutter-tvos run ` +
          `was ended.${runnerNote(killed)}`
      );
    }

    const targets = afterRunner ?? before;
    const outputs: string[] = [];
    for (const pid of targets) {
      const result = await runShell(
        `xcrun devicectl device process terminate --device ${quote(device)} --pid ${pid}`,
        { timeoutMs: 60000 }
      );
      outputs.push(result.combined.trim());
    }
    const remaining = await this.waitForAppExit(device, installed.bundlePath);
    const detail = outputs.filter(Boolean).join("\n");
    if (remaining === undefined) {
      return failedResult(
        `Sent terminate to ${appId} (pid ${targets.join(", ")}) but could not read the ` +
          `processes back to confirm it exited.${runnerNote(killed)}`,
        detail
      );
    }
    if (remaining.length > 0) {
      return failedResult(
        `${appId} is still running on ${device} (pid ${remaining.join(", ")}) after ` +
          `terminate.${runnerNote(killed)}`,
        detail
      );
    }
    return okResult(
      `Terminated ${appId} (pid ${targets.join(", ")}) on ${device}.${runnerNote(killed)}`
    );
  }

  /** The app's pids, or undefined when the process list could not be read. */
  private async readAppPids(
    device: string,
    bundlePath: string
  ): Promise<number[] | undefined> {
    const processes = await runShell(
      `xcrun devicectl device info processes --device ${quote(device)} --json-output - 2>/dev/null`,
      { timeoutMs: 60000 }
    );
    return findAppPids(processes.stdout, bundlePath);
  }

  private async waitForAppExit(
    device: string,
    bundlePath: string
  ): Promise<number[] | undefined> {
    const pollMs = this.config.terminatePollMs ?? TERMINATE_POLL_MS;
    let remaining: number[] | undefined;
    for (let attempt = 0; attempt < TERMINATE_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
      remaining = await this.readAppPids(device, bundlePath);
      if (remaining !== undefined && remaining.length === 0) return remaining;
    }
    return remaining;
  }

  /**
   * Siri Remote presses on a physical Apple TV, through pyatv's atvremote (see
   * {@link AtvRemoteInputController}). The target is resolved per key, so a
   * simulator, a missing install or a missing pairing each surface as
   * `{supported:false}` with the reason. There is no free cursor on tvOS.
   */
  input(): InputController {
    if (!this.inputController) {
      this.inputController = new AtvRemoteInputController({
        binary: () => this.atvremoteBinary(),
        target: () => this.inputTarget(),
        run: (command) => runShell(command, { timeoutMs: 30000 }),
      });
    }
    return this.inputController;
  }

  private async inputTarget(): Promise<AtvTarget | { unsupported: string }> {
    if (this.config.atvId) return { id: this.config.atvId };
    const resolution = await this.discoverDevice({ readOnly: true });
    if (resolution.kind === "simulator") {
      return {
        unsupported:
          "The resolved tvOS target is a simulator, which has no remote channel. Drive it " +
          "with Marionette over the VM service, or use the Simulator's own remote window.",
      };
    }
    if (!resolution.name) {
      return {
        unsupported:
          "devicectl reported no name for this Apple TV, and atvremote needs its name or " +
          "FLUTTER_DEVICE_TVOS_ATV_ID (its pyatv id from `atvremote scan`).",
      };
    }
    return { name: resolution.name };
  }
}

const TERMINATE_POLL_ATTEMPTS = 5;
const TERMINATE_POLL_MS = 1000;

/** A devicectl `file://` URL as a path, with `/private/var` folded to `/var`. */
export function deviceFilePath(url: string): string {
  let filePath = url;
  if (filePath.startsWith("file://")) {
    try {
      filePath = decodeURIComponent(filePath.slice("file://".length));
    } catch {
      filePath = filePath.slice("file://".length);
    }
  }
  return filePath.replace(/^\/private\/var\//, "/var/");
}

export type InstalledApp =
  | { kind: "installed"; bundlePath: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

/**
 * The installed bundle directory of `appId` from `devicectl device info apps
 * --bundle-id <appId> --json-output -`, normalized with a trailing slash.
 */
export function parseDevicectlAppBundlePath(
  json: string,
  appId: string
): InstalledApp {
  let parsed: { result?: { apps?: unknown } };
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: "unreadable" };
  }
  const apps = parsed?.result?.apps;
  if (!Array.isArray(apps)) return { kind: "unreadable" };
  const app = apps.find(
    (entry) =>
      entry && typeof entry === "object" && (entry as { bundleIdentifier?: unknown }).bundleIdentifier === appId
  ) as { url?: unknown } | undefined;
  if (!app) return { kind: "absent" };
  if (typeof app.url !== "string" || app.url.length === 0) return { kind: "unreadable" };
  const bundlePath = deviceFilePath(app.url);
  return {
    kind: "installed",
    bundlePath: bundlePath.endsWith("/") ? bundlePath : `${bundlePath}/`,
  };
}

/**
 * Pids from `devicectl device info processes --json-output -` whose executable
 * lives inside `bundlePath`, or undefined when the output is not a process list.
 * An empty array means the list was read and the app is not in it.
 */
export function findAppPids(json: string, bundlePath: string): number[] | undefined {
  let parsed: { result?: { runningProcesses?: unknown } };
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const processes = parsed?.result?.runningProcesses;
  if (!Array.isArray(processes)) return undefined;
  const pids: number[] = [];
  for (const proc of processes as Array<{ executable?: unknown; processIdentifier?: unknown }>) {
    if (typeof proc?.executable !== "string") continue;
    if (typeof proc.processIdentifier !== "number") continue;
    if (deviceFilePath(proc.executable).startsWith(bundlePath)) {
      pids.push(proc.processIdentifier);
    }
  }
  return pids;
}

function runnerNote(killed: Record<string, CommandResult>): string {
  return killed.tvosRun?.code === KILL_STALE_EXIT.killed
    ? " Ended the resident flutter-tvos run as well."
    : "";
}

/** The `build/tvos/<configuration>-<sdk>` directory a build lands in. */
export function tvosArtifactDir(kind: TvosDeviceKind, mode: TvosLaunchMode): string {
  if (kind === "simulator") return "Debug-appletvsimulator";
  return mode === "debug" ? "Debug-appletvos" : "Release-appletvos";
}

/** Read a saved capture once: its dimensions, and its bytes when asked for. */
function describePng(
  outPath: string,
  includeBase64?: boolean
): Pick<ScreenshotResult, "base64" | "pixelWidth" | "pixelHeight"> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(outPath);
  } catch {
    return {};
  }
  const dimensions = readPngDimensions(bytes);
  return {
    base64: includeBase64 ? bytes.toString("base64") : undefined,
    pixelWidth: dimensions?.width,
    pixelHeight: dimensions?.height,
  };
}

function failedResult(message: string, detail = ""): CommandResult {
  const combined = detail ? `${message}\n${detail}` : message;
  return {
    code: 1,
    stdout: "",
    stderr: combined,
    combined,
    success: false,
    timedOut: false,
  };
}

/** A successful result for a step that had nothing to run. */
function okResult(message: string): CommandResult {
  return {
    code: 0,
    stdout: message,
    stderr: "",
    combined: message,
    success: true,
    timedOut: false,
  };
}

function succeeded(message: string): BuildResult {
  return {
    result: okResult(message),
    enospc: false,
    installFailed: false,
    launchedDisplay: false,
  };
}

/** Return the last `maxLines` lines of `text` (for log tails in launch failures). */
function tailLines(text: string, maxLines: number): string {
  const lines = (text ?? "").split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

/** Expand a leading `~` in a path to the user's home directory. */
function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/**
 * Prefix a command with `PATH="<binDir>:$PATH"` when `binDir` is set and exists.
 *
 * WHY: `flutter-tvos` lives in a dir (default `~/flutter-tvos/bin`) that is only
 * added to PATH by the user's shell profile. A GUI-spawned MCP server runs a
 * NON-login shell inheriting the GUI/launchd PATH, which omits that dir — so
 * `flutter-tvos` is invisible and info/build/run report it "not found".
 * Prepending the configured bin dir (guarded so a missing dir is a no-op) fixes
 * that without touching global shell behavior for other platforms. A leading `~`
 * in the bin dir is expanded to the home directory before the existence check.
 * Pure over its inputs (the dir + a "does it exist" predicate) so it is
 * unit-testable; the adapter supplies the fs check. When the dir is unset/absent
 * the command is returned unchanged.
 */
export function withFlutterTvosPath(
  command: string,
  binDir: string | undefined,
  dirExists: (dir: string) => boolean
): string {
  if (!binDir) return command;
  const expanded = expandHome(binDir);
  if (!dirExists(expanded)) return command;
  // `export` (not a bare `VAR=val cmd` prefix) so the PATH applies to the WHOLE
  // compound command. Quote the dir (may contain spaces); leave $PATH bare so the
  // shell expands the inherited one.
  return `export PATH="${expanded.replace(/"/g, '\\"')}:$PATH"; ${command}`;
}

/**
 * The pty-wrapped `flutter-tvos run` for a physical Apple TV.
 *
 * The pty makes flutter-tvos line-flush its VM-service announcement (it is
 * buffered under a plain pipe). With a control channel the pty bridge owns the
 * terminal, so `r`/`R` written to the FIFO reach the runner's key handler. The
 * flutter-tvos bin dir goes on PATH inside the pty, because a GUI-spawned server
 * runs a non-login shell whose PATH omits it.
 */
export function buildTvosDeviceRunCommand(opts: {
  appDir: string;
  device: string;
  mode: TvosLaunchMode;
  extraArgs?: string[];
  flutterTvosBinDir: string | undefined;
  dirExists: (dir: string) => boolean;
  controlChannel?: ControlChannel;
  platform?: NodeJS.Platform;
}): string {
  const run = [
    "flutter-tvos",
    "run",
    "-d",
    quote(opts.device),
    `--${opts.mode}`,
    ...(opts.extraArgs ?? []).map(quote),
  ].join(" ");
  const inner = withFlutterTvosPath(
    `cd ${quote(opts.appDir)} && ${run}`,
    opts.flutterTvosBinDir,
    opts.dirExists
  );
  return buildPtyCaptureCommand({
    inner,
    platform: opts.platform,
    controlChannel: opts.controlChannel,
  });
}

/**
 * Lines that end a device launch early, for the mode being launched. A
 * connection reset is not among them: CoreDevice can recover from one inside the
 * same run, so it is read only after the run has failed, to decide on a retry.
 */
export function tvosDeviceFailureSignatures(mode: TvosLaunchMode): RegExp[] {
  return [
    ...TVOS_FAILURE_SIGNATURES,
    ...TVOS_ASLEEP_SIGNATURES,
    ...(mode === "debug" ? TVOS_DEVICE_DEBUG_FAILURE_SIGNATURES : []),
  ];
}

/**
 * How a non-debug device launch ends its wait when no URI is coming. Debug
 * returns undefined: its URI is the success criterion.
 */
export function tvosSettleOptionsFor(mode: TvosLaunchMode): SettleOptions | undefined {
  if (mode === "debug") return undefined;
  return {
    signatures: TVOS_RESIDENT_SETTLE_SIGNATURES,
    graceMs: TVOS_SETTLE_GRACE_MS,
    reason:
      mode === "release" ? TVOS_RELEASE_NO_VM_SERVICE_REASON : TVOS_PROFILE_NO_VM_SERVICE_REASON,
  };
}

/** The documented default flutter-tvos bin dir (`~/flutter-tvos/bin`). */
export function defaultFlutterTvosBinDir(homeDir: string): string {
  return path.join(homeDir, "flutter-tvos", "bin");
}
