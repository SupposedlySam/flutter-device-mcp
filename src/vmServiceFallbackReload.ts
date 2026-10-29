/**
 * The VM-service reload `flutter_hot_reload` falls back to when the launch's
 * pty control channel cannot deliver `r`. It returns the whole tool response so
 * the refusal and the no-kernel-compiler outcome are decided here, testably,
 * rather than in the server class.
 */
import { hotReload, reloadNeedsHostCompiler, VmDriver } from "./hotReload.js";

export type ReloadFallbackReason =
  | "no-control-channel"
  | "dead-control-channel"
  | "unconfirmed-control-channel";

export const CONTROL_CHANNEL_STATE: Record<ReloadFallbackReason, string> = {
  "no-control-channel": "This launch recorded no pty control channel.",
  "dead-control-channel":
    "The launch's pty control channel is gone (the run that owned it has exited).",
  "unconfirmed-control-channel":
    "`r` was written to the launch's control channel but the flutter tool never acknowledged it, so nothing is known to have reloaded.",
};

export const REDEPLOY_FOR_CONTROL_CHANNEL =
  "Redeploy with flutter_deploy (debug) to get a live control channel, then hot reload again.";

export interface FallbackReloadRequest {
  platform: string;
  device: string;
  vmServiceUriWs: string;
  fellBackFrom: ReloadFallbackReason;
  /** The adapter's reason this device can never reload over the VM service. */
  refusal?: () => Promise<string | undefined>;
  connect: () => VmDriver;
}

export interface FallbackReloadResult {
  body: Record<string, unknown>;
  /** The connection failed, so the recorded launch is dead and should go. */
  clearLaunch: boolean;
}

export async function vmServiceFallbackReload(
  request: FallbackReloadRequest
): Promise<FallbackReloadResult> {
  const { platform, device, vmServiceUriWs, fellBackFrom } = request;
  const refusal = await request.refusal?.();
  if (refusal) {
    return {
      clearLaunch: false,
      body: {
        platform,
        success: false,
        triggered: false,
        fellBackFrom,
        device,
        reason: `${CONTROL_CHANNEL_STATE[fellBackFrom]} ${refusal} ${REDEPLOY_FOR_CONTROL_CHANNEL}`,
      },
    };
  }
  const client = request.connect();
  try {
    const outcome = await hotReload(client);
    if (reloadNeedsHostCompiler(outcome)) {
      return {
        clearLaunch: false,
        body: {
          platform,
          success: false,
          triggered: false,
          via: "vm-service",
          fellBackFrom,
          device,
          isolates: outcome.isolates,
          reports: outcome.reports,
          reason:
            "Nothing reloaded: the device VM has no kernel compiler, so reloadSources cannot " +
            "compile the sources there. Only the flutter tool's `r` over a live control channel " +
            `reloads this app. ${REDEPLOY_FOR_CONTROL_CHANNEL}`,
        },
      };
    }
    return {
      clearLaunch: false,
      body: {
        platform,
        success: outcome.success,
        triggered: true,
        via: "vm-service",
        fellBackFrom,
        operation: outcome.kind,
        device,
        vmServiceUriWs,
        isolates: outcome.isolates,
        reports: outcome.reports,
        note:
          "Reloaded over the VM service (reloadSources + reassemble) because no live pty control " +
          "channel was available. This is weaker than the flutter tool's `r`: it reloads sources " +
          "in place but a fresh deploy (flutter_deploy) re-establishes the control channel for a " +
          "true `r`/`R`. A hot RESTART (re-run main()) is not reachable over the VM service — redeploy.",
      },
    };
  } catch (error) {
    return {
      clearLaunch: true,
      body: {
        platform,
        success: false,
        triggered: false,
        device,
        vmServiceUriWs,
        reason:
          (error instanceof Error ? error.message : String(error)) +
          " The launch daemon may have exited — redeploy with flutter_deploy.",
      },
    };
  } finally {
    client.close();
  }
}
