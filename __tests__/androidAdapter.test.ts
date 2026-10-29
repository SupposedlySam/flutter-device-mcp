import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";
import { androidAppTree, removeAndroidTrees } from "./support/androidTree.js";

// Mock the shell layer so we can assert exactly which adb/flutter commands the
// AndroidAdapter issues, without spawning real processes. ESM mocking requires
// unstable_mockModule + dynamic import (same pattern as iosAdapter.test.ts).
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  runTizenCli: jest.fn(),
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
}));

// Mock the neutral launch core to assert what the AndroidAdapter feeds INTO it.
const neutralLaunchAndCaptureUri =
  jest.fn<
    (
      command: string,
      cwd: string,
      timeoutMs: number,
      failureSignatures: RegExp[],
      controlFifoPath?: string
    ) => Promise<unknown>
  >();

// allocateControlChannel is called by the Android launch to mint the control
// channel that flutter_hot_reload/flutter_hot_restart write `r`/`R` to: the
// durable FIFO plus the pty bridge that carries it into flutter's terminal.
// Stubbed to deterministic values so tests can assert both are threaded into the
// launch command AND that the FIFO path reaches the neutral core (which records
// it on the launch).
const ANDROID_FIFO = "/tmp/flutter-device-mcp-control-android.fifo";
const ANDROID_BRIDGE = {
  python: "/usr/bin/python3",
  script: "/pkg/scripts/pty-control-forward.py",
};
const ANDROID_CHANNEL = { fifoPath: ANDROID_FIFO, forwarder: ANDROID_BRIDGE };
const allocateControlChannel = jest.fn<
  () => { fifoPath: string; forwarder: { python: string; script: string } } | undefined
>();

jest.unstable_mockModule("../src/launchCapture.js", () => ({
  launchAndCaptureUri: neutralLaunchAndCaptureUri,
  isLaunchFailure: (o: { failed?: boolean }) => o?.failed === true,
  allocateControlChannel,
  // buildPtyCaptureCommand is pure; the adapter's buildAndroidPtyLaunchCommand
  // delegates to it, so the mocked module must still expose it. Use the ONE
  // shared stand-in (pinned byte-for-byte to the real helper in
  // launchCapture.test.ts) rather than a per-file copy.
  buildPtyCaptureCommand: mockBuildPtyCaptureCommand,
}));

// The record path spawns its recorder for real; stub the runner so a unit test
// can never fire `adb shell screenrecord` at a developer's attached device.
const runTimedRecorder =
  jest.fn<() => Promise<{ ok: boolean; output: string }>>();

jest.unstable_mockModule("../src/recordingRun.js", () => ({
  runTimedRecorder,
  runScreenshotBurst: jest.fn(),
  convertVideoToGif: jest.fn(),
  cleanupDir: jest.fn(),
  runSequential: jest.fn(),
}));

// The adapter reads the launch registry at its DEFAULT path — a real file on
// this developer's machine, holding the record of any live session. A test must
// neither read nor write it, so the module is stubbed and the pid injected.
const findLaunch = jest.fn<(platform: string, device?: string) => unknown>();

jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  findLaunch,
  recordLaunch: jest.fn(),
  readRecords: jest.fn(() => []),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  defaultRegistryPath: () => "/tmp/never-used-by-this-suite.json",
}));

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

const {
  AndroidAdapter,
  buildAndroidPtyLaunchCommand,
  ANDROID_FAILURE_SIGNATURES,
  ANDROID_KEYCODE_HOME,
  androidBuildPackageId,
  DEVICE_IDENTITY_PROBE,
  parseDeviceIdentity,
} = await import("../src/adapters/android.js");
const { UnsupportedInputError } = await import("../src/types.js");
const { findDeployedPackage, recordDeployedPackage } = await import("../src/deployedPackages.js");
const { runKillStale } = await import("../src/killStaleFlow.js");

const SERIAL = "39121FDJH003AB";
const ANDROID_APP_DIR = "/repo/app";
const ANDROID_APP_ID = "com.example.app";

function android(device?: string) {
  // Pin the flutter command so assertions are deterministic regardless of the
  // host's fvm presence.
  return new AndroidAdapter({
    appDir: ANDROID_APP_DIR,
    appId: ANDROID_APP_ID,
    device,
    flutterCommand: "flutter",
    aaptCommand: "aapt2",
  });
}

/** Make discoverDevice resolve to the online Pixel above. */
function mockDiscovery() {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.includes("adb devices")) {
      return {
        ...okResult,
        stdout:
          "List of devices attached\n" +
          `${SERIAL}  device product:panther model:Pixel_7 device:panther transport_id:3\n`,
      };
    }
    return okResult;
  });
}

beforeEach(() => {
  // The pointer stage the adapter's input controller uses is DURABLE (on disk,
  // per developer), so give every test its own state dir — otherwise a position
  // staged by one case would still be staged for the next one.
  process.env.FLUTTER_DEVICE_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "android-adapter-state-")
  );
  runShell.mockReset();
  findLaunch.mockReset();
  findLaunch.mockReturnValue(undefined);
  neutralLaunchAndCaptureUri.mockReset();
  allocateControlChannel.mockReset();
  runShell.mockResolvedValue(okResult);
  neutralLaunchAndCaptureUri.mockResolvedValue({ failed: false });
  // By default the launch mints a full control channel (the on-device happy path).
  allocateControlChannel.mockReturnValue(ANDROID_CHANNEL);
  runTimedRecorder.mockResolvedValue({ ok: true, output: "" });
});

describe("AndroidAdapter identity", () => {
  it("reports the android platform and default applicationId", () => {
    const adapter = android();
    expect(adapter.platform).toBe("android");
    expect(adapter.appId).toBe("com.example.app");
  });

  it("honors an appId override", () => {
    const adapter = new AndroidAdapter(
      { appDir: ANDROID_APP_DIR, appId: "com.example.custom" }
    );
    expect(adapter.appId).toBe("com.example.custom");
  });
});

describe("AndroidAdapter.info", () => {
  it("queries adb version, adb devices, and the flutter Android toolchain", async () => {
    await android().info();
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("adb version");
    expect(cmd).toContain("adb devices -l");
    expect(cmd).toContain("flutter doctor");
  });
});

describe("AndroidAdapter.build", () => {
  it("builds a DEBUG apk by default (coherent with the debug deploy launch) and parses the apk path", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      combined: "Built build/app/outputs/flutter-apk/app-debug.apk (18.4MB)",
    });
    const build = await android().build({});
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("flutter build apk --debug");
    expect(build.artifactPath).toBe(
      "build/app/outputs/flutter-apk/app-debug.apk"
    );
  });

  it("builds a debug apk when debug is set", async () => {
    await android().build({ debug: true });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("flutter build apk --debug");
  });

  it("builds a profile apk when debug is explicitly false", async () => {
    await android().build({ debug: false });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("flutter build apk --profile");
  });

  it("builds the apk named by an explicit 3-way mode, which outranks debug", async () => {
    await android().build({ mode: "release", debug: true });
    expect(runShell.mock.calls[0][0]).toBe("flutter build apk --release");

    runShell.mockClear();
    // release is unreachable via the debug boolean; mode is the only way there.
    await android().build({ mode: "profile" });
    expect(runShell.mock.calls[0][0]).toBe("flutter build apk --profile");
  });

  it("honors a launchMode env pin (profile) when debug is omitted", async () => {
    const adapter = new AndroidAdapter(
      {
        appDir: ANDROID_APP_DIR,
        appId: ANDROID_APP_ID,
        flutterCommand: "flutter",
        launchMode: "profile",
      }
    );
    await adapter.build({});
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("flutter build apk --profile");
  });

  it("lets an explicit debug arg override the launchMode env pin", async () => {
    const adapter = new AndroidAdapter(
      {
        appDir: ANDROID_APP_DIR,
        appId: ANDROID_APP_ID,
        flutterCommand: "flutter",
        launchMode: "release",
      }
    );
    await adapter.build({ debug: true });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("flutter build apk --debug");
  });

  it("short-circuits to a no-op success when skip_flutter is set", async () => {
    const build = await android().build({ skip_flutter: true });
    expect(runShell).not.toHaveBeenCalled();
    expect(build.result.success).toBe(true);
  });

  it("flags enospc on the insufficient-storage signature", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      combined: "INSTALL_FAILED_INSUFFICIENT_STORAGE",
    });
    const build = await android().build({});
    expect(build.enospc).toBe(true);
  });
});

