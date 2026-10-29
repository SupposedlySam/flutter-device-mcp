import {
  classifyRunnerFailure,
  isIosRunnerKey,
  MAX_VOLUME_REPEAT,
  tapStep,
  UI_AUTOMATION_SETTING,
  volumeStep,
} from "../src/iosUiRunnerSteps.js";
import { UnsupportedInputError } from "../src/types.js";

describe("volumeStep", () => {
  it("maps each key name and repeat to the runner step", () => {
    expect(volumeStep("VOLUME_UP")).toBe("up1");
    expect(volumeStep("volume_down", 16)).toBe("down16");
    expect(volumeStep("VOLUMEUP", 3)).toBe("up3");
  });

  it("rejects a key the runner cannot press as unsupported", () => {
    expect(() => volumeStep("HOME")).toThrow(UnsupportedInputError);
    expect(isIosRunnerKey("HOME")).toBe(false);
    expect(isIosRunnerKey(" Volume_Up ")).toBe(true);
  });

  it.each([0, -1, 1.5, MAX_VOLUME_REPEAT + 1, NaN])("rejects repeat %p", (repeat) => {
    expect(() => volumeStep("VOLUME_UP", repeat)).toThrow(RangeError);
  });
});

describe("tapStep", () => {
  it("encodes points with a colon so the comma stays the step separator", () => {
    expect(tapStep(195, 420.5)).toBe("tap@195:420.5");
  });

  it.each([[-1, 0], [0, NaN], [Infinity, 1]])("rejects (%p, %p)", (x, y) => {
    expect(() => tapStep(x, y)).toThrow(RangeError);
  });
});

describe("classifyRunnerFailure", () => {
  it("names the UI Automation setting for the automation-mode timeout", () => {
    const failure = classifyRunnerFailure(
      "Testing failed:\n\tTimed out while enabling automation mode.\n** TEST FAILED **"
    );
    expect(failure.kind).toBe("ui-automation-disabled");
    expect(failure.message).toContain(UI_AUTOMATION_SETTING);
  });

  it("recognises a locked device and a signing failure", () => {
    expect(classifyRunnerFailure("Unlock iPhone to continue").kind).toBe("device-locked");
    expect(
      classifyRunnerFailure('error: No profiles for "dev.flutterdevice.uirunner.tABCDE12345" were found').kind
    ).toBe("signing");
  });

  it("reports an unrecognised failure as unrecognised, never as a known cause", () => {
    const failure = classifyRunnerFailure("** TEST FAILED **");
    expect(failure.kind).toBe("test-failed");
    expect(failure.message).not.toContain("UI Automation");
  });
});
