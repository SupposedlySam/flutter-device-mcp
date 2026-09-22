/**
 * webOS platform adapter.
 *
 * The LG counterpart of {@link TizenAdapter}, behind the same neutral
 * {@link PlatformAdapter} seam. webOS wraps:
 *   - a caller-supplied `preBuild` hook for packaging the `.ipk` (there is no
 *     standard `flutter-webos build` command),
 *   - the host `ares-*` SDK CLI for install/launch/uninstall/info + discovery,
 *   - LG's ssap WebSocket channel for physical input (native pointer).
 *
 * The neutral launch → URI-capture core and the shared VM-service-URI parser are
 * REUSED (not duplicated): deploy feeds the core a pty-wrapped `ares-launch
 * --inspect` command plus webOS's own failure signatures, exactly as the Tizen
 * adapter feeds it `flutter-tizen run`. Hot reload needs nothing here — it runs
 * platform-neutrally in the server against the URI this adapter records.
 *
 * =========================== EXPERIMENTAL / DEVICE-BLOCKED ==================
 * End-to-end build/deploy CANNOT run today:
 *   - webOS packaging depends entirely on the caller-supplied `preBuild` hook
 *     (with none, the build reports that a hook is required), and
 *   - there is no webOS device to install/launch on.
 * So the command WIRING, URI capture/parse, and input plane below are
 * implemented + unit-tested with fakes, but NONE of it has been run on-device.
 * Each device-touching path is marked. The shapes match the documented ares /
 * ssap interfaces so they are correct once a device lands.
 * ============================================================================
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CommandResult, quote, runShell } from "../cli.js";
import {
  buildPtyCaptureCommand,
  launchAndCaptureUri as neutralLaunchAndCaptureUri,
} from "../launchCapture.js";
import { logger } from "../logger.js";
import {
  BuildOptions,
  BuildResult,
  DeviceResolution,
  InputController,
  LaunchOutcome,
  Platform,
} from "../types.js";
import { WebosInputController } from "../input/webosInputController.js";
import {
  InstallOptions,
  KillStaleScope,
  KillStaleScopeKind,
  PlatformAdapter,
} from "./platformAdapter.js";
import { ScreenshotResult } from "../screenshot.js";
import { RecordResult } from "../recording.js";
import { resolveWebosDeviceTarget } from "../webos/webosDeviceTarget.js";
import {
  buildAresDeviceInfoCommand,
  buildAresDeviceListCommand,
  buildAresInstallCommand,
  buildAresLaunchCommand,
  buildAresUninstallCommand,
  withWebosPathGuard,
} from "../webos/webosCli.js";

/**
 * Install-failure signatures the ENOSPC uninstall-and-retry recovery acts on
 * for webOS: the device is out of space, or `ares-install` reported a failed
 * install. ares phrases the failure as "Failed to install" (Tizen says "Install
 * failed"), which is exactly why the neutral deploy handler defers to the active
 * adapter's {@link WebOSAdapter.isInstallFailure} instead of hard-coding one
 * platform's strings.
 */
export const WEBOS_INSTALL_FAILURE_SIGNATURES: RegExp[] = [
  /No space left on device/i,
  /Failed to install/i,
];

/**
 * Log signatures that mean a webOS launch failed and polling should stop early.
 *
 * These are the ares/webOS analogues of TIZEN_FAILURE_SIGNATURES: the
 * out-of-space guardrail carries over verbatim, and the rest cover the terminal
 * ares failure lines (no connected/registered device, failed install/launch,
 * missing ares CLI). Without them the poll would hang the full timeout on a
 * process that already exited.
 */
export const WEBOS_FAILURE_SIGNATURES: RegExp[] = [
  /No space left on device/i,
  /Failed to install/i,
  /Unable to (?:connect|launch)/i,
  /ares-launch ERR!/i,
  /ares-install ERR!/i,
  /Connection time ?out/i,
  /No device(?:s)? (?:found|connected|registered)/i,
  /command not found/i,
];

/**
 * Compose the webOS launch command and delegate the pty wrapping to
 * {@link buildPtyCaptureCommand} so `ares-launch --inspect` line-flushes its
 * inspector/VM-service URI line (buffered under a plain pipe), matching the
 * other adapters' pty strategy. This adapter owns only the PATH-guarded
 * ares-launch invocation; the cross-platform `script`/`/bin/sh -c` wrapping is
 * the shared helper's concern.
 *
 * DEVICE-BLOCKED: the exact URI line `ares-launch --inspect` prints on webOS
 * is unconfirmed; capture relies on it being a loopback `http://127.0.0.1:PORT/…`
 * form (an ssh tunnel the SDK opens), which the shared VM-service-URI parser
 * already matches. If a real device prints a non-loopback host, the launch
 * command here is where a tunnel/rewrite would be added.
 */
