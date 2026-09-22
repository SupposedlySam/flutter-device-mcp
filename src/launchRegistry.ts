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
 *
 * Every read-modify-write takes a lock file, because two devices in flight at
 * once is now normal: teardown is per-device, so a deploy to one device runs
 * while another device's daemon stays alive, and two concurrent deploys would
 * otherwise lose one of their records to a last-writer-wins overwrite — leaving
 * a live daemon with no record and its hot reload unreachable.
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

/** How long to wait for another writer's lock before giving up on it. */
const LOCK_TIMEOUT_MS = 2000;

/**
 * Take an exclusive lock for a read-modify-write of the store, run `mutate`,
 * and release it.
 *
 * `mkdir` is the primitive: it is atomic on POSIX and fails if the directory
 * exists, so exactly one holder wins. A lock older than {@link LOCK_TIMEOUT_MS}
 * is treated as abandoned (a crashed writer) and broken, and if the lock cannot
 * be taken at all the mutation still runs unlocked — this store is best-effort
 * and a missing record degrades to "redeploy to reload", which is far better
 * than a tool call that throws because a stale directory was left behind.
 */
function withStoreLock<T>(storePath: string, mutate: () => T): T {
  const lockPath = `${storePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_TIMEOUT_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The holder released it between the failed mkdir and the stat; retry.
        continue;
      }
    }
  }
  try {
    return mutate();
  } finally {
    if (held) fs.rmSync(lockPath, { recursive: true, force: true });
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
 * concurrent read-modify-write callers — {@link withStoreLock} does, and every
 * mutation here goes through it. It used to rest on a one-device-op-at-a-time
 * contract, which per-device teardown removed: a deploy to one device no longer
 * ends another device's session, so two live launches is the normal state. The
 * temp file is cleaned up on failure so we don't leak.
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
    withStoreLock(storePath, () => {
      const others = readRecords(storePath).filter(
        (r) => !(r.platform === record.platform && r.device === record.device)
      );
      writeRecordsAtomic(storePath, [...others, record]);
    });
  } catch {
    // best effort — a missing record just means "redeploy to reload".
  }
}

/**
 * Find the launch record for a platform+device, or the latest record for the
 * platform when no device is given. Returns undefined when nothing matches.
 *
 * Prefer {@link resolveLaunch} for a caller acting on the record: this returns
 * the LATEST launch when no device is named, which silently picks one of two
 * live daemons.
 */
export function findLaunch(
  platform: string,
  device: string | undefined,
  storePath = defaultRegistryPath()
): LaunchRecord | undefined {
  return launchesFor(platform, device, storePath)[0];
}

/** Records for a platform (optionally one device), newest first. */
export function launchesFor(
  platform: string,
  device: string | undefined,
  storePath = defaultRegistryPath()
): LaunchRecord[] {
  return readRecords(storePath)
    .filter((r) => r.platform === platform)
    .filter((r) => (device ? r.device === device : true))
    .sort((a, b) => b.recordedAt - a.recordedAt);
}

/** The outcome of looking up the launch a hot tool should act on. */
export type LaunchLookup =
  | { kind: "found"; record: LaunchRecord }
  | { kind: "none" }
  | { kind: "ambiguous"; devices: string[] };

/**
 * Resolve the launch a hot reload/restart should drive.
 *
 * Naming no device used to mean "the most recent launch on this platform",
 * which is a coin toss once two devices are running at once — and per-device
 * teardown makes that the normal state rather than a rarity, since a deploy to
 * one device no longer ends the other's session. Two live daemons with no device
 * named is reported as AMBIGUOUS so the caller picks, rather than having a
 * reload land on the wrong device and look like a reload that did nothing.
 */
export function resolveLaunch(
  platform: string,
  device: string | undefined,
  storePath = defaultRegistryPath()
): LaunchLookup {
  const records = launchesFor(platform, device, storePath);
  if (records.length === 0) return { kind: "none" };
  if (!device && records.length > 1) {
    return { kind: "ambiguous", devices: records.map((r) => r.device) };
  }
  return { kind: "found", record: records[0] };
}

/** Remove records for a platform (all devices). Best-effort. */
export function clearLaunches(
  platform: string,
  storePath = defaultRegistryPath()
): void {
  try {
    withStoreLock(storePath, () => {
      const remaining = readRecords(storePath).filter(
        (r) => r.platform !== platform
      );
      writeRecordsAtomic(storePath, remaining);
    });
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
    withStoreLock(storePath, () => {
      const remaining = readRecords(storePath).filter(
        (r) => !(r.platform === platform && r.device === device)
      );
      writeRecordsAtomic(storePath, remaining);
    });
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
