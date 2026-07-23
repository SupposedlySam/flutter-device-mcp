/**
 * Logical → device pixel conversion for pointer input.
 *
 * Flutter/Marionette report geometry in LOGICAL pixels (e.g. a 1200x675 canvas),
 * while a pointer-native platform positions the cursor in DEVICE pixels (e.g.
 * 1920x1080). The ratio between them is the device pixel ratio (DPR). This is
 * the single seam that bridges the two spaces, kept ready for the webOS Magic
 * Remote pointer (free-cursor move/scroll is unsupported on the Tizen appliance).
 *
 * The DPR is always a PARAMETER — never hardcoded. Different appliances (and
 * different developers' devices) run at different ratios, so the caller must
 * pass the device's actual DPR. This module is intentionally pure and free of
 * any device/platform knowledge so it can be unit-tested exhaustively.
 */

/** A 2D point. Reused for both logical and device coordinate spaces. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Convert a LOGICAL-space point to a DEVICE-space point by scaling with `dpr`
 * and rounding to the nearest whole pixel (the pointer channel takes integers).
 *
 * Example: logical (1200, 675) at dpr 1.6 → device (1920, 1080).
 *
 * @throws RangeError when `dpr` is not a finite positive number, or when either
 *   coordinate is not finite — silently sending a NaN/Infinity position would
 *   move the on-screen cursor to an undefined location.
 */
export function logicalToDevicePx(point: Point, dpr: number): Point {
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new RangeError(
      `dpr must be a finite positive number, received ${dpr}`
    );
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(
      `point coordinates must be finite, received (${point.x}, ${point.y})`
    );
  }
  return {
    x: Math.round(point.x * dpr),
    y: Math.round(point.y * dpr),
  };
}
