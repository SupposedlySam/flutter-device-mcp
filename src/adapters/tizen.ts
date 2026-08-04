/**
 * Tizen platform adapter.
 *
 * Drives the community flutter-tizen toolchain and sdb DIRECTLY, behind the
 * neutral {@link PlatformAdapter} seam. info/setup/build/install shell out to
 * `flutter-tizen` + `sdb` (no repo-private CLI); `resolveDeviceTarget` +
 * `sdb devices` back discovery; the neutral launch core is fed flutter-tizen's
 * run command + failure signatures for URI capture; and `pkill` handles
 * stale-process cleanup.
 *
 * Tizen-specific values that the neutral launch core needs — the flutter-tizen
 * run command and the failure signatures — are defined HERE and passed IN.
 *
 * EXPERIMENTAL: the build/install command surfaces here are the best
 * reconstruction of flutter-tizen's documented CLI and have not been verified
 * on-device in this environment; `// NOTE:` comments flag the spots a
 * maintainer should confirm.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { CommandResult, quote, runShell } from "../cli.js";
import {
  DEFAULT_SDB_PORT,
  parseDeviceTarget,
  resolveDeviceTarget,
} from "../deviceTarget.js";
import {
  buildPtyCaptureCommand,
  launchAndCaptureUri as neutralLaunchAndCaptureUri,
} from "../launchCapture.js";
import { logger } from "../logger.js";
import { checkTizenRootstrap, RootstrapCheck } from "../tizenRootstrap.js";
import {
  diagnoseDeveloperMode,
  fetchDeveloperModeFacts,
  localIpForDevice,
} from "../tizenDeveloperMode.js";
import { hostFromSdbTarget } from "../input/samsungToken.js";
import { TizenInputController } from "../input/tizenInputController.js";
import {
  BuildMode,
  BuildOptions,
  BuildResult,
  DeviceResolution,
  InputController,
  LaunchOutcome,
  Platform,
  resolveBuildMode,
} from "../types.js";
import { InstallOptions, PlatformAdapter } from "./platformAdapter.js";
import { ScreenshotResult } from "../screenshot.js";
import { RecordResult } from "../recording.js";

/**
 * Log signatures that mean the launch failed and polling should stop early.
 *
 * The no-device signature must NOT match flutter-tizen's transient progress
 * line "No devices found yet. Checking for wireless devices..." — that line is
 * printed during device enumeration even when the sdb device is attached and
 * found moments later. Only the terminal forms ("No devices found." /
 * "No devices connected.") count; the `(?! yet)` lookahead excludes the
 * transient one.
 *
 * "No supported devices found with name or id matching '<target>'." IS
 * terminal: flutter-tizen prints it (followed by the list of devices it did
 * find) and exits when the requested `-d` target does not exist — e.g. a
 * stale address after the device moved DHCP. Without this signature the poll
 * would hang for the full timeout on a process that already exited.
 */
export const TIZEN_FAILURE_SIGNATURES: RegExp[] = [
  /No space left on device/i,
  /Install failed/i,
  /Error launching application/i,
  /Application install failed/i,
  /Unable to find suitable/i,
  /no devices? (?:found(?! yet)|connected)/i,
  /No supported devices found with name or id matching/i,
  /flutter-tizen: command not found/i,
];

/** flutter-tizen device profile used when the config leaves it unset. */
const DEFAULT_DEVICE_PROFILE = "tv";

/**
 * Compose the flutter-tizen launch and delegate the pty wrapping to
 * {@link buildPtyCaptureCommand} so flutter-tizen sees a pty and line-flushes
 * (its VM-service URI line is buffered under a plain pipe). This adapter owns
 * only the flutter-tizen invocation (`--no-build --<mode> -d <target>`) + the
 * appDir cwd; the `script`/`/bin/sh -c` cross-platform wrapping is the shared
 * helper's concern.
 *
 * The `--<mode>` flag must match the mode of the INSTALLED TPK, or `--no-build`
 * has nothing of that mode to reuse and flutter-tizen rebuilds — throwing away
 * the point of `--no-build` and launching something other than what was
 * installed. Both `debug` and `profile` keep the VM service open, so the URI is
 * captured either way; `mode` defaults to `debug` for back-compat.
 *
 * `platform` defaults to the running host (`process.platform`) and is injectable
 * for tests.
 */