describe("AndroidAdapter.discoverDevice", () => {
  it("resolves the online device from `adb devices -l`", async () => {
    mockDiscovery();
    const r = await android().discoverDevice();
    expect(runShell).toHaveBeenCalledWith("adb devices -l", {
      timeoutMs: 15000,
    });
    expect(r.target).toBe(SERIAL);
  });

  it("throws when no device is listed", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      stdout: "List of devices attached\n",
    });
    await expect(android().discoverDevice()).rejects.toThrow(
      /No Android device/
    );
  });

  it("distinguishes a missing adb from 'no devices' (command-not-found)", async () => {
    runShell.mockResolvedValue({
      code: 127,
      stdout: "",
      stderr: "sh: adb: command not found",
      combined: "sh: adb: command not found",
      success: false,
      timedOut: false,
    });
    await expect(android().discoverDevice()).rejects.toThrow(
      /adb not found.*PATH/is
    );
  });

  it("distinguishes a missing adb from 'no devices' (spawn failure, code null)", async () => {
    runShell.mockResolvedValue({
      code: null,
      stdout: "",
      stderr: "spawn adb ENOENT",
      combined: "spawn adb ENOENT",
      success: false,
      timedOut: false,
    });
    await expect(android().discoverDevice()).rejects.toThrow(/adb not found/i);
  });
});

describe("AndroidAdapter.launchAndCaptureUri (deploy = flutter run)", () => {
  it("feeds the neutral core the pty-wrapped `flutter run --debug -d <serial>` + Android signatures + appDir", async () => {
    await android().launchAndCaptureUri(SERIAL, 4242);
    expect(neutralLaunchAndCaptureUri).toHaveBeenCalledTimes(1);
    const [command, cwd, timeoutMs, failureSignatures] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    expect(cwd).toBe("/repo/app");
    // A launch with a control channel gets its pty from the FIFO→pty bridge
    // rather than `script` (which cannot take a FIFO as its own stdin).
    expect(command).toContain(ANDROID_BRIDGE.script);
    expect(command).toContain("flutter run --debug -d");
    expect(command).toContain(SERIAL);
    // No --no-build: flutter run does the apk install itself on Android.
    expect(command).not.toContain("--no-build");
    expect(timeoutMs).toBe(4242);
    expect(failureSignatures).toBe(ANDROID_FAILURE_SIGNATURES);
  });

  it("allocates a control channel and threads it into BOTH the launch command and the neutral core (so hot_reload/hot_restart find a channel)", async () => {
    await android().launchAndCaptureUri(SERIAL, 4242);
    // The launch mints exactly one control channel.
    expect(allocateControlChannel).toHaveBeenCalledTimes(1);
    const [command, , , , controlFifoPath] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    // The neutral core receives the FIFO path as its 5th arg — this is what gets
    // persisted onto the LaunchRecord (controlFifoPath) so a later
    // flutter_hot_reload (`r`) / flutter_hot_restart (`R`) resolves it.
    expect(controlFifoPath).toBe(ANDROID_FIFO);
    // The launch command runs the runner through the bridge, fed by the SAME
    // FIFO — the pty is what lets flutter read `r`/`R` at all.
    expect(command).toContain(ANDROID_FIFO);
    expect(command).toContain(ANDROID_BRIDGE.script);
  });

  it("proceeds with no control channel when it cannot be allocated (undefined threads through, launch still happens)", async () => {
    allocateControlChannel.mockReturnValue(undefined);
    await android().launchAndCaptureUri(SERIAL, 4242);
    expect(neutralLaunchAndCaptureUri).toHaveBeenCalledTimes(1);
    const [command, , , , controlFifoPath] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    expect(controlFifoPath).toBeUndefined();
    // No FIFO wired into the command, but the flutter run launch still composes.
    expect(command).not.toContain(ANDROID_FIFO);
    expect(command).toContain("flutter run --debug -d");
  });

  it("defaults to a --debug launch (no debug requested) so Marionette can attach", async () => {
    await android().launchAndCaptureUri(SERIAL, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("flutter run --debug -d");
    expect(command).not.toContain("--profile");
  });

  it("launches --debug when the deploy recorded debug:true", async () => {
    const adapter = android();
    // The deploy path calls install (recording the mode) BEFORE launch.
    await adapter.install(SERIAL, { noLaunch: true, debug: true });
    await adapter.launchAndCaptureUri(SERIAL, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("flutter run --debug -d");
    expect(command).not.toContain("--profile");
  });

  it("launches --profile when a deploy records debug:false (explicit non-debug request)", async () => {
    const adapter = android();
    await adapter.install(SERIAL, { noLaunch: true, debug: false });
    await adapter.launchAndCaptureUri(SERIAL, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("flutter run --profile -d");
    expect(command).not.toContain("--debug");
  });

  it("uses the launchMode env pin when a deploy passes no explicit debug", async () => {
    const adapter = new AndroidAdapter(
      {
        appDir: ANDROID_APP_DIR,
        appId: ANDROID_APP_ID,
        flutterCommand: "flutter",
        launchMode: "profile",
      }
    );
    // No explicit debug on install → falls through to the env-pinned mode.
    await adapter.install(SERIAL, { noLaunch: true });
    await adapter.launchAndCaptureUri(SERIAL, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("flutter run --profile -d");
    expect(command).not.toContain("--debug");
  });

  it("uses the env-pinned mode even with no preceding install (seeded in the constructor)", async () => {
    const adapter = new AndroidAdapter(
      {
        appDir: ANDROID_APP_DIR,
        appId: ANDROID_APP_ID,
        flutterCommand: "flutter",
        launchMode: "release",
      }
    );
    await adapter.launchAndCaptureUri(SERIAL, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("flutter run --release -d");
  });
});

/**
 * An app tree whose Android build produces com.example.app, so install() and
 * space recovery can read the package id the way they do in a real checkout.
 */
const ANDROID_TREE = fs.mkdtempSync(path.join(os.tmpdir(), "android-adapter-tree-"));
fs.mkdirSync(path.join(ANDROID_TREE, "android", "app"), { recursive: true });
fs.writeFileSync(
  path.join(ANDROID_TREE, "android", "app", "build.gradle"),
  'android {\n  defaultConfig {\n    applicationId "com.example.app"\n  }\n  buildTypes {\n    debug {\n    }\n  }\n}\n'
);
afterAll(() => fs.rmSync(ANDROID_TREE, { recursive: true, force: true }));

function androidInTree() {
  return new AndroidAdapter(
    { appDir: ANDROID_TREE, appId: ANDROID_APP_ID, flutterCommand: "flutter", aaptCommand: "aapt2" }
  );
}

const PM_QUERY = `adb -s '${SERIAL}' shell 'pm list packages -i com.example.app; echo __pm_exit=$?'`;

describe("AndroidAdapter.install / uninstall", () => {
  it("install checks who installed the build's package, then is a no-op success (flutter run installs at launch)", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      stdout: "package:com.example.app  installer=null\n__pm_exit=0\n",
    });
    const result = await androidInTree().install(SERIAL, { noLaunch: true });
    expect(runShell.mock.calls.map(([c]) => c)).toEqual([PM_QUERY]);
    expect(result.success).toBe(true);
    expect(result.combined).toMatch(/flutter run/i);
  });

  it("install refuses over a Play Store copy, because flutter run would uninstall it", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      stdout: "package:com.example.app  installer=com.android.vending\n__pm_exit=0\n",
    });
    const result = await androidInTree().install(SERIAL, { noLaunch: true });
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/installed by com\.android\.vending, not by adb/);
    expect(result.combined).toMatch(/allow_store_app_removal/);
  });

  it("install refuses when it cannot tell who installed the app", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      success: false,
      code: 1,
      combined: "error: closed",
    });
    const result = await androidInTree().install(SERIAL, { noLaunch: true });
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/Could not tell who installed/);
  });

  it("install refuses when the tree does not say which package the build produces", async () => {
    const result = await android().install(SERIAL, { noLaunch: true });
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/No build\.gradle under/);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("install proceeds over a Play Store copy when allowStoreAppRemoval is set, without asking", async () => {
    const result = await androidInTree().install(SERIAL, {
      noLaunch: true,
      allowStoreAppRemoval: true,
    });
    expect(runShell).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it.each([
    ["refuses", "build-tree", false],
    ["allows", "deployed", true],
  ] as const)(
    "verifyUninstallTarget %s a requested uninstall of an absent package whose id came from %s",
    async (_, appIdSource, ok) => {
      runShell.mockResolvedValue({ ...okResult, stdout: "__pm_exit=0\n" });
      const verdict = await androidInTree().verifyUninstallTarget(SERIAL, {
        purpose: "requested",
        packageId: "com.example.app.dev",
        allowStoreAppRemoval: false,
        appIdSource,
      });
      expect(verdict.ok).toBe(ok);
      if (!verdict.ok) {
        expect(verdict.reason).toMatch(/com\.example\.app\.dev .*not installed/);
      }
    }
  );

  it("uninstall shells out to `adb -s <serial> uninstall <appId>`", async () => {
    await android().uninstall(SERIAL, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe(`adb -s '${SERIAL}' uninstall 'com.example.app'`);
  });
});

describe("androidBuildPackageId", () => {
  it("adds the build type's applicationIdSuffix to the applicationId", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "android-suffix-"));
    try {
      const dir = path.join(tree, "android");
      fs.mkdirSync(path.join(dir, "app"), { recursive: true });
      fs.writeFileSync(path.join(dir, "gradle.properties"), "appPackage=com.example.app\n");
      fs.writeFileSync(
        path.join(dir, "app", "build.gradle"),
        'android {\n  defaultConfig {\n    applicationId project.appPackage\n  }\n  buildTypes {\n    debug {\n      applicationIdSuffix ".dev"\n    }\n    release {\n    }\n  }\n}\n'
      );
      expect(androidBuildPackageId(tree, "debug")).toEqual({ ok: true, packageId: "com.example.app.dev" });
      expect(androidBuildPackageId(tree, "release")).toEqual({ ok: true, packageId: "com.example.app" });
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("gives a profile build the base id when only debug declares a suffix", () => {
    const appDir = androidAppTree("com.example.app", { debug: "dev" });
    expect(androidBuildPackageId(appDir, "profile")).toEqual({
      ok: true,
      packageId: "com.example.app",
    });
  });

  it("gives a profile build the suffix of the app's own profile block", () => {
    const appDir = androidAppTree("com.example.app", { debug: "dev", profile: "prof" });
    expect(androidBuildPackageId(appDir, "profile")).toEqual({
      ok: true,
      packageId: "com.example.app.prof",
    });
  });

  it("refuses to guess when a suffix is declared outside the build type", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "android-suffix-"));
    try {
      const dir = path.join(tree, "android");
      fs.mkdirSync(path.join(dir, "app"), { recursive: true });
      fs.writeFileSync(path.join(dir, "gradle.properties"), "appPackage=com.example.app\n");
      fs.writeFileSync(
        path.join(dir, "app", "build.gradle"),
        'android {\n  defaultConfig {\n    applicationId "com.example.app"\n  }\n  productFlavors {\n    staging {\n      applicationIdSuffix ".staging"\n    }\n  }\n  buildTypes {\n    debug {\n    }\n  }\n}\n'
      );
      expect(androidBuildPackageId(tree, "debug")).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});

/** A host where the built apk is com.example.app and the installed copy came from adb. */
function mockRecoverableHost() {
  runShell.mockImplementation(async (cmd: string) => {
    if (/aapt2'? dump packagename/.test(cmd)) {
      return { ...okResult, stdout: "com.example.app\n" };
    }
    if (cmd.includes("pm list packages -i")) {
      return { ...okResult, stdout: "package:com.example.app  installer=null\n__pm_exit=0\n" };
    }
    return okResult;
  });
}

const SPACE_RECOVERY = {
  purpose: "space-recovery" as const,
  packageId: "com.example.app",
  allowStoreAppRemoval: false,
};

describe("AndroidAdapter ENOSPC recovery (install happens at launch)", () => {
  it("isInstallFailure recognizes the Android storage wordings", () => {
    const adapter = android();
    expect(
      adapter.isInstallFailure!(
        "adb: failed to install app.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]"
      )
    ).toBe(true);
    expect(
      adapter.isInstallFailure!("write failed: No space left on device")
    ).toBe(true);
  });

  it("isInstallFailure does not match a benign progress line", () => {
    expect(
      android().isInstallFailure!(
        "Installing build/app/outputs/flutter-apk/app.apk..."
      )
    ).toBe(false);
  });

  it("recoverLaunchFailure asks for the build's package to be uninstalled on a storage failure, doing nothing itself", async () => {
    const rec = await androidInTree().recoverLaunchFailure(
      SERIAL,
      "adb: failed to install app.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]"
    );
    expect(rec).toEqual({
      action: "uninstall-and-retry",
      packageId: "com.example.app",
      note: expect.stringMatching(/out of storage/),
    });
    expect(runShell).not.toHaveBeenCalled();
  });

  it("recoverLaunchFailure asks for nothing when the tree does not say which package the build produces", async () => {
    const rec = await android().recoverLaunchFailure(SERIAL, "INSTALL_FAILED_INSUFFICIENT_STORAGE");
    expect(rec.action).toBe("none");
  });

  it("recoverLaunchFailure is a no-op for a non-storage launch failure", async () => {
    const rec = await androidInTree().recoverLaunchFailure(
      SERIAL,
      "Gradle task assembleDebug failed with exit code 1"
    );
    expect(rec).toEqual({ action: "none" });
    expect(runShell).not.toHaveBeenCalled();
  });

  it("verifyUninstallTarget refuses when aapt2 cannot be found to confirm the package", async () => {
    const adapter = new AndroidAdapter(
      { appDir: ANDROID_TREE, appId: ANDROID_APP_ID, flutterCommand: "flutter" }
    );
    const env = { ...process.env };
    process.env = { PATH: env.PATH };
    try {
      mockRecoverableHost();
      const verdict = await adapter.verifyUninstallTarget(SERIAL, {
        ...SPACE_RECOVERY,
        buildLog: "INSTALL_FAILED_INSUFFICIENT_STORAGE",
      });
      expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/aapt2 was not found/) });
    } finally {
      process.env = env;
    }
  });

  it("verifyUninstallTarget reads the apk path to check from the failed launch's own output", async () => {
    mockRecoverableHost();
    const verdict = await androidInTree().verifyUninstallTarget(SERIAL, {
      ...SPACE_RECOVERY,
      buildLog:
        "Installing build/app/outputs/flutter-apk/app-profile.apk...\nINSTALL_FAILED_INSUFFICIENT_STORAGE",
    });
    expect(verdict).toEqual({ ok: true });
    expect(runShell).toHaveBeenCalledWith(
      `'aapt2' dump packagename '${ANDROID_TREE}/build/app/outputs/flutter-apk/app-profile.apk'`,
      { timeoutMs: 30000 }
    );
  });

  it("the storage signature stays terminal for the launch poll (fails fast so recovery fires)", () => {
    expect(
      ANDROID_FAILURE_SIGNATURES.some((re) =>
        re.test("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]")
      )
    ).toBe(true);
  });

  it("classifies storage wordings through the install-failure seam too", () => {
    const adapter = android();
    expect(
      adapter.isInstallFailure!("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]")
    ).toBe(true);
    expect(adapter.isInstallFailure!("No space left on device")).toBe(true);
    expect(adapter.isInstallFailure!("some unrelated error")).toBe(false);
  });
});

