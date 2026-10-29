/**
 * Per-process claims on booted iOS simulators.
 *
 * Several agents each run their own flutter-device-mcp process against one Mac, and
 * routinely with several simulators booted. Without a claim, every process that
 * names no device resolves the same simulator, so one agent's deploy tears down
 * another's session and its VM service URI points at an app somebody else is
 * driving. A claim gives each process a simulator of its own for its lifetime.
 *
 * A claim is a directory per simulator udid under a shared state dir, holding
 * the owner's pid. `mkdir` is the atomic primitive: it fails when the directory
 * exists, so exactly one process wins a free simulator. A claim whose pid is
 * dead is stale and may be taken over; takeover runs under a host-wide mutex so
 * two processes cannot both break the same stale claim and both believe they
 * won.
 *
 * The claim lives on disk rather than in an adapter because a call carrying
 * `app_dir` builds a fresh adapter, and the process must still resolve the
 * simulator it already holds.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { withStoreLock } from "./fileLock.js";

export interface SimulatorClaimOwner {
  pid: number;
  claimedAt: number;
  name?: string;
}

export interface ClaimCandidate {
  udid: string;
  name?: string;
}

export interface ClaimStoreOptions {
  dir?: string;
  /** The claiming process; defaults to this one. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export type ClaimOutcome =
  | { kind: "claimed"; udid: string; tookOverFrom?: number }
  | { kind: "exhausted"; simulators: { udid: string; name?: string; heldBy: string }[] };

/**
 * A claim directory with no owner file yet is a claim in the middle of being
 * written. Past this age its writer is taken to have died between the two steps.
 */
const OWNERLESS_GRACE_MS = 5000;

const OWNER_FILE = "owner.json";
const LOCK_SUFFIX = ".lock";

export function defaultClaimDir(): string {
  return path.join(os.tmpdir(), "flutter-device-mcp-sim-claims");
}

/** `kill -0`: EPERM means the process exists under another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimPath(dir: string, udid: string): string {
  return path.join(dir, `${udid.toUpperCase()}${LOCK_SUFFIX}`);
}

type ClaimState =
  | { kind: "free" }
  | { kind: "held"; owner?: SimulatorClaimOwner }
  | { kind: "stale"; owner?: SimulatorClaimOwner };

function readClaimState(
  lockPath: string,
  isAlive: (pid: number) => boolean
): ClaimState {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return { kind: "free" };
  }
  try {
    const owner = JSON.parse(
      fs.readFileSync(path.join(lockPath, OWNER_FILE), "utf8")
    ) as SimulatorClaimOwner;
    if (typeof owner.pid !== "number") throw new Error("no pid");
    return isAlive(owner.pid) ? { kind: "held", owner } : { kind: "stale", owner };
  } catch {
    return Date.now() - mtimeMs > OWNERLESS_GRACE_MS
      ? { kind: "stale" }
      : { kind: "held" };
  }
}

/** The owner of a simulator's claim, when a live process holds one. */
export function readClaimOwner(
  udid: string,
  opts: ClaimStoreOptions = {}
): SimulatorClaimOwner | undefined {
  const state = readClaimState(
    claimPath(opts.dir ?? defaultClaimDir(), udid),
    opts.isAlive ?? isProcessAlive
  );
  return state.kind === "held" ? state.owner : undefined;
}

export function holdsClaim(udid: string, opts: ClaimStoreOptions = {}): boolean {
  return readClaimOwner(udid, opts)?.pid === (opts.pid ?? process.pid);
}

/** The live claims a process holds, by udid. */
export function claimsHeldBy(opts: ClaimStoreOptions = {}): { udid: string; name?: string }[] {
  const dir = opts.dir ?? defaultClaimDir();
  const pid = opts.pid ?? process.pid;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const held: { udid: string; name?: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(LOCK_SUFFIX)) continue;
    const udid = entry.slice(0, -LOCK_SUFFIX.length);
    const owner = readClaimOwner(udid, opts);
    if (owner?.pid === pid) held.push({ udid, name: owner.name });
  }
  return held;
}

