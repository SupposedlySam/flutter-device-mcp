import {
  ANDROID_DEFAULT_LAUNCH_MODE,
  flutterModeFlag,
  parseAndroidLaunchModeEnv,
  resolveAndroidLaunchMode,
} from "../src/androidLaunchMode.js";
import { resolveBuildMode } from "../src/types.js";

describe("ANDROID_DEFAULT_LAUNCH_MODE", () => {
  it("is debug so a plain Android deploy comes up Marionette-drivable", () => {
    expect(ANDROID_DEFAULT_LAUNCH_MODE).toBe("debug");
  });
});

describe("flutterModeFlag", () => {
  it("maps each mode to its flutter CLI flag", () => {
    expect(flutterModeFlag("debug")).toBe("--debug");
    expect(flutterModeFlag("profile")).toBe("--profile");
    expect(flutterModeFlag("release")).toBe("--release");
  });
});

describe("parseAndroidLaunchModeEnv", () => {
  it("accepts the three valid modes", () => {
    expect(parseAndroidLaunchModeEnv("debug")).toBe("debug");
    expect(parseAndroidLaunchModeEnv("profile")).toBe("profile");
    expect(parseAndroidLaunchModeEnv("release")).toBe("release");
  });

  it("trims and lower-cases", () => {
    expect(parseAndroidLaunchModeEnv("  PROFILE ")).toBe("profile");
    expect(parseAndroidLaunchModeEnv("Debug")).toBe("debug");
  });

  it("returns undefined for unset/empty/whitespace", () => {
    expect(parseAndroidLaunchModeEnv(undefined)).toBeUndefined();
    expect(parseAndroidLaunchModeEnv("")).toBeUndefined();
    expect(parseAndroidLaunchModeEnv("   ")).toBeUndefined();
  });

  it("returns undefined for an unrecognized value (falls back to the default, no surprise pin)", () => {
    expect(parseAndroidLaunchModeEnv("prod")).toBeUndefined();
    expect(parseAndroidLaunchModeEnv("jit")).toBeUndefined();
  });
});

describe("resolveAndroidLaunchMode precedence", () => {
  it("explicit debug:true wins over any env pin", () => {
    expect(
      resolveAndroidLaunchMode({ explicitDebug: true, envMode: "release" })
    ).toBe("debug");
  });

  it("explicit debug:false maps to profile and wins over any env pin", () => {
    expect(
      resolveAndroidLaunchMode({ explicitDebug: false, envMode: "release" })
    ).toBe("profile");
  });

  it("falls through to the env pin when debug is omitted", () => {
    expect(resolveAndroidLaunchMode({ envMode: "profile" })).toBe("profile");
    expect(resolveAndroidLaunchMode({ envMode: "release" })).toBe("release");
  });

  it("falls through to the debug default when both are absent", () => {
    expect(resolveAndroidLaunchMode({})).toBe("debug");
    expect(resolveAndroidLaunchMode({ explicitDebug: undefined })).toBe("debug");
  });

  it("an explicit 3-way mode outranks the debug boolean and the env pin", () => {
    // `mode` is the only input that can ask for release, so it has to win over
    // a `debug` boolean that would otherwise force debug/profile.
    expect(
      resolveAndroidLaunchMode({
        explicitMode: "release",
        explicitDebug: true,
        envMode: "debug",
      })
    ).toBe("release");
    expect(
      resolveAndroidLaunchMode({ explicitMode: "profile", explicitDebug: true })
    ).toBe("profile");
  });
});

describe("resolveBuildMode (the neutral 3-way resolver)", () => {
  it("an explicit mode always wins over the legacy debug boolean", () => {
    expect(resolveBuildMode({ mode: "profile", debug: true })).toBe("profile");
    expect(resolveBuildMode({ mode: "release", debug: true })).toBe("release");
    expect(resolveBuildMode({ mode: "debug", debug: false })).toBe("debug");
  });

  it("without a mode, debug keeps its historical 2-way meaning", () => {
    expect(resolveBuildMode({ debug: true })).toBe("debug");
    expect(resolveBuildMode({ debug: false })).toBe("release");
    expect(resolveBuildMode({})).toBe("release");
  });

  it("cannot reach profile through the debug boolean alone", () => {
    // The whole reason `mode` exists: profile is the only mode that is BOTH
    // realistically-timed and drivable, and a boolean cannot name three things.
    expect(resolveBuildMode({ debug: true })).not.toBe("profile");
    expect(resolveBuildMode({ debug: false })).not.toBe("profile");
  });
});