describe("AndroidAdapter.killStale (device-scoped teardown)", () => {
  // Two Android targets attached at once — the shape that made flutter_deploy
  // unusable: a `pkill -f "flutter run --debug"` aimed at the emulator killed the
  // session on the physical phone, which is indistinguishable by command line.
  const PHONE = "988a1b413950494c49";
  const EMULATOR = "emulator-5554";
  const OTHER_EMULATOR = "emulator-5556";
  const PS_ROWS = [
    `86630     1 /usr/bin/python3 /pkg/scripts/pty-control-forward.py /tmp/c.fifo fvm flutter run --debug -d '${PHONE}'`,
    `86631 86630 fvm flutter run --debug -d ${PHONE}`,
    `86633 86631 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --debug -d ${PHONE}`,
    "86699 86633 /Users/dev/dartaotruntime /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /x/",
    `86701 86633 /Users/dev/adb -s ${PHONE} shell -x logcat -v time`,
    `90010     1 /usr/bin/python3 /pkg/scripts/pty-control-forward.py /tmp/e.fifo fvm flutter run --debug -d '${EMULATOR}'`,
    `90011 90010 fvm flutter run --debug -d ${EMULATOR}`,
    `90013 90011 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --debug -d ${EMULATOR}`,
    "90080 90013 /Users/dev/dartaotruntime /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /x/",
  ];

  const TWO_DEVICE_ADB =
    "List of devices attached\n" +
    `${PHONE}  device product:panther model:Pixel_7 transport_id:3\n` +
    `${EMULATOR}  device product:sdk_gphone64 model:sdk_gphone64_arm64 transport_id:4\n`;

  /** Mock the two ps reads (table + reconciliation) and the device enumeration. */
  function mockHost(opts: { rows?: string[]; adb?: string } = {}) {
    const rows = opts.rows ?? PS_ROWS;
    const psTable = rows.join("\n") + "\n";
    const psPairs =
      rows
        .map((r) => r.trim().split(/\s+/).slice(0, 2).join(" "))
        .join("\n") + "\n";
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith("ps -Awwo pid=,ppid=,command=")) {
        return { ...okResult, stdout: psTable, combined: psTable };
      }
      if (cmd.startsWith("ps -Awwo pid=,ppid=")) {
        return { ...okResult, stdout: psPairs, combined: psPairs };
      }
      if (cmd.includes("adb devices")) {
        return { ...okResult, stdout: opts.adb ?? TWO_DEVICE_ADB };
      }
      return okResult;
    });
  }

  /** The pids the `kill` invocation actually named, exactly. */
  function killedPids(): number[] {
    const kill = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.startsWith("kill "));
    if (!kill) return [];
    return kill
      .replace(/^kill\s+/, "")
      .replace(/2>&1$/, "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .sort((a, b) => a - b);
  }

  it("flutter_kill_stale naming an offline emulator by model kills only that emulator's session", async () => {
    mockHost({
      adb:
        "List of devices attached\n" +
        `${PHONE}  device product:panther model:Pixel_7 transport_id:3\n` +
        `${EMULATOR}  offline product:sdk_gphone64 model:sdk_gphone64_arm64 transport_id:4\n`,
    });
    const result = await runKillStale({
      adapter: android(),
      args: { device_udid: "sdk_gphone64_arm64" },
      store: {
        readRecords: () => [],
        removeControlFifo: () => undefined,
        clearLaunch: () => undefined,
        clearLaunches: () => undefined,
      },
    });
    expect(killedPids()).toEqual([90010, 90011, 90013, 90080]);
    expect(result.scope).toBe(EMULATOR);
  });

  it("kills the EMULATOR's session and leaves the phone's running", async () => {
    mockHost();
    const killed = await android().killStale({
      kind: "device",
      device: EMULATOR,
    });
    expect(killedPids()).toEqual([90010, 90011, 90013, 90080]);
    expect(killed.flutterRun.combined).toContain(
      "Left running, on another device"
    );
  });

  it("kills the PHONE's session and leaves the emulator's running", async () => {
    mockHost();
    await android().killStale({ kind: "device", device: PHONE });
    expect(killedPids()).toEqual([86630, 86631, 86633, 86699, 86701]);
  });

  it("issues NO pkill — a command-line pattern cannot tell the two sessions apart", async () => {
    mockHost();
    await android().killStale({ kind: "device", device: EMULATOR });
    expect(
      runShell.mock.calls.some((c) => (c[0] as string).includes("pkill"))
    ).toBe(false);
  });

  it("treats a UNIQUE model name as the same device (`flutter run -d Pixel_7`)", async () => {
    mockHost({ rows: ["70010     1 fvm flutter run --debug -d Pixel_7"] });
    await android().killStale({ kind: "device", device: PHONE });
    expect(killedPids()).toEqual([70010]);
  });

  it("does NOT treat a model name TWO emulators share as an identity", async () => {
    // Two emulators booted from one AVD image report identical model/product, so
    // a teardown scoped to -5554 would otherwise kill a healthy -5556 session.
    mockHost({
      rows: ["70020     1 fvm flutter run --debug -d sdk_gphone64_arm64"],
      adb:
        "List of devices attached\n" +
        `${EMULATOR}  device product:sdk_gphone64 model:sdk_gphone64_arm64 transport_id:4\n` +
        `${OTHER_EMULATOR}  device product:sdk_gphone64 model:sdk_gphone64_arm64 transport_id:5\n`,
    });
    const killed = await android().killStale({
      kind: "device",
      device: EMULATOR,
    });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterRun.combined).toContain("could not be attributed");
  });

  it("tears down OUR OWN recorded session even when its argv names no device", async () => {
    // The registry knows the pid this MCP launched for the device; a session
    // with no `-d` and no adb child is otherwise unattributable on a two-device
    // host, and the deploy would proceed into a held lock.
    findLaunch.mockReturnValue({
      platform: "android",
      device: EMULATOR,
      vmServiceUriWs: "ws://127.0.0.1:1/ws",
      pid: 70030,
      recordedAt: 1,
    });
    mockHost({ rows: ["70030     1 fvm flutter run --debug"] });
    await android().killStale({ kind: "device", device: EMULATOR });
    expect(killedPids()).toEqual([70030]);
    expect(findLaunch).toHaveBeenCalledWith("android", EMULATOR);
  });

  it("does not attribute a recorded pid from ANOTHER device to this one", async () => {
    // findLaunch is keyed by platform+device; asking for the emulator must not
    // return (or kill) the phone's recorded session.
    findLaunch.mockReturnValue(undefined);
    mockHost({ rows: ["70040     1 fvm flutter run --debug"] });
    const killed = await android().killStale({
      kind: "device",
      device: EMULATOR,
    });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterRun.combined).toContain("could not be attributed");
  });

  it("reports a no-match as an outcome, not a failure, and signals nothing", async () => {
    mockHost({
      rows: [
        "11668 10348 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot daemon",
      ],
    });
    const killed = await android().killStale({
      kind: "device",
      device: EMULATOR,
    });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterRun.code).toBe(1);
    expect(killed.flutterRun.combined).toContain("No launch driver found");
  });

  it("kills BOTH devices' sessions only for an explicit all-devices scope", async () => {
    mockHost();
    await android().killStale({ kind: "all-devices" });
    expect(killedPids()).toEqual([
      86630, 86631, 86633, 86699, 86701, 90010, 90011, 90013, 90080,
    ]);
  });

  it("sweeps an ORPHANED compiler only under the all-devices hammer", async () => {
    // The old host-wide `pkill -f frontend_server` took these; a device-scoped
    // teardown must not (a compiler holds no device lock, and it may be the
    // IDE's), so the hammer is the one mode that keeps that behavior.
    const rows = [
      `90011     1 fvm flutter run --debug -d ${EMULATOR}`,
      "11670 10348 /Users/dev/dartaotruntime /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /x/",
    ];
    mockHost({ rows });
    await android().killStale({ kind: "device", device: EMULATOR });
    expect(killedPids()).toEqual([90011]);

    runShell.mockReset();
    mockHost({ rows });
    await android().killStale({ kind: "all-devices" });
    expect(killedPids()).toEqual([11670, 90011]);
  });

  it("declares that its teardown cannot be confined without a device", () => {
    expect(android().killStaleScope).toBe("device");
  });
});

