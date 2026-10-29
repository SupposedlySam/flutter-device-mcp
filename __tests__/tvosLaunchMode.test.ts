import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isTvosAsleepFailure,
  parseTvosLaunchModeEnv,
  resolveTvosLaunchMode,
  TVOS_DEFAULT_LAUNCH_MODE,
  tvosLaunchModeCaveat,
} from "../src/tvosLaunchMode.js";
import { resolveConfig } from "../src/config/config.js";
import { buildRuntime } from "../src/runtime.js";

describe("parseTvosLaunchModeEnv", () => {
  it("accepts the three modes in any case and with surrounding space", () => {
    expect(parseTvosLaunchModeEnv("debug")).toBe("debug");
    expect(parseTvosLaunchModeEnv(" Profile ")).toBe("profile");
    expect(parseTvosLaunchModeEnv("RELEASE")).toBe("release");
  });

  it("ignores anything else, so a typo falls back to the default", () => {
    expect(parseTvosLaunchModeEnv("prof")).toBeUndefined();
    expect(parseTvosLaunchModeEnv("")).toBeUndefined();
    expect(parseTvosLaunchModeEnv(undefined)).toBeUndefined();
  });
});

describe("resolveTvosLaunchMode", () => {
  it("defaults to debug, the only mode with hot reload and a working Marionette screenshot", () => {
    expect(TVOS_DEFAULT_LAUNCH_MODE).toBe("debug");
    expect(resolveTvosLaunchMode({})).toBe("debug");
  });

  it("takes an explicit mode over the debug boolean and the env", () => {
    expect(
      resolveTvosLaunchMode({ explicitMode: "profile", explicitDebug: true, envMode: "release" })
    ).toBe("profile");
  });

  it("maps the legacy debug boolean, over the env", () => {
    expect(resolveTvosLaunchMode({ explicitDebug: true, envMode: "release" })).toBe("debug");
    expect(resolveTvosLaunchMode({ explicitDebug: false, envMode: "debug" })).toBe("release");
  });

  it("uses the env mode when the call names none", () => {
    expect(resolveTvosLaunchMode({ envMode: "profile" })).toBe("profile");
  });
});

describe("tvosLaunchModeCaveat", () => {
  it("says nothing for a debug launch that was asked for", () => {
    expect(tvosLaunchModeCaveat("debug", "debug")).toBeNull();
  });

  it("names both modes when a simulator answered a profile request in debug", () => {
    expect(tvosLaunchModeCaveat("profile", "debug")).toMatch(
      /^Requested --profile, launched --debug: the tvOS simulator only runs the debug/
    );
  });

  it("tells a profile caller what Marionette and hot reload lose, and that release has no URI", () => {
    expect(tvosLaunchModeCaveat("profile", "profile")).toMatch(
      /registers Marionette outside debug.*take_screenshots fails.*no hot reload/
    );
    expect(tvosLaunchModeCaveat("release", "release")).toMatch(/no URI/);
  });
});

describe("isTvosAsleepFailure", () => {
  it("recognises devicectl's refusals on a sleeping Apple TV", () => {
    expect(isTvosAsleepFailure("ERROR: The operation couldn't be completed. (System is asleep)")).toBe(true);
    expect(isTvosAsleepFailure("Foreground app launch is forbidden")).toBe(true);
  });

  it("does not mistake other launch failures for sleep", () => {
    expect(isTvosAsleepFailure("Connection reset by peer")).toBe(false);
    expect(isTvosAsleepFailure("Could not build the application")).toBe(false);
  });
});

describe("the tvOS launch-mode and atvremote pins reach the adapter", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvos-launch-mode-"));
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: app\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    FLUTTER_DEVICE_LOG_DISABLE: "1",
    ...extra,
  });

  it("reads FLUTTER_DEVICE_TVOS_LAUNCH_MODE and FLUTTER_DEVICE_TVOS_ATV_ID into the tvOS settings only", () => {
    const config = resolveConfig({
      cwd: dir,
      env: envWith({
        FLUTTER_DEVICE_TVOS_LAUNCH_MODE: " Profile ",
        FLUTTER_DEVICE_TVOS_ATV_ID: "AA:BB:CC:DD:EE:FF",
      }),
    });
    expect(config.platforms.tvos.tvosLaunchMode).toBe("profile");
    expect(config.platforms.tvos.atvId).toBe("AA:BB:CC:DD:EE:FF");
    expect(config.platforms.ios.tvosLaunchMode).toBeUndefined();
    expect(config.platforms.ios.atvId).toBeUndefined();
  });

  it("falls back to the config file's tvosLaunchMode and atvId, env winning over them", () => {
    fs.writeFileSync(
      path.join(dir, "flutter-device.config.json"),
      JSON.stringify({ platforms: { tvos: { tvosLaunchMode: "release", atvId: "FILE-ID" } } })
    );
    const fromFile = resolveConfig({ cwd: dir, env: envWith({}) }).platforms.tvos;
    expect(fromFile.tvosLaunchMode).toBe("release");
    expect(fromFile.atvId).toBe("FILE-ID");
    const fromEnv = resolveConfig({
      cwd: dir,
      env: envWith({ FLUTTER_DEVICE_TVOS_LAUNCH_MODE: "profile", FLUTTER_DEVICE_TVOS_ATV_ID: "ENV-ID" }),
    }).platforms.tvos;
    expect(fromEnv.tvosLaunchMode).toBe("profile");
    expect(fromEnv.atvId).toBe("ENV-ID");
  });

  it("hands the resolved pins to the TvosAdapter the runtime constructs", () => {
    const { registry } = buildRuntime({
      cwd: dir,
      env: envWith({ FLUTTER_DEVICE_TVOS_LAUNCH_MODE: "release", FLUTTER_DEVICE_TVOS_ATV_ID: "ENV-ID" }),
    });
    const adapter = registry.resolve("tvos") as unknown as {
      config: { launchMode?: string; atvId?: string };
    };
    expect(adapter.config.launchMode).toBe("release");
    expect(adapter.config.atvId).toBe("ENV-ID");
  });
});
