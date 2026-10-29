import type { PlatformAdapter } from "./adapters/platformAdapter.js";
import { resolveAppIdFor } from "./appIdResolution.js";
import { invalidOpenUrlReason, type OpenUrlResult } from "./openUrl.js";

/**
 * `flutter_open_url` once the platform can open one. A caller that names no
 * package gets the one every other verb resolves for that device, so an https
 * link opens in the app deploy installed rather than raising a chooser; an
 * empty string asks for the unscoped open on purpose. That package is checked
 * as terminate checks it, since a scoped intent launches it. Only an adapter
 * that resolves packages takes part, since that is where scoping exists.
 */
export async function runOpenUrlCore(deps: {
  adapter: Pick<
    PlatformAdapter,
    "appId" | "resolveAppId" | "discoverDevice" | "verifyLifecycleTarget"
  >;
  openUrl: NonNullable<PlatformAdapter["openUrl"]>;
  args: {
    url: string;
    package_or_bundle_id?: string;
    target?: "device" | "simulator";
    device_udid?: string;
    allow_store_app?: boolean;
  };
}): Promise<OpenUrlResult> {
  const { adapter, openUrl, args } = deps;
  const preference = { kind: args.target, udid: args.device_udid };
  if (args.package_or_bundle_id !== undefined || !adapter.resolveAppId) {
    return openUrl(args.url, args.package_or_bundle_id, preference);
  }
  const invalid = invalidOpenUrlReason(args.url);
  if (invalid) return { opened: false, url: args.url, reason: invalid };
  const resolution = await adapter.discoverDevice(preference);
  const app = await resolveAppIdFor(adapter, resolution.target);
  if (!app.ok) {
    return { opened: false, url: args.url, device: resolution.target, reason: app.reason };
  }
  const verdict = adapter.verifyLifecycleTarget
    ? await adapter.verifyLifecycleTarget(resolution.target, {
        verb: "open_url",
        appId: app.appId,
        appIdSource: app.source,
        allowStoreApp: args.allow_store_app === true,
      })
    : { kind: "proceed" as const };
  if (verdict.kind !== "proceed") {
    const reason = verdict.kind === "refuse" ? verdict.reason : verdict.message;
    return { opened: false, url: args.url, device: resolution.target, reason };
  }
  const result = await openUrl(args.url, app.appId, { ...preference, udid: resolution.target });
  return app.note ? { ...result, appIdNote: app.note } : result;
}
