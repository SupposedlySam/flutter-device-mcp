import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";

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
} = await import("../src/adapters/android.js");
const { UnsupportedInputError } = await import("../src/types.js");

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

describe("AndroidAdapter.install / uninstall", () => {
  it("install is a no-op success (flutter run installs the apk at launch)", async () => {
    const result = await android().install(SERIAL, { noLaunch: true });
    expect(runShell).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.combined).toMatch(/flutter run/i);
  });

  it("uninstall shells out to `adb -s <serial> uninstall <appId>`", async () => {
    await android().uninstall(SERIAL, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe(`adb -s '${SERIAL}' uninstall 'com.example.app'`);
  });
});

describe("AndroidAdapter out-of-storage recovery (fires at LAUNCH, not install)", () => {
  it("the deploy's install-side ENOSPC retry can never fire on Android", async () => {
    // This is WHY the recovery has to live on the launch seam: the deploy
    // retries the INSTALL when install output looks like ENOSPC, but Android's
    // install step never runs an install at all -- `flutter run` does, at launch.
    // A storage-starved device therefore produces a SUCCESSFUL install step.
    const install = await android().install(SERIAL, { noLaunch: true });
    expect(install.success).toBe(true);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("uninstalls to free space and asks for a retry on a storage launch failure", async () => {
    const adapter = android();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    const rec = await adapter.recoverLaunchFailure!(
      SERIAL,
      "adb: failed to install app.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]"
    );
    expect(rec.recovered).toBe(true);
    expect(rec.note).toMatch(/out of storage/i);
    expect(runShell.mock.calls[0][0]).toBe(
      `adb -s '${SERIAL}' uninstall '${ANDROID_APP_ID}'`
    );
  });

  it("recognizes the other two storage wordings adb/the filesystem emit", async () => {
    for (const logTail of [
      "Failure [INSUFFICIENT_STORAGE]",
      "Error: No space left on device",
    ]) {
      const adapter = android();
      runShell.mockClear();
      runShell.mockResolvedValue(okResult);
      const rec = await adapter.recoverLaunchFailure!(SERIAL, logTail);
      expect(rec.recovered).toBe(true);
    }
  });

  it("does NOT retry when the space-freeing uninstall itself fails", async () => {
    // Nothing was freed, so a retry would hit the same wall -- report the real
    // blocker instead of burning the one retry.
    const adapter = android();
    runShell.mockClear();
    runShell.mockResolvedValue({
      ...okResult,
      success: false,
      code: 1,
      combined: "adb: device offline",
    });
    const rec = await adapter.recoverLaunchFailure!(
      SERIAL,
      "INSTALL_FAILED_INSUFFICIENT_STORAGE"
    );
    expect(rec.recovered).toBe(false);
    expect(rec.note).toMatch(/device offline/);
  });

  it("is a no-op for a launch failure that is not about storage", async () => {
    const adapter = android();
    runShell.mockClear();
    const rec = await adapter.recoverLaunchFailure!(
      SERIAL,
      "Gradle task assembleDebug failed with exit code 1"
    );
    expect(rec.recovered).toBe(false);
    // No uninstall on an unrelated failure -- that would destroy app state.
    expect(runShell).not.toHaveBeenCalled();
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

describe("AndroidAdapter.killStale", () => {
  it("pkills BOTH flutter run modes and the dart frontend server", async () => {
    const killed = await android().killStale();
    // Matches both modes this adapter can spawn so a stale DEBUG deploy is also
    // torn down (a --profile-only match would leak a wedged debug session and
    // break the "one deploy at a time" guardrail for debug launches).
    expect(runShell).toHaveBeenCalledWith("pkill -f 'flutter run --profile'", {
      timeoutMs: 10000,
    });
    expect(runShell).toHaveBeenCalledWith("pkill -f 'flutter run --debug'", {
      timeoutMs: 10000,
    });
    expect(runShell).toHaveBeenCalledWith("pkill -f 'frontend_server'", {
      timeoutMs: 10000,
    });
    // Reported under generic keys the server's summarizeKillStale handles.
    expect(killed.flutterRun).toBeDefined();
    expect(killed.flutterRunDebug).toBeDefined();
    expect(killed.frontendServer).toBeDefined();
  });
});

describe("AndroidAdapter.lifecycle (OS-level, mobile capability, adb)", () => {
  it("terminate uses `adb shell am force-stop`", async () => {
    await android().lifecycle!.terminate(SERIAL, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe(
      `adb -s '${SERIAL}' shell am force-stop 'com.example.app'`
    );
  });

  it("background sends KEYCODE_HOME (3) via input keyevent, not killing the app", async () => {
    await android().lifecycle!.background(SERIAL, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(ANDROID_KEYCODE_HOME).toBe(3);
    expect(cmd).toBe(`adb -s '${SERIAL}' shell input keyevent 3`);
    expect(cmd).not.toContain("com.example.app"); // does not target the app pkg
  });

  it("foreground relaunches the package via a monkey LAUNCHER intent", async () => {
    await android().lifecycle!.foreground(SERIAL, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe(
      `adb -s '${SERIAL}' shell monkey -p 'com.example.app' ` +
        `-c android.intent.category.LAUNCHER 1`
    );
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

  /** The physical device online, the emulator listed but OFFLINE. */
  function mockEmulatorOffline() {
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
  }

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

  it("self-heals a pin whose target went offline instead of failing the call", async () => {
    mockEmulatorOffline();
    const r = await android().discoverDevice({ udid: EMULATOR });
    // Same fallback a stale env pin gets — with the warning naming the argument,
    // which is the knob this caller can actually change.
    expect(r.target).toBe(SERIAL);
    expect(r.source).toBe("discovered");
    expect(r.warning).toMatch(/device_udid/);
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

    // The pin lasts exactly one call: the next unpinned send resolves normally.
    await adapter.input().key("HOME");
    expect(runShell).toHaveBeenCalledWith(
      `adb -s '${SERIAL}' shell input keyevent ${ANDROID_KEYCODE_HOME}`,
      { timeoutMs: 15000 }
    );
  });

  it("does NOT tap one device at a position staged for another", async () => {
    mockTwoOnlineDevices();
    const adapter = android();
    // Staged against the default target, then clicked with a pin to the other
    // one. The two screens have different coordinate spaces, so carrying the
    // position across would tap a blind, wrong point — refuse and say so.
    await adapter.input().pointerMove(120, 340);
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

    it("via flutter_key: pinned device OFFLINE, another online -> self-heals AND names both devices", async () => {
      mockEmulatorOffline();
      const adapter = android();
      await adapter.input({ udid: EMULATOR }).key("HOME");
      // Still sent — to the device it healed to, not the one asked for.
      expect(runShell).toHaveBeenCalledWith(
        `adb -s '${SERIAL}' shell input keyevent ${ANDROID_KEYCODE_HOME}`,
        { timeoutMs: 15000 }
      );
      expect(adapter.inputDeviceWarning()).toMatch(/device_udid/);
      expect(adapter.inputDeviceWarning()).toContain(EMULATOR);
      expect(adapter.inputDeviceWarning()).toContain(SERIAL);
    });

    it("via flutter_pointer move: the pin's warning surfaces even though move sends no adb event", async () => {
      mockEmulatorOffline();
      const adapter = android();
      await adapter.input({ udid: EMULATOR }).pointerMove(10, 20);
      // move stages only — no `input` adb command, but the resolver still ran.
      expect(runShell).not.toHaveBeenCalledWith(
        expect.stringContaining("shell input"),
        expect.anything()
      );
      expect(adapter.inputDeviceWarning()).toContain(EMULATOR);
      expect(adapter.inputDeviceWarning()).toContain(SERIAL);
    });

    it("no per-call pin, stale env pin -> the existing env-pin warning still surfaces unchanged", async () => {
      mockDiscovery();
      // The env pin (constructor `device`) names a serial that never shows up.
      const adapter = android(EMULATOR);
      await adapter.input().key("HOME");
      expect(adapter.inputDeviceWarning()).toMatch(
        /FLUTTER_DEVICE_ANDROID_DEVICE/
      );
      expect(adapter.inputDeviceWarning()).not.toMatch(/device_udid/);
    });

    it("no per-call pin, no env pin, one device -> no warning", async () => {
      mockDiscovery();
      const adapter = android();
      await adapter.input().key("HOME");
      expect(adapter.inputDeviceWarning()).toBeUndefined();
    });

    it("clears a previous call's warning even when the new call resolves nothing", async () => {
      // The reset happens in input() itself, not only as a side effect of the
      // next resolve. A verb that returns or throws BEFORE resolving a serial
      // (an unsupported key, a click with nothing staged) would otherwise report
      // the previous call's warning as if it belonged to this one.
      mockEmulatorOffline();
      const adapter = android();
      await adapter.input({ udid: EMULATOR }).key("HOME");
      expect(adapter.inputDeviceWarning()).toContain(EMULATOR);

      adapter.input();
      expect(adapter.inputDeviceWarning()).toBeUndefined();
    });

    it("the pin and the warning reset between calls, but the staged position survives", async () => {
      mockEmulatorOffline();
      const adapter = android();
      // Call 1: pin names the offline emulator — self-heals, warns.
      await adapter.input({ udid: EMULATOR }).pointerMove(120, 340);
      expect(adapter.inputDeviceWarning()).toContain(EMULATOR);

      // Call 2: pin names the online device directly — no reason to warn, and
      // the OLD warning from call 1 must not leak into this clean call.
      await adapter.input({ udid: SERIAL }).pointerClick();
      expect(adapter.inputDeviceWarning()).toBeUndefined();
      // The staged position from call 1 still lands — same cached controller.
      expect(runShell).toHaveBeenCalledWith(
        `adb -s '${SERIAL}' shell input tap 120 340`,
        { timeoutMs: 15000 }
      );
    });
  });
});
