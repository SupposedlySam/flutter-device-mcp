/**
 * The platform-neutral half of a point-to-point drag: how a request becomes a
 * press, a sequence of evenly spaced moves, and a release. Pure, so the gesture
 * a call will send is inspectable without a device; each controller only turns
 * the plan into its own command.
 */
import { Point } from "./dpr.js";
import { PointerDragRequest } from "../types.js";

export const DRAG_DEFAULT_DURATION_MS = 500;

/** The move rate a drag aims for when the caller does not choose `steps`. */
export const DRAG_TARGET_HZ = 60;

/**
 * Ceilings on the caller's numbers. A drag send blocks for the whole gesture,
 * so these keep a typo from holding the device for minutes; `steps` is bounded
 * too because every step is a line of the command sent to the device.
 */
export const DRAG_MAX_DURATION_MS = 10000;
export const DRAG_MAX_HOLD_MS = 10000;
export const DRAG_MAX_STEPS = 600;

export interface DragPlan {
  from: Point;
  to: Point;
  steps: number;
  /** `intervalMs * steps`: the planned press-to-last-move time. */
  durationMs: number;
  intervalMs: number;
  holdMs: number;
  distancePx: number;
  /** The positions of the MOVE events, in order; the last one is `to`. */
  moves: Point[];
  notes: string[];
}

/** Default step count for a duration: the {@link DRAG_TARGET_HZ} rate, at least one move. */
export function defaultDragSteps(durationMs: number): number {
  return Math.max(1, Math.round((durationMs * DRAG_TARGET_HZ) / 1000));
}

/**
 * Plan a drag. `minIntervalMs` is the shortest wait the platform can put
 * between events (cliclick refuses anything under 20ms); a step count that
 * would need a shorter one is reduced so the duration still holds.
 *
 * The interval is whole milliseconds, so the planned duration can differ from
 * the requested one by under a millisecond per step. It is reported as planned.
 */
export function planDrag(
  request: PointerDragRequest,
  opts: { minIntervalMs?: number } = {}
): DragPlan {
  const minIntervalMs = Math.max(1, opts.minIntervalMs ?? 1);
  const from = { x: Math.round(request.from.x), y: Math.round(request.from.y) };
  const to = { x: Math.round(request.to.x), y: Math.round(request.to.y) };
  const requestedDuration = Math.max(1, Math.round(request.durationMs));
  const holdMs = Math.max(0, Math.round(request.holdMs ?? 0));
  const notes: string[] = [];

  const requestedSteps = request.steps ?? defaultDragSteps(requestedDuration);
  const maxSteps = Math.max(
    1,
    Math.min(DRAG_MAX_STEPS, Math.floor(requestedDuration / minIntervalMs))
  );
  const steps = Math.min(Math.max(1, Math.round(requestedSteps)), maxSteps);
  if (request.steps !== undefined && steps !== Math.round(request.steps)) {
    notes.push(
      `Requested ${request.steps} steps but sent ${steps}: over ${requestedDuration}ms ` +
        `the platform cannot put less than ${minIntervalMs}ms between events.`
    );
  }

  const intervalMs = Math.max(minIntervalMs, Math.round(requestedDuration / steps));
  const moves: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    moves.push({
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
    });
  }
  const distancePx = Math.round(Math.hypot(to.x - from.x, to.y - from.y));
  if (distancePx === 0) {
    notes.push(
      "from and to are the same point, so this is a press, a hold and a release " +
        "in place — no travel was sent."
    );
  }

  return {
    from,
    to,
    steps,
    durationMs: intervalMs * steps,
    intervalMs,
    holdMs,
    distancePx,
    moves,
    notes,
  };
}

/** Moves per second actually achieved, from a measured send that includes the hold. */
export function effectiveDragHz(plan: DragPlan, measuredMs: number): number {
  const moving = measuredMs - plan.holdMs;
  if (moving <= 0) return 0;
  return Number(((plan.steps * 1000) / moving).toFixed(1));
}

/**
 * Note on a measured drag that ran well past its plan. On Android each event
 * is a separate `input` process, and its start-up is paid on top of every
 * interval, so the overrun is per event and fewer steps is the fix.
 */
export function dragOverrunNote(
  plan: DragPlan,
  measuredMs: number,
  perEventCause: string
): string | undefined {
  const planned = plan.durationMs + plan.holdMs;
  if (measuredMs <= planned * 1.25) return undefined;
  const events = plan.steps + 2;
  const perEvent = Math.round((measuredMs - planned) / events);
  return (
    `The drag took ${measuredMs}ms against ${planned}ms planned — about ${perEvent}ms ` +
    `extra per event (${perEventCause}). The path is the same; only the speed is ` +
    `lower. For a faster gesture pass fewer steps, or a shorter duration_ms.`
  );
}
