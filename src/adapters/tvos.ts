/**
 * tvOS (Apple TV) platform adapter — EXPERIMENTAL.
 *
 * Drives a Flutter app on Apple TV behind the neutral {@link PlatformAdapter}
 * seam — the TV-family sibling of {@link IosAdapter}. Where iOS wraps `flutter`
 * + `xcrun devicectl`/`simctl`, tvOS wraps the community **flutter-tvos**
 * toolchain for info/setup/build/launch, and drives `xcrun devicectl`/`simctl`
 * directly for device resolution, install, lifecycle, and uninstall.
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
 * VM-service-URI capture works EXACTLY like the iOS adapter (the crown jewel): a
 * PROFILE launch is wrapped in a pty and its loopback
 * `http://127.0.0.1:PORT/<authCode>/` line is scraped, then the process is LEFT
 * RUNNING to hold the service open. On a physical Apple TV there is no LAN IP
 * (only a per-command CoreDevice IPv6 tunnel that tears down when a one-shot
 * devicectl command exits), so `flutter-tvos run -d <id> --profile` is used:
 * flutter holds a localhost port-forward over the tunnel open for the lifetime of
 * the process and prints the standard loopback VM-service line, e.g.
 *   A Dart VM Service on Example Apple TV is available at: http://127.0.0.1:53182/<authCode>/
 * The `127.0.0.1` forward is loopback-scoped to THIS run's device, so a running
 * iOS simulator (same bundle id) cannot collide with it — the collision an
 * mDNS/bundle-name resolve suffered.
 *
 * GUARDRAILS encoded here:
 *  - Physical Apple TV is AOT-only — a standalone DEBUG launch segfaults (the
 *    engine's ptrace check). AND a RELEASE build STRIPS the Dart VM service, so
 *    there would be nothing for Marionette to attach to. So the driving/deploy
 *    flow uses a PROFILE build (AOT + a live VM service): both the default device
 *    build (`--profile`) and the launch (`flutter-tvos run --profile`).
 *  - Only Apple TV / tvOS targets are ever selected — an iPhone/iPad in the same
 *    device list is excluded (the mirror of the iOS adapter's Apple-TV exclusion;
 *    see {@link ../tvosDeviceTarget}).
 *
 * SCOPE: OS-level device control only. In-app taps/gestures are Marionette's job
 * over the Dart VM service and are NOT reimplemented here; the Siri-Remote/focus
 * model has no free cursor, so the input controller reports `{ supported: false }`
 * for key/pointer (mirroring iOS/Android).
 *
 * KNOWN MARIONETTE LIMITATION on tvOS: `take_screenshots` returns a server error
 * against a tvOS PROFILE/AOT build (the render-surface capture path Marionette
 * uses is unavailable in AOT there). Element-tree inspection and coordinate/
 * element taps DO work over the VM service — so drive by element tree, not by
 * screenshot, on tvOS. This is a Marionette AOT limitation, not a fault of this
 * adapter or the returned URI.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
  buildPtyCaptureCommand,
  launchAndCaptureUri as neutralLaunchAndCaptureUri,
} from "../launchCapture.js";
import {
  buildSimctlScreenshotCommand,
  defaultScreenshotPath,
  ScreenshotResult,
} from "../screenshot.js";
import { RecordResult } from "../recording.js";
import { logger } from "../logger.js";
import { parseVmServiceUri } from "../vmServiceUri.js";
import { killScopedLaunchDrivers } from "../killStaleScope.js";
import {
  parseDevicectlAppleTvs,
  parseTvosSimulators,
  resolveTvosTarget,
  TvosDeviceKind,
} from "../tvosDeviceTarget.js";
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
  KillStaleScope,
  KillStaleScopeKind,
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
  /physical Apple TV runs must be --release or --profile/i,
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

  constructor(private readonly config: TvosAdapterConfig) {
    this.binDir =
      config.flutterTvosBinDir ?? defaultFlutterTvosBinDir(os.homedir());
  }

  get appId(): string {
    return this.config.appId;
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
   * Build the app for Apple TV via `flutter-tvos build`.
   *
   * Any configured {@link TvosAdapterConfig.preBuild} shell commands run first
   * (in order, cwd=appDir); the first non-zero exit aborts the build and is
   * returned as the failing result.
   *
   * A `simulator` profile builds for the tvOS simulator (a debug/JIT slice is
   * fine there); otherwise a PHYSICAL Apple TV build is produced with `--profile`
   * — a standalone debug launch SEGFAULTS on-device (the engine's ptrace check),
   * and a `--release` AOT build STRIPS the Dart VM service, so nothing would
   * remain for Marionette to attach to. `--profile` gives AOT plus a live VM
   * service, the only drivable device build. `skip_flutter` short-circuits to a
   * no-op success; `skip_rust` is accepted for interface parity and ignored (a
   * Rust engine, if any, builds inside Xcode via cargokit on tvOS, not as a
   * separate step).
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    if (opts.skip_flutter) {
      const message = "skip_flutter set — reusing existing tvOS build artifact.";
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
    // flutter-tvos ships a dedicated `build tvos` subcommand (verified on-device)
    // with a `--[no-]simulator` flag — NOT the `build ios` target.
    const flags: string[] = forSimulator ? ["tvos", "--simulator"] : ["tvos"];
    if (forSimulator) {
      // Simulator builds can be debug/JIT — no profile requirement, no signing.
      flags.push(opts.debug === false ? "--release" : "--debug");
    } else {
      // Physical Apple TV: AOT + a live VM service. --profile keeps the Dart VM
      // service (a --release AOT build STRIPS it, leaving nothing to attach to);
      // a device --debug build SEGFAULTS on-device. A physical build must be
      // CODE-SIGNED (installed via devicectl), which `flutter-tvos build tvos`
      // does using the Xcode project's development team — so no --no-codesign.
      flags.push("--profile");
    }

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
   * Resolve the tvOS target across physical Apple TVs and simulators. A pin
   * (APPLE_TV_DEVICE/FLUTTER_DEVICE_TVOS_DEVICE) self-heals to the first available
   * target with a warning, mirroring the iOS/Tizen stale-pin fallback. Only
   * Apple TV / tvOS targets are ever considered (iPhones/iPads are excluded by
   * the parser). Throws an McpError when nothing is usable. Records the resolved
   * kind for later devicectl/simctl selection.
   */
  async discoverDevice(
    preference?: DeviceTargetPreference
  ): Promise<DeviceResolution> {
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
    const resolution = resolveTvosTarget(
      this.config.device,
      physical,
      simulators,
      preference
    );
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
    return resolution;
  }

  /**
   * Install the already-built app on the resolved target.
   *
   * Physical Apple TV: `xcrun devicectl device install app` with the
   * `Profile-appletvos` Runner.app (matches `launchDevice`'s `--profile`
   * build — a plain debug launch segfaults on-device and release strips the
   * VM service). Simulator: `xcrun simctl install` with the
   * `Debug-appletvsimulator` Runner.app. The neutral deploy handler calls install
   * THEN launch; keeping install separate lets the ENOSPC uninstall-and-retry
   * seam work uniformly with the other adapters.
   */
  async install(device: string, _opts: InstallOptions): Promise<CommandResult> {
    const appPath = this.artifactPathFor(this.lastKind);
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
    return runShell(
      `xcrun devicectl device install app --device ${quote(device)} ${quote(appPath)}`,
      { timeoutMs: 600000 }
    );
  }

  /**
   * The built Runner.app path for a device kind. flutter-tvos writes the
   * simulator bundle under `build/tvos/Debug-appletvsimulator/` and the device
   * bundle under `build/tvos/Profile-appletvos/` (matching `launchDevice`'s
   * `--profile` run — the config the device launch path actually produces).
   *
   * NOTE: verify flutter-tvos's build output directory layout on real hardware —
   * a fork may write under `build/ios/` (reusing the iOS embedder identity)
   * rather than `build/tvos/`. Adjust the base segment if it differs.
   */
  private artifactPathFor(kind: TvosDeviceKind): string {
    const sdk = kind === "simulator" ? "appletvsimulator" : "appletvos";
    const buildDir = path.join(this.config.appDir, "build", "tvos");
    // The Xcode build-config folder name varies by mode (a --profile build lands
    // in `Release-appletvos`, a debug/sim build in `Debug-appletvsimulator`, etc.),
    // so DETECT the produced `Runner.app` rather than hardcode one config. Prefer
    // the modes we build (Profile/Release for device, Debug/Release for sim), then
    // fall back to any `*-<sdk>/Runner.app` on disk.
    const preferred =
      kind === "simulator"
        ? ["Debug-appletvsimulator", "Release-appletvsimulator", "Profile-appletvsimulator"]
        : ["Profile-appletvos", "Release-appletvos", "Debug-appletvos"];
    for (const config of preferred) {
      const p = path.join(buildDir, config, "Runner.app");
      if (fs.existsSync(p)) return p;
    }
    try {
      for (const entry of fs.readdirSync(buildDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.endsWith(`-${sdk}`)) {
          const p = path.join(buildDir, entry.name, "Runner.app");
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {
      // build dir absent — fall through to the conventional default path.
    }
    return path.join(buildDir, preferred[0], "Runner.app");
  }

  /**
   * Launch and capture the Dart VM Service URI.
   *
   * PHYSICAL Apple TV: run `flutter-tvos run -d <id> --profile` through a pty and
   * scrape the loopback `http://127.0.0.1:PORT/<authCode>/` line flutter prints.
   * flutter holds a localhost port-forward over the CoreDevice tunnel open for
   * the lifetime of the process, so the loopback URI is connectable from this
   * Mac; the process is LEFT RUNNING (like iOS) to hold that forward open. The
   * `127.0.0.1` forward is loopback-scoped to THIS run's device, so a running iOS
   * simulator (same bundle id) cannot collide with it.
   *
   * SIMULATOR: `simctl launch --console-pty` prints the usual loopback URI
   * (the sim shares the Mac's loopback), so the neutral loopback parser applies.
   *
   * On either path the launched process is left running to hold the VM service
   * open — matching the other adapters.
   */
  async launchAndCaptureUri(
    device: string,
    timeoutMs: number
  ): Promise<LaunchOutcome> {
    return this.lastKind === "simulator"
      ? this.launchSimulator(device, timeoutMs)
      : this.launchDevice(device, timeoutMs);
  }

  /**
   * Physical-device launch: pty-wrap `flutter-tvos run -d <id> --profile` and
   * feed it (with the flutter-tvos bin dir on PATH) into the SAME neutral launch
   * core the iOS adapter uses. The core spawns the launch detached, tees its
   * output to a temp log, and polls for the loopback VM-service URI (or a failure
   * signature). Leaving the run process alive holds the CoreDevice tunnel's
   * localhost port-forward open so Marionette can connect.
   */
  private async launchDevice(
    device: string,
    timeoutMs: number
  ): Promise<LaunchOutcome> {
    const command = this.buildTvosRunPtyCommand(device);
    return neutralLaunchAndCaptureUri(
      command,
      this.config.appDir,
      timeoutMs,
      TVOS_FAILURE_SIGNATURES
    );
  }

  /**
   * Build the pty-wrapped `flutter-tvos run -d <id> --profile` launch command.
   *
   * `flutter-tvos run` prints the standard flutter run output (including the
   * "A Dart VM Service … is available at:" loopback line). Wrapping it in a pty
   * (via {@link buildPtyCaptureCommand}) makes flutter line-flush that URI —
   * identical mechanism to the iOS/Tizen pty launch. The flutter-tvos bin dir is
   * prepended to PATH (when present) so `flutter-tvos` resolves under a
   * GUI-spawned (non-login-shell) server. `--profile` keeps the Dart VM service
   * alive (a device debug launch segfaults; a release build strips the service).
   *
   * NOTE: `flutter-tvos run -d <id> --profile` mirrors `flutter run`; confirm the
   * fork accepts `-d`/`--profile` on real hardware. A future
   * `--use-application-binary <Runner.app>` would skip the rebuild after a prior
   * build/install — leaving the run to build is acceptable for now (it matches
   * how iOS deploy runs `flutter run`).
   */
  private buildTvosRunPtyCommand(device: string): string {
    const inner = `flutter-tvos run -d ${quote(device)} --profile`;
    return buildTvosPtyLaunchCommand(
      inner,
      this.binDir,
      (dir) => fs.existsSync(dir)
    );
  }

  /**
   * Simulator launch: `simctl launch --console-pty` prints the loopback VM
   * service URI (the sim shares the Mac's loopback), captured with the neutral
   * loopback parser. Polls the captured output until the URI appears or the
   * deadline passes.
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
   * Uninstall the app to free space / reset state. devicectl for a physical
   * Apple TV, simctl for a simulator — chosen from the last resolved kind.
   */
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
   * Capture the current screen.
   *
   * tvOS SIMULATOR: `xcrun simctl io <udid> screenshot <path>` works (same as the
   * iOS simulator). PHYSICAL Apple TV: no CLI capture path — devicectl has no
   * screenshot subcommand and there is no idevicescreenshot equivalent — so it
   * returns `{ supported: false }`. Discovers the target first to know which kind
   * is active.
   */
  async screenshot(opts: {
    outPath?: string;
    includeBase64?: boolean;
  }): Promise<ScreenshotResult> {
    const resolution = await this.discoverDevice();
    if (this.lastKind !== "simulator") {
      return {
        captured: false,
        supported: false,
        reason:
          "Screen capture is not available for a PHYSICAL Apple TV: `xcrun devicectl` has no " +
          "screenshot subcommand and there is no idevicescreenshot equivalent for tvOS hardware.",
        hint:
          "Use a tvOS SIMULATOR for screenshot walkthroughs, or Marionette take_screenshots over " +
          "the VM service to capture the Flutter view on the device.",
      };
    }
    const outPath = opts.outPath ?? defaultScreenshotPath("tvos");
    const result = await runShell(
      buildSimctlScreenshotCommand(resolution.target, outPath),
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
   * Simulator (simctl): `simctl terminate <udid> <bundleId>` — simctl terminates
   * by bundle id directly. Physical Apple TV (devicectl): `process terminate`
   * requires a pid, so we resolve the running pid from `device info processes`
   * and terminate by pid, treating "not running" as a successful no-op.
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
    const processes = await runShell(
      `xcrun devicectl device info processes --device ${quote(device)} --json-output - 2>/dev/null`,
      { timeoutMs: 60000 }
    );
    const pid = findRunnerPid(processes.stdout);
    if (pid === undefined) {
      const message = `No running Runner process for ${appId} on ${device}; nothing to terminate.`;
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
      `xcrun devicectl device process terminate --device ${quote(device)} --pid ${pid}`,
      { timeoutMs: 60000 }
    );
  }

  /**
   * tvOS input controller. Navigation and taps are Marionette's job over the VM
   * service, so this MCP does not drive them; the Siri-Remote/focus model has no
   * free cursor. Every send reports unsupported (throws
   * {@link UnsupportedInputError}, surfaced by the server as `{supported:false}`).
   */
  input(): InputController {
    if (!this.inputController) {
      this.inputController = new TvosInputStub();
    }
    return this.inputController;
  }
}

/**
 * Resolve the Runner pid from `xcrun devicectl device info processes
 * --json-output -`. Running-process entries carry an `executable` file URL
 * (e.g. `…/Runner.app/Runner`) and an integer `processIdentifier`; the tvOS
 * Runner's executable path contains `/Runner.app/`. Returns the first match or
 * undefined (app not running → the caller no-ops). Defensive parse: a shape
 * drift degrades to "not running", never throws.
 */
export function findRunnerPid(json: string): number | undefined {
  let parsed: {
    result?: {
      runningProcesses?: Array<{
        processIdentifier?: number;
        executable?: string | null;
      }>;
    };
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const processes = parsed?.result?.runningProcesses;
  if (!Array.isArray(processes)) return undefined;
  for (const proc of processes) {
    const exe = proc?.executable;
    if (typeof exe !== "string") continue;
    if (exe.includes("/Runner.app/") && typeof proc.processIdentifier === "number") {
      return proc.processIdentifier;
    }
  }
  return undefined;
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
 * Wrap a `flutter-tvos run` invocation in a pty allocator so flutter-tvos
 * line-flushes its "A Dart VM Service … is available at:" URI (buffered under a
 * plain pipe otherwise) — the same mechanism as the iOS/Tizen pty launch. The
 * flutter-tvos bin dir is prepended to PATH (when present) so `flutter-tvos`
 * resolves under a GUI-spawned non-login-shell server; the PATH prefix is applied
 * to the INNER command so it survives inside the pty.
 *
 * This adapter owns only the PATH-guarded inner; the cross-platform
 * `script`/`/bin/sh -c` wrapping (and the leading `exec`) is delegated to the
 * shared {@link buildPtyCaptureCommand}, so tvOS matches the other adapters and
 * the `script` signature lives in exactly one place. Pure over its inputs (the
 * inner command, the bin dir, and a "does it exist" predicate) so it is
 * unit-testable; the adapter supplies the fs check.
 */
export function buildTvosPtyLaunchCommand(
  innerCommand: string,
  flutterTvosBinDir: string | undefined,
  dirExists: (dir: string) => boolean,
  platform: NodeJS.Platform = process.platform
): string {
  const inner = withFlutterTvosPath(innerCommand, flutterTvosBinDir, dirExists);
  return buildPtyCaptureCommand({ inner, platform });
}

/** The documented default flutter-tvos bin dir (`~/flutter-tvos/bin`). */
export function defaultFlutterTvosBinDir(homeDir: string): string {
  return path.join(homeDir, "flutter-tvos", "bin");
}

/**
 * tvOS input stub: physical-remote/cursor input is not driven by this MCP.
 * Navigation and taps are performed by Marionette over the Dart VM service, so
 * this controller reports every input path as unsupported. `mode` is tracked
 * only for interface parity.
 */
class TvosInputStub implements InputController {
  readonly platform: Platform = "tvos";
  private _mode: InputMode = "dpad";
  get mode(): InputMode {
    return this._mode;
  }
  setMode(mode: InputMode): void {
    this._mode = mode;
  }
  async key(): Promise<void> {
    throw new UnsupportedInputError(
      "Remote/D-pad keys are not wired on tvOS. Drive the app with Marionette " +
        "(tap/enter_text/scroll) over the Dart VM service instead."
    );
  }
  async pointerMove(): Promise<void> {
    throw new UnsupportedInputError(
      "Free-cursor pointer move is unsupported on tvOS (the Siri Remote is a " +
        "focus/gesture model, not a free cursor). Use Marionette over the VM service."
    );
  }
  async pointerClick(): Promise<void> {
    throw new UnsupportedInputError(
      "Pointer click is unsupported on tvOS. Use Marionette tap over the VM service."
    );
  }
  async pointerScroll(): Promise<void> {
    throw new UnsupportedInputError(
      "Free-cursor scroll is unsupported on tvOS. Use Marionette scroll/swipe " +
        "over the VM service."
    );
  }
}
