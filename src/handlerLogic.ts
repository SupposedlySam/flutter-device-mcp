/**
 * Pure dispatch-layer helpers extracted from the MCP server so the branching
 * logic can be unit-tested without standing up a Server/transport.
 *
 * These encode two behaviors the CallTool handler relied on inline:
 *   - platform merge: a tool honors the caller-supplied `platform` arg (a route
 *     may also force a platform, though none do today).
 *   - pointer target resolution: coordinates default to DEVICE space; a
 *     `logical` space is converted to device pixels via the DPR helper, and
 *     the DPR is required (never assumed) for logical coordinates.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ScreenSize } from "./deviceGeometry.js";
import { ANDROID_SWIPE_MAX_DURATION_MS } from "./input/androidInputController.js";
import {
  DRAG_DEFAULT_DURATION_MS,
  DRAG_MAX_DURATION_MS,
  DRAG_MAX_HOLD_MS,
  DRAG_MAX_STEPS,
} from "./input/drag.js";
import { logicalToDevicePx, Point } from "./input/dpr.js";
import { ToolRoute } from "./toolRouting.js";
import { CommandResult, PointerDragRequest, UnsupportedInputError } from "./types.js";

/**
 * Merge the platform an alias forces with the caller-supplied one.
 *
 * `route.forcedPlatform` (set for `tizen_*` aliases) wins; otherwise the
 * caller's `platform` arg is honored (undefined → the registry default).
 */
export function resolvePlatform(
  route: ToolRoute,
  args: { platform?: unknown }
): string | undefined {
  return route.forcedPlatform ?? (args.platform as string | undefined);
}

/** A resolved pointer target in DEVICE space plus the space it came from. */
export interface ResolvedPointerTarget {
  point: Point;
  coordinateSpace: "device" | "logical";
}

/**
 * Resolve pointer `x`/`y` into a DEVICE-space point.
 *
 * `coordinateSpace` defaults to `device`. For `logical`, the point is scaled to
 * device pixels via {@link logicalToDevicePx}; `dpr` is required (never assumed)
 * and its absence throws an InvalidParams {@link McpError}. Missing/non-numeric
 * `x`/`y` also throw InvalidParams so callers get a clean protocol error.
 */
export function resolvePointerTarget(args: {
  x?: unknown;
  y?: unknown;
  coordinateSpace?: unknown;
  dpr?: unknown;
}): ResolvedPointerTarget {
  const coordinateSpace = (args.coordinateSpace as "device" | "logical") ?? "device";
  if (typeof args.x !== "number" || typeof args.y !== "number") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "pointer move requires numeric x and y."
    );
  }
  if (coordinateSpace === "logical") {
    if (typeof args.dpr !== "number") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "coordinateSpace 'logical' requires dpr (the device pixel ratio; it is never assumed)."
      );
    }
    return {
      point: logicalToDevicePx({ x: args.x, y: args.y }, args.dpr),
      coordinateSpace,
    };
  }
  return { point: { x: args.x, y: args.y }, coordinateSpace };
}

/**
 * Resolve a scroll `dy` into a DEVICE-space vertical delta, plus the optional
 * duration that decides how FAST the resulting drag is.
 *
 * Same coordinate rules as {@link resolvePointerTarget}: `device` by default;
 * `logical` scales via the DPR helper with `dpr` required. `duration_ms` is not
 * scaled — it is milliseconds in every space.
 *
 * The duration is range-checked HERE, before any device is resolved or shelled
 * out to, so a typo costs nothing instead of an adb round-trip and a gesture
 * nobody wanted.
 */
