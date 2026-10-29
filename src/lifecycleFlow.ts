import type { AppLifecycle, PlatformAdapter } from "./adapters/platformAdapter.js";
import { resolveAppIdFor } from "./appIdResolution.js";
import { messageResult, type CommandResult, type DeviceResolution } from "./types.js";

export type LifecycleVerb = keyof AppLifecycle;

export type LifecycleOutcome =
  | { kind: "refused"; resolution: DeviceResolution; reason: string; appId?: string }
  | {
      kind: "ran";
      resolution: DeviceResolution;
      appId?: string;
      appIdNote?: string;
      result: CommandResult;
    };

/**
 * terminate/background/foreground once the server has the platform's lifecycle.
 * Background acts on the device, not on a package, so it resolves none. The
 * other two resolve the package exactly as deploy does and let the adapter
 * decide whether that copy may be acted on before the verb runs.
 */
export async function runLifecycleCore(deps: {
  adapter: Pick<
    PlatformAdapter,
    "appId" | "resolveAppId" | "discoverDevice" | "verifyLifecycleTarget"
  >;
  lifecycle: AppLifecycle;
  verb: LifecycleVerb;
  args: { device_udid?: string; allow_store_app?: boolean };
}): Promise<LifecycleOutcome> {
  const { adapter, lifecycle, verb, args } = deps;
  const resolution = await adapter.discoverDevice({ udid: args.device_udid });
  if (verb === "background") {
    return { kind: "ran", resolution, result: await lifecycle.background(resolution.target) };
  }
  const app = await resolveAppIdFor(adapter, resolution.target);
  if (!app.ok) return { kind: "refused", resolution, reason: app.reason };
  const verdict = adapter.verifyLifecycleTarget
    ? await adapter.verifyLifecycleTarget(resolution.target, {
        verb,
        appId: app.appId,
        appIdSource: app.source,
        allowStoreApp: args.allow_store_app === true,
      })
    : { kind: "proceed" as const };
  if (verdict.kind === "refuse") {
    return { kind: "refused", resolution, reason: verdict.reason, appId: app.appId };
  }
  if (verdict.kind === "nothing-to-do") {
    return {
      kind: "ran",
      resolution,
      appId: app.appId,
      appIdNote: app.note,
      result: messageResult(true, verdict.message),
    };
  }
  const result = await lifecycle[verb](resolution.target, app.appId);
  return { kind: "ran", resolution, appId: app.appId, appIdNote: app.note, result };
}
