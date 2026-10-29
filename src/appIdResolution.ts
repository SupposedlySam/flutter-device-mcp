import type { AppIdResolution, PlatformAdapter } from "./adapters/platformAdapter.js";

/**
 * The package every verb that acts on the app uses for `device`: the adapter's
 * own resolution where it has one, else its configured {@link PlatformAdapter.appId}.
 * One function so terminate, uninstall and the rest cannot each pick a different
 * package from the one deploy installed.
 */
export async function resolveAppIdFor(
  adapter: Pick<PlatformAdapter, "appId" | "resolveAppId">,
  device: string
): Promise<AppIdResolution> {
  if (adapter.resolveAppId) return adapter.resolveAppId(device);
  return { ok: true, appId: adapter.appId, source: "configured" };
}

/**
 * The package the build about to be installed carries. Distinct from
 * {@link resolveAppIdFor}: an install replaces what the new build carries,
 * which need not be what the last deploy left on the device.
 */
export function installPackageIdFor(
  adapter: Pick<PlatformAdapter, "appId" | "installPackageId">
): AppIdResolution {
  if (adapter.installPackageId) return adapter.installPackageId();
  return { ok: true, appId: adapter.appId, source: "configured" };
}
