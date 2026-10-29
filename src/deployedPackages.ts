/**
 * Which package flutter_deploy installed on each device, read from the apk it
 * installed.
 *
 * Kept apart from the launch registry on purpose. That registry describes a
 * running daemon and is cleared whenever the daemon goes (kill_stale, a hot
 * reload that cannot reach it), but the installed app stays on the device
 * after its daemon is gone, and terminate, foreground and uninstall still need
 * to know which package it is. It lives in the per-developer state dir rather
 * than the temp dir so it survives a reboot the device itself survives.
 */
import fs from "fs";
import path from "path";
import { withStoreLock } from "./fileLock.js";
import { stateDir } from "./input/pointerStage.js";

export interface DeployedPackage {
  platform: string;
  /** The adb serial or equivalent: how the device is addressed, which can be reused. */
  device: string;
  /**
   * What the device itself says it is, so a record is not applied to another
   * device that later answers to the same serial (every first emulator is
   * emulator-5554). A record without one cannot be checked and is not used.
   */
  identity?: string;
  packageId: string;
  recordedAt: number;
}

/**
 * Cap on retained entries, one per (platform, device). It only stops the file
 * growing without bound as emulator serials churn.
 */
const MAX_ENTRIES = 32;

export function deployedPackagesPath(): string {
  return path.join(stateDir(), "deployed-packages.json");
}

function isDeployedPackage(value: unknown): value is DeployedPackage {
  const v = value as Partial<DeployedPackage> | null;
  return (
    !!v &&
    typeof v.platform === "string" &&
    typeof v.device === "string" &&
    typeof v.packageId === "string" &&
    v.packageId.length > 0 &&
    (v.identity === undefined || typeof v.identity === "string") &&
    typeof v.recordedAt === "number"
  );
}

function readEntries(storePath: string): DeployedPackage[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isDeployedPackage) : [];
  } catch {
    return [];
  }
}

function rewriteEntries(
  storePath: string,
  change: (entries: DeployedPackage[]) => DeployedPackage[]
): void {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    withStoreLock(storePath, () => {
      const next = change(readEntries(storePath));
      const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
        fs.renameSync(tmpPath, storePath);
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }
    });
  } catch {
    // best effort
  }
}

const sameDevice = (e: DeployedPackage, platform: string, device: string) =>
  e.platform === platform && e.device === device;

/**
 * Record that `packageId` is what deploy installed on `device`, replacing the
 * device's earlier entry. Best-effort: a failed write leaves later verbs to
 * work the package out from the device.
 */
export function recordDeployedPackage(
  entry: Omit<DeployedPackage, "recordedAt">,
  storePath = deployedPackagesPath()
): void {
  rewriteEntries(storePath, (entries) => [
    { ...entry, recordedAt: Date.now() },
    ...entries
      .filter((e) => !sameDevice(e, entry.platform, entry.device))
      .sort((a, b) => b.recordedAt - a.recordedAt)
      .slice(0, MAX_ENTRIES - 1),
  ]);
}

/**
 * Drop the device's entry, or only an entry naming `packageId` when one is
 * given, so a verb no longer acts on a package that is gone or unconfirmed.
 */
export function forgetDeployedPackage(
  key: { platform: string; device: string; packageId?: string },
  storePath = deployedPackagesPath()
): void {
  const matches = (e: DeployedPackage) =>
    sameDevice(e, key.platform, key.device) &&
    (key.packageId === undefined || e.packageId === key.packageId);
  if (!readEntries(storePath).some(matches)) return;
  rewriteEntries(storePath, (entries) => entries.filter((e) => !matches(e)));
}

/** The entry deploy last recorded for `device`, if any. Its identity is the caller's to check. */
export function findDeployedPackage(
  platform: string,
  device: string,
  storePath = deployedPackagesPath()
): DeployedPackage | undefined {
  return readEntries(storePath).find((e) => sameDevice(e, platform, device));
}
