/**
 * Pure logic for the iOS UI-test runner: which step script a key or tap becomes,
 * and what a failed `xcodebuild` run means. The runner itself (build, cache,
 * spawn) is in iosUiRunner.ts.
 */
import { UnsupportedInputError } from "./types.js";

/** Most volume presses one call may send; each costs ~250 ms on the device. */
export const MAX_VOLUME_REPEAT = 64;

const VOLUME_STEP_PREFIX: Readonly<Record<string, string>> = {
  VOLUME_UP: "up",
  VOLUMEUP: "up",
  VOLUME_DOWN: "down",
  VOLUMEDOWN: "down",
};

/** The hardware keys the runner can press, as `flutter_key` names. */
export const IOS_RUNNER_KEYS = ["VOLUME_UP", "VOLUME_DOWN"] as const;

export function isIosRunnerKey(name: string): boolean {
  return normalizeKey(name) in VOLUME_STEP_PREFIX;
}

function normalizeKey(name: string): string {
  return name.trim().toUpperCase();
}

/** `up3` / `down16`: the runner step for `repeat` presses of a volume key. */
export function volumeStep(name: string, repeat = 1): string {
  const prefix = VOLUME_STEP_PREFIX[normalizeKey(name)];
  if (!prefix) {
    throw new UnsupportedInputError(
      `iOS has no '${name}' key. The hardware keys it can press are ` +
        `${IOS_RUNNER_KEYS.join(", ")}; drive everything else with Marionette.`
    );
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_VOLUME_REPEAT) {
    throw new RangeError(
      `repeat must be a whole number from 1 to ${MAX_VOLUME_REPEAT}, received ${repeat}`
    );
  }
  return `${prefix}${repeat}`;
}

/** `tap@x:y`, in points from the top-left of the app's window. */
export function tapStep(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new RangeError(
      `tap coordinates must be finite and not negative, received (${x}, ${y})`
    );
  }
  return `tap@${x}:${y}`;
}

export const UI_AUTOMATION_SETTING = "Settings > Developer > Enable UI Automation";

export interface RunnerFailure {
  kind: "ui-automation-disabled" | "device-locked" | "signing" | "test-failed";
  message: string;
}

/**
 * Classify the output of a failed runner `xcodebuild` run. The first match wins
 * and an unrecognised failure is reported as such, never as a known cause.
 */
export function classifyRunnerFailure(output: string): RunnerFailure {
  if (/Timed out while enabling automation mode/i.test(output)) {
    return {
      kind: "ui-automation-disabled",
      message:
        `UI Automation is off on the device. Turn on ${UI_AUTOMATION_SETTING} ` +
        "(it asks for the passcode), then retry. This is a one-time switch per device.",
    };
  }
  if (/device is (?:currently )?locked|Unlock .* to continue/i.test(output)) {
    return {
      kind: "device-locked",
      message: "The device is locked. Unlock it and retry.",
    };
  }
  if (/No Account for Team|No profiles for|requires a development team|Signing for .* requires/i.test(output)) {
    return {
      kind: "signing",
      message:
        "Xcode could not sign the UI runner for this device. Open the app's " +
        "Xcode project once with the account that owns the team, register the " +
        "device, and retry.",
    };
  }
  return {
    kind: "test-failed",
    message: "The UI runner failed for a reason this tool does not recognise.",
  };
}
