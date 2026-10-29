/**
 * The shared command core — "one brain, two faces".
 *
 * Every device operation lives here as a method that returns a PLAIN result
 * object. Both frontends are thin translation layers over it: the MCP server
 * ({@link ../index}) wraps each result in a JSON content block, and the
 * `flutter-device` CLI ({@link ../bin/flutter-device}) renders it to stdout +
 * an exit code. All the guardrails (one-deploy-at-a-time, ENOSPC uninstall+retry,
 * pty VM-service-URI capture, stale-pin self-heal, Marionette drivability probe)
 * run identically for both callers because they run HERE, not in the frontends.
 */
import fs from "fs";
import os from "os";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger.js";
import { CommandResult, tail } from "../cli.js";
import {
  BuildMode,
  InputController,
  InputMode,
  isLaunchFailure,
  UnsupportedInputError,
} from "../types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { PlatformAdapter } from "../adapters/platformAdapter.js";
import { ResolvedConfig } from "../config/config.js";
import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_FPS,
  RecordFormat,
} from "../recording.js";
import {
  mapUnsupportedInput,
  resolvePointerTarget,
  resolveScrollDelta,
  resolveViewMetrics,
} from "../handlerLogic.js";
import { crossCheckView, DeviceGeometryReading } from "../deviceGeometry.js";
import {
  clearLaunch,
  clearLaunches,
  readRecords,
  recordLaunch,
  resolveLaunch,
} from "../launchRegistry.js";
import { runKillStale, tearDownForDeploy } from "../killStaleFlow.js";
import { VmServiceClient } from "../vmServiceClient.js";
import { hotReload, ReloadOutcome } from "../hotReload.js";
import { hotControl } from "../hotControl.js";
import { sendControlChar, removeControlFifo } from "../ptyControl.js";
import { NO_PTY_FORWARDER_REASON } from "../ptyForward.js";
import { confirmHotAction, logSize } from "../hotConfirm.js";
import {
  MarionetteProbeResult,
  probeMarionetteReady,
} from "../marionetteProbe.js";
import {
  isLoopbackHost,
  localBackendDefines,
  LocalBackendPlan,
  resolveLocalBackendHost,
  TargetKind,
} from "../localBackend.js";

/**
 * Per-request VM-service timeout for the post-deploy Marionette probe. Kept well
 * under the probe's ~10s total wall budget so a single wedged connect/RPC can't
 * outrun the budget (the client's 20s default would).
 */
const MARIONETTE_PROBE_CLIENT_TIMEOUT_MS = 3000;

/**
 * The coordinate-space contract a geometry answer carries. Stated on the result
 * itself because mixing the two spaces is exactly how taps end up in the wrong
 * place, and a caller should not have to remember which is which.
 */
const GEOMETRY_COORDINATE_NOTE =
  "`displaySize` is DISPLAY device pixels — the space `adb shell input tap` " +
  "(and flutter_pointer's default) addresses. `logicalDisplaySize` is that " +
  "display divided by `dpr`; it is NOT the Flutter view, which is smaller " +
  "wherever system bars take space. Flutter geometry is view-relative, so " +
  "convert view logical coordinates with `dpr` rather than measuring against " +
  "`logicalDisplaySize`.";

/**
 * The macOS-specific coordinate contract — see {@link GEOMETRY_COORDINATE_NOTE}'s
 * Android framing, which does not apply here.
 */
const GEOMETRY_COORDINATE_NOTE_MACOS =
  "`displaySize`/`logicalDisplaySize` are the TARGET WINDOW's bounds in POINTS — the " +
  "same point space flutter_pointer (window-relative by default) and " +
  "flutter_screenshot (`screencapture -R`) address; there is no further \"logical\" " +
  "reduction beneath points on macOS. `dpr` is the display's backingScaleFactor and " +
  "matters ONLY for interpreting a flutter_screenshot PNG's pixel dimensions " +
  "(pixels = points × dpr) — it does NOT scale flutter_pointer/flutter_key " +
  "coordinates, which are already point-space.";

/** A plain, JSON-serializable command result (both frontends render this). */
export type CommandOutput = Record<string, unknown>;

/** Arguments common to every command. */
export interface CommonArgs {
  platform?: string;
}