/** A tree whose debug build type adds `.dev`, as a checkout that keeps dev builds apart from the store app does. */
let devSuffixTree: string;
beforeAll(() => {
  devSuffixTree = androidAppTree("com.example.app", { debug: "dev" });
});
afterAll(removeAndroidTrees);

function androidWithDevSuffix(
  launchMode?: "debug" | "profile" | "release",
  checkoutNamed?: boolean
) {
  return new AndroidAdapter({
    appDir: devSuffixTree,
    appId: ANDROID_APP_ID,
    flutterCommand: "flutter",
    aaptCommand: "aapt2",
    launchMode,
    checkoutNamed,
  });
}

function pmReply(packageId: string, installer: string) {
  return { ...okResult, stdout: `package:${packageId}  installer=${installer}\n__pm_exit=0\n` };
}

describe("parseDeviceIdentity", () => {
  it("names an emulator by its AVD, since every emulator shares one ro.serialno", () => {
    expect(parseDeviceIdentity("avd=Pixel_7_API_34\nserialno=EMULATOR35X1X11X0\n")).toBe(
      "avd:Pixel_7_API_34"
    );
  });

  it("names real hardware by ro.serialno", () => {
    expect(parseDeviceIdentity("avd=\nserialno=39121FDJH003AB\n")).toBe("serialno:39121FDJH003AB");
  });

  it("names nothing when the device printed neither", () => {
    expect(parseDeviceIdentity("avd=\nserialno=\n")).toBeUndefined();
  });
});

