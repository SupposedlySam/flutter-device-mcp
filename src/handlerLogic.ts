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
import { logicalToDevicePx, Point } from "./input/dpr.js";
import { ToolRoute } from "./toolRouting.js";
import { CommandResult, UnsupportedInputError } from "./types.js";

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
 * Resolve a scroll `dy` into a DEVICE-space vertical delta.
 *
 * Same rules as {@link resolvePointerTarget}: `device` by default; `logical`
 * scales via the DPR helper with `dpr` required.
 */
export function resolveScrollDelta(args: {
  dy?: unknown;
  coordinateSpace?: unknown;
  dpr?: unknown;
}): { dy: number; coordinateSpace: "device" | "logical" } {
  const coordinateSpace = (args.coordinateSpace as "device" | "logical") ?? "device";
  if (typeof args.dy !== "number") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "pointer scroll requires a numeric dy."
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
      dy: logicalToDevicePx({ x: 0, y: args.dy }, args.dpr).y,
      coordinateSpace,
    };
  }
  return { dy: args.dy, coordinateSpace };
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
 * `<key>Killed` boolean (true when that pkill exited 0 — pkill exits 0 when it
 * killed something, 1 when nothing matched) plus a `<key>Exit` entry under
 * `detail`.
 *
 * Being generic means it reports the right keys for every platform whatever the
 * adapter names them — e.g. Tizen's `flutterTizen` and iOS's `flutterRun`/
 * `frontendServer` — rather than hardcoding one platform's keys.
 */
export function summarizeKillStale(
  killed: Record<string, CommandResult>
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const detail: Record<string, number | null | undefined> = {};
  for (const [key, result] of Object.entries(killed)) {
    summary[`${key}Killed`] = result?.code === 0;
    detail[`${key}Exit`] = result?.code;
  }
  summary.detail = detail;
  return summary;
}