export function resolveScrollDelta(args: {
  dy?: unknown;
  coordinateSpace?: unknown;
  dpr?: unknown;
  duration_ms?: unknown;
}): {
  dy: number;
  coordinateSpace: "device" | "logical";
  durationMs?: number;
} {
  const coordinateSpace = (args.coordinateSpace as "device" | "logical") ?? "device";
  if (typeof args.dy !== "number") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "pointer scroll requires a numeric dy."
    );
  }
  const durationMs = resolveScrollDurationMs(args.duration_ms);
  if (coordinateSpace === "logical") {
    if (typeof args.dpr !== "number") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "coordinateSpace 'logical' requires dpr (the device pixel ratio; it is never assumed)."
      );
    }
    return {
      dy: logicalToDevicePx({ x: 0, y: args.dy }, args.dpr).y,
      coordinateSpace,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return {
    dy: args.dy,
    coordinateSpace,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Validate the optional `duration_ms` scroll argument. */
function resolveScrollDurationMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "duration_ms must be a positive number of milliseconds."
    );
  }
  if (value > ANDROID_SWIPE_MAX_DURATION_MS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `duration_ms must be at most ${ANDROID_SWIPE_MAX_DURATION_MS}ms — the ` +
        "swipe send blocks for the whole gesture, so a longer one is killed " +
        "mid-drag and reported as a failed send rather than as a bad argument."
    );
  }
  return value;
}

/**
 * Resolve a drag's two ends and timing, checked before any device is touched.
 *
 * Both ends follow the {@link resolvePointerTarget} coordinate rules. Times are
 * milliseconds in every space; `steps` is a count and is never scaled.
 */
