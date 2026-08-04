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
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger.js";
import { CommandResult, tail } from "../cli.js";
import {
  BuildMode,
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
  summarizeKillStale,
} from "../handlerLogic.js";
import {
  clearLaunch,
  clearLaunches,
  findLaunch,
  readRecords,
  recordLaunch,
} from "../launchRegistry.js";
import { VmServiceClient } from "../vmServiceClient.js";
import { hotReload, ReloadOutcome } from "../hotReload.js";
import { hotControl } from "../hotControl.js";
import { sendControlChar, removeControlFifo } from "../ptyControl.js";
import {
  MarionetteProbeResult,
  probeMarionetteReady,
} from "../marionetteProbe.js";

/**
 * Per-request VM-service timeout for the post-deploy Marionette probe. Kept well
 * under the probe's ~10s total wall budget so a single wedged connect/RPC can't
 * outrun the budget (the client's 20s default would).
 */
const MARIONETTE_PROBE_CLIENT_TIMEOUT_MS = 3000;

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
        skip_rust: args.skip_rust,
        skip_flutter: args.skip_flutter,
        install: args.install,
        run: args.run,
      });
      return {
        platform: adapter.platform,
        ...this.summarizeCli(build.result, 200),
        artifactPath: build.artifactPath,
        enospc: build.enospc,
        installFailed: build.installFailed,
        launchedDisplay: build.launchedDisplay,
      };
    });
  }

  // =========== deploy ==========
  async deploy(
    args: CommonArgs & {
      no_launch?: boolean;
      timeout_ms?: number;
      mode?: BuildMode;
      debug?: boolean;
      target?: "simulator" | "device";
      device_udid?: string;
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard("flutter_deploy", { platform: adapter.platform, ...args }, async () => {
      // 1. One deploy at a time: kill any stale drivers holding the lock.
      const killed = await adapter.killStale();
      const resolution = await adapter.discoverDevice({
        kind: args.target,
        udid: args.device_udid,
      });
      const device = resolution.target;
      const deviceWarning = resolution.warning;

      const environmentDiagnostic = adapter.environmentDiagnostic
        ? (await adapter.environmentDiagnostic(resolution)) ?? undefined
        : undefined;

      // 2. Install the already-built package (install-only).
      let install = await adapter.install(device, {
        noLaunch: true,
        mode: args.mode,
        debug: args.debug,
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
        launchMode
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
            launchMode
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
          launchRecovery,
          reason: outcome.reason,
          pid: outcome.pid,
          logPath: outcome.logPath,
          logTail: outcome.logTail,
        };
      }

      const marionette = await this.probeMarionette(outcome.vmServiceUriWs);

      // Persist the launch so hot_reload/restart can reach this daemon later.
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

      const isTvLike =
        adapter.platform === "tizen" ||
        adapter.platform === "webos" ||
        adapter.platform === "tvos";
      const note =
        "The launch process is left running to hold the VM service open for a driver " +
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
        environmentDiagnostic,
        staleKilled: killed,
        enospcRecoveryAttempted: recovered,
        launchRecovery,
        vmServiceUriWs: outcome.vmServiceUriWs,
        vmServiceUriHttp: outcome.vmServiceUriHttp,
        pid: outcome.pid,
        logPath: outcome.logPath,
        device,
        marionetteReady: marionette.marionetteReady,
        marionetteHint: marionette.marionetteHint,
        note,
      };
    });
  }

  // =========== uninstall ==========
  async uninstall(args: CommonArgs): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_uninstall",
      { platform: adapter.platform, appId: adapter.appId },
      async () => {
        if (!adapter.appId) return this.missingAppId(adapter, "uninstall");
        const resolution = await adapter.discoverDevice();
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
  async killStale(args: CommonArgs): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard("flutter_kill_stale", { platform: adapter.platform }, async () => {
      const killed = await adapter.killStale();
      for (const rec of readRecords().filter((r) => r.platform === adapter.platform)) {
        removeControlFifo(rec.controlFifoPath);
      }
      clearLaunches(adapter.platform);
      return {
        platform: adapter.platform,
        ...summarizeKillStale(killed),
      };
    });
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
    args: CommonArgs,
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
      const resolution = await adapter.discoverDevice();
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

  terminate(args: CommonArgs): Promise<CommandOutput> {
    return this.lifecycleOp(
      "flutter_terminate",
      "terminate",
      args,
      "Force-quit the app. Its Dart VM service (and any driver connection) is gone after this; redeploy to get a fresh URI."
    );
  }

  background(args: CommonArgs): Promise<CommandOutput> {
    return this.lifecycleOp(
      "flutter_background",
      "background",
      args,
      "Sent the app to the background WITHOUT killing it (iOS: foreground a neutral system app; Android: HOME keyevent) — its didEnterBackground/onPause lifecycle runs and its VM service stays alive. Foreground it again with flutter_foreground."
    );
  }

  foreground(args: CommonArgs): Promise<CommandOutput> {
    return this.lifecycleOp(
      "flutter_foreground",
      "foreground",
      args,
      "Brought the app back to the foreground by relaunching its bundle id (exercises didBecomeActive). State is preserved when the app was only backgrounded (not terminated)."
    );
  }

  /** Look up the recorded launch, or a ready-made "no live daemon" result. */
  private findLaunchRecord(adapter: PlatformAdapter, device: string | undefined) {
    const record = findLaunch(adapter.platform, device);
    if (record) return { record };
    return {
      miss: {
        platform: adapter.platform,
        success: false,
        triggered: false,
        reason:
          "No live launch daemon is recorded for this platform. Run flutter_deploy first " +
          "(it launches the app and records its VM service URI + control channel for hot reload/restart).",
      } as CommandOutput,
    };
  }

  /** VM-service reload FALLBACK (used only when no live control FIFO exists). */
  private async vmServiceReload(
    adapter: PlatformAdapter,
    record: { device: string; vmServiceUriWs: string },
    timeoutMs: number | undefined,
    fellBackFrom: "no-control-channel" | "dead-control-channel"
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
          const outcome = await hotControl("reload", (c) =>
            sendControlChar(record.controlFifoPath!, c)
          );
          if (outcome.triggered) {
            return {
              platform: adapter.platform,
              success: true,
              triggered: true,
              via: outcome.via,
              operation: outcome.kind,
              device: record.device,
              controlFifoPath: record.controlFifoPath,
              note:
                "Sent `r` to the running flutter daemon's stdin over the pty control channel — a " +
                "REAL hot reload (recompiles changed Dart + reassembles). Preserves state. Use " +
                "flutter_hot_restart (`R`) for changes a reload can't apply (main(), top-level/global " +
                "state, new enums/static fields).",
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
              "service). Redeploy with flutter_deploy to establish the control channel.",
          };
        }

        const outcome = await hotControl("restart", (c) =>
          sendControlChar(record.controlFifoPath!, c)
        );
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
        return {
          platform: adapter.platform,
          success: true,
          triggered: true,
          via: outcome.via,
          operation: outcome.kind,
          device: record.device,
          controlFifoPath: record.controlFifoPath,
          note:
            "Sent `R` to the running flutter daemon's stdin over the pty control channel — a hot " +
            "RESTART: re-runs main() and drops in-memory state, while KEEPING the process, its VM " +
            "service URI, and any driver connection alive (no redeploy, no new URI).",
        };
      }
    );
  }

  // =========== screenshot ==========
  async screenshot(
    args: CommonArgs & { output_path?: string; include_base64?: boolean }
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
        });
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
    args: CommonArgs & { key?: string; text?: string }
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
        const input = adapter.input();

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
        };
      }
    );
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
    }
  ): Promise<CommandOutput> {
    const adapter = this.adapterFor(args);
    return this.guard(
      "flutter_pointer",
      { platform: adapter.platform, action: args.action },
      async () => {
        const input = adapter.input();
        switch (args.action) {
          case "move": {
            const { point, coordinateSpace } = resolvePointerTarget(args);
            try {
              await input.pointerMove(point.x, point.y);
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
              devicePosition: point,
              sent: true,
            };
          }
          case "click": {
            try {
              await input.pointerClick();
            } catch (error) {
              const notSupported = mapUnsupportedInput(error, adapter.platform, "click");
              if (notSupported) return notSupported;
              throw error;
            }
            return {
              platform: adapter.platform,
              mode: input.mode,
              action: "click",
              sent: true,
              note: "Activates the currently-focused element (KEY_ENTER) on focus/D-pad-driven platforms; pair it with flutter_key to move focus first.",
            };
          }
          case "scroll": {
            const { dy, coordinateSpace } = resolveScrollDelta(args);
            try {
              await input.pointerScroll(dy);
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
}
