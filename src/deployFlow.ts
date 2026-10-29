/**
 * The deploy's device-touching steps — resolve, tear down, install, recover,
 * launch — with the adapter injected so a fake or a shell-mocked adapter can
 * record which of them ran. The response envelope stays in the server.
 */
import { unnamedChoiceRefused } from "./deviceRequest.js";
import { tearDownForDeploy } from "./killStaleFlow.js";
import type {
  InstallOptions,
  PlatformAdapter,
  RecoveryContext,
} from "./adapters/platformAdapter.js";
import { authorizeSpaceRecovery } from "./uninstallGuard.js";
import {
  BuildMode,
  CommandResult,
  DeviceResolution,
  isLaunchFailure,
  LaunchOutcome,
} from "./types.js";

/** The slice of a {@link PlatformAdapter} a deploy drives. */
export type DeployAdapter = Pick<
  PlatformAdapter,
  | "platform"
  | "appId"
  | "killStaleScope"
  | "killStale"
  | "discoverDevice"
  | "install"
  | "isInstallFailure"
  | "uninstall"
  | "launchAndCaptureUri"
  | "recoverLaunchFailure"
  | "defaultLaunchTimeoutMs"
  | "verifyUninstallTarget"
  | "environmentDiagnostic"
>;

export interface DeployArgs {
  no_launch?: boolean;
  timeout_ms?: number;
  mode?: BuildMode;
  debug?: boolean;
  dart_define?: Record<string, string>;
  target?: "simulator" | "device";
  device_udid?: string;
  app_path?: string;
  app_url?: string;
  allow_store_app_removal?: boolean;
}

export type DeployCoreResult = {
  resolution: DeviceResolution;
  killed: Record<string, CommandResult>;
  environmentDiagnostic?: string;
  install: CommandResult;
  enospcRecoveryAttempted: boolean;
  /** Why an install-stage space recovery was not attempted. */
  enospcRecoveryRefused?: string;
} & (
  | { stage: "install-failed" }
  | { stage: "installed" }
  | {
      stage: "launched" | "launch-failed";
      outcome: LaunchOutcome;
      launchRecovery?: { recovered: boolean; note?: string };
    }
);

// Only a full device justifies uninstalling to make room. A bare "Install
// failed" also covers a certificate mismatch, where uninstalling is data loss
// that fixes nothing.
const NEUTRAL_STORAGE_FAILURE = /No space left on device/i;

export async function runDeployCore(deps: {
  adapter: DeployAdapter;
  args: DeployArgs;
}): Promise<DeployCoreResult> {
  const { adapter, args } = deps;

  const { resolution, killed } = await tearDownForDeploy({
    adapter,
    preference: { kind: args.target, udid: args.device_udid },
  });
  const device = resolution.target;
  const recoveryContext: RecoveryContext = {
    explicitDevice: resolution.source === "pin",
    allowStoreAppRemoval: args.allow_store_app_removal === true,
  };

  const environmentDiagnostic = adapter.environmentDiagnostic
    ? (await adapter.environmentDiagnostic(resolution)) ?? undefined
    : undefined;

  const installOptions: InstallOptions = {
    noLaunch: true,
    launchFollows: !args.no_launch,
    mode: args.mode,
    debug: args.debug,
    dartDefine: args.dart_define,
    // macOS-only (ignored by every other adapter): the .app source for this
    // deploy, overriding the configured
    // FLUTTER_DEVICE_MACOS_APP_PATH/FLUTTER_DEVICE_MACOS_APP_URL defaults.
    appPath: args.app_path,
    appUrl: args.app_url,
    allowStoreAppRemoval: recoveryContext.allowStoreAppRemoval,
  };
  let install = await adapter.install(device, installOptions);

  const isStorageFailure = (combined: string): boolean =>
    adapter.isInstallFailure
      ? adapter.isInstallFailure(combined)
      : NEUTRAL_STORAGE_FAILURE.test(combined);
  let enospcRecoveryAttempted = false;
  let enospcRecoveryRefused: string | undefined;
  if (!install.success && isStorageFailure(install.combined)) {
    const verdict = await authorizeSpaceRecovery(adapter, device, {
      ...recoveryContext,
      packageId: adapter.appId,
      buildLog: install.combined,
    });
    if (verdict.ok) {
      await adapter.uninstall(device, adapter.appId);
      enospcRecoveryAttempted = true;
      install = await adapter.install(device, installOptions);
    } else {
      enospcRecoveryRefused = verdict.reason;
    }
  }

  const base = {
    resolution,
    killed,
    environmentDiagnostic,
    install,
    enospcRecoveryAttempted,
    enospcRecoveryRefused,
  };
  if (!install.success) return { ...base, stage: "install-failed" };
  if (args.no_launch) return { ...base, stage: "installed" };

  // The launch must name the mode of what was just installed (Tizen's
  // `--no-build` reuses only a TPK of the named mode); `mode` wins over the
  // legacy `debug` boolean.
  const launchMode = args.mode ?? (args.debug ? "debug" : undefined);
  const timeoutMs =
    args.timeout_ms ?? adapter.defaultLaunchTimeoutMs?.(launchMode) ?? 180000;
  const launch = () =>
    adapter.launchAndCaptureUri(device, timeoutMs, launchMode, args.dart_define);
  let outcome = await launch();

  let launchRecovery: { recovered: boolean; note?: string } | undefined;
  if (isLaunchFailure(outcome) && adapter.recoverLaunchFailure) {
    const request = await adapter.recoverLaunchFailure(
      device,
      outcome.logTail ?? outcome.reason ?? ""
    );
    launchRecovery = await carryOutRecovery(adapter, device, request, {
      ...recoveryContext,
      buildLog: outcome.logTail ?? outcome.reason ?? "",
    });
    if (launchRecovery.recovered) outcome = await launch();
  }

  return {
    ...base,
    stage: isLaunchFailure(outcome) ? "launch-failed" : "launched",
    outcome,
    launchRecovery,
  };
}