export function buildPtyLaunchCommand(
  appDir: string,
  deviceTarget: string,
  mode: BuildMode = "debug",
  platform: NodeJS.Platform = process.platform
): string {
  const inner = `flutter-tizen run --no-build --${mode} -d ${quote(deviceTarget)}`;
  return buildPtyCaptureCommand({ inner, cwd: appDir, platform });
}

/** Configuration a TizenAdapter needs from the runtime. */
export interface TizenAdapterConfig {
  /** Absolute path to the Flutter app (dir containing pubspec.yaml). */
  appDir: string;
  /** Device pin (sdb target host/id), optional. */
  device?: string;
  /** Tizen application id, for uninstall. */
  appId: string;
  /** flutter-tizen device profile: tv | mobile | wearable (default "tv"). */
  profile?: string;
  /** Shell commands run in order (cwd=appDir) BEFORE the build; non-zero exit aborts. */
  preBuild?: string[];
  /**
   * Tizen SDK data dir (the folder containing `platforms/`). Optional; when
   * omitted the rootstrap precheck falls back to `$TIZEN_SDK` and common install
   * locations. Used only to locate installed rootstraps for the precheck.
   */
  sdkPath?: string;
  /**
   * Tizen api-version to target (e.g. "8.0"). Optional; when omitted the
   * precheck reads it from the app's `tizen/tizen-manifest.xml`. Set it to a
   * version you have an installed device rootstrap for.
   */
  apiVersion?: string;
  /** Security profile name to sign the TPK with (`-s`); defaults to the active one. */
  securityProfile?: string;
  /**
   * Rootstrap precheck override. Optional; defaults to {@link checkTizenRootstrap}
   * over the real filesystem. Injectable so tests pin the outcome deterministically
   * without a real Tizen SDK on disk.
   */
  checkRootstrap?: () => RootstrapCheck;
}

export class TizenAdapter implements PlatformAdapter {
  readonly platform: Platform = "tizen";

  /** Cached input controller so its selected mode survives across tool calls. */
  private inputController: InputController | undefined;

  constructor(private readonly config: TizenAdapterConfig) {}

  get appId(): string {
    return this.config.appId;
  }

  /** The device profile to build/launch against (config override, else "tv"). */
  private get profile(): string {
    return this.config.profile ?? DEFAULT_DEVICE_PROFILE;
  }

  /**
   * Precheck that a Tizen SDK device rootstrap for the app's api-version is
   * installed (the #1 cause of an opaque `flutter-tizen build tpk` failure). Pure
   * over the config + filesystem; see {@link checkTizenRootstrap}.
   */
  private rootstrapCheck(): RootstrapCheck {
    if (this.config.checkRootstrap) return this.config.checkRootstrap();
    return checkTizenRootstrap({
      appDir: this.config.appDir,
      configuredSdkPath: this.config.sdkPath,
      configuredApiVersion: this.config.apiVersion,
    });
  }

