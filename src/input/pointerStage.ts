/**
 * Durable staging store for the pointer position a positional click/scroll uses.
 *
 * WHY THIS EXISTS: on Android there is no visible cursor, so `flutter_pointer`
 * `move` cannot send anything — it only records WHERE the next `click`/`scroll`
 * should land, and the click reads it back. Holding that record in a field on
 * the controller made the pair work only while ONE server process happened to
 * survive between the two calls. Any host reload, session boundary, or plain
 * server restart silently dropped it, and the click then failed with "No
 * pointer position staged" — an error naming a precondition the caller HAD
 * satisfied, one call earlier. Coordinate tapping was effectively unusable,
 * which pushed callers back to raw `adb shell input tap`.
 *
 * So the stage lives on DISK, per developer, outside the process:
 * `$FLUTTER_DEVICE_STATE_DIR` (else `$HOME/.config/flutter-device-mcp`)`/pointer-stage.json`.
 *
 * KEYED BY PLATFORM + DEVICE, deliberately: a position staged against one
 * device must never be tapped on another (the coordinate spaces differ, and a
 * blind tap at a stale coordinate is worse than an error). A `click` therefore
 * resolves its device first and looks up THAT key — so "no position staged" now
 * means exactly what it says: nothing was staged for this device.
 *
 * Coordinates are DEVICE PIXELS — the same space `flutter_screenshot` returns,
 * so a coordinate read off a screenshot round-trips unchanged. Logical→device
 * conversion happens above this layer (with an explicit `dpr`, never assumed).
 *
 * Nothing here is device-specific-and-committed: the file is per-developer
 * machine-local state, like the Samsung pairing token (see samsungToken.ts),
 * and shares that module's state directory.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** A staged pointer position in DEVICE pixels, plus when it was staged. */
export interface StagedPointerPosition {
  x: number;
  y: number;
  /** ISO timestamp of the `move` that staged it — reported so a caller can see
   * it is tapping a position staged in an earlier session, not this one. */
  stagedAt: string;
}

/** The on-disk shape: stage key → staged position. */
export type PointerStageStore = Record<string, StagedPointerPosition>;

/**
 * Cap on retained entries. One per (platform, device) the developer has ever
 * driven, so the real count is tiny; the cap only stops an unbounded file if
 * device serials churn (fresh emulator ids, DHCP-renamed Tizen targets).
 */
export const MAX_STAGE_ENTRIES = 16;

/** Directory holding this developer's machine-local flutter-device-mcp state. */
export function stateDir(): string {
  const override = process.env.FLUTTER_DEVICE_STATE_DIR?.trim();
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".config", "flutter-device-mcp");
}

/** Absolute path to the pointer-stage file. */
export function stagePath(): string {
  return path.join(stateDir(), "pointer-stage.json");
}

/**
 * The store key for a device. Platform is included so two platforms' targets
 * can never collide, even in the pathological case of a shared id string.
 */
export function stageKey(platform: string, device: string): string {
  return `${platform}:${device}`;
}

/** True when `value` is a usable staged position (finite numeric x/y). */
function isStagedPosition(value: unknown): value is StagedPointerPosition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y)
  );
}

/**
 * Parse the store from raw file text, DROPPING anything malformed.
 *
 * Tolerant on purpose: a corrupt or hand-edited file must degrade to "nothing
 * staged" (which produces the clear guidance error) rather than break input
 * entirely. A missing/invalid `stagedAt` is backfilled as unknown-but-present
 * so an otherwise-good position is still usable.
 */
export function parseStageStore(raw: string): PointerStageStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const store: PointerStageStore = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isStagedPosition(value)) continue;
    store[key] = {
      x: value.x,
      y: value.y,
      stagedAt:
        typeof (value as { stagedAt?: unknown }).stagedAt === "string"
          ? (value as { stagedAt: string }).stagedAt
          : "",
    };
  }
  return store;
}

/**
 * Pure update: `store` with `key` set to `position`, trimmed to
 * {@link MAX_STAGE_ENTRIES} by dropping the oldest `stagedAt` first. The
 * just-staged entry is never the one dropped.
 */
export function withStagedPosition(
  store: PointerStageStore,
  key: string,
  position: StagedPointerPosition
): PointerStageStore {
  const next: PointerStageStore = { ...store, [key]: position };
  const keys = Object.keys(next);
  if (keys.length <= MAX_STAGE_ENTRIES) return next;
  const oldestFirst = keys
    .filter((candidate) => candidate !== key)
    .sort((a, b) => (next[a].stagedAt < next[b].stagedAt ? -1 : 1));
  for (const stale of oldestFirst.slice(0, keys.length - MAX_STAGE_ENTRIES)) {
    delete next[stale];
  }
  return next;
}

/**
 * The staging port the input controllers depend on. Injected so unit tests use
 * an in-memory stage and never touch the developer's real state dir.
 */
export interface PointerStage {
  load(key: string): StagedPointerPosition | undefined;
  save(key: string, x: number, y: number): StagedPointerPosition;
}

/** Read the whole store from disk; `{}` when absent or unreadable. */
export function readStageStore(file: string = stagePath()): PointerStageStore {
  try {
    return parseStageStore(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Write the store to disk ATOMICALLY (temp file + rename), so a concurrent
 * reader never sees a half-written file and two servers racing cannot merge
 * into corruption — the loser's write simply lands second.
 *
 * Failure is swallowed: an unwritable state dir must degrade to "the position
 * did not persist", never break a `move` that otherwise worked.
 */
export function writeStageStore(
  store: PointerStageStore,
  file: string = stagePath()
): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}

/** The disk-backed {@link PointerStage} used in production. */
export function filePointerStage(file: string = stagePath()): PointerStage {
  return {
    load(key) {
      return readStageStore(file)[key];
    },
    save(key, x, y) {
      const position: StagedPointerPosition = {
        x,
        y,
        stagedAt: new Date().toISOString(),
      };
      writeStageStore(
        withStagedPosition(readStageStore(file), key, position),
        file
      );
      return position;
    },
  };
}

/** An in-memory {@link PointerStage} — for tests and for a read-only state dir. */
export function memoryPointerStage(): PointerStage {
  const entries = new Map<string, StagedPointerPosition>();
  return {
    load(key) {
      return entries.get(key);
    },
    save(key, x, y) {
      const position: StagedPointerPosition = {
        x,
        y,
        stagedAt: new Date().toISOString(),
      };
      entries.set(key, position);
      return position;
    },
  };
}