describe("AndroidAdapter.resolveAppId (the package every verb acts on)", () => {
  const PM_BASE = `adb -s '${SERIAL}' shell 'pm list packages -i com.example.app; echo __pm_exit=$?'`;
  const IDENTITY = `adb -s '${SERIAL}' shell '${DEVICE_IDENTITY_PROBE}'`;
  const PHONE_IDENTITY = `serialno:${SERIAL}`;

  /**
   * The device: what `pm` lists (filtered by substring, as pm does), and what it
   * says it is. `listing: "fails"` makes every pm call fail.
   */
  function device(
    packages: string[],
    opts: { identity?: string; listing?: "fails"; aapt?: string } = {}
  ) {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd === IDENTITY) return { ...okResult, stdout: opts.identity ?? `avd=\nserialno=${SERIAL}\n` };
      const pm = cmd.match(/pm list packages -i (\S+);/);
      if (pm) {
        if (opts.listing === "fails") {
          return { ...okResult, success: false, code: 1, combined: "error: device offline" };
        }
        const lines = packages.filter((line) => line.match(/^package:(\S+)/)![1].includes(pm[1]));
        return { ...okResult, stdout: `${[...lines, "__pm_exit=0"].join("\n")}\n` };
      }
      if (/aapt2'? dump packagename/.test(cmd)) {
        return opts.aapt === undefined
          ? { ...okResult, success: false, code: 1, combined: "ERROR: bad apk" }
          : { ...okResult, stdout: `${opts.aapt}\n` };
      }
      return okResult;
    });
  }
  const pmLists = (...lines: string[]) => device(lines);

  it("names the package the debug build produces, suffix included, as a guess from the tree", async () => {
    pmLists();
    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app.dev",
      source: "build-tree",
    });
  });

  it("follows the launch mode, so a release build resolves without the debug suffix", async () => {
    pmLists();
    await expect(androidWithDevSuffix("release").resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app",
      source: "build-tree",
    });
  });

  it("prefers the package deploy recorded on that device while the device and the package are still there", async () => {
    recordDeployedPackage({
      platform: "android",
      device: SERIAL,
      identity: PHONE_IDENTITY,
      packageId: "com.example.app.profiled",
    });
    pmLists(
      "package:com.example.app.profiled  installer=null",
      "package:com.example.app.dev  installer=null"
    );
    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app.profiled",
      source: "deployed",
    });
  });

  it("drops a record whose package is gone and names what the device holds instead", async () => {
    recordDeployedPackage({
      platform: "android",
      device: SERIAL,
      identity: PHONE_IDENTITY,
      packageId: "com.example.app.dev",
    });
    pmLists("package:com.example.app  installer=null");

    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app",
      source: "device",
    });
    expect(findDeployedPackage("android", SERIAL)).toBeUndefined();
  });

  it("refuses when it cannot confirm the recorded package is still installed", async () => {
    recordDeployedPackage({
      platform: "android",
      device: SERIAL,
      identity: PHONE_IDENTITY,
      packageId: "com.example.app.dev",
    });
    device([], { listing: "fails" });

    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(
        /Could not confirm com\.example\.app\.dev, which flutter_deploy recorded installing on 39121FDJH003AB, is still installed/
      ),
    });
  });

  it("ignores a record made on another device that answered to the same serial", async () => {
    recordDeployedPackage({
      platform: "android",
      device: SERIAL,
      identity: "avd:Pixel_7_API_34",
      packageId: "com.example.app.dev",
    });
    device(
      ["package:com.example.app.dev  installer=null", "package:com.example.app  installer=null"],
      { identity: "avd=Medium_Phone_API_35\nserialno=EMULATOR35X1X11X0\n" }
    );

    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/several adb installs of com\.example\.app .*recorded none of them/),
    });
  });

  it("ignores a record written before records carried the device's identity", async () => {
    recordDeployedPackage({ platform: "android", device: SERIAL, packageId: "com.example.app.dev" });
    pmLists("package:com.example.app  installer=null");

    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app",
      source: "device",
    });
  });

  it("ignores a record without an identity on a device that cannot say what it is either", async () => {
    recordDeployedPackage({ platform: "android", device: SERIAL, packageId: "com.example.app.dev" });
    device(["package:com.example.app  installer=null", "package:com.example.app.dev  installer=null"], {
      identity: "avd=\nserialno=\n",
    });

    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("flutter_deploy recorded none of them"),
    });
  });

  it("refuses rather than guess from the tree when pm cannot list the device's installs", async () => {
    device([], { listing: "fails" });

    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(
        /Could not list the installs of com\.example\.app on 39121FDJH003AB \(error: device offline\)/
      ),
    });
  });

  it("with no record, names the one adb install of the app on the device over the tree's guess", async () => {
    pmLists(
      "package:com.example.app  installer=com.android.vending",
      "package:com.example.app.dev  installer=null"
    );
    await expect(androidWithDevSuffix("release").resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app.dev",
      source: "device",
    });
  });

  it("with several adb installs, picks the one a named app dir builds and says it was a pick", async () => {
    pmLists(
      "package:com.example.app  installer=null",
      "package:com.example.app.dev  installer=com.android.shell"
    );
    await expect(androidWithDevSuffix(undefined, true).resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app.dev",
      source: "build-tree",
      note: expect.stringMatching(
        /several adb installs of com\.example\.app \(com\.example\.app, com\.example\.app\.dev\).*com\.example\.app\.dev was picked because it is what the build in/
      ),
    });
  });

  it("with several adb installs, refuses to let a derived app dir pick among them", async () => {
    pmLists(
      "package:com.example.app  installer=null",
      "package:com.example.app.dev  installer=com.android.shell"
    );
    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(
        /builds com\.example\.app\.dev, but it was not named .*Pass app_dir naming the checkout that deployed/
      ),
    });
  });

  it("refuses when several adb installs exist and none is what this checkout builds", async () => {
    pmLists(
      "package:com.example.app.qa  installer=null",
      "package:com.example.app.staging  installer=null"
    );
    const resolution = await androidWithDevSuffix().resolveAppId(SERIAL);
    expect(resolution).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /several adb installs of com\.example\.app \(com\.example\.app\.qa, com\.example\.app\.staging\)/
      ),
    });
  });

  it("refuses rather than fall back to the configured id when the tree cannot be read", async () => {
    pmLists();
    const resolution = await android().resolveAppId(SERIAL);
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).toMatch(
      /cannot be named, so nothing was done/
    );
  });

  /** A launch whose log names the apk it installed, as flutter run prints it. */
  function launchLogging(apk: string) {
    const logPath = path.join(process.env.FLUTTER_DEVICE_STATE_DIR!, "launch.log");
    fs.writeFileSync(logPath, `Installing ${apk}...\n`);
    neutralLaunchAndCaptureUri.mockResolvedValue({
      failed: false,
      vmServiceUriWs: "ws://127.0.0.1:1/x/ws",
      logPath,
    });
  }

  it("records the package read from the installed apk, and who the device is, for later verbs", async () => {
    launchLogging("build/app/outputs/flutter-apk/app-profile.apk");
    device(["package:com.example.app.fromapk  installer=null"], { aapt: "com.example.app.fromapk" });

    await androidWithDevSuffix().launchAndCaptureUri(SERIAL, 1000);

    expect(runShell).toHaveBeenCalledWith(
      `'aapt2' dump packagename '${devSuffixTree}/build/app/outputs/flutter-apk/app-profile.apk'`,
      { timeoutMs: 30000 }
    );
    expect(findDeployedPackage("android", SERIAL)).toMatchObject({
      packageId: "com.example.app.fromapk",
      identity: PHONE_IDENTITY,
    });
    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app.fromapk",
      source: "deployed",
    });
  });

  it("records nothing when aapt2 cannot read the installed apk", async () => {
    launchLogging("build/app/outputs/flutter-apk/app-debug.apk");
    device([]);

    await androidWithDevSuffix().launchAndCaptureUri(SERIAL, 1000);

    expect(findDeployedPackage("android", SERIAL)).toBeUndefined();
  });

  it("clears the device's earlier record when aapt2 cannot read the apk this launch installed", async () => {
    recordDeployedPackage({
      platform: "android",
      device: SERIAL,
      identity: PHONE_IDENTITY,
      packageId: "com.example.app.profiled",
    });
    launchLogging("build/app/outputs/flutter-apk/app-debug.apk");
    device(["package:com.example.app.profiled  installer=null"]);

    await androidWithDevSuffix().launchAndCaptureUri(SERIAL, 1000);

    expect(findDeployedPackage("android", SERIAL)).toBeUndefined();
    await expect(androidWithDevSuffix().resolveAppId(SERIAL)).resolves.toEqual({
      ok: true,
      appId: "com.example.app.profiled",
      source: "device",
    });
  });

  it("records nothing, and clears the earlier record, when the device does not say what it is", async () => {
    recordDeployedPackage({
      platform: "android",
      device: SERIAL,
      identity: PHONE_IDENTITY,
      packageId: "com.example.app.profiled",
    });
    launchLogging("build/app/outputs/flutter-apk/app-debug.apk");
    device([], { aapt: "com.example.app.dev", identity: "avd=\nserialno=\n" });

    await androidWithDevSuffix().launchAndCaptureUri(SERIAL, 1000);

    expect(findDeployedPackage("android", SERIAL)).toBeUndefined();
  });
});