/** Authorize and perform what an adapter's launch recovery asked for. */
async function carryOutRecovery(
  adapter: DeployAdapter,
  device: string,
  request: Awaited<ReturnType<NonNullable<DeployAdapter["recoverLaunchFailure"]>>>,
  context: RecoveryContext & { buildLog: string }
): Promise<{ recovered: boolean; note?: string }> {
  if (request.action === "none") return { recovered: false, note: request.note };
  if (request.action === "retry") return { recovered: true, note: request.note };
  const verdict = await authorizeSpaceRecovery(adapter, device, {
    ...context,
    packageId: request.packageId,
  });
  if (!verdict.ok) {
    return { recovered: false, note: `${request.note} ${verdict.reason}` };
  }
  const uninstall = await adapter.uninstall(device, request.packageId);
  if (!uninstall.success) {
    return {
      recovered: false,
      note:
        `${request.note} The space-freeing uninstall of ${request.packageId} failed, ` +
        `so a launch retry would hit the same wall: ${uninstall.combined.trim().slice(-400)}`,
    };
  }
  return {
    recovered: true,
    note: `${request.note} Uninstalled ${request.packageId} from ${device} to free space; retrying the launch.`,
  };
}

/**
 * `flutter_uninstall`: resolve the device, refuse a guess between several,
 * let the adapter veto the uninstall (Android: a store copy without the
 * override), then uninstall.
 */
export async function runUninstallCore(deps: {
  adapter: Pick<
    DeployAdapter,
    "platform" | "appId" | "discoverDevice" | "uninstall" | "verifyUninstallTarget"
  >;
  args: { device_udid?: string; allow_store_app_removal?: boolean };
}): Promise<
  | { kind: "refused"; resolution: DeviceResolution; reason: string }
  | { kind: "ran"; resolution: DeviceResolution; result: CommandResult }
> {
  const { adapter, args } = deps;
  const resolution = await adapter.discoverDevice({ udid: args.device_udid });
  if (resolution.source !== "pin" && resolution.unnamedAmong) {
    throw unnamedChoiceRefused({
      platform: adapter.platform === "webos" ? "webOS" : adapter.platform,
      online: resolution.unnamedAmong,
      hint: "An uninstall always needs the device named.",
    });
  }
  if (adapter.verifyUninstallTarget) {
    const verdict = await adapter.verifyUninstallTarget(resolution.target, {
      purpose: "requested",
      packageId: adapter.appId,
      allowStoreAppRemoval: args.allow_store_app_removal === true,
    });
    if (!verdict.ok) return { kind: "refused", resolution, reason: verdict.reason };
  }
  const result = await adapter.uninstall(resolution.target, adapter.appId);
  return { kind: "ran", resolution, result };
}
