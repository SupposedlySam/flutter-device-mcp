/**
 * Decide how `flutter_hot_reload` reaches a recorded launch before it touches
 * the control channel or the VM service.
 *
 * Some launches can only be reloaded by the flutter run that owns them: a debug
 * app on a physical Apple TV has no kernel compiler on the device, so the
 * VM-service fallback fails on every isolate. For those, a run that is gone is
 * answered with a redeploy instruction up front, and an unacknowledged `r` is
 * reported as such instead of being followed by a fallback that cannot work.
 */
import {
  CONTROL_CHANNEL_STATE,
  REDEPLOY_FOR_CONTROL_CHANNEL,
  ReloadFallbackReason,
} from "./vmServiceFallbackReload.js";

export type RunLiveness = "alive" | "dead" | "unknown";

/**
 * Whether the recorded launch process still exists. `kill(pid, 0)` delivers no
 * signal; EPERM means the process exists under another user.
 */
export function runLiveness(
  pid: number | undefined,
  probe: (pid: number) => void = (p) => process.kill(p, 0)
): RunLiveness {
  if (pid === undefined) return "unknown";
  try {
    probe(pid);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "alive" : "dead";
  }
}

export type NoControlPlan =
  | { kind: "vm-service"; fellBackFrom: ReloadFallbackReason }
  | { kind: "refuse"; fellBackFrom: ReloadFallbackReason; reason: string };

export type HotReloadPlan = { kind: "send-control" } | NoControlPlan;

export const OWNING_RUN_ONLY =
  "This launch can only be reloaded by the flutter run that started it (a physical Apple TV's " +
  "debug app has no on-device kernel compiler, so a VM-service reload fails on every isolate), " +
  "and no VM-service reload was attempted.";

interface PlanInput {
  hasControlChannel: boolean;
  liveness: RunLiveness;
  reloadNeedsOwningRun: boolean;
}

export function planHotReload(opts: PlanInput): HotReloadPlan {
  if (opts.hasControlChannel && opts.liveness !== "dead") {
    return { kind: "send-control" };
  }
  return planWithoutControlChannel(opts);
}

/** The control channel cannot carry `r` (none was recorded, or its run is gone). */
export function planWithoutControlChannel(opts: PlanInput): NoControlPlan {
  const fellBackFrom: ReloadFallbackReason = opts.hasControlChannel
    ? "dead-control-channel"
    : "no-control-channel";
  if (!opts.reloadNeedsOwningRun) return { kind: "vm-service", fellBackFrom };
  const runState =
    opts.liveness === "dead"
      ? "The run that owns this app is gone (its process has exited)."
      : CONTROL_CHANNEL_STATE[fellBackFrom];
  return {
    kind: "refuse",
    fellBackFrom,
    reason: `${runState} ${OWNING_RUN_ONLY} ${REDEPLOY_FOR_CONTROL_CHANNEL}`,
  };
}
