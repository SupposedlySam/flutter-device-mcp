import { logicalToDevicePx } from "../src/input/dpr.js";

describe("logicalToDevicePx", () => {
  it("scales the canonical 1200x675 @1.6 → 1920x1080", () => {
    expect(logicalToDevicePx({ x: 1200, y: 675 }, 1.6)).toEqual({
      x: 1920,
      y: 1080,
    });
  });

  it("is identity at dpr 1", () => {
    expect(logicalToDevicePx({ x: 640, y: 360 }, 1)).toEqual({ x: 640, y: 360 });
  });

  it("rounds to the nearest whole pixel", () => {
    // 100 * 1.5 = 150 exactly; 101 * 1.5 = 151.5 → 152; 99 * 1.5 = 148.5 → 149
    expect(logicalToDevicePx({ x: 100, y: 101 }, 1.5)).toEqual({
      x: 150,
      y: 152,
    });
    expect(logicalToDevicePx({ x: 99, y: 99 }, 1.5)).toEqual({ x: 149, y: 149 });
  });

  it("rounds half up (Math.round semantics)", () => {
    // 5 * 0.5 = 2.5 → 3 (round half up)
    expect(logicalToDevicePx({ x: 5, y: 5 }, 0.5)).toEqual({ x: 3, y: 3 });
  });

  it("handles the origin", () => {
    expect(logicalToDevicePx({ x: 0, y: 0 }, 3)).toEqual({ x: 0, y: 0 });
  });

  it("supports fractional dpr like 2.625 (common on hi-dpi)", () => {
    expect(logicalToDevicePx({ x: 411, y: 891 }, 2.625)).toEqual({
      x: Math.round(411 * 2.625),
      y: Math.round(891 * 2.625),
    });
  });

  it("rejects a non-positive dpr", () => {
    expect(() => logicalToDevicePx({ x: 1, y: 1 }, 0)).toThrow(RangeError);
    expect(() => logicalToDevicePx({ x: 1, y: 1 }, -1)).toThrow(/positive/);
  });

  it("rejects a non-finite dpr", () => {
    expect(() => logicalToDevicePx({ x: 1, y: 1 }, NaN)).toThrow(RangeError);
    expect(() => logicalToDevicePx({ x: 1, y: 1 }, Infinity)).toThrow(RangeError);
  });

  it("rejects non-finite coordinates", () => {
    expect(() => logicalToDevicePx({ x: NaN, y: 1 }, 2)).toThrow(RangeError);
    expect(() => logicalToDevicePx({ x: 1, y: Infinity }, 2)).toThrow(/finite/);
  });
});
