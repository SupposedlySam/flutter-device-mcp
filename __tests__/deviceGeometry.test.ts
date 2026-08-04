import {
  crossCheckView,
  deriveAndroidGeometry,
  dprFromDensity,
  parseWmDensity,
} from "../src/deviceGeometry.js";
import { parseWmSize } from "../src/input/androidInputController.js";

/** Verbatim `adb shell wm density` output from the physical SM-G892U. */
const SM_G892U_DENSITY = "Physical density: 480\nOverride density: 640\n";
/** Verbatim `adb shell wm size` output from the same device. */
const SM_G892U_SIZE = "Physical size: 1440x2960\n";

describe("parseWmDensity", () => {
  it("prefers the override density — it is the one actually in force", () => {
    // Reading the physical line here would yield dpr 3.0 instead of 4.0 and
    // mis-scale every tap by a third.
    expect(parseWmDensity(SM_G892U_DENSITY)).toEqual({
      physical: 480,
      override: 640,
      effective: 640,
    });
  });

  it("falls back to the physical density when no override is set", () => {
    expect(parseWmDensity("Physical density: 420\n")).toEqual({
      physical: 420,
      override: undefined,
      effective: 420,
    });
  });

  it("returns undefined when nothing parses or the value is unusable", () => {
    expect(parseWmDensity("")).toBeUndefined();
    expect(parseWmDensity("error: device offline")).toBeUndefined();
    expect(parseWmDensity("Physical density: 0")).toBeUndefined();
  });
});

describe("dprFromDensity", () => {
  it("treats 160dpi as dpr 1.0", () => {
    expect(dprFromDensity(160)).toBe(1);
    expect(dprFromDensity(640)).toBe(4);
    expect(dprFromDensity(420)).toBeCloseTo(2.625);
  });
});

describe("deriveAndroidGeometry", () => {
  it("derives the live device's geometry from real adb output", () => {
    const geometry = deriveAndroidGeometry(
      parseWmSize(SM_G892U_SIZE),
      parseWmDensity(SM_G892U_DENSITY)
    );

    expect(geometry).toBeDefined();
    expect(geometry?.displaySize).toEqual({ width: 1440, height: 2960 });
    expect(geometry?.dpr).toBe(4);
    expect(geometry?.dprSource).toContain("Override density");
    // 2960 / 4 = 740 — the logical DISPLAY, which is NOT the Flutter view (725).
    expect(geometry?.logicalDisplaySize).toEqual({ width: 360, height: 740 });
  });

  it("names the PHYSICAL density as the source when no override is set", () => {
    // The other half of the dprSource branch: with no override line the ratio
    // came from the panel's own density, and saying "Override" here would tell a
    // caller the system was rendering at a density it never reported.
    const geometry = deriveAndroidGeometry(
      parseWmSize("Physical size: 1080x2400\n"),
      parseWmDensity("Physical density: 420\n")
    );

    expect(geometry?.dpr).toBeCloseTo(2.625);
    expect(geometry?.dprSource).toContain("Physical density");
    expect(geometry?.dprSource).not.toContain("Override");
  });

  it("returns undefined rather than a half-guess when either input is missing", () => {
    expect(
      deriveAndroidGeometry(undefined, parseWmDensity(SM_G892U_DENSITY))
    ).toBeUndefined();
    expect(
      deriveAndroidGeometry(parseWmSize(SM_G892U_SIZE), undefined)
    ).toBeUndefined();
  });
});

describe("crossCheckView", () => {
  const geometry = deriveAndroidGeometry(
    parseWmSize(SM_G892U_SIZE),
    parseWmDensity(SM_G892U_DENSITY)
  )!;

  it("reports the display-vs-view height gap as an expected NOTE, not a warning", () => {
    const check = crossCheckView(geometry, { width: 360, height: 725 }, 4);

    expect(check.warnings).toEqual([]);
    expect(check.notes).toHaveLength(1);
    // 2960 - (725 * 4) = 60 device px of navigation bar.
    expect(check.notes[0]).toContain("60 device px are system chrome");
    expect(check.notes[0]).toContain("740");
  });

  it("says NOTHING when the view fills the display — there is no chrome to name", () => {
    // The boundary the note guards: 740 logical * dpr 4 = 2960 device px, the
    // whole display. A note here would invent a navigation bar that isn't there
    // and tell the caller the view size differs from the display when it doesn't.
    const check = crossCheckView(geometry, { width: 360, height: 740 }, 4);

    expect(check.notes).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it("WARNS when the view width disagrees — that means the dpr is wrong", () => {
    // A view 360 logical wide at a wrongly-assumed dpr of 3 implies 1080px on a
    // 1440px display: exactly the silent mis-scaling this catches.
    const wrongDpr = deriveAndroidGeometry(
      { width: 1440, height: 2960 },
      { physical: 480, effective: 480 }
    )!;

    const check = crossCheckView(wrongDpr, { width: 360, height: 725 }, 4);

    expect(check.warnings.join(" ")).toContain("dpr is probably wrong");
  });

  it("WARNS when the app's own devicePixelRatio disagrees with the platform's", () => {
    // The DROP-3841 shape: an embedder reporting a bogus MediaQuery ratio.
    const check = crossCheckView(geometry, { width: 360, height: 725 }, 0.4);
    expect(check.warnings.join(" ")).toContain("MediaQuery.devicePixelRatio 0.4");
  });

  it("is silent when nothing is known about the view", () => {
    expect(crossCheckView(geometry, undefined, undefined)).toEqual({
      notes: [],
      warnings: [],
    });
  });
});