export class CommandCore {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly config: ResolvedConfig
  ) {}

  private adapterFor(args: CommonArgs): PlatformAdapter {
    return this.registry.resolve(args.platform);
  }

  private summarizeCli(result: CommandResult, maxLines = 120) {
    return {
      success: result.success,
      exitCode: result.code,
      timedOut: result.timedOut,
      output: tail(result.combined, maxLines),
    };
  }

  /** Wrap an implementation with logging + error mapping to an McpError. */
  private async guard<T>(
    description: string,
    context: Record<string, unknown>,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      logger.info(description, context);
      return await fn();
    } catch (error) {
      logger.error(`Error: ${description}`, { error, ...context });
      if (error instanceof McpError) throw error;
      const message =
        error instanceof Error ? error.message : String(error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed: ${description}: ${message}`
      );
    }
  }

  /**
   * Probe a captured VM service URI for the marionette extension so the deploy
   * response can flag a non-drivable build (profile/release without the
   * marionette define). Advisory only: any connect/RPC error resolves to
   * `marionetteReady: null` — this NEVER throws out of a successful deploy.
   */
  private async probeMarionette(
    vmServiceUriWs: string
  ): Promise<MarionetteProbeResult> {
    const client = new VmServiceClient({
      wsUri: vmServiceUriWs,
      timeoutMs: MARIONETTE_PROBE_CLIENT_TIMEOUT_MS,
    });
    return probeMarionetteReady(client);
  }

  /** A snapshot of the resolved configuration, for the `info` provenance block. */
  configProvenance(): CommandOutput {
    return {
      appDir: this.config.appDir,
      appDirSource: this.config.appDirSource,
      fvm: this.config.fvm,
      defaultPlatform: this.config.defaultPlatform,
      defaultPlatformSource: this.config.defaultPlatformSource,
      configFile: this.config.configFilePath ?? null,
    };
  }

  // =========== info ==========
  async info(args: CommonArgs): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard("flutter_info", { platform: adapter.platform }, async () => {
      const result = await adapter.info();
      const environmentDiagnostic = adapter.environmentDiagnostic
        ? (await adapter.environmentDiagnostic()) ?? undefined
        : undefined;
      return {
        platform: adapter.platform,
        appId: adapter.appId || null,
        config: this.configProvenance(),
        ...this.summarizeCli(result, 200),
        environmentDiagnostic,
      };
    });
  }

  // =========== setup ==========
  async setup(args: CommonArgs & { device_ip?: string }): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_setup",
      { platform: adapter.platform, deviceIp: args.device_ip },
      async () => {
        const { result, wrote } = await adapter.setup({
          deviceAddr: args.device_ip,
        });
        return {
          platform: adapter.platform,
          ...this.summarizeCli(result, 200),
          wrote,
        };
      }
    );
  }

  // =========== build ==========
  async build(
    args: CommonArgs & {
      profile?: string;
      mode?: BuildMode;
      debug?: boolean;
      dart_define?: Record<string, string>;
      skip_rust?: boolean;
      skip_flutter?: boolean;
      install?: boolean;
      run?: boolean;
      target?: "simulator" | "device";
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard("flutter_build", { platform: adapter.platform, ...args }, async () => {
      const profile =
        adapter.platform === "ios" && args.target === "simulator" && !args.profile
          ? "simulator"
          : args.profile;
      const build = await adapter.build({
        profile,
        mode: args.mode,
        debug: args.debug,
        dartDefine: args.dart_define,
        skip_rust: args.skip_rust,
        skip_flutter: args.skip_flutter,
        install: args.install,
        run: args.run,
      });
      return {
        platform: adapter.platform,
        ...this.summarizeCli(build.result, 200),
        artifactPath: build.artifactPath,
        supported: build.supported,
        enospc: build.enospc,
        installFailed: build.installFailed,
        launchedDisplay: build.launchedDisplay,
      };
    });
  }

  // =========== deploy ==========
  /**
   * Resolve where a local backend lives from the DEVICE's point of view, and set
   * up any tunnel that answer depends on.
   *
   * Returns `fatal` rather than injecting a guessed host. The whole hazard this
   * addresses is that a wrong host does not look like a wrong host: the app
   * reports a connection error, and every reading of that points at the backend
   * or the app rather than at the address. So an unresolvable target STOPS the
   * deploy with the question, instead of shipping a build that will fail later
   * and elsewhere.
   */
  private async planLocalBackend(
    adapter: PlatformAdapter,
    device: string,
    args: {
      local_backend_ports?: number[];
      local_backend_host?: string;
      local_backend_keys?: { env?: string; host?: string };
    }
  ): Promise<{
    defines: Record<string, string>;
    report: Record<string, unknown>;
    fatal?: string;
  }> {
    const kind: TargetKind = adapter.targetKind
      ? adapter.targetKind(device)
      : "device";
    const ports = args.local_backend_ports ?? [];
    const keys = { envKey: args.local_backend_keys?.env, hostKey: args.local_backend_keys?.host };

    let plan: LocalBackendPlan = resolveLocalBackendHost(
      { platform: adapter.platform, kind },
      os.networkInterfaces(),
      ports
    );

    // An explicit host is the caller answering the question this cannot: which
    // address the device can actually reach. It overrides the resolved host and
    // keeps whatever tunnelling the target still needs.
    if (args.local_backend_host) {
      plan = {
        ...plan,
        host: args.local_backend_host,
        rationale: `Host supplied explicitly by the caller (${args.local_backend_host}); ` +
          `resolution for this ${adapter.platform} ${kind} target would otherwise say: ${plan.rationale}`,
        unresolved: undefined,
      };
      // The tunnel exists only to make a LOOPBACK name true on the device. A
      // caller who named a routable address does not depend on it, so it is not
      // attempted: attempting it would let a failed `adb reverse` abort a deploy
      // whose host never needed one.
      if (!isLoopbackHost(args.local_backend_host)) {
        plan.reversePorts = [];
      }
    }

    const report: Record<string, unknown> = {
      targetKind: kind,
      host: plan.host,
      rationale: plan.rationale,
      reversePorts: plan.reversePorts,
      defineKeys: {
        env: keys.envKey ?? "USE_LOCAL_ENV",
        host: keys.hostKey ?? "LOCAL_HOST",
      },
    };

    if (!plan.host) {
      return {
        defines: {},
        report,
        fatal:
          `Could not resolve a local-backend host for this ${adapter.platform} ` +
          `${kind} target. ${plan.unresolved ?? ""} ` +
          "Pass local_backend_host explicitly, or drop local_backend. Nothing was " +
          "installed — a build carrying a wrong host fails later, somewhere that " +
          "says nothing about the address.",
      };
    }

    // Checked AFTER resolution so the refusal can hand over the host it worked
    // out, and BEFORE any tunnel, so a refused deploy changes nothing on the
    // device.
    if (!adapter.deployCompilesDefines) {
      const defines = localBackendDefines(plan, keys);
      return {
        defines: {},
        report: { ...report, buildDartDefine: defines },
        fatal:
          `local_backend cannot take effect on a ${adapter.platform} deploy: it installs an ` +
          "app compiled EARLIER, and a host is a compile-time constant, so a deploy-time " +
          "define would change nothing while this response claimed it had. Nothing was " +
          `installed. Resolved for this target: ${plan.host}. Rebuild with flutter_build ` +
          `passing dart_define ${JSON.stringify(defines)}, then deploy without local_backend.`,
      };
    }

    if (plan.reversePorts.length > 0) {
      if (!adapter.setupReverseTunnels) {
        return {
          defines: {},
          report,
          fatal:
            `This target needs an \`adb reverse\` tunnel for ${plan.reversePorts.join(", ")}, ` +
            `but the ${adapter.platform} adapter cannot make one. Pass a routable ` +
            "local_backend_host instead.",
        };
      }
      const tunnel = await adapter.setupReverseTunnels(device, plan.reversePorts);
      report.tunnel = tunnel.detail;
      if (!tunnel.ok) {
        return {
          defines: {},
          report,
          fatal:
            `${tunnel.detail} The host \`${plan.host}\` depends on that tunnel, so ` +
            "nothing was installed rather than shipping a build pointed at a " +
            "loopback address that does not reach this machine.",
        };
      }
    }

    return { defines: localBackendDefines(plan, keys), report };
  }

  async deploy(
    args: CommonArgs & {
      no_launch?: boolean;
      timeout_ms?: number;
      mode?: BuildMode;
      debug?: boolean;
      dart_define?: Record<string, string>;
      target?: "simulator" | "device";
      device_udid?: string;
      app_path?: string;
      app_url?: string;
      local_backend?: boolean;
      local_backend_ports?: number[];
      local_backend_host?: string;
      local_backend_keys?: { env?: string; host?: string };
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard("flutter_deploy", { platform: adapter.platform, ...args }, async () => {
      // 1. One deploy at a time, PER DEVICE: resolve the target and tear down
      // only the drivers holding IT, leaving every other device's session
      // running — a deploy to the emulator used to kill the `flutter run` on the
      // phone attached beside it, so `device_udid` could pick a target but not
      // spare the other one. The order (resolve-then-kill, or kill-first where
      // the teardown needs no device) is tearDownForDeploy's decision.
      const { resolution, killed } = await tearDownForDeploy({
        adapter,
        preference: { kind: args.target, udid: args.device_udid },
      });
      const device = resolution.target;
      const deviceWarning = resolution.warning;

      const environmentDiagnostic = adapter.environmentDiagnostic
        ? (await adapter.environmentDiagnostic(resolution)) ?? undefined
        : undefined;

      // 1b. Local-backend host resolution, BEFORE the install: on iOS/Android the
      // install happens inside `flutter run`, so a define that arrives later
      // never reaches the build that actually runs.
      const localBackend = args.local_backend
        ? await this.planLocalBackend(adapter, device, args)
        : undefined;
      if (localBackend?.fatal) {
        return {
          platform: adapter.platform,
          stage: "local-backend",
          success: false,
          device,
          deviceWarning,
          environmentDiagnostic,
          staleKilled: killed,
          localBackend: localBackend.report,
          reason: localBackend.fatal,
        };
      }
      // Explicit dart_define WINS: a caller who named a key was specific, and
      // silently overwriting it would make the flag change what their own
      // define means.
      const dartDefine =
        localBackend && Object.keys(localBackend.defines).length > 0
          ? { ...localBackend.defines, ...(args.dart_define ?? {}) }
          : args.dart_define;

      // 2. Install the already-built package (install-only).
      let install = await adapter.install(device, {
        noLaunch: true,
        mode: args.mode,
        debug: args.debug,
        dartDefine,
        // macOS-only (ignored by every other adapter): the .app source for this
        // deploy, overriding the configured
        // FLUTTER_DEVICE_MACOS_APP_PATH/FLUTTER_DEVICE_MACOS_APP_URL defaults.
        appPath: args.app_path,
        appUrl: args.app_url,
      });

      // 3. ENOSPC recovery: uninstall + retry the install once.
      const isInstallFailure = (combined: string): boolean =>
        adapter.isInstallFailure
          ? adapter.isInstallFailure(combined)
          : /No space left on device/i.test(combined) ||
            /Install failed/i.test(combined);
      let recovered = false;
      if (!install.success && isInstallFailure(install.combined)) {
        await adapter.uninstall(device, adapter.appId);
        recovered = true;
        install = await adapter.install(device, {
          noLaunch: true,
          mode: args.mode,
          debug: args.debug,
          dartDefine,
          appPath: args.app_path,
          appUrl: args.app_url,
        });
      }

      if (!install.success) {
        const installDiagnostic = adapter.installFailureDiagnostic
          ? (adapter.installFailureDiagnostic(install.combined) ?? undefined)
          : undefined;
        return {
          platform: adapter.platform,
          stage: "install",
          success: false,
          device,
          deviceWarning,
          environmentDiagnostic,
          installDiagnostic,
          staleKilled: killed,
          enospcRecoveryAttempted: recovered,
          localBackend: localBackend?.report,
          install: this.summarizeCli(install, 120),
        };
      }

      if (args.no_launch) {
        return {
          platform: adapter.platform,
          stage: "install",
          success: true,
          launched: false,
          device,
          deviceWarning,
          environmentDiagnostic,
          staleKilled: killed,
          enospcRecoveryAttempted: recovered,
          localBackend: localBackend?.report,
          install: this.summarizeCli(install, 60),
        };
      }

      // 4. Launch through a pty, backgrounded, and capture the VM Service URI.
      const timeoutMs = args.timeout_ms ?? 180000;
      // The launch must name the mode of what was just installed (Tizen's
      // `--no-build` reuses only a TPK of the named mode).
      const launchMode = args.mode ?? (args.debug ? "debug" : undefined);
      let outcome = await adapter.launchAndCaptureUri(
        device,
        timeoutMs,
        launchMode,
        // The MERGED defines, not args.dart_define: on iOS/Android the launch is
        // the `flutter run` that compiles the app, so anything left out here is
        // left out of the binary — the local-backend host included.
        dartDefine
      );

      // 4a. Reactive launch-failure recovery (iOS first-time provisioning).
      let launchRecovery: { recovered: boolean; note?: string } | undefined;
      if (isLaunchFailure(outcome) && adapter.recoverLaunchFailure) {
        launchRecovery = await adapter.recoverLaunchFailure(
          device,
          outcome.logTail ?? outcome.reason ?? ""
        );
        if (launchRecovery.recovered) {
          outcome = await adapter.launchAndCaptureUri(
            device,
            timeoutMs,
            launchMode,
            dartDefine
          );
        }
      }

      if (isLaunchFailure(outcome)) {
        return {
          platform: adapter.platform,
          stage: "launch",
          success: false,
          launched: false,
          device,
          deviceWarning,
          environmentDiagnostic,
          staleKilled: killed,
          enospcRecoveryAttempted: recovered,
          localBackend: localBackend?.report,
          launchRecovery,
          reason: outcome.reason,
          runtimeDiagnostic: adapter.runtimeCrashDiagnostic
            ? (adapter.runtimeCrashDiagnostic(
                outcome.logTail ?? outcome.reason ?? ""
              ) ?? undefined)
            : undefined,
          pid: outcome.pid,
          logPath: outcome.logPath,
          logTail: outcome.logTail,
        };
      }

      // No Dart VM service exists at all for a launch that is not a `flutter
      // run` daemon (an empty URI is how the macOS adapter reports it), so the
      // probe is skipped rather than dialing an empty ws:// URL just to watch
      // it fail.
      const marionette: MarionetteProbeResult = outcome.vmServiceUriWs
        ? await this.probeMarionette(outcome.vmServiceUriWs)
        : outcome.noVmServiceReason
          ? // The launch SUCCEEDED and the adapter knows why there is no URI (a
            // release build has none; a settled non-debug run is not getting one).
            // That is a determinate answer, so report `false` rather than the
            // `null` that means "could not determine".
            {
              marionetteReady: false,
              marionetteHint: outcome.noVmServiceReason,
            }
          : {
              marionetteReady: null,
              marionetteHint:
                "This platform has no Dart VM service (macOS launches a prebuilt .app " +
                "directly, not under `flutter run`), so an in-app driver such as " +
                "Marionette does not apply. Drive it with flutter_pointer/flutter_key/" +
                "flutter_screenshot instead.",
            };
      // A non-debug launch CAN hand back a live URI (profile keeps the VM service
      // open) while still registering no ext.flutter.marionette.* extension, so the
      // probe's bare "not ready" would send the caller hunting for a broken URI.
      // The adapter states which half is missing; carry it into the hint so it
      // cannot be missed.
      const marionetteHint =
        outcome.vmServiceUriWs && outcome.launchModeCaveat
          ? [marionette.marionetteHint, outcome.launchModeCaveat]
              .filter(Boolean)
              .join(" ")
          : marionette.marionetteHint;

      // Persist the launch so hot_reload/restart can reach this daemon later.
      // Skipped when there is no VM service to reconnect to (macOS).
      if (outcome.vmServiceUriWs) {
        recordLaunch({
          platform: adapter.platform,
          device,
          vmServiceUriWs: outcome.vmServiceUriWs,
          vmServiceUriHttp: outcome.vmServiceUriHttp,
          pid: outcome.pid,
          logPath: outcome.logPath,
          controlFifoPath: outcome.controlFifoPath,
          recordedAt: Date.now(),
        });
      }

      const isTvLike =
        adapter.platform === "tizen" ||
        adapter.platform === "webos" ||
        adapter.platform === "tvos";
      const note =
        adapter.platform === "macos"
          ? "macOS has no Dart VM service — this launched a prebuilt signed .app from a " +
            "scratch dir (never /Applications), pid above. Drive it with flutter_pointer " +
            "(window-relative by default), flutter_key, and flutter_screenshot " +
            "(window-targeted); flutter_geometry reports the window's live bounds. " +
            "flutter_hot_reload/flutter_hot_restart do not apply (no daemon to reload)."
          : "The launch process is left running to hold the VM service open for a driver " +
            "(e.g. Marionette). Use flutter_hot_reload against this same daemon for a fast inner " +
            "loop instead of rebuilding + redeploying." +
            (adapter.platform === "ios" || adapter.platform === "android"
              ? " Drive the app with Marionette (tap/enter_text/scroll) over this VM service; the " +
                "flutter_key/flutter_pointer input tools do not apply. Use flutter_background/" +
                "flutter_foreground to exercise app lifecycle."
              : "") +
            (adapter.platform === "tvos"
              ? " NOTE (tvOS): the VM-service URI is a ws://127.0.0.1:<port>/<authCode>=/ws loopback " +
                "forward held open by the launch process over the CoreDevice tunnel — the auth code is " +
                "PER-RUN, so re-deploy (not just reconnect) after a relaunch. This launch has seized the " +
                "Apple TV's HDMI display."
              : "") +
            (isTvLike && adapter.platform !== "tvos"
              ? " This launch has seized the physical TV/monitor display."
              : "");

      return {
        platform: adapter.platform,
        stage: "launch",
        success: true,
        launched: true,
        deviceWarning,
        controlChannel: outcome.controlFifoPath ? true : undefined,
        controlChannelWarning:
          outcome.vmServiceUriWs &&
          !outcome.controlFifoPath &&
          // A non-debug launch is a COLD run with no reload/restart to drive, so
          // its missing channel is the mode, not a host limitation. Reporting the
          // host warning there would blame the wrong thing.
          !outcome.launchModeCaveat
            ? NO_PTY_FORWARDER_REASON
            : undefined,
        environmentDiagnostic,
        staleKilled: killed,
        enospcRecoveryAttempted: recovered,
        localBackend: localBackend?.report,
        launchRecovery,
        vmServiceUriWs: outcome.vmServiceUriWs,
        vmServiceUriHttp: outcome.vmServiceUriHttp,
        pid: outcome.pid,
        logPath: outcome.logPath,
        device,
        launchMode: outcome.launchMode,
        launchModeCaveat: outcome.launchModeCaveat,
        noVmServiceReason: outcome.noVmServiceReason,
        marionetteReady: marionette.marionetteReady,
        marionetteHint,
        note,
      };
    });
  }

  // =========== uninstall ==========
  async uninstall(
    args: CommonArgs & { device_udid?: string }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_uninstall",
      { platform: adapter.platform, appId: adapter.appId },
      async () => {
        if (!adapter.appId) return this.missingAppId(adapter, "uninstall");
        const resolution = await adapter.discoverDevice({
          udid: args.device_udid,
        });
        const device = resolution.target;
        const result = await adapter.uninstall(device, adapter.appId);
        const notInstalled = /not installed|no such|does not exist/i.test(
          result.combined
        );
        return {
          platform: adapter.platform,
          success: result.success || notInstalled,
          softSuccess: notInstalled && !result.success,
          device,
          deviceWarning: resolution.warning,
          appId: adapter.appId,
          output: tail(result.combined, 60),
        };
      }
    );
  }

  // =========== kill_stale ==========
  async killStale(
    args: CommonArgs & { device_udid?: string; all_devices?: boolean }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard("flutter_kill_stale", { platform: adapter.platform }, async () =>
      // Every decision here — which scope, whether to refuse, which launch
      // records the teardown invalidated — lives in killStaleFlow so it can be
      // tested against a fake adapter. It could not be while it was inline: a
      // refusal that killed the host anyway and reported `killed: false` passed
      // the entire suite.
      runKillStale({
        adapter,
        args,
        store: {
          readRecords,
          removeControlFifo,
          clearLaunch,
          clearLaunches,
        },
      })
    );
  }

  /** Shared "app id not configured" result for uninstall/lifecycle. */
  private missingAppId(adapter: PlatformAdapter, verb: string): CommandOutput {
    return {
      platform: adapter.platform,
      success: false,
      supported: true,
      reason:
        `Cannot ${verb}: no app id is configured for ${adapter.platform} and it could not be ` +
        `derived from the project. Set FLUTTER_DEVICE_${adapter.platform.toUpperCase()}_APP_ID ` +
        `or add platforms.${adapter.platform}.appId to flutter-device.config.json.`,
    };
  }

  // =========== lifecycle (terminate/background/foreground) ==========
  private async lifecycleOp(
    toolName: string,
    verb: "terminate" | "background" | "foreground",
    args: CommonArgs & { device_udid?: string },
    note: string
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(toolName, { platform: adapter.platform, verb }, async () => {
      if (!adapter.lifecycle) {
        return {
          platform: adapter.platform,
          verb,
          supported: false,
          reason:
            `OS-level app lifecycle (${verb}) is not supported on ${adapter.platform}. ` +
            "It is a mobile capability (iOS/Android). Use platform 'ios' or 'android'.",
        };
      }
      if (!adapter.appId) return this.missingAppId(adapter, verb);
      const resolution = await adapter.discoverDevice({
        udid: args.device_udid,
      });
      const device = resolution.target;
      const result = await adapter.lifecycle[verb](device, adapter.appId);
      return {
        platform: adapter.platform,
        verb,
        success: result.success,
        device,
        deviceWarning: resolution.warning,
        appId: adapter.appId,
        output: tail(result.combined, 60),
        note,
      };
    });
  }

  terminate(args: CommonArgs & { device_udid?: string }): Promise<CommandOutput> {
    return this.lifecycleOp(
      "flutter_terminate",
      "terminate",
      args,
      "Force-quit the app. Its Dart VM service (and any driver connection) is gone after this; redeploy to get a fresh URI."
    );
  }

  background(args: CommonArgs & { device_udid?: string }): Promise<CommandOutput> {
    return this.lifecycleOp(
      "flutter_background",
      "background",
      args,
      "Sent the app to the background WITHOUT killing it (iOS: foreground a neutral system app; Android: HOME keyevent) — its didEnterBackground/onPause lifecycle runs and its VM service stays alive. Foreground it again with flutter_foreground."
    );
  }

  foreground(args: CommonArgs & { device_udid?: string }): Promise<CommandOutput> {
    return this.lifecycleOp(
      "flutter_foreground",
      "foreground",
      args,
      "Brought the app back to the foreground by relaunching its bundle id (exercises didBecomeActive). State is preserved when the app was only backgrounded (not terminated)."
    );
  }

  /**
   * Look up the recorded launch, or a ready-made result when there is nothing to
   * act on.
   *
   * TWO launches with no device named is a miss, not a pick. Per-device teardown
   * means a deploy no longer ends the other device's session, so two live
   * daemons is normal now — and reloading "the latest" would land on whichever
   * was deployed most recently, which reads as a reload that did nothing.
   */
  private findLaunchRecord(adapter: PlatformAdapter, device: string | undefined) {
    const lookup = resolveLaunch(adapter.platform, device);
    if (lookup.kind === "found") return { record: lookup.record };
    return {
      miss: {
        platform: adapter.platform,
        success: false,
        triggered: false,
        devices: lookup.kind === "ambiguous" ? lookup.devices : undefined,
        reason:
          lookup.kind === "ambiguous"
            ? `Two or more launches are live on this platform (${lookup.devices.join(", ")}), ` +
              "so which one to reload is ambiguous. Pass `device` to name it — reloading the " +
              "most recent one would silently drive the wrong device."
            : "No live launch daemon is recorded for this platform. Run flutter_deploy first " +
              "(it launches the app and records its VM service URI + control channel for hot reload/restart).",
      } as CommandOutput,
    };
  }

  /** VM-service reload FALLBACK (used only when no live control FIFO exists). */
  private async vmServiceReload(
    adapter: PlatformAdapter,
    record: { device: string; vmServiceUriWs: string },
    timeoutMs: number | undefined,
    fellBackFrom:
      | "no-control-channel"
      | "dead-control-channel"
      | "unconfirmed-control-channel"
  ): Promise<CommandOutput> {
    const client = new VmServiceClient({
      wsUri: record.vmServiceUriWs,
      timeoutMs: timeoutMs ?? undefined,
    });
    try {
      const outcome: ReloadOutcome = await hotReload(client);
      return {
        platform: adapter.platform,
        success: outcome.success,
        triggered: true,
        via: "vm-service",
        fellBackFrom,
        operation: outcome.kind,
        device: record.device,
        vmServiceUriWs: record.vmServiceUriWs,
        isolates: outcome.isolates,
        reports: outcome.reports,
        note:
          "Reloaded over the VM service (reloadSources + reassemble) because no live pty control " +
          "channel was available. This is weaker than the flutter tool's `r`: a fresh deploy " +
          "(flutter_deploy) re-establishes the control channel for a true `r`/`R`. A hot RESTART " +
          "(re-run main()) is not reachable over the VM service — redeploy.",
      };
    } catch (error) {
      clearLaunch(adapter.platform, record.device);
      return {
        platform: adapter.platform,
        success: false,
        triggered: false,
        device: record.device,
        vmServiceUriWs: record.vmServiceUriWs,
        reason:
          (error instanceof Error ? error.message : String(error)) +
          " The launch daemon may have exited — redeploy with flutter_deploy.",
      };
    } finally {
      client.close();
    }
  }

  // =========== hot_reload ==========
  async hotReload(
    args: CommonArgs & { device?: string; timeout_ms?: number }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_hot_reload",
      { platform: adapter.platform, device: args.device },
      async () => {
        const found = this.findLaunchRecord(adapter, args.device);
        if (found.miss) return found.miss;
        const { record } = found;

        if (record.controlFifoPath) {
          // Measure the log BEFORE sending, so a previous reload's
          // acknowledgement cannot be read as this one's.
          const logFrom = record.logPath
            ? await logSize(record.logPath)
            : undefined;
          const outcome = await hotControl(
            "reload",
            (c) => sendControlChar(record.controlFifoPath!, c),
            record.logPath
              ? () =>
                  confirmHotAction({
                    logPath: record.logPath!,
                    action: "reload",
                    fromByte: logFrom ?? 0,
                  })
              : undefined
          );
          if (outcome.triggered && outcome.confirmed === false) {
            // The bytes landed and flutter never acknowledged them, so nothing
            // is known to have reloaded. The VM service can still reload
            // sources, so take it rather than reporting a reload that did not
            // happen.
            return this.vmServiceReload(
              adapter,
              record,
              args.timeout_ms,
              "unconfirmed-control-channel"
            );
          }
          if (outcome.triggered) {
            return {
              platform: adapter.platform,
              success: true,
              triggered: true,
              confirmed: outcome.confirmed,
              via: outcome.via,
              operation: outcome.kind,
              device: record.device,
              controlFifoPath: record.controlFifoPath,
              note:
                (outcome.confirmed
                  ? "Sent `r` over the pty control channel and SAW the flutter tool acknowledge it — a "
                  : "Sent `r` over the pty control channel. NOT CONFIRMED (no launch log to watch), so " +
                    "treat the reload as unverified — a ") +
                "REAL hot reload recompiles changed Dart + reassembles, stronger than the " +
                "VM-service reassemble. Preserves state. Use flutter_hot_restart (`R`) for changes " +
                "a reload can't apply (main(), top-level/global state, new enums/static fields).",
            };
          }
          return this.vmServiceReload(
            adapter,
            record,
            args.timeout_ms,
            "dead-control-channel"
          );
        }

        return this.vmServiceReload(
          adapter,
          record,
          args.timeout_ms,
          "no-control-channel"
        );
      }
    );
  }

  // =========== hot_restart ==========
  async hotRestart(args: CommonArgs & { device?: string }): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_hot_restart",
      { platform: adapter.platform, device: args.device },
      async () => {
        const found = this.findLaunchRecord(adapter, args.device);
        if (found.miss) return found.miss;
        const { record } = found;

        if (!record.controlFifoPath) {
          return {
            platform: adapter.platform,
            success: false,
            triggered: false,
            device: record.device,
            reason:
              "No pty control channel is recorded for this launch, so a hot restart cannot be " +
              "driven (it re-runs main() via the flutter tool's stdin `R`, not reachable over the VM " +
              "service). Redeploy with flutter_deploy to establish the control channel. If the " +
              "redeploy's response carries a controlChannelWarning, the host is missing what the " +
              "channel needs: " +
              NO_PTY_FORWARDER_REASON,
          };
        }

        const restartLogFrom = record.logPath
          ? await logSize(record.logPath)
          : undefined;
        const outcome = await hotControl(
          "restart",
          (c) => sendControlChar(record.controlFifoPath!, c),
          record.logPath
            ? () =>
                confirmHotAction({
                  logPath: record.logPath!,
                  action: "restart",
                  fromByte: restartLogFrom ?? 0,
                })
            : undefined
        );
        if (outcome.triggered && outcome.confirmed === false) {
          // There is no VM-service equivalent of a restart, so this cannot be
          // rescued the way an unconfirmed reload can — say so plainly instead
          // of returning a success the app never performed.
          return {
            platform: adapter.platform,
            success: false,
            triggered: true,
            confirmed: false,
            device: record.device,
            controlFifoPath: record.controlFifoPath,
            logPath: record.logPath,
            reason:
              "Wrote `R` to the control channel but the flutter tool never acknowledged a restart " +
              "within the confirmation window. The write landing is not the restart happening, and " +
              "there is no VM-service equivalent to fall back to (reloadSources cannot re-run " +
              "main()), so this is reported as a failure rather than a restart the app never " +
              "performed. The launch drives `R` through a pty (the flutter tool only reads keys on " +
              "a terminal), so a channel that accepts the write should act on it: check the launch " +
              "log for a still-compiling restart or an exited daemon, then redeploy with " +
              "flutter_deploy to pick up the change.",
          };
        }
        if (!outcome.triggered) {
          clearLaunch(adapter.platform, record.device);
          return {
            platform: adapter.platform,
            success: false,
            triggered: false,
            device: record.device,
            controlFifoPath: record.controlFifoPath,
            reason:
              "Could not write `R` to the control channel — the launch daemon has likely exited. " +
              "Redeploy with flutter_deploy.",
          };
        }
        // Confirmed (`true`) and unwatched (`undefined`) both land here, and
        // they are different facts: only the first one saw the flutter tool act.
        // So `confirmed` is passed STRAIGHT THROUGH rather than dropped — a
        // caller that cannot see the difference has no way to distinguish a
        // restart that happened from one nobody looked at — and the note
        // branches instead of asserting main() re-ran in both cases.
        //
        // Unwatched stays a success rather than becoming a failure: a
        // CONTRADICTED restart (above) waited out the confirmation window and
        // saw nothing, which is positive evidence; an unwatched one has no
        // evidence either way and a write to a live pty-bridged FIFO normally
        // does reach flutter, so reporting failure would send the caller into
        // an unnecessary redeploy. The defect was the UNQUALIFIED success, not
        // the success. This mirrors the unconfirmed-reload shape above on
        // purpose: the pair is only readable if both say "unverified" the same
        // way.
        return {
          platform: adapter.platform,
          success: true,
          triggered: true,
          confirmed: outcome.confirmed,
          via: outcome.via,
          operation: outcome.kind,
          device: record.device,
          controlFifoPath: record.controlFifoPath,
          note:
            (outcome.confirmed
              ? "Sent `R` to the running flutter daemon's stdin over the pty control channel and " +
                "SAW the flutter tool acknowledge it — a hot "
              : "Sent `R` to the running flutter daemon's stdin over the pty control channel. NOT " +
                "CONFIRMED (no launch log to watch), so treat the restart as UNVERIFIED: do not " +
                "assume main() re-ran or that in-memory state was dropped — check the app, or " +
                "redeploy with flutter_deploy to get a launch log this can be confirmed against. " +
                "A hot ") +
            "RESTART: re-runs main() and drops in-memory state, while KEEPING the process, its VM " +
            "service URI, and any driver connection alive (no redeploy, no new URI).",
        };
      }
    );
  }

  // =========== diagnose ==========
  /**
   * Read a launch log and name any RUNTIME crash class in it.
   *
   * WHY THIS TOOL EXISTS, and it is the whole point: the launch poll stops the
   * moment the VM-service URI appears, deliberately — a found URI outranks every
   * failure signature, because the launch genuinely succeeded. But an Impeller
   * constant-buffer overflow fires when a shader is first RASTERIZED, which is
   * normally AFTER that. So the crash that most needs naming lands in the window
   * where nothing is watching any more: `flutter_deploy` returns success, the app
   * is dead, and the log holds the only evidence.
   *
   * Wiring the detector solely into the launch-failure branch would have shipped a
   * check that cannot fire in its own common case. This is the surface that fires.
   *
   * `log_path` defaults to the log of the most recent recorded launch, so the
   * ordinary call is argument-free right after a deploy.
   */
  async diagnose(
    args: CommonArgs & { device?: string; log_path?: string }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_diagnose",
      { platform: adapter.platform, device: args.device },
      async () => {
        let logPath = args.log_path;
        let device: string | undefined;

        if (!logPath) {
          const found = this.findLaunchRecord(adapter, args.device);
          if (found.miss) {
            return {
              platform: adapter.platform,
              success: false,
              reason:
                "No launch is recorded for this platform and no log_path was given, so there is " +
                "nothing to read. Run flutter_deploy first, or pass log_path explicitly.",
            };
          }
          device = found.record.device;
          logPath = found.record.logPath;
          if (!logPath) {
            return {
              platform: adapter.platform,
              success: false,
              device,
              reason:
                "The recorded launch carries no log path (it predates log capture). Redeploy with " +
                "flutter_deploy, or pass log_path explicitly.",
            };
          }
        }

        let contents: string;
        try {
          contents = fs.readFileSync(logPath, "utf8");
        } catch {
          // A log that cannot be READ is not a log with no crash in it. Saying
          // "no known crash" here would report ignorance as a clean bill of health.
          return {
            platform: adapter.platform,
            success: false,
            device,
            logPath,
            reason:
              `Could not read the launch log at ${logPath}. This is NOT a finding that the log ` +
              "is clean — nothing was examined. The launch process may have cleaned it up, or " +
              "the path may be from a previous boot's temp dir.",
          };
        }

        if (!adapter.runtimeCrashDiagnostic) {
          return {
            platform: adapter.platform,
            success: true,
            device,
            logPath,
            crashFound: false,
            note:
              `No runtime-crash classifier is wired for ${adapter.platform}, so this log was NOT ` +
              "examined. Absence of a finding here says nothing about the log's contents.",
          };
        }

        const diagnostic = adapter.runtimeCrashDiagnostic(contents);
        if (!diagnostic) {
          return {
            platform: adapter.platform,
            success: true,
            device,
            logPath,
            crashFound: false,
            note:
              "No KNOWN runtime crash class matched this log. That is not the same as the app " +
              "being healthy — it means nothing in the classifier's set is present. " +
              `Read ${logPath} directly if the app is misbehaving.`,
          };
        }

        return {
          platform: adapter.platform,
          success: true,
          device,
          logPath,
          crashFound: true,
          runtimeDiagnostic: diagnostic,
          logTail: tail(contents, 40),
        };
      }
    );
  }

  // =========== screenshot ==========
  async screenshot(
    args: CommonArgs & {
      output_path?: string;
      include_base64?: boolean;
      device_udid?: string;
      target?: "device" | "simulator";
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_screenshot",
      { platform: adapter.platform, outputPath: args.output_path },
      async () => {
        if (!adapter.screenshot) {
          return {
            platform: adapter.platform,
            captured: false,
            supported: false,
            reason: `Screen capture is not implemented on ${adapter.platform}.`,
          };
        }
        const result = await adapter.screenshot({
          outPath: args.output_path,
          includeBase64: args.include_base64,
          deviceUdid: args.device_udid,
          target: args.target,
        });
        return { platform: adapter.platform, ...result };
      }
    );
  }

  // =========== openUrl ==========
  async openUrl(
    args: CommonArgs & {
      url: string;
      package_or_bundle_id?: string;
      target?: "device" | "simulator";
      device_udid?: string;
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_open_url",
      { platform: adapter.platform, url: args.url },
      async () => {
        // An adapter with no open-url seam reports unsupported (mirroring
        // screenshot/lifecycle), never an error.
        if (!adapter.openUrl) {
          return {
            platform: adapter.platform,
            opened: false,
            supported: false,
            url: args.url,
            reason: `Opening a URL is not implemented on ${adapter.platform}.`,
            hint:
              adapter.platform === "tizen" || adapter.platform === "webos"
                ? "Samsung/LG appliances expose no device-side launcher here (`sdb shell` is disabled on Samsung devices). Drive the app over the VM service instead."
                : undefined,
          };
        }
        // Target preference matters MORE here than for other verbs: Apple
        // supports this on a SIMULATOR and not on a physical device, while
        // discovery is physical-first — so without this a host with a paired
        // iPhone could never reach the path that works.
        const result = await adapter.openUrl(
          args.url,
          args.package_or_bundle_id,
          { kind: args.target, udid: args.device_udid }
        );
        return { platform: adapter.platform, ...result };
      }
    );
  }

  // =========== record ==========
  async record(
    args: CommonArgs & {
      output_path?: string;
      duration_s?: number;
      fps?: number;
      format?: "mp4" | "gif";
      device_udid?: string;
      target?: "device" | "simulator";
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_record",
      {
        platform: adapter.platform,
        outputPath: args.output_path,
        durationSeconds: args.duration_s,
        format: args.format,
      },
      async () => {
        if (!adapter.record) {
          return {
            platform: adapter.platform,
            recorded: false,
            supported: false,
            reason: `Screen recording is not implemented on ${adapter.platform}.`,
          };
        }
        const format: RecordFormat = args.format === "gif" ? "gif" : "mp4";
        const durationSeconds =
          typeof args.duration_s === "number" && args.duration_s > 0
            ? args.duration_s
            : DEFAULT_DURATION_SECONDS;
        const fps =
          typeof args.fps === "number" && args.fps > 0 ? args.fps : DEFAULT_FPS;
        const result = await adapter.record({
          outPath: args.output_path,
          durationSeconds,
          fps,
          format,
          deviceUdid: args.device_udid,
          target: args.target,
        });
        return { platform: adapter.platform, ...result };
      }
    );
  }

  // =========== set_input_mode ==========
  async setInputMode(args: CommonArgs & { mode: InputMode }): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_set_input_mode",
      { platform: adapter.platform, mode: args.mode },
      async () => {
        if (args.mode !== "dpad" && args.mode !== "pointer") {
          throw new McpError(
            ErrorCode.InvalidParams,
            `mode must be "dpad" or "pointer", received ${JSON.stringify(args.mode)}`
          );
        }
        const input = adapter.input();
        input.setMode(args.mode);
        return {
          platform: adapter.platform,
          mode: input.mode,
          note: "Input mode is session-sticky. It records the active plane; flutter_key and flutter_pointer send regardless of mode.",
        };
      }
    );
  }

  // =========== key ==========
  async key(
    args: CommonArgs & { key?: string; text?: string; device_udid?: string }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_key",
      { platform: adapter.platform, key: args.key, text: args.text },
      async () => {
        const hasKey =
          typeof args.key === "string" && args.key.trim().length > 0;
        const hasText =
          typeof args.text === "string" && args.text.length > 0;
        // Exactly one: they are different channels (`input keyevent` vs
        // `input text`), and silently preferring one would drop the other.
        if (hasKey === hasText) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Provide exactly one of `key` (a navigation/remote key) or `text` " +
              "(a string to type into the focused field)."
          );
        }
        const input = adapter.input({ udid: args.device_udid });

        if (hasText) {
          // Text injection is an OPTIONAL controller capability (Android's
          // `adb shell input text` today). Absence — or a controller that
          // throws UnsupportedInputError — is surfaced as a clear, non-fatal
          // {supported:false} result rather than an internal error.
          try {
            if (!input.text) {
              throw new UnsupportedInputError(
                `Text input is not wired on ${adapter.platform}. Use a driver ` +
                  "over the Dart VM service to type into the app instead."
              );
            }
            await input.text(args.text as string);
          } catch (error) {
            const notSupported = mapUnsupportedInput(
              error,
              adapter.platform,
              "text"
            );
            if (notSupported) return notSupported;
            throw error;
          }
          return {
            platform: adapter.platform,
            mode: input.mode,
            text: args.text,
            sent: true,
            deviceWarning: adapter.inputDeviceWarning?.(),
          };
        }

        try {
          await input.key(args.key as string);
        } catch (error) {
          const notSupported = mapUnsupportedInput(error, adapter.platform, "key");
          if (notSupported) return notSupported;
          throw error;
        }
        return {
          platform: adapter.platform,
          mode: input.mode,
          key: args.key,
          sent: true,
          deviceWarning: adapter.inputDeviceWarning?.(),
        };
      }
    );
  }

  /**
   * The position a positional click just used, for the response. ADVISORY: a
   * controller with no such position (focus-driven click, or a real OS cursor)
   * omits the seam, and any read failure resolves to undefined — reporting
   * where a tap landed must never be able to fail a tap that worked.
   */
  private async pointerPosition(
    input: InputController
  ): Promise<{ x: number; y: number } | undefined> {
    if (!input.pointerPosition) return undefined;
    try {
      const position = await input.pointerPosition();
      return position ? { x: position.x, y: position.y } : undefined;
    } catch {
      return undefined;
    }
  }

  // =========== pointer ==========
  async pointer(
    args: CommonArgs & {
      action: "move" | "click" | "scroll";
      x?: number;
      y?: number;
      dy?: number;
      coordinateSpace?: "device" | "logical";
      dpr?: number;
      absolute?: boolean;
      double?: boolean;
      duration_ms?: number;
      verify?: boolean;
      device_udid?: string;
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_pointer",
      { platform: adapter.platform, action: args.action },
      async () => {
        const input = adapter.input({ udid: args.device_udid });
        switch (args.action) {
          case "move": {
            const { point, coordinateSpace } = resolvePointerTarget(args);
            try {
              await input.pointerMove(point.x, point.y, {
                absolute: args.absolute,
              });
            } catch (error) {
              const notSupported = mapUnsupportedInput(error, adapter.platform, "move");
              if (notSupported) return notSupported;
              throw error;
            }
            return {
              platform: adapter.platform,
              mode: input.mode,
              action: "move",
              coordinateSpace,
              absolute: args.absolute,
              devicePosition: point,
              sent: true,
              deviceWarning: adapter.inputDeviceWarning?.(),
            };
          }
          case "click": {
            // Coordinates ON the click are staged first, so a tap is ONE call
            // instead of the move-then-click pair a caller would otherwise
            // write. Omitting them preserves the staged-position behavior.
            const staged =
              args.x !== undefined && args.y !== undefined
                ? resolvePointerTarget(args)
                : undefined;
            if (staged) {
              // Staging is reported as its OWN action: on a focus-driven
              // platform `click` IS supported but positioning is not, so
              // blaming "click" here would deny a verb that works.
              try {
                await input.pointerMove(staged.point.x, staged.point.y, {
                  absolute: args.absolute,
                });
              } catch (error) {
                const notSupported = mapUnsupportedInput(
                  error,
                  adapter.platform,
                  "click at coordinates"
                );
                if (notSupported) return notSupported;
                throw error;
              }
            }
            try {
              await input.pointerClick({ double: args.double });
            } catch (error) {
              const notSupported = mapUnsupportedInput(error, adapter.platform, "click");
              if (notSupported) return notSupported;
              throw error;
            }
            // Report WHERE the tap landed, not just that one was sent: on a
            // positional platform a bare `sent: true` leaves a mis-tap
            // indistinguishable from a mis-staged coordinate. Purely advisory —
            // a failed read never turns a successful click into an error.
            const tapped = staged?.point ?? (await this.pointerPosition(input));
            return {
              platform: adapter.platform,
              mode: input.mode,
              action: "click",
              sent: true,
              deviceWarning: adapter.inputDeviceWarning?.(),
              ...(staged ? { coordinateSpace: staged.coordinateSpace } : {}),
              ...(tapped ? { devicePosition: tapped } : {}),
              note: staged
                ? "Tapped at the coordinates given on this call."
                : "Taps the staged pointer position where the platform has one — reported as devicePosition — or activates the currently-focused element (KEY_ENTER) on focus/D-pad-driven platforms. Passing x/y here taps a coordinate in ONE call instead.",
            };
          }
          case "scroll": {
            const { dy, coordinateSpace, durationMs } = resolveScrollDelta(args);
            // The outcome is reported when the controller returns one, because
            // `sent: true` alone cannot distinguish a scroll that worked from a
            // request the screen's bounds truncated or one the app ignored —
            // and a caller who cannot tell those apart reasonably concludes the
            // whole plane is dead and goes looking in the wrong place.
            let outcome;
            try {
              outcome = await input.pointerScroll(dy, {
                absolute: args.absolute,
                durationMs,
                verify: args.verify,
              });
            } catch (error) {
              const notSupported = mapUnsupportedInput(error, adapter.platform, "scroll");
              if (notSupported) return notSupported;
              throw error;
            }
            return {
              platform: adapter.platform,
              mode: input.mode,
              action: "scroll",
              coordinateSpace,
              deviceDy: dy,
              sent: true,
              deviceWarning: adapter.inputDeviceWarning?.(),
              ...(outcome ? { gesture: outcome } : {}),
            };
          }
          default:
            throw new McpError(
              ErrorCode.InvalidParams,
              `action must be "move", "click", or "scroll", received ${JSON.stringify(
                args.action
              )}`
            );
        }
      }
    );
  }

  // =========== system_prompt ==========
  async systemPrompt(
    args: CommonArgs & {
      action: "detect" | "tap" | "dismiss";
      button_label?: string;
      udid?: string;
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_system_prompt",
      { platform: adapter.platform, action: args.action },
      async () => {
        if (
          args.action !== "detect" &&
          args.action !== "tap" &&
          args.action !== "dismiss"
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `action must be "detect", "tap", or "dismiss", received ${JSON.stringify(
              args.action
            )}`
          );
        }
        if (!adapter.systemPrompt) {
          return {
            platform: adapter.platform,
            action: args.action,
            supported: false,
            reason:
              `System-prompt detection/tapping is not supported on ${adapter.platform}. ` +
              "It is a mobile capability (iOS today, via idb over the accessibility tree). Use platform 'ios'.",
          };
        }
        const result = await adapter.systemPrompt.handle(
          args.action,
          args.button_label,
          args.udid
        );
        return {
          platform: adapter.platform,
          supported: true,
          action: args.action,
          udid: args.udid,
          ...result,
        };
      }
    );
  }

  // =========== geometry ==========
  async geometry(
    args: CommonArgs & {
      device_udid?: string;
      view_width?: number;
      view_height?: number;
      view_dpr?: number;
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_geometry",
      { platform: adapter.platform, deviceUdid: args.device_udid },
      async () => {
        // Validate the caller-supplied view metrics FIRST: resolving a device
        // and shelling two adb round-trips at it only to reject an argument
        // afterwards spends the device's time on a typo.
        const view = resolveViewMetrics(args);

        if (!adapter.geometry) {
          return {
            platform: adapter.platform,
            supported: false,
            reason:
              `Screen geometry is not wired on ${adapter.platform}. It is ` +
              "wired on Android (adb wm size + wm density) and macOS (the target " +
              "window's live bounds via System Events); no ratio is assumed for " +
              "other platforms.",
          };
        }

        let geometry: DeviceGeometryReading | undefined;
        try {
          geometry = await adapter.geometry({ udid: args.device_udid });
        } catch (error) {
          return {
            platform: adapter.platform,
            supported: false,
            reason: `Could not read screen geometry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        if (!geometry) {
          return {
            platform: adapter.platform,
            supported: false,
            reason:
              "The device answered but its screen size/density output could not " +
              "be parsed, so no device pixel ratio is reported (rather than " +
              "guessed).",
          };
        }

        // The view half is whatever the CALLER supplied — this server never
        // reads the running app, so an absent view simply means no view
        // observation.
        const check = crossCheckView(
          geometry,
          view.logicalSize,
          view.devicePixelRatio
        );
        return {
          platform: adapter.platform,
          supported: true,
          ...geometry,
          viewLogicalSize: view.logicalSize,
          viewDevicePixelRatio: view.devicePixelRatio,
          notes: check.notes,
          warnings: check.warnings,
          note:
            adapter.platform === "macos"
              ? GEOMETRY_COORDINATE_NOTE_MACOS
              : GEOMETRY_COORDINATE_NOTE,
        };
      }
    );
  }
}