describe("AndroidAdapter.lifecycle (OS-level, mobile capability, adb)", () => {
  const PM_DEV = `adb -s '${SERIAL}' shell 'pm list packages -i com.example.app.dev; echo __pm_exit=$?'`;

  const check = (
    appId: string,
    overrides: Partial<Parameters<InstanceType<typeof AndroidAdapter>["verifyLifecycleTarget"]>[1]> = {}
  ) => ({
    verb: "terminate" as const,
    appId,
    appIdSource: "deployed" as const,
    allowStoreApp: false,
    ...overrides,
  });

  it("lets a verb proceed on a copy adb installed, after asking only who installed it", async () => {
    runShell.mockResolvedValueOnce(pmReply("com.example.app.dev", "null"));
    await expect(
      android().verifyLifecycleTarget(SERIAL, check("com.example.app.dev"))
    ).resolves.toEqual({ kind: "proceed" });
    expect(runShell.mock.calls.map(([c]) => c)).toEqual([PM_DEV]);
  });

  it("refuses a Play Store copy and says how to override", async () => {
    runShell.mockResolvedValueOnce(pmReply("com.example.app", "com.android.vending"));
    const verdict = await android().verifyLifecycleTarget(SERIAL, check("com.example.app"));
    expect(verdict).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(
        /com\.example\.app on 39121FDJH003AB was installed by com\.android\.vending, not by adb.*allow_store_app: true/
      ),
    });
  });

  it("lets a verb proceed on a store copy when allowStoreApp is set", async () => {
    runShell.mockResolvedValueOnce(pmReply("com.example.app", "com.android.vending"));
    await expect(
      android().verifyLifecycleTarget(SERIAL, check("com.example.app", { allowStoreApp: true }))
    ).resolves.toEqual({ kind: "proceed" });
  });

  it("refuses when it cannot tell who installed the package", async () => {
    runShell.mockResolvedValueOnce({
      ...okResult,
      success: false,
      code: 1,
      combined: "error: closed",
    });
    const verdict = await android().verifyLifecycleTarget(SERIAL, check("com.example.app"));
    expect(verdict).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/Could not tell who installed com\.example\.app/),
    });
  });

  it("reports nothing to terminate for a recorded package that is no longer installed", async () => {
    runShell.mockResolvedValueOnce({ ...okResult, stdout: "__pm_exit=0\n" });
    await expect(
      android().verifyLifecycleTarget(SERIAL, check("com.example.app.dev"))
    ).resolves.toEqual({
      kind: "nothing-to-do",
      message: "com.example.app.dev is not installed on 39121FDJH003AB; nothing to terminate.",
    });
  });

  it.each(["terminate", "foreground"] as const)(
    "refuses to %s a package id only guessed from the tree when it is not installed",
    async (verb) => {
      runShell.mockResolvedValueOnce({ ...okResult, stdout: "__pm_exit=0\n" });
      const verdict = await android().verifyLifecycleTarget(
        SERIAL,
        check("com.example.app.dev", { verb, appIdSource: "build-tree" })
      );
      expect(verdict).toEqual({
        kind: "refuse",
        reason: expect.stringMatching(
          /com\.example\.app\.dev is not installed on 39121FDJH003AB\. That id is what this checkout's build would produce/
        ),
      });
    }
  );

  it("terminate force-stops the package it is given", async () => {
    const result = await android().lifecycle!.terminate(SERIAL, "com.example.app.dev");
    expect(runShell.mock.calls.map(([c]) => c)).toEqual([
      `adb -s '${SERIAL}' shell am force-stop 'com.example.app.dev'`,
    ]);
    expect(result.success).toBe(true);
  });

  it("background sends KEYCODE_HOME (3) via input keyevent, not killing the app", async () => {
    await android().lifecycle!.background(SERIAL);
    const cmd = runShell.mock.calls[0][0] as string;
    expect(ANDROID_KEYCODE_HOME).toBe(3);
    expect(cmd).toBe(`adb -s '${SERIAL}' shell input keyevent 3`);
    expect(cmd).not.toContain("com.example.app"); // does not target the app pkg
  });

  it("foreground relaunches the package it is given via a monkey LAUNCHER intent", async () => {
    const result = await android().lifecycle!.foreground(SERIAL, "com.example.app.dev");
    expect(runShell.mock.calls.map(([c]) => c)).toEqual([
      `adb -s '${SERIAL}' shell monkey -p 'com.example.app.dev' ` +
        `-c android.intent.category.LAUNCHER 1`,
    ]);
    expect(result.success).toBe(true);
  });

  it("refuses to foreground a Galaxy Store copy", async () => {
    runShell.mockResolvedValueOnce(pmReply("com.example.app", "com.sec.android.app.samsungapps"));
    const verdict = await android().verifyLifecycleTarget(
      SERIAL,
      check("com.example.app", { verb: "foreground" })
    );
    expect(verdict).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/installed by com\.sec\.android\.app\.samsungapps/),
    });
  });

  it("refuses to foreground a recorded package that is not installed, pointing at deploy", async () => {
    runShell.mockResolvedValueOnce({ ...okResult, stdout: "__pm_exit=0\n" });
    const verdict = await android().verifyLifecycleTarget(
      SERIAL,
      check("com.example.app.dev", { verb: "foreground" })
    );
    expect(verdict).toEqual({
      kind: "refuse",
      reason: "com.example.app.dev is not installed on 39121FDJH003AB; run flutter_deploy first.",
    });
  });
});

describe("AndroidAdapter input drives the OS-level adb `input` plane", () => {
  it("returns a cached controller so mode + staged position survive tool calls", () => {
    const adapter = android();
    const input = adapter.input();
    expect(input.platform).toBe("android");
    expect(adapter.input()).toBe(input);
  });

  it("sends a D-pad key as an adb keyevent against the resolved serial", async () => {
    mockDiscovery();
    runShell.mockClear();
    mockDiscovery();
    await android().input().key("UP");
    const sent = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("input keyevent"))!;
    // 19 = KEYCODE_DPAD_UP. The serial comes from the SAME resolution deploy
    // and lifecycle use, so a multi-device host stays on one device.
    expect(sent).toBe(`adb -s '${SERIAL}' shell input keyevent 19`);
  });

  it("taps at the staged position (move stages, click sends)", async () => {
    mockDiscovery();
    const input = android().input();
    await input.pointerMove(120, 340);
    // Android has no visible cursor, so `move` sends nothing at all.
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("input tap"))
    ).toBe(false);
    await input.pointerClick();
    const tap = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("input tap"))!;
    expect(tap).toBe(`adb -s '${SERIAL}' shell input tap 120 340`);
  });

  it("refuses a click with no staged position rather than tapping somewhere", async () => {
    mockDiscovery();
    await expect(android().input().pointerClick()).rejects.toThrow(
      /No pointer position staged/
    );
  });

  it("types into the focused field via `input text`", async () => {
    mockDiscovery();
    await android().input().text!("hello world");
    const sent = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("input text"))!;
    // `input text` encodes a space as %s.
    expect(sent).toBe(`adb -s '${SERIAL}' shell input text 'hello%sworld'`);
  });

  it("surfaces a failed adb send as an error instead of reporting sent", async () => {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("adb devices -l")) {
        return {
          ...okResult,
          stdout: `List of devices attached\n${SERIAL}  device\n`,
        };
      }
      return {
        ...okResult,
        success: false,
        code: 1,
        combined: "error: device offline",
      };
    });
    await expect(android().input().key("UP")).rejects.toThrow(
      /adb input send failed/
    );
  });
});

describe("AndroidAdapter --dart-define passthrough", () => {
  it("splices defines into `flutter build apk`", async () => {
    await android().build({ dartDefine: { USE_LOCAL_ENV: "true", HOST: "10.0.2.2" } });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("'--dart-define=HOST=10.0.2.2'");
    expect(cmd).toContain("'--dart-define=USE_LOCAL_ENV=true'");
  });

  it("ALSO splices them into the launch, because the launch is the build", async () => {
    // On Android `flutter run` compiles + installs + launches. Defines applied
    // only to `flutter build apk` would never reach the apk a deploy runs.
    mockDiscovery();
    await android().launchAndCaptureUri(SERIAL, 1000, undefined, {
      USE_LOCAL_ENV: "true",
    });
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("--dart-define=USE_LOCAL_ENV=true");
  });

  it("leaves the command untouched when no defines are given", async () => {
    await android().build({});
    expect(runShell.mock.calls[0][0] as string).not.toContain("--dart-define");
  });
});