export function buildWebosPtyLaunchCommand(
  appDir: string,
  device: string,
  appId: string,
  platform: NodeJS.Platform = process.platform,
  guard: (command: string) => string = withWebosPathGuard
): string {
  // Guard the ares-launch invocation's PATH before wrapping it, so the SDK bin
  // dir is visible even under the GUI server's non-login shell. The guard turns
  // `inner` into a compound statement (`export PATH=…; ares-launch …`); the
  // shared helper runs every inner through `/bin/sh -c`, so a compound survives
  // on both `script` signatures (this was the webOS-specific hazard the helper
  // now handles for all adapters).
  // `guard` is injectable so a test can force the guard on regardless of whether
  // the host actually has the SDK bin dir on disk.
  const inner = guard(buildAresLaunchCommand(device, appId));
  return buildPtyCaptureCommand({ inner, cwd: appDir, platform });
}

/** Configuration a WebOSAdapter needs from the server. */
export interface WebosAdapterConfig {
  appDir: string;
  device?: string;
  appId: string;
  /** Shell commands run in order (cwd=appDir) BEFORE the build; non-zero exit aborts. */
  preBuild?: string[];
}

export class WebOSAdapter implements PlatformAdapter {
  readonly platform: Platform = "webos";

  /**
   * `ares-launch`/`flutter-webos` name this toolchain and no other, and one
   * webOS target is modelled, so the teardown needs no device.
   */
  readonly killStaleScope: KillStaleScopeKind = "platform";

  /** Cached input controller so its selected mode survives across tool calls. */
  private inputController: InputController | undefined;
  /** The most recently built .ipk, remembered so install() has a package. */
  private lastArtifactPath: string | undefined;

  constructor(private readonly config: WebosAdapterConfig) {}

  get appId(): string {
    return this.config.appId;
  }

  /**
   * Device + environment info via `ares-device -i`. DEVICE-BLOCKED: needs a
   * registered ares device; with none this returns the CLI's own error output
   * (success:false), which the server surfaces — never `sdb shell`.
   */
  async info(): Promise<CommandResult> {
    const resolution = await this.discoverDevice().catch(() => undefined);
    const device = resolution?.target;
    if (!device) {
      // No device configured — still return the device list so callers can see
      // what ares knows about, rather than throwing.
      return runShell(withWebosPathGuard(buildAresDeviceListCommand()), {
        timeoutMs: 30000,
      });
    }
    return runShell(withWebosPathGuard(buildAresDeviceInfoCommand(device)), {
      timeoutMs: 60000,
    });
  }

  /**
   * webOS has no analogue of the Tizen setup (sdb connect). Devices are
   * registered once with `ares-setup-device`; there is no per-session target
   * file to write. We surface the current device list so the caller can confirm
   * registration, and report that no file was written.
   */
  async setup(_opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }> {
    const result = await runShell(withWebosPathGuard(buildAresDeviceListCommand()), {
      timeoutMs: 30000,
    });
    return { result };
  }