  /**
   * Device + environment status. Combines `flutter-tizen devices` (the runner's
   * own view of attachable targets) with `sdb devices` (the raw connection
   * table). Runs with cwd=appDir so flutter-tizen resolves the app's toolchain.
   *
   * NEVER uses `sdb shell`: it is DISABLED on Samsung Smart Monitor/TV devices
   * (returns empty rc=0 — guardrail #1). For device metadata beyond this, use
   * the device's REST API on port 8001, not a device-side shell.
   */
  async info(): Promise<CommandResult> {
    const flutterDevices = await runShell("flutter-tizen devices", {
      cwd: this.config.appDir,
      timeoutMs: 60000,
    });
    const sdbDevices = await runShell("sdb devices", {
      cwd: this.config.appDir,
      timeoutMs: 15000,
    });

    // Rootstrap readiness (the #1 build blocker) — surfaced here so
    // `flutter-device info --platform tizen` doubles as a Tizen SDK doctor.
    const rootstrap = this.rootstrapCheck();
    const rootstrapNote = rootstrap.ok
      ? `Tizen SDK rootstrap: OK (api-version ${rootstrap.requiredApiVersion} device rootstrap installed; SDK ${rootstrap.sdkPath}).`
      : `Tizen SDK rootstrap: NOT READY — ${rootstrap.message}`;

    const note =
      "Note: `sdb shell` is disabled on Samsung Smart Monitor/TV devices " +
      "(returns empty rc=0); use the device REST API on port 8001 for device " +
      "metadata, never a device-side shell.";
    const combined =
      `$ flutter-tizen devices\n${flutterDevices.combined}\n` +
      `$ sdb devices\n${sdbDevices.combined}\n${rootstrapNote}\n${note}\n`;

    // Surface a non-zero result only if BOTH probes failed — either alone is a
    // usable status signal.
    const success = flutterDevices.success || sdbDevices.success;
    return {
      code: success ? 0 : flutterDevices.code ?? sdbDevices.code,
      stdout: `${flutterDevices.stdout}\n${sdbDevices.stdout}`,
      stderr: `${flutterDevices.stderr}\n${sdbDevices.stderr}`,
      combined,
      success,
      timedOut: flutterDevices.timedOut || sdbDevices.timedOut,
    };
  }

