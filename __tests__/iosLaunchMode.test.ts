import fs from "fs";
import os from "os";
import path from "path";
import {
  IOS_DEFAULT_LAUNCH_MODE,
  iosFlutterModeFlag,
  iosLaunchModeCaveat,
  marionetteAvailableInMode,
  parseIosLaunchModeEnv,
  resolveIosLaunchMode,
} from "../src/iosLaunchMode.js";
import { resolveConfig } from "../src/config/config.js";
import { buildRuntime } from "../src/runtime.js";

describe("IOS_DEFAULT_LAUNCH_MODE", () => {
  // The default is load-bearing, not cosmetic: the app gates
  // bootstrapMarionette() on kDebugMode, so anything but debug leaves a plain
  // `flutter_deploy platform=ios` undrivable.
  it("is debug, so a plain deploy comes up Marionette-drivable", () => {
    expect(IOS_DEFAULT_LAUNCH_MODE).toBe("debug");
    expect(marionetteAvailableInMode(IOS_DEFAULT_LAUNCH_MODE)).toBe(true);
  });

  it("reports every non-debug mode as Marionette-unavailable", () => {
    expect(marionetteAvailableInMode("profile")).toBe(false);
    expect(marionetteAvailableInMode("release")).toBe(false);
  });
});

describe("iosFlutterModeFlag", () => {
  it("maps each mode to its flutter flag", () => {
    expect(iosFlutterModeFlag("debug")).toBe("--debug");
    expect(iosFlutterModeFlag("profile")).toBe("--profile");
    expect(iosFlutterModeFlag("release")).toBe("--release");
  });
});

describe("parseIosLaunchModeEnv", () => {
  it("accepts the three modes", () => {
    expect(parseIosLaunchModeEnv("debug")).toBe("debug");
    expect(parseIosLaunchModeEnv("profile")).toBe("profile");
    expect(parseIosLaunchModeEnv("release")).toBe("release");
  });

  it("trims and lower-cases", () => {
    expect(parseIosLaunchModeEnv("  PROFILE ")).toBe("profile");
    expect(parseIosLaunchModeEnv("Debug")).toBe("debug");
  });

  it("treats unset/empty as no pin", () => {
    expect(parseIosLaunchModeEnv(undefined)).toBeUndefined();
    expect(parseIosLaunchModeEnv("")).toBeUndefined();
    expect(parseIosLaunchModeEnv("   ")).toBeUndefined();
  });

  it("treats an unrecognized value as no pin rather than a surprise mode", () => {
    expect(parseIosLaunchModeEnv("prod")).toBeUndefined();
    expect(parseIosLaunchModeEnv("jit")).toBeUndefined();
  });
});

describe("resolveIosLaunchMode precedence", () => {
  it("lets an explicit mode beat both the debug flag and the env pin", () => {
    expect(
      resolveIosLaunchMode({
        explicitMode: "profile",
        explicitDebug: true,
        envMode: "release",
      })
    ).toBe("profile");
  });

  it("lets the legacy debug flag beat the env pin", () => {
    expect(resolveIosLaunchMode({ explicitDebug: true, envMode: "release" })).toBe(
      "debug"
    );
    // false keeps the meaning it already had on iOS and Tizen (resolveBuildMode):
    // release, NOT Android's profile.
    expect(resolveIosLaunchMode({ explicitDebug: false, envMode: "profile" })).toBe(
      "release"
    );
  });

  it("uses the env pin when no tool arg selects a mode", () => {
    expect(resolveIosLaunchMode({ envMode: "profile" })).toBe("profile");
    expect(resolveIosLaunchMode({ envMode: "release" })).toBe("release");
  });

  it("defaults to debug when nothing selects a mode", () => {
    expect(resolveIosLaunchMode({})).toBe("debug");
    expect(
      resolveIosLaunchMode({ explicitMode: undefined, explicitDebug: undefined })
    ).toBe("debug");
  });
});

describe("iosLaunchModeCaveat", () => {
  it("has nothing to warn about for a debug launch", () => {
    expect(iosLaunchModeCaveat("debug")).toBeNull();
  });

  it("tells a profile caller the URI is real but Marionette is not", () => {
    const caveat = iosLaunchModeCaveat("profile");
    expect(caveat).toContain("kDebugMode");
    // The distinction that stops a caller debugging a URI that is fine.
    expect(caveat).toMatch(/URI is real/i);
    expect(caveat).toMatch(/connect succeeds/i);
  });

  it("tells a release caller there is no VM service at all", () => {
    const caveat = iosLaunchModeCaveat("release");
    expect(caveat).toMatch(/no Dart VM service/i);
    expect(caveat).toMatch(/not a launch failure/i);
  });
});

describe("the iOS launch-mode pin reaches the adapter", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-launch-mode-"));
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: app\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    FLUTTER_DEVICE_LOG_DISABLE: "1",
    ...extra,
  });

  it("reads FLUTTER_DEVICE_IOS_LAUNCH_MODE into the iOS settings only", () => {
    const config = resolveConfig({
      cwd: dir,
      env: envWith({ FLUTTER_DEVICE_IOS_LAUNCH_MODE: " Profile " }),
    });
    expect(config.platforms.ios.iosLaunchMode).toBe("profile");
    expect(config.platforms.android.iosLaunchMode).toBeUndefined();
  });

  it("falls back to the config file's iosLaunchMode, env winning over it", () => {
    fs.writeFileSync(
      path.join(dir, "flutter-device.config.json"),
      JSON.stringify({ platforms: { ios: { iosLaunchMode: "release" } } })
    );
    expect(
      resolveConfig({ cwd: dir, env: envWith({}) }).platforms.ios.iosLaunchMode
    ).toBe("release");
    expect(
      resolveConfig({
        cwd: dir,
        env: envWith({ FLUTTER_DEVICE_IOS_LAUNCH_MODE: "profile" }),
      }).platforms.ios.iosLaunchMode
    ).toBe("profile");
  });

  it("hands the resolved pin to the IosAdapter the runtime constructs", () => {
    const { registry } = buildRuntime({
      cwd: dir,
      env: envWith({ FLUTTER_DEVICE_IOS_LAUNCH_MODE: "profile" }),
    });
    const adapter = registry.resolve("ios") as unknown as {
      config: { launchMode?: string };
    };
    expect(adapter.config.launchMode).toBe("profile");
  });
});
