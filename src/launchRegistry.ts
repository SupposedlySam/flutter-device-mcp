/**
 * Persistent record of the most recent successful launch, so a later tool call
 * (hot reload) can find the live launch daemon's Dart VM service
 * without the caller re-supplying the URI.
 *
 * WHY a file and not an in-memory handle: the launch child is spawned detached
 * and unref'd — it deliberately outlives this MCP process so the VM service
 * stays open across MCP restarts. An in-memory `ChildProcess` handle would be
 * lost on restart, but the VM service `ws://.../ws` URI it printed is a durable
 * string. We persist the small launch record (keyed by device) to a JSON file
 * under the temp dir; reload/restart read the latest record for the device.
 *
 * The store is intentionally tiny and best-effort: read/write failures degrade
 * to "no record" rather than throwing, and the reload/restart tools surface an
 * actionable "run flutter_deploy first" message when nothing is recorded.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** One recorded launch: what a reload/restart needs to reach the daemon. */
export interface LaunchRecord {
  platform: string;
  device: string;
  vmServiceUriWs: string;
  vmServiceUriHttp?: string;
  pid?: number;
  logPath?: string;
  /**
   * Path to the control FIFO wired to this launch's flutter stdin, when one was
   * allocated. Present → hot reload/restart drive `r`/`R` over the FIFO (the
   * authoritative flutter-tool path); absent → they fall back to the VM service.
   * Durable on disk so it survives MCP restarts, like the VM-service URI.
   */
  controlFifoPath?: string;
  /** Epoch ms the record was written (latest wins). */
  recordedAt: number;
}

/** Default store path (single file, all devices). Overridable for tests. */
export function defaultRegistryPath(): string {
  return path.join(os.tmpdir(), "flutter-device-mcp-launches.json");
}

/** Read all records; returns [] on any read/parse failure. */
export function readRecords(storePath = defaultRegistryPath()): LaunchRecord[] {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLaunchRecord);
  } catch {
    return [];
  }
}

/**
 * Serialize records to a temp file in the same directory as `storePath`, then
 * atomically `rename` it over the store.
 *
 * WHY temp+rename and not a plain `writeFileSync`: writing to a sibling temp
 * file (same filesystem) and `rename`-ing is atomic on POSIX, so a reader sees
 * either the whole old file or the whole new one — never a torn/partial file
 * from a half-written or interrupted in-place write, which `readRecords` would
 * discard as corrupt. This does NOT guard against a lost update between two
 * concurrent read-modify-write callers; that relies on the serialized
 * one-device-op-at-a-time contract, so it isn't a concern in practice. The temp
 * file is cleaned up on failure so we don't leak.
 */
function writeRecordsAtomic(storePath: string, records: LaunchRecord[]): void {
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
    fs.renameSync(tmpPath, storePath);
  } finally {
    // If the rename succeeded the temp file is gone; if it threw, clean it up.
    fs.rmSync(tmpPath, { force: true });
  }
}

/**
 * Record a launch, replacing any prior record for the same
 * platform+device (latest wins). Best-effort: write failures are swallowed.
 */
export function recordLaunch(
  record: LaunchRecord,
  storePath = defaultRegistryPath()
): void {
  try {
    const others = readRecords(storePath).filter(
      (r) => !(r.platform === record.platform && r.device === record.device)
    );
    writeRecordsAtomic(storePath, [...others, record]);
  } catch {
    // best effort — a missing record just means "redeploy to reload".
  }
}

/**
 * Find the launch record for a platform+device, or the latest record for the
 * platform when no device is given. Returns undefined when nothing matches.
 */
export function findLaunch(
  platform: string,
  device: string | undefined,
  storePath = defaultRegistryPath()
): LaunchRecord | undefined {
  const records = readRecords(storePath)
    .filter((r) => r.platform === platform)
    .filter((r) => (device ? r.device === device : true))
    .sort((a, b) => b.recordedAt - a.recordedAt);
  return records[0];
}

/** Remove records for a platform (all devices). Best-effort. */
export function clearLaunches(
  platform: string,
  storePath = defaultRegistryPath()
): void {
  try {
    const remaining = readRecords(storePath).filter(
      (r) => r.platform !== platform
    );
    writeRecordsAtomic(storePath, remaining);
  } catch {
    // best effort
  }
}

/**
 * Remove only the record for one platform+device, leaving every other device's
 * record intact. Best-effort. Use when a single device's daemon is gone (a dead
 * VM service on hot reload) rather than {@link clearLaunches}, which drops the
 * whole platform.
 */
export function clearLaunch(
  platform: string,
  device: string,
  storePath = defaultRegistryPath()
): void {
  try {
    const remaining = readRecords(storePath).filter(
      (r) => !(r.platform === platform && r.device === device)
    );
    writeRecordsAtomic(storePath, remaining);
  } catch {
    // best effort
  }
}

function isLaunchRecord(value: unknown): value is LaunchRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.platform === "string" &&
    typeof r.device === "string" &&
    typeof r.vmServiceUriWs === "string" &&
    typeof r.recordedAt === "number"
  );
}
