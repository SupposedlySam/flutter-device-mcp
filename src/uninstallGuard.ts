/**
 * When a deploy may uninstall the app to free space.
 *
 * Space recovery is the only place this server removes an app nobody asked it to
 * remove, so it has three preconditions, all checked before the uninstall runs:
 * the call named the device itself; the build being installed carries the
 * package id that would be removed; and the adapter's own check of the installed
 * copy (Android: installed by adb, not a store; iOS: built by a developer)
 * passes. A precondition that cannot be checked counts as failed.
 */
import type {
  PlatformAdapter,
  RecoveryContext,
  UninstallVerdict,
} from "./adapters/platformAdapter.js";

export type GuardedAdapter = Pick<
  PlatformAdapter,
  "platform" | "verifyUninstallTarget"
>;

export async function authorizeSpaceRecovery(
  adapter: GuardedAdapter,
  device: string,
  context: RecoveryContext & { packageId: string; buildLog?: string }
): Promise<UninstallVerdict> {
  if (!context.explicitDevice) {
    return {
      ok: false,
      reason:
        `Space recovery would uninstall ${context.packageId} from ${device}, which ` +
        `this call did not name, so it was not attempted. Name the device with ` +
        `device_udid (or its pin) to allow it, or free space on the device yourself.`,
    };
  }
  if (!adapter.verifyUninstallTarget) {
    return {
      ok: false,
      reason:
        `Space recovery was not attempted: the ${adapter.platform} adapter cannot ` +
        `confirm the build being installed carries ${context.packageId}, and an ` +
        `unconfirmed package id is never uninstalled. Free space on ${device} ` +
        `yourself (flutter_uninstall), then redeploy.`,
    };
  }
  return adapter.verifyUninstallTarget(device, {
    purpose: "space-recovery",
    packageId: context.packageId,
    allowStoreAppRemoval: context.allowStoreAppRemoval,
    buildLog: context.buildLog,
  });
}
