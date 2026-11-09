import {
  chooseAndroidDisplay,
  parseAndroidDisplays,
} from "../src/androidDisplays.js";
import { FOLDABLE_DUMPSYS_DISPLAY, FOLDABLE_INNER_ON_DUMPSYS_DISPLAY } from "./support/androidDisplayFixtures.js";

const COVER = {
  id: "1234567890123456701",
  uniqueId: "local:1234567890123456701",
  width: 832,
  height: 2268,
  state: "ON",
  isDefault: true,
};
const INNER = {
  id: "1234567890123456700",
  uniqueId: "local:1234567890123456700",
  width: 1768,
  height: 2208,
  state: "OFF",
  isDefault: false,
};

describe("parseAndroidDisplays", () => {
  it("reads both foldable panels with size, state and which backs logical display 0", () => {
    expect(parseAndroidDisplays(FOLDABLE_DUMPSYS_DISPLAY)).toEqual([COVER, INNER]);
  });

  it("follows the logical display when the inner panel is the lit one", () => {
    expect(parseAndroidDisplays(FOLDABLE_INNER_ON_DUMPSYS_DISPLAY)).toEqual([
      { ...COVER, state: "OFF", isDefault: false },
      { ...INNER, state: "ON", isDefault: true },
    ]);
  });

  it("skips displays screencap cannot address and reads nothing from unrelated text", () => {
    const virtual =
      'DisplayDeviceInfo{"Overlay #1": uniqueId="overlay:1", 1280 x 720, state ON}';
    expect(parseAndroidDisplays(virtual)).toEqual([]);
    expect(parseAndroidDisplays("")).toEqual([]);
  });
});

describe("chooseAndroidDisplay", () => {
  const foldable = [COVER, INNER];

  it("takes the only display that is on", () => {
    const lit = [{ ...COVER, state: "OFF", isDefault: true }, { ...INNER, state: "ON" }];
    expect(chooseAndroidDisplay(lit)).toEqual({
      ok: true,
      display: lit[1],
      why: "only display that is on",
    });
  });

  it("falls back to the default display when none, or both, are on", () => {
    const coverOff = { ...COVER, state: "OFF" };
    const bothOff = [coverOff, INNER];
    const bothOn = [COVER, { ...INNER, state: "ON" }];
    expect(chooseAndroidDisplay(bothOff)).toEqual({ ok: true, display: coverOff, why: "default display" });
    expect(chooseAndroidDisplay(bothOn)).toEqual({ ok: true, display: COVER, why: "default display" });
  });

  it("passes no display for a device with a single display, or one that could not be read", () => {
    expect(chooseAndroidDisplay([COVER])).toMatchObject({ ok: true, display: undefined });
    expect(chooseAndroidDisplay([])).toMatchObject({ ok: true, display: undefined });
  });

  it("honours a requested display even when it is off, by bare id or local: id", () => {
    expect(chooseAndroidDisplay(foldable, INNER.id)).toEqual({ ok: true, display: INNER, why: "requested" });
    expect(chooseAndroidDisplay(foldable, INNER.uniqueId)).toEqual({ ok: true, display: INNER, why: "requested" });
  });

  it("refuses an unknown display and lists the displays", () => {
    const choice = chooseAndroidDisplay(foldable, "7");
    expect(choice.ok).toBe(false);
    expect(choice).toMatchObject({
      reason:
        "Display 7 is not one of this device's displays. Available: " +
        "1234567890123456701 (832x2268, ON, default); 1234567890123456700 (1768x2208, OFF).",
    });
  });

  it("refuses a requested display when none could be read, rather than guessing", () => {
    const choice = chooseAndroidDisplay([], "1");
    expect(choice).toMatchObject({ ok: false });
    expect((choice as { reason: string }).reason).toContain("No display could be read");
  });
});