  /**
   * Connect to a wireless Tizen device over sdb and record it as the target.
   *
   * Runs `sdb connect <host>:26101` (only port 26101 is supported; a bare host
   * gets the port appended), then writes the resolved target into
   * `<appDir>/.tizen-target` so later operations resolve the same device.
   */
  async setup(opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }> {
    // `sdb connect` on these devices only accepts the sdb debug port 26101;
    // normalize a bare host to that port and reject any other explicit port
    // rather than dial an address that can't accept a debug connection.
    let connectHost: string | undefined;
    if (opts.deviceAddr) {
      const { host, port } = parseDeviceTarget(opts.deviceAddr);
      if (port !== DEFAULT_SDB_PORT) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unsupported sdb port ${port} in device_ip "${opts.deviceAddr}": ` +
            `sdb connect on these devices only accepts port ${DEFAULT_SDB_PORT}. ` +
            `Pass the bare host (or host:${DEFAULT_SDB_PORT}).`
        );
      }
      connectHost = host;
    }

    let result: CommandResult;
    let resolvedTarget: string;
    if (connectHost) {
      const target = `${connectHost}:${DEFAULT_SDB_PORT}`;
      result = await runShell(`sdb connect ${quote(target)}`, {
        cwd: this.config.appDir,
        timeoutMs: 180000,
      });
      resolvedTarget = target;
    } else {
      // No address supplied — record whatever sdb already reports so the target
      // file still reflects the connected device.
      result = await runShell("sdb devices", {
        cwd: this.config.appDir,
        timeoutMs: 15000,
      });
      const resolution = resolveDeviceTarget(this.config.device, result.stdout);
      resolvedTarget = resolution?.target ?? this.config.device ?? "";
    }

    const targetFile = path.join(this.config.appDir, ".tizen-target");
    try {
      fs.writeFileSync(targetFile, `${resolvedTarget}\n`, "utf8");
    } catch (error) {
      logger.warn("Failed to write .tizen-target", { error, targetFile });
    }

    return { result, wrote: targetFile };
  }

  /**
   * Build the app package (TPK) with flutter-tizen.
   *
   * Any configured `preBuild` commands run first, in order, with cwd=appDir;
   * the first non-zero exit short-circuits and IS the build result (a generic
   * hook that replaces the former CLI's engine/asset prebuild steps). Then
   * `flutter-tizen build tpk --device-profile <profile>` runs (with `--debug`
   * when requested). A first build fetches the flutter-tizen engine, so the
   * timeout is generous (~40 min).
   *
   * NOTE (verify on-device): the `--device-profile <tv|mobile|wearable>` flag
   * is flutter-tizen's documented profile selector for `build tpk`; confirm the
   * exact flag spelling against the installed flutter-tizen version. The
   * `skip_rust`/`skip_flutter` BuildOptions are no-ops here — the generic
   * equivalent is the `preBuild` hook.
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    // Fail fast on a missing device rootstrap BEFORE the long flutter-tizen
    // build (which would otherwise die with an opaque Dart stack trace). The
    // message is actionable: install the SDK version or retarget to an installed
    // one. This is a pure filesystem check — no side effects.
    const rootstrap = this.rootstrapCheck();
    if (!rootstrap.ok) {
      const message = `Tizen rootstrap precheck failed: ${rootstrap.message}`;
      return {
        result: {
          code: 1,
          stdout: "",
          stderr: message,
          combined: message,
          success: false,
          timedOut: false,
        },
        artifactPath: undefined,
        enospc: false,
        installFailed: false,
        launchedDisplay: false,
      };
    }

    for (const cmd of this.config.preBuild ?? []) {
      const pre = await runShell(cmd, {
        cwd: this.config.appDir,
        timeoutMs: 2400000, // 40 min — a prebuild may itself fetch/compile
      });
      if (!pre.success) {
        // A failing prebuild is the build outcome; surface its output verbatim.
        return {
          result: pre,
          artifactPath: undefined,
          enospc: /No space left on device/i.test(pre.combined),
          installFailed: /Install failed/i.test(pre.combined),
          launchedDisplay: false,
        };
      }
    }

    const flags = ["--device-profile", quote(this.profile)];
    // The 3-way build mode (`mode` wins over the legacy `debug` boolean), always
    // passed EXPLICITLY so the TPK's mode is a stated fact rather than
    // flutter-tizen's default — the launch's `--no-build --<mode>` has to name
    // the same mode to reuse this artifact. NB `--device-profile` above is the
    // tv/mobile device profile; `--profile` here is the compilation mode.
    const mode = resolveBuildMode({ mode: opts.mode, debug: opts.debug });
    flags.push(`--${mode}`);
    if (this.config.securityProfile) {
      flags.push("-s", quote(this.config.securityProfile));
    }

    // NOTE (verify on-device): `flutter-tizen build tpk` is the documented TPK
    // build subcommand. A first build fetches the engine, hence the long timeout.
    const result = await runShell(
      `flutter-tizen build tpk ${flags.join(" ")}`,
      {
        cwd: this.config.appDir,
        timeoutMs: 2400000, // 40 min
      }
    );

    const combined = result.combined;
    // flutter-tizen prints the built package path ending in `.tpk`; grab the
    // last such token so a later "Built <path>.tpk" line wins over any earlier
    // mention.
    const tpkMatches = combined.match(/\S+\.tpk/g);
    const artifactPath = tpkMatches ? tpkMatches[tpkMatches.length - 1] : undefined;
    const enospc = /No space left on device/i.test(combined);
    const installFailed = /Install failed/i.test(combined);

    return {
      result,
      artifactPath,
      enospc,
      installFailed,
      // `build tpk` never launches; a run+launch is the separate launch path.
      launchedDisplay: false,
    };
  }

  /**
   * Resolve the sdb device target: the device pin while it is confirmed online,
   * else the first online device from `sdb devices`. `sdb devices` is always
   * consulted — a stale pin (device moved DHCP address) would otherwise route
   * deploys to a dead address. Throws an McpError when nothing is usable.
   */
  async discoverDevice(): Promise<DeviceResolution> {
    let result = await runShell("sdb devices", { timeoutMs: 15000 });
    let resolution = resolveDeviceTarget(this.config.device, result.stdout);

    // Auto-connect a CONFIGURED device that is not attached yet. Unlike USB
    // platforms, a Tizen TV is reached over the network and `sdb devices` lists
    // NOTHING until an explicit `sdb connect <ip>:26101`. When a device is
    // configured (FLUTTER_DEVICE_TIZEN_DEVICE / config) but absent from the list,
    // connect it once and re-list — the convenience the standalone `setup` step
    // otherwise provides, so a configured TV "just works" without a manual setup.
    if (!resolution && this.config.device) {
      const { host } = parseDeviceTarget(this.config.device);
      const target = `${host}:${DEFAULT_SDB_PORT}`;
      const connect = await runShell(`sdb connect ${quote(target)}`, {
        timeoutMs: 30000,
      });
      logger.info("Tizen auto-connect attempt", {
        target,
        output: connect.combined,
      });
      result = await runShell("sdb devices", { timeoutMs: 15000 });
      resolution = resolveDeviceTarget(this.config.device, result.stdout);
    }

    if (!resolution) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No Tizen device found. Set FLUTTER_DEVICE_TIZEN_DEVICE to the TV's IP " +
          "(it is auto-connected on the sdb debug port 26101), run `flutter-device " +
          "setup --platform tizen --device-ip <ip>`, or `sdb connect <ip>:26101` yourself. " +
          `sdb devices output:\n${result.stdout || result.stderr}`
      );
    }
    if (resolution.warning) {
      logger.warn("Stale FLUTTER_DEVICE_TIZEN_DEVICE pin", resolution);
    }
    return resolution;
  }

  /**
   * Install the already-built TPK on the device (install-only, no launch).
   *
   * `flutter-tizen install -d <device>` installs the most recent
   * `build/tizen/**.tpk` produced by {@link build}. A debug TPK installs the
   * same way as a release one, so `opts.debug` does not change the command here.
   *
   * NOTE (verify on-device): `flutter-tizen install -d <target>` is the
   * documented install-only surface; confirm it targets the most recent build
   * artifact without an explicit path on the installed version.
   */
  async install(device: string, _opts: InstallOptions): Promise<CommandResult> {
    return runShell(`flutter-tizen install -d ${quote(device)}`, {
      cwd: this.config.appDir,
      timeoutMs: 300000,
    });
  }

  async launchAndCaptureUri(
    device: string,
    timeoutMs: number,
    mode?: BuildMode
  ): Promise<LaunchOutcome> {
    // The launch mode must name the mode of the TPK that was installed, or
    // `--no-build` finds nothing of that mode to reuse. debug/profile both keep
    // the VM service open, so the URI is captured either way; default debug.
    const launchMode: BuildMode = mode ?? "debug";
    const command = buildPtyLaunchCommand(
      this.config.appDir,
      device,
      launchMode
    );
    return neutralLaunchAndCaptureUri(
      command,
      this.config.appDir,
      timeoutMs,
      TIZEN_FAILURE_SIGNATURES
    );
  }

  async uninstall(device: string, appId: string): Promise<CommandResult> {
    return runShell(
      `sdb -s ${quote(device)} uninstall ${quote(appId)}`,
      { timeoutMs: 120000 }
    );
  }

  async killStale(): Promise<Record<string, CommandResult>> {
    // One deploy/build at a time — a leftover flutter-tizen process holds the
    // device lock and wedges a concurrent install.
    const flutterTizen = await runShell(`pkill -f ${quote("flutter-tizen")}`, {
      timeoutMs: 10000,
    });
    return { flutterTizen };
  }

  /**
   * Diagnose the Samsung Developer Mode "Host PC IP" binding before connect.
   *
   * Resolves the device host, reads `developerMode`/`developerIP` from the
   * device's `:8001/api/v2/` REST payload, and compares the bound Host PC IP to
   * this Mac's LAN IP on the device's subnet. Returns an actionable diagnostic
   * on a mismatch (or Developer Mode off), else `null`. Fully non-throwing —
   * device discovery or REST failure resolves to `null` so a transient hiccup
   * can never fail a deploy pre-check.
   */
  async environmentDiagnostic(
    resolved?: DeviceResolution
  ): Promise<string | null> {
    try {
      // Reuse the caller's already-resolved device (deploy path) to avoid a
      // redundant `sdb devices` + REST round-trip; self-discover otherwise.
      const resolution = resolved ?? (await this.discoverDevice());
      const host = hostFromSdbTarget(resolution.target);
      const facts = await fetchDeveloperModeFacts(host);
      // With no facts at all the REST probe didn't answer — stay silent rather
      // than emit a misleading "Developer Mode off" from an empty payload.
      if (facts.developerMode === undefined && facts.developerIP === undefined) {
        return null;
      }
      const localIp = localIpForDevice(host);
      return diagnoseDeveloperMode(
        facts.developerMode,
        facts.developerIP,
        localIp
      );
    } catch (error) {
      logger.warn("Tizen developer-mode diagnostic skipped", { error });
      return null;
    }
  }

  /**
   * Screen capture is NOT SUPPORTED on Samsung Smart Monitor/TV devices: the one
   * clean capture path would be a device-side screencap over `sdb shell`, but
   * `sdb shell` is DISABLED on these devices (returns empty rc=0 — guardrail #1),
   * and neither the REST :8001 API nor flutter-tizen exposes a framebuffer grab.
   * Rather than invent an sdb-shell call that silently no-ops, this reports a
   * structured `{ supported: false }`. (Capturing the Flutter view specifically
   * is possible via Marionette take_screenshots over the VM service.)
   */
  async screenshot(): Promise<ScreenshotResult> {
    return {
      captured: false,
      supported: false,
      reason:
        "Screen capture is not available on Samsung Smart Monitor/TV devices: `sdb shell` is " +
        "disabled (returns empty rc=0), so a device-side screencap can't run, and no REST :8001 " +
        "or flutter-tizen framebuffer-grab path exists.",
      hint:
        "To capture the Flutter view, use Marionette take_screenshots over the VM service " +
        "(the ws://…/ws URI from the deploy/launch path).",
    };
  }

  /**
   * Screen RECORDING is NOT SUPPORTED on Samsung Smart Monitor/TV devices, for
   * the same reason as {@link screenshot}: the only clean path would run over
   * `sdb shell`, which is DISABLED on these devices (guardrail #1), and neither
   * REST :8001 nor flutter-tizen exposes a framebuffer/screenrecord grab. Reports
   * a structured `{ supported: false }` rather than invent a silent no-op.
   */
  async record(): Promise<RecordResult> {
    return {
      recorded: false,
      supported: false,
      reason:
        "Screen recording is not available on Samsung Smart Monitor/TV devices: `sdb shell` is " +
        "disabled (returns empty rc=0), so no device-side screenrecord can run, and no REST :8001 " +
        "or flutter-tizen capture path exists.",
      hint:
        "To capture the Flutter view, use Marionette take_screenshots over the VM service " +
        "(the ws://…/ws URI from the deploy/launch path).",
    };
  }

  /**
   * Real dual-mode input controller (Stage 2), backed by the Samsung remote
   * WebSocket channel. Cached so its selected mode is session-sticky across
   * tool calls. The device host is resolved LAZILY on each send via live device
   * discovery (the bare IP, sdb :26101 stripped) — never a hardcoded address.
   */
  input(): InputController {
    if (!this.inputController) {
      this.inputController = new TizenInputController(async () => {
        const resolution = await this.discoverDevice();
        return hostFromSdbTarget(resolution.target);
      });
    }
    return this.inputController;
  }
}