  /**
   * Build the `.ipk` via the caller-supplied `preBuild` hook.
   *
   * There is no standard `flutter-webos build` command, so webOS packaging is
   * driven entirely by `preBuild`: each command runs in order (cwd=appDir), and
   * the first non-zero exit short-circuits and IS the build result. The LAST
   * `preBuild` command is treated as the packaging step (it produces the `.ipk`)
   * and is given the generous 40-min timeout; earlier commands run as ordinary
   * setup steps. With no `preBuild` configured, the build reports that a hook is
   * required — no command is invented. The `.ipk` path is parsed from the
   * combined output; the SAME out-of-space / install-failed signatures are
   * detected.
   *
   * EXPERIMENTAL: this has not been run on-device; `debug` is not forwarded (the
   * hook owns its own flags).
   */
  async build(_opts: BuildOptions): Promise<BuildResult> {
    const commands = this.config.preBuild ?? [];
    if (commands.length === 0) {
      const message =
        "webOS packaging requires a `preBuild` hook: there is no standard " +
        "`flutter-webos build` command, so configure `preBuild` with the " +
        "command(s) that produce the .ipk (the last one is treated as the " +
        "packaging step).";
      const result: CommandResult = {
        code: null,
        stdout: "",
        stderr: message,
        combined: message,
        success: false,
        timedOut: false,
      };
      return {
        result,
        artifactPath: undefined,
        enospc: false,
        installFailed: false,
        launchedDisplay: false,
      };
    }

    const lastIndex = commands.length - 1;
    let result!: CommandResult;
    for (let i = 0; i < commands.length; i++) {
      const isPackagingStep = i === lastIndex;
      result = await runShell(commands[i], {
        cwd: this.config.appDir,
        // The packaging step can run long (image pull + build) — same ceiling as
        // Tizen; earlier setup commands get a shorter default ceiling.
        timeoutMs: isPackagingStep ? 2400000 : 300000, // 40 min / 5 min
      });
      if (!result.success) {
        // A failing preBuild command is the build outcome; surface it verbatim.
        return {
          result,
          artifactPath: undefined,
          enospc: /No space left on device/i.test(result.combined),
          installFailed: /Failed to install/i.test(result.combined),
          launchedDisplay: false,
        };
      }
    }

    const combined = result.combined;
    // The packaging step prints the produced package path; accept both an
    // explicit "IPK:" prefix and a bare build/webos/**/ipk/*.ipk path.
    const ipkMatch =
      combined.match(/IPK:\s*(\S+\.ipk)/) ??
      combined.match(/(\S*build\/webos\/\S*\.ipk)/);
    const artifactPath = ipkMatch ? ipkMatch[1] : undefined;
    if (artifactPath) this.lastArtifactPath = artifactPath;

    return {
      result,
      artifactPath,
      enospc: /No space left on device/i.test(combined),
      installFailed: /Failed to install/i.test(combined),
      launchedDisplay: false, // the preBuild hook never launches on webOS.
    };
  }