describe("AndroidAdapter.geometry (the dpr nothing used to report)", () => {
  /** Layer `wm size` / `wm density` answers over the device-discovery mock. */
  function mockGeometry(size: string, density: string) {
    mockDiscovery();
    const base = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string, opts?: unknown) => {
      if (cmd.includes("wm size")) return { ...okResult, combined: size };
      if (cmd.includes("wm density")) return { ...okResult, combined: density };
      return base(cmd, opts);
    });
  }

  it("derives the dpr from density and reports the device it read", async () => {
    mockGeometry("Physical size: 1440x2960", "Physical density: 640");
    const g = (await android().geometry!())!;
    expect(g.displaySize).toEqual({ width: 1440, height: 2960 });
    expect(g.dpr).toBe(4);
    expect(g.logicalDisplaySize).toEqual({ width: 360, height: 740 });
    // The reading names its device: a multi-device host has several geometries
    // and an unattributed one can silently be the wrong device's.
    expect(g.device).toBe(SERIAL);
  });

  it("prefers the OVERRIDE density — the one actually in force", async () => {
    // Reading only "Physical density" here would give dpr 3.0 instead of 4.0
    // and mis-scale every derived tap by a third.
    mockGeometry(
      "Physical size: 1440x2960",
      "Physical density: 480\nOverride density: 640"
    );
    const g = (await android().geometry!())!;
    expect(g.dpr).toBe(4);
    expect(g.density).toEqual({ physical: 480, override: 640, effective: 640 });
    expect(g.dprSource).toMatch(/Override/);
  });

  it("reads both numbers from ONE resolved device, honoring an explicit udid", async () => {
    mockGeometry("Physical size: 1080x2400", "Physical density: 440");
    await android().geometry!({ udid: SERIAL });
    const shelled = runShell.mock.calls.map(([c]) => c as string);
    expect(shelled).toContain(`adb -s '${SERIAL}' shell wm size`);
    expect(shelled).toContain(`adb -s '${SERIAL}' shell wm density`);
  });

  it("returns undefined rather than half a geometry when a read is unparseable", async () => {
    // A guess wearing a result's clothes is worse than no answer: the caller
    // would scale taps by it.
    mockGeometry("Physical size: 1440x2960", "garbage");
    expect(await android().geometry!()).toBeUndefined();
    mockGeometry("garbage", "Physical density: 640");
    expect(await android().geometry!()).toBeUndefined();
  });
});

describe("buildAndroidPtyLaunchCommand", () => {
  // This adapter owns only the `flutter run --<mode>` inner + the appDir cwd;
  // the cross-platform `script` wrapping is buildPtyCaptureCommand's concern
  // (see its own tests). Assert only this adapter's contribution here.
  it("composes the flutter run --debug (default) inner with the appDir cwd (platform-agnostic)", () => {
    const cmd = buildAndroidPtyLaunchCommand(
      "/repo/app",
      SERIAL,
      "flutter",
      "darwin"
    );
    expect(cmd).toContain("cd '/repo/app'");
    // The inner is passed to `/bin/sh -c` (which escapes its single-quotes), so
    // assert on the unquoted fragment + the serial rather than a quoted inner.
    expect(cmd).toContain("flutter run --debug -d");
    expect(cmd).toContain(SERIAL);
    // Delegates the pty wrap rather than emitting its own `script` branch.
    expect(cmd).toMatch(/\bexec script -q\b/);
  });

  it("delegates the darwin wrap to buildPtyCaptureCommand's `/bin/sh -c` form", () => {
    // BEHAVIOR DELTA (deliberate, visible): the prior BSD form spliced the inner
    // bare — `exec script -q /dev/null flutter run …`. Standardizing on
    // buildPtyCaptureCommand inserts a single `/bin/sh -c '<inner>'` layer and
    // changes nothing else.
    const inner = `flutter run --debug -d '${SERIAL}'`;
    expect(
      buildAndroidPtyLaunchCommand("/repo/app", SERIAL, "flutter", "darwin")
    ).toBe(
      `cd '/repo/app' && exec script -q /dev/null /bin/sh -c '${inner.replace(/'/g, "'\\''")}'`
    );
  });

  it("delegates the linux wrap to buildPtyCaptureCommand's util-linux `-c` form", () => {
    const inner = `flutter run --debug -d '${SERIAL}'`;
    expect(
      buildAndroidPtyLaunchCommand("/repo/app", SERIAL, "flutter", "linux")
    ).toBe(
      `cd '/repo/app' && exec script -q -c '${inner.replace(/'/g, "'\\''")}' /dev/null`
    );
  });

  it("threads an fvm-wrapped flutter command into the pty launch", () => {
    const cmd = buildAndroidPtyLaunchCommand(
      "/repo/app",
      SERIAL,
      "fvm flutter",
      "darwin"
    );
    expect(cmd).toContain("fvm flutter run --debug -d");
    expect(cmd).toContain(SERIAL);
  });

  it("emits --debug when the mode is omitted/debug (drivable by Marionette)", () => {
    expect(
      buildAndroidPtyLaunchCommand("/repo/app", SERIAL, "flutter", "darwin")
    ).toContain("flutter run --debug -d");
    expect(
      buildAndroidPtyLaunchCommand(
        "/repo/app",
        SERIAL,
        "flutter",
        "darwin",
        "debug"
      )
    ).toContain("flutter run --debug -d");
  });

  it("emits --profile when the mode is profile", () => {
    const cmd = buildAndroidPtyLaunchCommand(
      "/repo/app",
      SERIAL,
      "flutter",
      "darwin",
      "profile"
    );
    expect(cmd).toContain("flutter run --profile -d");
    expect(cmd).not.toContain("--debug");
    expect(cmd).toContain(SERIAL);
  });

  it("emits --release when the mode is release", () => {
    const cmd = buildAndroidPtyLaunchCommand(
      "/repo/app",
      SERIAL,
      "flutter",
      "darwin",
      "release"
    );
    expect(cmd).toContain("flutter run --release -d");
    expect(cmd).not.toContain("--debug");
    expect(cmd).not.toContain("--profile");
  });

  it("runs the runner through the FIFO→pty bridge when a control channel is passed", () => {
    const cmd = buildAndroidPtyLaunchCommand(
      "/repo/app",
      SERIAL,
      "flutter",
      "darwin",
      "debug",
      ANDROID_CHANNEL
    );
    // Delegated to buildPtyCaptureCommand: the bridge process owns the pty and
    // reads the FIFO, so the runner's stdin is a TERMINAL and `r`/`R` appended to
    // the FIFO actually reach flutter's key handler. A plain `<&3` redirect (a
    // FIFO on fd 0) does not — flutter never enters single-char mode.
    expect(cmd).toContain(ANDROID_FIFO);
    expect(cmd).toContain(ANDROID_BRIDGE.python);
    expect(cmd).toContain(ANDROID_BRIDGE.script);
    expect(cmd).not.toContain("<&3");
    expect(cmd).toContain("flutter run --debug -d");
  });

  it("omits the bridge when no control channel is passed", () => {
    const cmd = buildAndroidPtyLaunchCommand(
      "/repo/app",
      SERIAL,
      "flutter",
      "darwin",
      "debug"
    );
    expect(cmd).not.toContain(ANDROID_FIFO);
    expect(cmd).not.toContain("<&3");
  });
});

describe("ANDROID_FAILURE_SIGNATURES", () => {
  it("matches terminal Android launch/install failures", () => {
    expect(
      ANDROID_FAILURE_SIGNATURES.some((re) =>
        re.test("adb: failed to install app.apk")
      )
    ).toBe(true);
    expect(
      ANDROID_FAILURE_SIGNATURES.some((re) =>
        re.test("Gradle task assembleProfile failed with exit code 1")
      )
    ).toBe(true);
  });

  it("does not match a benign progress line", () => {
    expect(
      ANDROID_FAILURE_SIGNATURES.some((re) =>
        re.test("Installing build/app/outputs/flutter-apk/app.apk...")
      )
    ).toBe(false);
  });
});