function writeOwner(lockPath: string, pid: number, name?: string): void {
  const tmp = path.join(lockPath, `${OWNER_FILE}.${pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ pid, claimedAt: Date.now(), name }));
  fs.renameSync(tmp, path.join(lockPath, OWNER_FILE));
}

function tryCreate(lockPath: string, pid: number, name?: string): boolean {
  try {
    fs.mkdirSync(lockPath);
  } catch {
    return false;
  }
  writeOwner(lockPath, pid, name);
  return true;
}

function tryClaim(
  dir: string,
  candidate: ClaimCandidate,
  pid: number,
  isAlive: (pid: number) => boolean
): { claimed: boolean; tookOverFrom?: number } {
  const lockPath = claimPath(dir, candidate.udid);
  if (tryCreate(lockPath, pid, candidate.name)) return { claimed: true };
  const state = readClaimState(lockPath, isAlive);
  if (state.kind === "held") return { claimed: false };
  if (state.kind === "free") return { claimed: tryCreate(lockPath, pid, candidate.name) };
  return withStoreLock(path.join(dir, ".takeover"), () => {
    // Re-read under the mutex: another process may have taken it over already.
    const current = readClaimState(lockPath, isAlive);
    if (current.kind === "held") return { claimed: false };
    fs.rmSync(lockPath, { recursive: true, force: true });
    return {
      claimed: tryCreate(lockPath, pid, candidate.name),
      tookOverFrom: state.owner?.pid,
    };
  });
}

/**
 * The candidate this process already holds, else the first candidate nobody
 * else holds and no foreign `flutter run` is attached to. `occupied` maps a udid
 * to a description of the foreign session holding it; those are never newly
 * claimed. A claim this process holds on a simulator that is no longer a
 * candidate (shut down since) is released. When nothing is left, reports who
 * holds each candidate so the caller can say so.
 */
export function claimSimulator(opts: {
  candidates: readonly ClaimCandidate[];
  occupied?: ReadonlyMap<string, string>;
} & ClaimStoreOptions): ClaimOutcome {
  const dir = opts.dir ?? defaultClaimDir();
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isProcessAlive;
  fs.mkdirSync(dir, { recursive: true });

  const store = { dir, pid, isAlive };
  const held = opts.candidates.find((c) => holdsClaim(c.udid, store));
  if (held) return { kind: "claimed", udid: held.udid };
  for (const stale of claimsHeldBy(store)) releaseClaim(stale.udid, store);

  for (const candidate of opts.candidates) {
    if (opts.occupied?.has(candidate.udid)) continue;
    const { claimed, tookOverFrom } = tryClaim(dir, candidate, pid, isAlive);
    if (claimed) return { kind: "claimed", udid: candidate.udid, tookOverFrom };
  }

  return {
    kind: "exhausted",
    simulators: opts.candidates.map((c) => {
      const foreign = opts.occupied?.get(c.udid);
      const owner = readClaimOwner(c.udid, { dir, isAlive });
      const heldBy = foreign
        ? foreign
        : owner
          ? `claimed by flutter-device-mcp pid ${owner.pid}`
          : "claimed while this call ran";
      return { udid: c.udid, name: c.name, heldBy };
    }),
  };
}

/** Drop a claim, but only one this process holds. */
export function releaseClaim(udid: string, opts: ClaimStoreOptions = {}): void {
  if (!holdsClaim(udid, opts)) return;
  fs.rmSync(claimPath(opts.dir ?? defaultClaimDir(), udid), {
    recursive: true,
    force: true,
  });
}

const EXIT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const releasedOnExit = new Set<string>();

/**
 * Release this process's claims in `dir` when it exits; idempotent per dir. A
 * signal handler suppresses the default exit, so each one releases and then
 * re-raises the signal with the handler gone. A crash or SIGKILL skips all of
 * this; stale-pid takeover covers those.
 */
export function releaseClaimsOnExit(dir: string = defaultClaimDir()): void {
  if (releasedOnExit.has(dir)) return;
  releasedOnExit.add(dir);
  const release = () => {
    try {
      for (const claim of claimsHeldBy({ dir })) releaseClaim(claim.udid, { dir });
    } catch {
      // best effort; a leftover claim is taken over once this pid is gone.
    }
  };
  process.once("exit", release);
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, () => {
      release();
      process.kill(process.pid, signal);
    });
  }
}

export function describeExhaustedClaims(
  outcome: Extract<ClaimOutcome, { kind: "exhausted" }>
): string {
  const listed = outcome.simulators
    .map((s) => `${s.udid}${s.name ? ` (${s.name})` : ""}: ${s.heldBy}`)
    .join("; ");
  return (
    `Every booted iOS simulator is in use by another session, so none was claimed for this ` +
    `MCP process and nothing was done: ${listed}. Pass device_udid to name one deliberately, ` +
    "or boot another simulator (`xcrun simctl boot <udid>`, then `open -a Simulator`) and retry."
  );
}