  /**
   * Resolve the ares device target: the pin while it is registered, else the
   * first listed device (stale-pin self-heal). Always consults
   * `ares-setup-device --list` so a stale pin can't route to a dead name.
   * Throws an McpError when nothing is usable.
   *
   * DEVICE-BLOCKED: returns the parsed live list; with no registered device it
   * throws the actionable "register with ares-setup-device" error.
   */
  async discoverDevice(): Promise<DeviceResolution> {
    const result = await runShell(withWebosPathGuard(buildAresDeviceListCommand()), {
      timeoutMs: 15000,
    });
    const resolution = resolveWebosDeviceTarget(this.config.device, result.stdout);
    if (!resolution) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No webOS device found. Register one with `ares-setup-device` or set " +
          `FLUTTER_DEVICE_WEBOS_DEVICE. ares device list output:\n${result.stdout || result.stderr}`
      );
    }
    if (resolution.warning) {
      logger.warn("Stale FLUTTER_DEVICE_WEBOS_DEVICE pin (webOS)", resolution);
    }
    return resolution;
  }

  /**
   * Install the most-recently-built `.ipk` on the resolved device via
   * `ares-install`. Unlike Tizen (whose CLI resolves the device + package
   * itself), ares needs both the device name and the ipk path explicitly, so
   * this uses the `device` arg and the artifact remembered from {@link build}.
   *
   * DEVICE-BLOCKED + EXPERIMENTAL: throws a clear error if no ipk has been
   * built this session (nothing to install yet).
   */
  async install(device: string, _opts: InstallOptions): Promise<CommandResult> {
    if (!this.lastArtifactPath) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No webOS .ipk is available to install. Build the .ipk first via the " +
          "`preBuild` hook (webOS install needs an explicit package path, unlike Tizen)."
      );
    }
    return runShell(
      withWebosPathGuard(buildAresInstallCommand(device, this.lastArtifactPath)),
      { timeoutMs: 300000 }
    );
  }

  isInstallFailure(combined: string): boolean {
    return WEBOS_INSTALL_FAILURE_SIGNATURES.some((re) => re.test(combined));
  }

  /**
   * Launch in debug through a pty and capture the Dart VM Service URI via the
   * SHARED neutral core (same parser + poll as Tizen). Feeds the core webOS's
   * own pty-wrapped `ares-launch --inspect` command and failure signatures.
   */
  async launchAndCaptureUri(
    device: string,
    timeoutMs: number
  ): Promise<LaunchOutcome> {
    const command = buildWebosPtyLaunchCommand(
      this.config.appDir,
      device,
      this.config.appId
    );
    return neutralLaunchAndCaptureUri(
      command,
      this.config.appDir,
      timeoutMs,
      WEBOS_FAILURE_SIGNATURES
    );
  }

  /** Uninstall via `ares-install --remove <appId>`. */
  async uninstall(device: string, appId: string): Promise<CommandResult> {
    return runShell(withWebosPathGuard(buildAresUninstallCommand(device, appId)), {
      timeoutMs: 120000,
    });
  }

  /**
   * Kill leftover webOS driver processes that would wedge a concurrent
   * build/deploy — the ares launch (held open for the VM service) and the
   * flutter-webos runner. Mirrors the Tizen `pkill` cleanup.
   *
   * Both patterns name the webOS toolchain, so they cannot reach a mobile or
   * tvOS `flutter run` on the same host; one webOS target is modelled, so no
   * device scope is threaded here.
   */
  async killStale(
    _scope: KillStaleScope
  ): Promise<Record<string, CommandResult>> {
    const aresLaunch = await runShell(`pkill -f ${quote("ares-launch")}`, {
      timeoutMs: 10000,
    });
    const flutterWebos = await runShell(`pkill -f ${quote("flutter-webos")}`, {
      timeoutMs: 10000,
    });
    return { aresLaunch, flutterWebos };
  }

  /**
   * Screen capture is NOT WIRED for webOS: the ares SDK has no general
   * device-screenshot command exposed here, and (as on Tizen) there is no clean
   * shell-screencap path to a Smart-TV framebuffer we can rely on. Reported as a
   * structured `{ supported: false }` rather than a guessed command. (This is a
   * candidate to revisit once webOS device support is real.)
   */
  async screenshot(): Promise<ScreenshotResult> {
    return {
      captured: false,
      supported: false,
      reason:
        "Screen capture is not wired for webOS: no reliable ares/device screenshot path is " +
        "exposed here yet (and there is no clean shell-screencap path to the TV framebuffer).",
      hint:
        "To capture the Flutter view, use Marionette take_screenshots over the VM service. " +
        "(webOS device support is experimental.)",
    };
  }

  /**
   * Screen RECORDING is NOT WIRED for webOS, for the same reason as
   * {@link screenshot}: no reliable ares/device recording path is exposed here,
   * and there is no clean shell path to the TV framebuffer. Reported as a
   * structured `{ supported: false }` rather than a guessed command. (Candidate to
   * revisit once webOS device support is real.)
   */
  async record(): Promise<RecordResult> {
    return {
      recorded: false,
      supported: false,
      reason:
        "Screen recording is not wired for webOS: no reliable ares/device recording path is " +
        "exposed here yet (and there is no clean shell path to the TV framebuffer).",
      hint:
        "To capture the Flutter view, use Marionette take_screenshots over the VM service. " +
        "(webOS device support is experimental.)",
    };
  }

  /**
   * Real dual-mode input controller over ssap. Cached so its mode is
   * session-sticky. The device host is resolved LAZILY on each send via live
   * discovery. Unlike Tizen, the pointer plane (move/scroll) is functional —
   * webOS's Magic Remote is a native cursor.
   *
   * DEVICE-BLOCKED: `ares-setup-device --list` reports the device NAME, not its
   * IP; the ssap channel needs the bare host. The resolver maps the resolved
   * device to its parsed connection host. See {@link hostFromWebosResolution}.
   */
  input(): InputController {
    if (!this.inputController) {
      this.inputController = new WebosInputController(async () => {
        const resolution = await this.discoverDevice();
        return hostFromWebosResolution(resolution);
      });
    }
    return this.inputController;
  }
}

/**
 * Map a resolved webOS device to the bare host the ssap channel dials.
 *
 * ares addresses devices by NAME, so `resolution.target` is generally a name,
 * not something ssap can connect to. The resolver parses the connection column
 * of `ares-setup-device --list --full` (`user@host:port`) into
 * `resolution.host`; that host is what ssap dials. We fall back to the target
 * only when no host was parsed (e.g. a device configured with a non-`user@host`
 * transport), which keeps a bare-IP-named device working.
 *
 * DEVICE-BLOCKED: the exact `--full` connection-column format is written to the
 * documented ares layout but unconfirmed on a real webOS device; if a device
 * formats it differently, `hostFromAresConnection` is the single place to adjust.
 */
export function hostFromWebosResolution(resolution: DeviceResolution): string {
  return resolution.host ?? resolution.target;
}