describe("AndroidAdapter per-call device pin (device_udid)", () => {
  const EMULATOR = "emulator-5554";

  /**
   * Both targets ONLINE, the physical device listed first — the shape that makes
   * a pin necessary rather than cosmetic: discovery is online-first, so the
   * physical device wins every call and nothing short of an env pin (a host
   * reload) could redirect it.
   */
  function mockTwoOnlineDevices() {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("adb devices")) {
        return {
          ...okResult,
          stdout:
            "List of devices attached\n" +
            `${SERIAL}  device product:panther model:Pixel_7\n` +
            `${EMULATOR}  device product:sdk_gphone64 model:sdk_gphone64_arm64\n`,
        };
      }
      return okResult;
    });
  }

  it("honours the env pin on the input path when device_udid is passed blank", async () => {
    mockTwoOnlineDevices();
    await android(EMULATOR).input({ udid: "" }).key("HOME");
    expect(runShell).toHaveBeenCalledWith(
      `adb -s '${EMULATOR}' shell input keyevent ${ANDROID_KEYCODE_HOME}`,
      { timeoutMs: 15000 }
    );
  });

  it("records the class of device target asks for, as a deploy would resolve it", async () => {
    mockTwoOnlineDevices();
    await android().record({
      durationSeconds: 1,
      fps: 10,
      format: "mp4",
      target: "simulator",
    } as Parameters<InstanceType<typeof AndroidAdapter>["record"]>[0]);
    const [call] = runTimedRecorder.mock.calls as unknown as [{ command: string }][];
    expect(call[0].command).toContain(`adb -s '${EMULATOR}'`);
  });

  it("selects the named target over the online-first default", async () => {
    mockTwoOnlineDevices();
    const r = await android().discoverDevice({ udid: EMULATOR });
    expect(r.target).toBe(EMULATOR);
    expect(r.source).toBe("pin");
    expect(r.warning).toBeUndefined();
  });

  it("beats the env pin for that one call, leaving the env pin otherwise intact", async () => {
    mockTwoOnlineDevices();
    // FLUTTER_DEVICE_ANDROID_DEVICE names the physical device; the call names
    // the emulator. Precedence is arg > env, and the env pin still applies to
    // the next unpinned call — the pin must not be sticky.
    const adapter = android(SERIAL);
    expect((await adapter.discoverDevice({ udid: EMULATOR })).target).toBe(
      EMULATOR
    );
    expect((await adapter.discoverDevice()).target).toBe(SERIAL);
  });

  it("matches by model name as well as by serial", async () => {
    mockTwoOnlineDevices();
    const r = await android().discoverDevice({ udid: "sdk_gphone64_arm64" });
    expect(r.target).toBe(EMULATOR);
  });

  it("refuses a pin whose target went offline rather than using the online device", async () => {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("adb devices")) {
        return {
          ...okResult,
          stdout:
            "List of devices attached\n" +
            `${SERIAL}  device product:panther model:Pixel_7\n` +
            `${EMULATOR}  offline product:sdk_gphone64 model:sdk_gphone64_arm64\n`,
        };
      }
      return okResult;
    });
    await expect(android().discoverDevice({ udid: EMULATOR })).rejects.toThrow(
      /from the device_udid argument/
    );
  });

  it("screenshot captures the pinned device, not the first online one", async () => {
    mockTwoOnlineDevices();
    await android().screenshot!({
      outPath: "/tmp/shot.png",
      deviceUdid: EMULATOR,
    });
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining(`adb -s '${EMULATOR}' exec-out screencap`),
      expect.anything()
    );
    expect(runShell).not.toHaveBeenCalledWith(
      expect.stringContaining(`adb -s '${SERIAL}' exec-out screencap`),
      expect.anything()
    );
  });

  it("record runs the recorder against the pinned device", async () => {
    mockTwoOnlineDevices();
    await android().record!({
      durationSeconds: 1,
      fps: 2,
      format: "mp4",
      deviceUdid: EMULATOR,
    });
    // The recorder command itself goes to the stubbed runner; the stop and pull
    // are plain shells, and both must address the SAME pinned device — a pull
    // from the other target would return someone else's screen.
    const commands = runShell.mock.calls.map((c) => c[0] as string);
    const deviceCommands = commands.filter((c) => c.startsWith("adb -s"));
    expect(deviceCommands.length).toBeGreaterThan(0);
    for (const cmd of deviceCommands) {
      expect(cmd).toContain(`adb -s '${EMULATOR}'`);
    }
  });

  it("input taps the pinned device at the position staged for THAT device", async () => {
    mockTwoOnlineDevices();
    const adapter = android();
    // Stage and tap against the SAME pinned target: the pin has to change which
    // device the plane addresses without resetting the plane.
    await adapter.input({ udid: EMULATOR }).pointerMove(120, 340);
    await adapter.input({ udid: EMULATOR }).pointerClick();
    expect(runShell).toHaveBeenCalledWith(
      `adb -s '${EMULATOR}' shell input tap 120 340`,
      { timeoutMs: 15000 }
    );

    // The pin lasts exactly one call: the next unpinned send has two online
    // devices to choose from and refuses rather than picking one.
    await expect(adapter.input().key("HOME")).rejects.toThrow(/none was named/);
    expect(runShell).not.toHaveBeenCalledWith(
      expect.stringContaining("keyevent"),
      expect.anything()
    );
  });

  it("does NOT tap one device at a position staged for another", async () => {
    mockTwoOnlineDevices();
    const adapter = android();
    // Staged against one target, then clicked with a pin to the other. The two
    // screens have different coordinate spaces, so carrying the position across
    // would tap a blind, wrong point — refuse and say so.
    await adapter.input({ udid: SERIAL }).pointerMove(120, 340);
    await expect(
      adapter.input({ udid: EMULATOR }).pointerClick()
    ).rejects.toThrow(/No pointer position staged for emulator-5554/);
    const taps = runShell.mock.calls
      .map((c) => c[0] as string)
      .filter((c) => c.includes("input tap"));
    expect(taps).toEqual([]);
  });

  it("a pinned call reuses the cached controller (the selected mode survives)", async () => {
    mockTwoOnlineDevices();
    const adapter = android();
    adapter.input().setMode("pointer");
    // A fresh controller per pinned call would reset this to the "dpad" default.
    expect(adapter.input({ udid: EMULATOR }).mode).toBe("pointer");
  });

  /**
   * The seam `flutter_key`/`flutter_pointer` read to build `deviceWarning` in
   * the JSON they return (see `CommandCore.key`/`CommandCore.pointer`) — and see
   * `deviceUdidProp` in toolRegistry.ts, which promises this on both tools.
   * `adapter.input()` sets up the pin; `inputDeviceWarning()` is what a caller
   * reads back AFTER the send that actually resolved it, since resolution
   * happens lazily.
   */
  describe("inputDeviceWarning (deviceWarning surfaced through the input path)", () => {
    it("pinned device ONLINE -> no warning at all", async () => {
      mockTwoOnlineDevices();
      const adapter = android();
      await adapter.input({ udid: EMULATOR }).key("HOME");
      expect(adapter.inputDeviceWarning()).toBeUndefined();
    });

    it("via flutter_key: pinned device OFFLINE, another online -> refused, naming both, and no key is sent anywhere", async () => {
      mockPinnedEmulatorOffline();
      const adapter = android();
      await expect(adapter.input({ udid: EMULATOR }).key("HOME")).rejects.toThrow(
        new RegExp(`${EMULATOR}.*device_udid.*${SERIAL}`)
      );
      expect(runShell).not.toHaveBeenCalledWith(
        expect.stringContaining("shell input"),
        expect.anything()
      );
    });

    it("via flutter_pointer move: a staged move to an offline pin is refused too", async () => {
      mockPinnedEmulatorOffline();
      const adapter = android();
      await expect(
        adapter.input({ udid: EMULATOR }).pointerMove(10, 20)
      ).rejects.toThrow(new RegExp(EMULATOR));
    });

    it("no per-call pin, stale env pin -> refused, naming the env var", async () => {
      runShell.mockImplementation(async (cmd: string) => {
        if (cmd.includes("adb devices")) {
          return {
            ...okResult,
            stdout:
              "List of devices attached\n" +
              `${SERIAL}  device product:panther model:Pixel_7\n`,
          };
        }
        return okResult;
      });
      // The env pin (constructor `device`) names a serial that never shows up.
      const adapter = android(EMULATOR);
      await expect(adapter.input().key("HOME")).rejects.toThrow(
        /FLUTTER_DEVICE_ANDROID_DEVICE/
      );
      expect(runShell).not.toHaveBeenCalledWith(
        expect.stringContaining("shell input"),
        expect.anything()
      );
    });

    it("no per-call pin, no env pin, one device -> no warning", async () => {
      mockDiscovery();
      const adapter = android();
      await adapter.input().key("HOME");
      expect(adapter.inputDeviceWarning()).toBeUndefined();
    });

    it("a refused call leaves nothing staged, and the next call targets its own pin", async () => {
      mockPinnedEmulatorOffline();
      const adapter = android();
      await expect(
        adapter.input({ udid: EMULATOR }).pointerMove(120, 340)
      ).rejects.toThrow();

      await adapter.input({ udid: SERIAL }).pointerMove(30, 40);
      await adapter.input({ udid: SERIAL }).pointerClick();
      expect(adapter.inputDeviceWarning()).toBeUndefined();
      expect(runShell).toHaveBeenCalledWith(
        `adb -s '${SERIAL}' shell input tap 30 40`,
        { timeoutMs: 15000 }
      );
    });
  });
});

/** The pinned emulator is listed but offline; the Pixel is online. */
function mockPinnedEmulatorOffline() {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.includes("adb devices")) {
      return {
        ...okResult,
        stdout:
          "List of devices attached\n" +
          `${SERIAL}  device product:panther model:Pixel_7\n` +
          `emulator-5554  offline product:sdk_gphone64 model:sdk_gphone64_arm64\n`,
      };
    }
    return okResult;
  });
}