export function resolveDragGesture(args: {
  x?: unknown;
  y?: unknown;
  x2?: unknown;
  y2?: unknown;
  coordinateSpace?: unknown;
  dpr?: unknown;
  duration_ms?: unknown;
  steps?: unknown;
  hold_ms?: unknown;
}): { request: PointerDragRequest; coordinateSpace: "device" | "logical" } {
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  if (![args.x, args.y, args.x2, args.y2].every(finite)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "pointer drag requires numeric x, y (where it starts) and x2, y2 (where it ends)."
    );
  }
  const from = resolvePointerTarget(args);
  const to = resolvePointerTarget({ ...args, x: args.x2, y: args.y2 });

  const bounded = (name: string, value: unknown, min: number, max: number, integer = false) => {
    if (value === undefined) return undefined;
    const inRange = finite(value) && (value as number) >= min && (value as number) <= max;
    if (!inRange || (integer && !Number.isInteger(value))) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`
      );
    }
    return value as number;
  };
  // A zero duration has no interval to put between the moves.
  const durationMs = bounded("duration_ms", args.duration_ms, 1, DRAG_MAX_DURATION_MS);
  const steps = bounded("steps", args.steps, 1, DRAG_MAX_STEPS, true);
  const holdMs = bounded("hold_ms", args.hold_ms, 0, DRAG_MAX_HOLD_MS);

  return {
    request: {
      from: from.point,
      to: to.point,
      durationMs: durationMs ?? DRAG_DEFAULT_DURATION_MS,
      ...(steps !== undefined ? { steps } : {}),
      ...(holdMs !== undefined ? { holdMs } : {}),
    },
    coordinateSpace: from.coordinateSpace,
  };
}

/** Why a platform whose controller has no drag cannot do one, and what to use. */
export function dragUnsupportedReason(platform: string): string {
  switch (platform) {
    case "tizen":
      return (
        "Drag is unsupported on Tizen: the Tizen TV app is focus/D-pad-driven and the " +
        "Samsung remote touchpad channel never reaches it as pointer events (verified " +
        "on-device). Drive gestures with Marionette over the VM service on a debug build."
      );
    case "webos":
      return (
        "Drag is not wired on webOS: the ssap pointer socket sends moves, clicks and " +
        "scrolls but has no way to hold the button across moves."
      );
    case "ios":
    case "tvos":
      return (
        `Drag is unsupported on ${platform === "ios" ? "iOS" : "tvOS"}: this MCP has no ` +
        "OS-level input injection there. Use Marionette swipe over the VM service."
      );
    default:
      return `Drag is not wired on ${platform}.`;
  }
}

/** Caller-supplied Flutter view metrics to cross-check geometry against. */
export interface ResolvedViewMetrics {
  /** The view's logical size, when both dimensions were supplied. */
  logicalSize?: ScreenSize;
  /** The view's own reported device pixel ratio, when supplied. */
  devicePixelRatio?: number;
}

/**
 * Resolve the optional view metrics `flutter_geometry` cross-checks against.
 *
 * Every field is optional (the OS-level geometry stands alone), but a supplied
 * one must be usable: a width without a height cannot describe a view, and a
 * zero/negative/non-numeric dimension would produce a comparison that reads as
 * authoritative while meaning nothing. Rejecting here — before any device is
 * resolved or shelled out to — keeps a typo cheap instead of paying two adb
 * round-trips to then discard the answer.
 */
export function resolveViewMetrics(args: {
  view_width?: unknown;
  view_height?: unknown;
  view_dpr?: unknown;
}): ResolvedViewMetrics {
  const positive = (value: unknown): boolean =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const hasWidth = args.view_width !== undefined;
  const hasHeight = args.view_height !== undefined;

  if (hasWidth !== hasHeight) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "view_width and view_height must be supplied together — one alone cannot " +
        "describe the Flutter view."
    );
  }
  if (hasWidth && !(positive(args.view_width) && positive(args.view_height))) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "view_width and view_height must be positive numbers (Flutter LOGICAL px)."
    );
  }
  if (args.view_dpr !== undefined && !positive(args.view_dpr)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "view_dpr must be a positive number (the view's own devicePixelRatio)."
    );
  }

  return {
    logicalSize: hasWidth
      ? { width: args.view_width as number, height: args.view_height as number }
      : undefined,
    devicePixelRatio: args.view_dpr as number | undefined,
  };
}

/**
 * Map an {@link UnsupportedInputError} to a clean, non-fatal result payload
 * (the requested input action is unsupported on this platform); return
 * undefined for any other error so the caller rethrows it.
 *
 * `action` names the actual action attempted (`key`, `click`, `move`,
 * `scroll`, …) so the payload accurately reflects what the caller asked for
 * rather than a hardcoded guess.
 *
 * The payload is the plain object the server serializes via its JSON envelope;
 * keeping the mapping pure lets it be tested without the Server transport.
 */
export function mapUnsupportedInput(
  error: unknown,
  platform: string,
  action: string
): { platform: string; action: string; sent: boolean; supported: false; reason: string } | undefined {
  if (!(error instanceof UnsupportedInputError)) return undefined;
  return {
    platform,
    action,
    sent: false,
    supported: false,
    reason: error.message,
  };
}

/**
 * Summarize an adapter's {@link CommandResult} map into the kill_stale response
 * payload, GENERIC over whatever keys the adapter returns. Each `<key>` yields a
 * `<key>Killed` boolean (true when that teardown killed something — exit 0, the
 * `pkill` convention the adapters keep) plus a `<key>Exit` entry under `detail`.
 *
 * Being generic means it reports the right keys for every platform whatever the
 * adapter names them — e.g. Tizen's `flutterTizen` and iOS's `flutterRun`/
 * `frontendServer` — rather than hardcoding one platform's keys.
 *
 * A `<key>Killed: false` is an OUTCOME, not a failure: nothing was running that
 * belonged to this device. Device-scoped teardowns produce far more of those
 * than a host-wide `pkill` did, which is why each key's note is carried through
 * to `detail` — it is where "no launch driver found for emulator-5554" and
 * "left running on another device: pid 8123" are said, and without it a caller
 * reads a bare `false` and cannot tell those two apart.
 */
export function summarizeKillStale(
  killed: Record<string, CommandResult>
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const detail: Record<string, unknown> = {};
  for (const [key, result] of Object.entries(killed)) {
    summary[`${key}Killed`] = result?.code === 0;
    detail[`${key}Exit`] = result?.code;
    const note = result?.combined?.trim();
    if (note) detail[`${key}Note`] = note;
  }
  summary.detail = detail;
  return summary;
}
