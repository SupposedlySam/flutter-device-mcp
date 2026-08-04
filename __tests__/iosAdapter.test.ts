import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";

// Mock the shell layer so we can assert exactly which xcrun/flutter commands the
// IosAdapter issues, without spawning real processes. ESM mocking requires
// unstable_mockModule + dynamic import (same pattern as adapters.test.ts).
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  runTizenCli: jest.fn(),
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
}));

// Mock the neutral launch core to assert what the IosAdapter feeds INTO it.
const neutralLaunchAndCaptureUri =
  jest.fn<
    (
      command: string,
      cwd: string,
      timeoutMs: number,
      failureSignatures: RegExp[]
    ) => Promise<unknown>
  >();

jest.unstable_mockModule("../src/launchCapture.js", () => ({
  launchAndCaptureUri: neutralLaunchAndCaptureUri,
  isLaunchFailure: (o: { failed?: boolean }) => o?.failed === true,
  // buildPtyCaptureCommand is pure; the adapter's buildIosPtyLaunchCommand
  // delegates to it, so the mocked module must still expose it. Use the ONE
  // shared stand-in (pinned byte-for-byte to the real helper in
  // launchCapture.test.ts) rather than a per-file copy.
  buildPtyCaptureCommand: mockBuildPtyCaptureCommand,
  // allocateControlFifo is called by the iOS launch; stand it in as "no control
  // channel" (undefined) since these tests have no live daemon/FIFO.
  allocateControlFifo: () => undefined,
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
  IosAdapter,
  buildIosPtyLaunchCommand,
  findIosProcessPid,
  IOS_APP_EXECUTABLE_MARKER,
  IOS_FAILURE_SIGNATURES,
  IOS_BACKGROUND_APP_ID,
} = await import("../src/adapters/ios.js");
const { UnsupportedInputError } = await import("../src/types.js");

const IOS_APP_DIR = "/repo/app";
const IOS_APP_ID = "com.example.app";

function ios(device?: string) {
  // Pin the flutter command so assertions are deterministic regardless of the
  // host's fvm presence (the adapter otherwise resolves "fvm flutter" when the
  // app dir is fvm-managed).
  return new IosAdapter({
    appDir: IOS_APP_DIR,
    appId: IOS_APP_ID,
    device,
    flutterCommand: "flutter",
  });
}

// A physical iPhone is addressed by TWO ids: devicectl reports its own UUID,
// flutter reports the ECID. mockDiscovery("device") mirrors that so the flutter
// id (target) and devicectl id (lifecycle) are distinct, matched by name.
const IPHONE_DEVICECTL_ID = "0831CB2E-D597-5C19-9699-6DFA21324AC4";
const IPHONE_FLUTTER_ECID = "00008020-001A2D021AF3002E";

// The pid the app runs under in the fixture below.
const APP_PID = 4231;

/**
 * Realistic `xcrun devicectl device info processes --json-output -` payload:
 * the process list lives under `result.runningProcesses`, each entry carrying
 * an integer `processIdentifier` and an `executable` file URL. There is NO
 * bundle-id field, so the app process is matched by its `/Runner.app/`
 * executable path. Includes system procs + another `.app` so the matcher must
 * pick the RIGHT pid, not just the first process.
 */
const PROCESSES_JSON = JSON.stringify({
  info: { operation: "info", outcome: "success" },
  result: {
    runningProcesses: [
      { processIdentifier: 1, executable: "file:///sbin/launchd" },
      {
        processIdentifier: 318,
        executable:
          "file:///private/var/containers/Bundle/Application/AAAA-BBBB/Preferences.app/Preferences",
      },
      {
        processIdentifier: APP_PID,
        executable:
          "file:///private/var/containers/Bundle/Application/1234-5678/Runner.app/Runner",
      },
      { processIdentifier: 55, executable: "file:///usr/libexec/backboardd" },
    ],
  },
});

/** Make discoverDevice resolve to a simulator or a physical device. */
function mockDiscovery(kind: "simulator" | "device") {
  if (kind === "simulator") {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl list devices --json")) {
        return {
          ...okResult,
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                {
                  udid: "SIM-UDID-1",
                  name: "iPhone 15",
                  state: "Booted",
                  isAvailable: true,
                },
              ],
            },
          }),
        };
      }
      if (cmd.includes("devicectl list devices")) {
        return { ...okResult, stdout: "" };
      }
      if (cmd.includes("devices --machine")) {
        return { ...okResult, stdout: "[]" };
      }
      return okResult;
    });
  } else {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl list devices")) {
        return {
          ...okResult,
          stdout:
            "Name  Host  Identifier  State  Model\n" +
            `My iPhone  h  ${IPHONE_DEVICECTL_ID}  connected  (iPhone11,8)\n`,
        };
      }
      if (cmd.includes("simctl list devices --json")) {
        return { ...okResult, stdout: "{}" };
      }
      if (cmd.includes("devices --machine")) {
        return {
          ...okResult,
          stdout: JSON.stringify([
            {
              id: IPHONE_FLUTTER_ECID,
              name: "My iPhone",
              targetPlatform: "ios",
              emulator: false,
              isSupported: true,
            },
          ]),
        };
      }
      return okResult;
    });
  }
}

beforeEach(() => {
  runShell.mockReset();
  neutralLaunchAndCaptureUri.mockReset();
  runShell.mockResolvedValue(okResult);
  neutralLaunchAndCaptureUri.mockResolvedValue({ failed: false });
});

describe("IosAdapter identity", () => {
  it("reports the ios platform and default bundle id", () => {
    const adapter = ios();
    expect(adapter.platform).toBe("ios");
    expect(adapter.appId).toBe("com.example.app");
  });

  it("honors an appId override", () => {
    const adapter = new IosAdapter(
      { appDir: IOS_APP_DIR, appId: "com.example.custom" }
    );
    expect(adapter.appId).toBe("com.example.custom");
  });
});

describe("IosAdapter.info", () => {
  it("queries flutter, devicectl and simctl without sdb shell", async () => {
    await ios().info();
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("flutter --version");
    expect(cmd).toContain("xcrun devicectl list devices");
    expect(cmd).toContain("xcrun simctl list devices");
  });
});

describe("IosAdapter.build", () => {
  it("builds release ios by default and parses the .app path", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      combined: "Built build/ios/iphoneos/Runner.app (12.3MB)",
    });
    const build = await ios().build({});
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("flutter build ios");
    expect(cmd).toContain("--release");
    expect(cmd).toContain("--no-codesign");
    expect(build.artifactPath).toBe("build/ios/iphoneos/Runner.app");
  });

  it("builds debug for the simulator profile (no codesign flag)", async () => {
    const build = await ios().build({ debug: true, profile: "simulator" });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("flutter build ios --simulator");
    expect(cmd).toContain("--debug");
    expect(cmd).not.toContain("--no-codesign");
    expect(build.launchedDisplay).toBe(false);
  });

  it("short-circuits to a no-op success when skip_flutter is set", async () => {
    const build = await ios().build({ skip_flutter: true });
    expect(runShell).not.toHaveBeenCalled();
    expect(build.result.success).toBe(true);
  });
});

describe("IosAdapter --dart-define passthrough", () => {
  it("splices defines into `flutter build ios`", async () => {
    await ios().build({ dartDefine: { API: "staging" } });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("'--dart-define=API=staging'");
  });

  it("ALSO splices them into the launch, because the full pipeline builds", async () => {
    // iOS deploys via the FULL `flutter run` pipeline (build+sign+install+
    // launch), so the launch is where the app being installed is compiled.
    await ios().launchAndCaptureUri("SIM-UDID-1", 1000, undefined, {
      API: "staging",
    });
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("--dart-define=API=staging");
  });

  it("leaves the command untouched when no defines are given", async () => {
    await ios().build({});
    expect(runShell.mock.calls[0][0] as string).not.toContain("--dart-define");
  });
});

describe("IosAdapter.discoverDevice", () => {
  it("resolves a booted simulator via simctl JSON", async () => {
    mockDiscovery("simulator");
    const r = await ios().discoverDevice();
    expect(r.target).toBe("SIM-UDID-1");
  });

  it("resolves a connected physical device via devicectl", async () => {
    mockDiscovery("device");
    const r = await ios().discoverDevice();
    expect(r.target).toBe("00008020-001A2D021AF3002E");
  });

  it("throws when nothing is connected or booted", async () => {
    runShell.mockResolvedValue({ ...okResult, stdout: "{}" });
    await expect(ios().discoverDevice()).rejects.toThrow(
      /No iOS device or simulator/
    );
  });
});

describe("IosAdapter.discoverDevice validates the SIMULATOR destination", () => {
  // A booted simulator is not necessarily a target the build can use: the
  // Runner scheme lists only a subset as valid destinations, and one that is
  // not listed fails with "Unable to find a destination matching id:<udid>".
  // Realistic UUID-shaped simulator ids. This matters: the destination parser
  // only accepts hex-and-hyphen ids, which is exactly what makes it skip
  // Xcode's `id:dvtdevice-...placeholder` rows. A made-up id like "SIM-UDID-1"
  // is correctly dropped by that rule and would exercise the wrong branch here.
  const BOOTED_SIM = "AAAA1111-1111-1111-1111-111111111111";
  const OTHER_SIM = "BBBB2222-2222-2222-2222-222222222222";

  /** A simulator host with exactly one BOOTED simulator, `BOOTED_SIM`. */
  function mockBootedSim() {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl list devices --json")) {
        return {
          ...okResult,
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                {
                  udid: BOOTED_SIM,
                  name: "iPhone 15",
                  state: "Booted",
                  isAvailable: true,
                },
              ],
            },
          }),
        };
      }
      if (cmd.includes("devicectl list devices")) return { ...okResult, stdout: "" };
      if (cmd.includes("devices --machine")) return { ...okResult, stdout: "[]" };
      return okResult;
    });
  }

  /**
   * Layer a scheme-destination list over the current mock. Passing a list that
   * omits `BOOTED_SIM` reproduces the booted-but-ineligible case.
   */
  function mockScheme(destinationUdids: string[]) {
    const rows = destinationUdids
      .map(
        (id, i) =>
          `{ platform:iOS Simulator, id:${id}, OS:17.5, name:iPhone 1${i} }`
      )
      .join("\n");
    const base = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string, opts?: unknown) => {
      if (cmd.includes("-showdestinations")) {
        return {
          ...okResult,
          combined: `Available destinations for the "Runner" scheme:\n${rows}\n`,
        };
      }
      return base(cmd, opts);
    });
  }

  it("keeps a booted simulator that IS a valid destination, and boots nothing", async () => {
    mockBootedSim();
    mockScheme([BOOTED_SIM, OTHER_SIM]);
    const r = await ios().discoverDevice();
    expect(r.target).toBe(BOOTED_SIM);
    expect(r.warning).toBeUndefined();
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("simctl boot"))
    ).toBe(false);
  });

  it("substitutes a valid destination when the booted sim is ineligible", async () => {
    mockBootedSim();
    mockScheme([OTHER_SIM]); // the BOOTED simulator is NOT listed
    const r = await ios().discoverDevice();
    expect(r.target).toBe(OTHER_SIM);
    // The substitution is surfaced, not silent -- the caller asked for one
    // simulator and is getting another.
    expect(r.warning).toMatch(/not a valid Runner-scheme destination/);
    expect(r.warning).toMatch(BOOTED_SIM);
    // The substitute was not booted, so it has to be booted before use.
    expect(
      runShell.mock.calls.some(([c]) =>
        (c as string).includes(`simctl boot '${OTHER_SIM}'`)
      )
    ).toBe(true);
  });

  it("keeps devicectlId in step with the substituted target", async () => {
    // simctl and flutter share one UUID for a simulator; leaving devicectlId on
    // the OLD udid would send uninstall/lifecycle to a different simulator.
    mockBootedSim();
    mockScheme([OTHER_SIM]);
    const r = (await ios().discoverDevice()) as { devicectlId?: string };
    expect(r.devicectlId).toBe(OTHER_SIM);
  });

  it("leaves the resolution alone when xcodebuild lists no destinations", async () => {
    // Best-effort: refusing to deploy because a VALIDATION step failed would be
    // a worse failure than the one being prevented.
    mockBootedSim();
    mockScheme([]);
    const r = await ios().discoverDevice();
    expect(r.target).toBe(BOOTED_SIM);
    expect(r.warning).toBeUndefined();
  });

  it("ignores the placeholder row Xcode always prints", async () => {
    // `id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-...` is not a simulator; if
    // it were parsed as a destination the booted sim would look ineligible and
    // get substituted for a target that does not exist.
    mockBootedSim();
    const base = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string, opts?: unknown) => {
      if (cmd.includes("-showdestinations")) {
        return {
          ...okResult,
          combined:
            'Available destinations for the "Runner" scheme:\n' +
            "{ platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }\n",
        };
      }
      return base(cmd, opts);
    });
    const r = await ios().discoverDevice();
    expect(r.target).toBe(BOOTED_SIM);
    expect(r.warning).toBeUndefined();
  });

  it("does not run the scheme check for a PHYSICAL device", async () => {
    mockDiscovery("device");
    await ios().discoverDevice();
    expect(
      runShell.mock.calls.some(([c]) =>
        (c as string).includes("-showdestinations")
      )
    ).toBe(false);
  });
});

describe("IosAdapter.launchAndCaptureUri", () => {
  it("feeds the neutral core the pty-wrapped flutter run + iOS signatures + appDir", async () => {
    await ios().launchAndCaptureUri("SIM-UDID-1", 4242);
    expect(neutralLaunchAndCaptureUri).toHaveBeenCalledTimes(1);
    const [command, cwd, timeoutMs, failureSignatures] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    expect(cwd).toBe("/repo/app");
    expect(command).toMatch(/\bscript -q\b/);
    // FULL flutter run pipeline (NOT --no-build): it builds + signs + installs +
    // launches in one shot — the reliable iOS path.
    expect(command).toContain("flutter run --debug");
    expect(command).not.toContain("--no-build");
    expect(command).toContain("SIM-UDID-1");
    expect(timeoutMs).toBe(4242);
    expect(failureSignatures).toBe(IOS_FAILURE_SIGNATURES);
  });
});

describe("IosAdapter.install is now a PREFLIGHT (full flutter run pipeline installs)", () => {
  it("does NOT run a separate `flutter install` — the full pipeline owns install", async () => {
    // The real install happens inside launchAndCaptureUri's `flutter run` (no
    // --no-build). install() only preflights pods/provisioning, never installs.
    await ios().install("SIM-UDID-1", { noLaunch: true });
    const ran = runShell.mock.calls.map(([c]) => c as string);
    expect(ran.some((c) => c.includes("flutter install"))).toBe(false);
  });

  it("uninstall uses simctl after a simulator was resolved", async () => {
    const adapter = ios();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.uninstall("SIM-UDID-1", "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("xcrun simctl uninstall 'SIM-UDID-1' 'com.example.app'");
  });

  it("uninstall uses devicectl after a physical device was resolved", async () => {
    const adapter = ios();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.uninstall(IPHONE_FLUTTER_ECID, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("xcrun devicectl device uninstall app");
    // The flutter id was translated to the devicectl id for devicectl.
    expect(cmd).toContain(IPHONE_DEVICECTL_ID);
    expect(cmd).not.toContain(IPHONE_FLUTTER_ECID);
  });
});

describe("IosAdapter.killStale", () => {
  it("pkills the flutter run driver and the dart frontend server", async () => {
    await ios().killStale();
    expect(runShell).toHaveBeenCalledWith("pkill -f 'flutter run'", {
      timeoutMs: 10000,
    });
    expect(runShell).toHaveBeenCalledWith("pkill -f 'frontend_server'", {
      timeoutMs: 10000,
    });
  });
});

describe("IosAdapter.lifecycle (OS-level, mobile capability)", () => {
  it("terminate uses simctl terminate on a simulator", async () => {
    const adapter = ios();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.lifecycle!.terminate("SIM-UDID-1", "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("xcrun simctl terminate 'SIM-UDID-1' 'com.example.app'");
  });

  it("background foregrounds the neutral Preferences app (does not kill the target)", async () => {
    const adapter = ios();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.lifecycle!.background("SIM-UDID-1", "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain(IOS_BACKGROUND_APP_ID);
    expect(cmd).not.toContain("com.example.app");
  });

  it("foreground relaunches the target bundle id", async () => {
    const adapter = ios();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.lifecycle!.foreground("SIM-UDID-1", "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("xcrun simctl launch 'SIM-UDID-1' 'com.example.app'");
  });

  it("foreground uses devicectl process launch on a physical device", async () => {
    const adapter = ios();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.lifecycle!.foreground(IPHONE_FLUTTER_ECID, "com.example.app");
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("xcrun devicectl device process launch");
    // Lifecycle drives devicectl, so the flutter id is translated to the
    // devicectl id.
    expect(cmd).toContain(IPHONE_DEVICECTL_ID);
    expect(cmd).not.toContain(IPHONE_FLUTTER_ECID);
  });

  it("terminate on a physical device resolves the pid then terminates by --pid (no --bundle-identifier)", async () => {
    const adapter = ios();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    // First call: the pid lookup returns the processes JSON. Subsequent calls
    // (the terminate itself) succeed.
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("device info processes")) {
        return { ...okResult, stdout: PROCESSES_JSON };
      }
      return okResult;
    });

    await adapter.lifecycle!.terminate(IPHONE_FLUTTER_ECID, "com.example.app");

    // Step 1: it queries the running-process list (json to stdout) by devicectl id.
    const infoCmd = runShell.mock.calls[0][0] as string;
    expect(infoCmd).toContain("xcrun devicectl device info processes");
    expect(infoCmd).toContain(IPHONE_DEVICECTL_ID);
    expect(infoCmd).toContain("--json-output -");

    // Step 2: it terminates by the RESOLVED pid, NOT by bundle id.
    const termCmd = runShell.mock.calls[1][0] as string;
    expect(termCmd).toContain("xcrun devicectl device process terminate");
    expect(termCmd).toContain(IPHONE_DEVICECTL_ID);
    expect(termCmd).toContain(`--pid ${APP_PID}`);
    expect(termCmd).not.toContain("--bundle-identifier");
    expect(termCmd).not.toContain("com.example.app");
  });

  it("terminate is a clean no-op when the app is not running (no matching pid)", async () => {
    const adapter = ios();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    // Process list contains NO Runner.app process → app not running.
    const noAppJson = JSON.stringify({
      result: {
        runningProcesses: [
          { processIdentifier: 1, executable: "file:///sbin/launchd" },
        ],
      },
    });
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("device info processes")) {
        return { ...okResult, stdout: noAppJson };
      }
      return okResult;
    });

    const result = await adapter.lifecycle!.terminate(
      IPHONE_FLUTTER_ECID,
      "com.example.app"
    );

    // Only the lookup ran; terminate was NOT invoked.
    expect(runShell.mock.calls).toHaveLength(1);
    expect(
      runShell.mock.calls.some((c) =>
        (c[0] as string).includes("process terminate")
      )
    ).toBe(false);
    // And the caller sees success (nothing to terminate is not a failure).
    expect(result.success).toBe(true);
  });
});

describe("findIosProcessPid", () => {
  it("selects the pid of the /Runner.app/ process, not the first process", () => {
    expect(findIosProcessPid(PROCESSES_JSON)).toBe(APP_PID);
  });

  it("returns undefined when no matching process is present", () => {
    const json = JSON.stringify({
      result: {
        runningProcesses: [
          { processIdentifier: 1, executable: "file:///sbin/launchd" },
        ],
      },
    });
    expect(findIosProcessPid(json)).toBeUndefined();
  });

  it("returns undefined on unparseable / empty output (safe no-op)", () => {
    expect(findIosProcessPid("")).toBeUndefined();
    expect(findIosProcessPid("not json")).toBeUndefined();
    expect(findIosProcessPid("{}")).toBeUndefined();
  });

  it("also matches on the bundle id appearing in the executable path", () => {
    const json = JSON.stringify({
      result: {
        runningProcesses: [
          {
            processIdentifier: 909,
            executable: "file:///path/com.example.app/Exec",
          },
        ],
      },
    });
    expect(findIosProcessPid(json, { bundleId: "com.example.app" })).toBe(909);
  });

  it("exposes the Runner.app executable marker it matches on", () => {
    expect(IOS_APP_EXECUTABLE_MARKER).toBe("/Runner.app/");
  });
});

describe("IosAdapter input is unsupported (Marionette owns in-app gestures)", () => {
  it("returns a cached controller that reports every send unsupported", async () => {
    const adapter = ios();
    const input = adapter.input();
    expect(input.platform).toBe("ios");
    expect(adapter.input()).toBe(input); // cached / session-sticky
    await expect(input.key("UP")).rejects.toThrow(UnsupportedInputError);
    await expect(input.pointerMove(0, 0)).rejects.toThrow(UnsupportedInputError);
    await expect(input.pointerClick()).rejects.toThrow(UnsupportedInputError);
    await expect(input.pointerScroll(0)).rejects.toThrow(UnsupportedInputError);
  });

  // The server wraps key()/pointerClick() in the same try/catch it uses for
  // move/scroll, mapping the thrown UnsupportedInputError via mapUnsupportedInput
  // to a non-fatal {supported:false}. Exercise that exact conversion so the
  // handler's iOS key/click path is proven to return supported:false instead of
  // faulting into an InternalError.
  it("key/click map to a non-fatal supported:false result instead of throwing", async () => {
    const { mapUnsupportedInput } = await import("../src/handlerLogic.js");
    const input = ios().input();

    const keyError = await input.key("UP").catch((e) => e);
    expect(mapUnsupportedInput(keyError, "ios", "key")).toMatchObject({
      platform: "ios",
      action: "key",
      sent: false,
      supported: false,
    });

    const clickError = await input.pointerClick().catch((e) => e);
    expect(mapUnsupportedInput(clickError, "ios", "click")).toMatchObject({
      platform: "ios",
      action: "click",
      sent: false,
      supported: false,
    });
  });
});

describe("buildIosPtyLaunchCommand", () => {
  // This adapter owns only the `flutter run` inner + the appDir cwd; the
  // cross-platform `script` wrapping is buildPtyCaptureCommand's concern (see
  // its own tests). Assert only this adapter's contribution here.
  it("composes the flutter run inner with the appDir cwd (platform-agnostic)", () => {
    const cmd = buildIosPtyLaunchCommand(
      "/repo/app",
      "SIM-UDID-1",
      "flutter",
      "darwin"
    );
    expect(cmd).toContain("cd '/repo/app'");
    // The inner is passed to `/bin/sh -c` (which escapes its single-quotes), so
    // assert on the unquoted fragment + the udid rather than a quoted inner.
    expect(cmd).toContain("flutter run --debug -d");
    expect(cmd).not.toContain("--no-build");
    expect(cmd).toContain("SIM-UDID-1");
    // Delegates the pty wrap rather than emitting its own `script` branch.
    expect(cmd).toMatch(/\bexec script -q\b/);
  });

  it("delegates the darwin wrap to buildPtyCaptureCommand's `/bin/sh -c` form", () => {
    // BEHAVIOR DELTA (deliberate, visible): the prior BSD form spliced the inner
    // bare — `exec script -q /dev/null flutter run …`. Standardizing on
    // buildPtyCaptureCommand inserts a single `/bin/sh -c '<inner>'` layer and
    // changes nothing else.
    const inner = "flutter run --debug -d 'SIM-UDID-1'";
    expect(
      buildIosPtyLaunchCommand("/repo/app", "SIM-UDID-1", "flutter", "darwin")
    ).toBe(
      `cd '/repo/app' && exec script -q /dev/null /bin/sh -c '${inner.replace(/'/g, "'\\''")}'`
    );
  });

  it("delegates the linux wrap to buildPtyCaptureCommand's util-linux `-c` form", () => {
    const inner = "flutter run --debug -d 'SIM-UDID-1'";
    expect(
      buildIosPtyLaunchCommand("/repo/app", "SIM-UDID-1", "flutter", "linux")
    ).toBe(
      `cd '/repo/app' && exec script -q -c '${inner.replace(/'/g, "'\\''")}' /dev/null`
    );
  });

  it("threads an fvm-wrapped flutter command into the pty launch", () => {
    const cmd = buildIosPtyLaunchCommand(
      "/repo/app",
      IPHONE_FLUTTER_ECID,
      "fvm flutter",
      "darwin"
    );
    expect(cmd).toContain("fvm flutter run --debug -d");
    expect(cmd).not.toContain("--no-build");
    expect(cmd).toContain(IPHONE_FLUTTER_ECID);
  });
});

describe("IosAdapter.systemPrompt", () => {
  const ALERT_JSON = JSON.stringify([
    { AXType: "Alert", AXLabel: "Open in “Example”?" },
    { AXType: "Button", AXLabel: "Cancel", AXFrame: { x: 50, y: 410, width: 130, height: 44 } },
    { AXType: "Button", AXLabel: "Open", AXFrame: { x: 190, y: 410, width: 130, height: 44 } },
  ]);

  // idb is now located on the filesystem (locateIdb), which is INJECTED into the
  // adapter for deterministic tests (idbLocate's real search order is unit-tested
  // separately in idbLocate.test.ts). The controller shells idb by this absolute
  // path. `idbPresent:false` injects a locator that returns undefined (idb not
  // found).
  const REAL_IDB = "/opt/homebrew/bin/idb";

  /** Build an ios adapter with a pinned idb locator + flutter command. */
  function iosWithIdb(idbPresent: boolean, device?: string) {
    return new IosAdapter(
      {
        appDir: IOS_APP_DIR,
        appId: IOS_APP_ID,
        device,
        flutterCommand: "flutter",
        locateIdb: () => (idbPresent ? REAL_IDB : undefined),
      }
    );
  }

  /**
   * Route the `idb ui describe-all`/`idb ui tap` calls the controller makes. The
   * controller shells idb by its ABSOLUTE located path (quoted), so match on the
   * `ui describe-all`/`ui tap` subcommand, not a bare `idb` prefix.
   */
  function mockIdb(opts: { describe?: string } = {}) {
    const describe = opts.describe ?? ALERT_JSON;
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("ui describe-all")) {
        return { ...okResult, stdout: describe };
      }
      if (cmd.includes("ui tap")) {
        return okResult;
      }
      return okResult;
    });
  }

  // An explicit sim udid is passed so the controller does not need to list
  // simulators; the physical-only / auto-resolution paths are covered separately.
  const SIM = "SIM-UDID-1";

  it("reports an actionable note (not a throw) when idb is not installed", async () => {
    mockIdb();
    const res = await iosWithIdb(false).systemPrompt!.handle("detect", undefined, SIM);
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/brew install idb-companion/);
    expect(res.note).toMatch(/FLUTTER_DEVICE_IDB_PATH/);
  });

  it("detects the 'Open in app' prompt and returns its button labels", async () => {
    mockIdb();
    const res = await iosWithIdb(true).systemPrompt!.handle("detect", undefined, SIM);
    expect(res.present).toBe(true);
    expect(res.buttons).toEqual(["Cancel", "Open"]);
    // describe-all is invoked; no tap for a detect.
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("ui tap"))
    ).toBe(false);
  });

  it("taps the requested button by label at its frame center", async () => {
    mockIdb();
    const res = await iosWithIdb(true).systemPrompt!.handle("tap", "Open", SIM);
    expect(res.tapped).toBe("Open");
    // Open center: (190 + 65, 410 + 22) = (255, 432)
    expect(res.tappedAt).toEqual({ x: 255, y: 432 });
    const tapCmd = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("ui tap"))!;
    // idb is shelled by its located absolute path (quoted), then the subcommand.
    expect(tapCmd).toContain(`ui tap --udid '${SIM}' 255 432`);
    expect(tapCmd).toContain(REAL_IDB);
  });

  it("dismiss taps the negative action (Cancel)", async () => {
    mockIdb();
    const res = await iosWithIdb(true).systemPrompt!.handle("dismiss", undefined, SIM);
    expect(res.tapped).toBe("Cancel");
  });

  it("reports available buttons when the requested label is not found", async () => {
    mockIdb();
    const res = await iosWithIdb(true).systemPrompt!.handle("tap", "Nope", SIM);
    expect(res.present).toBe(true);
    expect(res.tapped).toBeUndefined();
    expect(res.note).toMatch(/No button matching "Nope"/);
    expect(res.note).toMatch(/Cancel, Open/);
  });

  it("reports no prompt (no tap) on an ordinary screen", async () => {
    mockIdb({
      describe: JSON.stringify([
        { type: "Button", label: "Play", frame: { x: 0, y: 0, width: 10, height: 10 } },
      ]),
    });
    const res = await iosWithIdb(true).systemPrompt!.handle("tap", "Open", SIM);
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/No system prompt detected/);
  });

  it("auto-resolves a booted simulator when no udid is given", async () => {
    // First the controller lists targets (simctl/devicectl/flutter) to pick a
    // booted sim, then reads/taps it. mockDiscovery("simulator") supplies a
    // booted "SIM-UDID-1".
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl list devices --json")) {
        return {
          ...okResult,
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                { udid: "SIM-UDID-1", name: "iPhone 15", state: "Booted", isAvailable: true },
              ],
            },
          }),
        };
      }
      if (cmd.includes("devicectl list devices")) return { ...okResult, stdout: "" };
      if (cmd.includes("devices --machine")) return { ...okResult, stdout: "[]" };
      if (cmd.includes("ui describe-all")) return { ...okResult, stdout: ALERT_JSON };
      return okResult;
    });
    const res = await iosWithIdb(true).systemPrompt!.handle("detect");
    expect(res.present).toBe(true);
    const describeCmd = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("ui describe-all"))!;
    expect(describeCmd).toContain("--udid 'SIM-UDID-1'");
  });

  it("returns a simulator-only note when only a physical device is connected", async () => {
    // A physical iPhone connected, NO simulator booted/listed.
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl list devices")) {
        return {
          ...okResult,
          stdout:
            "Name  Host  Identifier  State  Model\n" +
            `My iPhone  h  ${IPHONE_DEVICECTL_ID}  connected  (iPhone11,8)\n`,
        };
      }
      if (cmd.includes("simctl list devices --json")) return { ...okResult, stdout: "{}" };
      if (cmd.includes("devices --machine")) {
        return {
          ...okResult,
          stdout: JSON.stringify([
            { id: IPHONE_FLUTTER_ECID, name: "My iPhone", targetPlatform: "ios", emulator: false, isSupported: true },
          ]),
        };
      }
      return okResult;
    });
    const res = await iosWithIdb(true).systemPrompt!.handle("detect");
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/simulator-only/i);
    expect(res.note).toMatch(/FBSimulatorLifecycle/);
    // It must NOT have tried to describe/tap the physical device.
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("ui describe-all"))
    ).toBe(false);
  });

  it("reports no-simulator when nothing is connected", async () => {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl list devices --json")) return { ...okResult, stdout: "{}" };
      if (cmd.includes("devicectl list devices")) return { ...okResult, stdout: "" };
      if (cmd.includes("devices --machine")) return { ...okResult, stdout: "[]" };
      return okResult;
    });
    const res = await iosWithIdb(true).systemPrompt!.handle("detect");
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/No iOS simulator found/);
  });
});

describe("IosAdapter.screenshot", () => {
  it("captures a SIMULATOR screen via `xcrun simctl io ... screenshot` to the given path", async () => {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const outPath = path.join(
      os.tmpdir(),
      `flutter-device-mcp-shot-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`
    );
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl list devices --json")) {
        return {
          ...okResult,
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                { udid: "SIM-UDID-1", name: "iPhone 15", state: "Booted", isAvailable: true },
              ],
            },
          }),
        };
      }
      if (cmd.includes("devicectl list devices")) return { ...okResult, stdout: "" };
      if (cmd.includes("devices --machine")) return { ...okResult, stdout: "[]" };
      if (cmd.includes("simctl io") && cmd.includes("screenshot")) {
        // Stand in for simctl by actually writing the PNG so existsSync passes.
        fs.writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return okResult;
      }
      return okResult;
    });
    try {
      const res = await ios().screenshot({ outPath });
      expect(res.captured).toBe(true);
      expect(res.savedPath).toBe(outPath);
      const shotCmd = runShell.mock.calls
        .map(([c]) => c as string)
        .find((c) => c.includes("simctl io"))!;
      expect(shotCmd).toContain("simctl io 'SIM-UDID-1' screenshot");
    } finally {
      fs.rmSync(outPath, { force: true });
    }
  });

  /** Build an ios adapter with a pinned pymobiledevice3 locator + flutter command. */
  function iosWithPmd3(present: boolean, device?: string) {
    return new IosAdapter(
      {
        appDir: IOS_APP_DIR,
        appId: IOS_APP_ID,
        device,
        flutterCommand: "flutter",
        locatePymobiledevice3: () =>
          present ? "/opt/homebrew/bin/pymobiledevice3" : undefined,
      }
    );
  }

  /**
   * Mock a single connected physical iPhone (no simulator). When `writePng` is
   * given, the mocked `pymobiledevice3 developer dvt screenshot` call stands in
   * for the real capture by writing a PNG stub to that path (so existsSync
   * passes). `fs` is imported at module scope so the async mock can write it.
   */
  function mockPhysicalOnly(writePng?: string) {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl list devices")) {
        return {
          ...okResult,
          stdout:
            "Name  Host  Identifier  State  Model\n" +
            `My iPhone  h  ${IPHONE_DEVICECTL_ID}  connected  (iPhone11,8)\n`,
        };
      }
      if (cmd.includes("simctl list devices --json")) return { ...okResult, stdout: "{}" };
      if (cmd.includes("devices --machine")) {
        return {
          ...okResult,
          stdout: JSON.stringify([
            { id: IPHONE_FLUTTER_ECID, name: "My iPhone", targetPlatform: "ios", emulator: false, isSupported: true },
          ]),
        };
      }
      if (cmd.includes("developer dvt screenshot")) {
        if (writePng) fs.writeFileSync(writePng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return okResult;
      }
      return okResult;
    });
  }

  it("captures a PHYSICAL device screen via pymobiledevice3 developer dvt screenshot (with --udid)", async () => {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const outPath = path.join(
      os.tmpdir(),
      `flutter-device-mcp-pmd3-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`
    );
    mockPhysicalOnly(outPath);
    try {
      const res = await iosWithPmd3(true).screenshot({ outPath });
      expect(res.captured).toBe(true);
      expect(res.savedPath).toBe(outPath);
      const shotCmd = runShell.mock.calls
        .map(([c]) => c as string)
        .find((c) => c.includes("developer dvt screenshot"))!;
      expect(shotCmd).toContain("'/opt/homebrew/bin/pymobiledevice3' developer dvt screenshot");
      // Targets the device by its flutter id / ECID via --udid.
      expect(shotCmd).toContain(`--udid '${IPHONE_FLUTTER_ECID}'`);
      // Never fell back to the simulator-only path.
      expect(
        runShell.mock.calls.some(([c]) => (c as string).includes("simctl io"))
      ).toBe(false);
    } finally {
      fs.rmSync(outPath, { force: true });
    }
  });

  it("returns {supported:false} with an install hint when pymobiledevice3 is missing (no hard fail)", async () => {
    mockPhysicalOnly();
    const res = await iosWithPmd3(false).screenshot({});
    expect(res.captured).toBe(false);
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/pymobiledevice3` was not found/i);
    expect(res.hint).toMatch(/pipx install pymobiledevice3/);
    expect(res.hint).toMatch(/FLUTTER_DEVICE_PYMOBILEDEVICE3/);
    // Must never have shelled any screenshot command.
    expect(
      runShell.mock.calls.some(
        ([c]) =>
          (c as string).includes("developer dvt screenshot") ||
          (c as string).includes("simctl io")
      )
    ).toBe(false);
  });
});

describe("IosAdapter preflight (pod drift + provisioning)", () => {
  // A real temp repo whose app/ios has a Podfile, so the adapter's
  // fs.existsSync(Podfile) gate passes and the pod-drift path is exercised.
  let repoRoot: string;
  let iosDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-mcp-ios-"));
    iosDir = path.join(repoRoot, "app", "ios");
    fs.mkdirSync(iosDir, { recursive: true });
    fs.writeFileSync(path.join(iosDir, "Podfile"), "platform :ios");
  });
  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A physical-device adapter rooted at the temp repo, with a pinned flutter. */
  function iosDevice(): InstanceType<typeof IosAdapter> {
    return new IosAdapter({
      appDir: path.join(repoRoot, "app"),
      appId: IOS_APP_ID,
      flutterCommand: "flutter",
    });
  }

  /** Resolve a physical device against the temp-rooted adapter. */
  async function resolvedDevice(): Promise<InstanceType<typeof IosAdapter>> {
    const adapter = iosDevice();
    mockDiscovery("device");
    await adapter.discoverDevice();
    return adapter;
  }

  it("detects sandbox drift and repairs it with a UTF-8-locale pod install", async () => {
    const adapter = await resolvedDevice();
    runShell.mockClear();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("pod install --deployment")) {
        // Dry check fails with the drift signature.
        return {
          ...okResult,
          success: false,
          code: 1,
          combined:
            "[!] The sandbox is not in sync with the Podfile.lock. Run 'pod install'",
        };
      }
      return okResult; // the real `pod install` succeeds
    });

    const res = await adapter.install(IPHONE_FLUTTER_ECID, { noLaunch: true });
    expect(res.success).toBe(true);

    // The real (mutating) pod install ran with a UTF-8 locale env.
    const podInstall = runShell.mock.calls.find(
      ([c]) => (c as string).includes("pod install") && !(c as string).includes("--deployment")
    );
    expect(podInstall).toBeDefined();
    const opts = podInstall![1] as { env?: Record<string, string>; cwd?: string };
    expect(opts.env).toMatchObject({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
    expect(opts.cwd).toBe(iosDir);
  });

  it("runs the DRY drift check itself with the UTF-8 locale env", async () => {
    // Under a non-UTF-8 locale the dry `pod install --deployment` dies in the
    // Ruby-4.0 encoding crash before it can report drift, and the crash output
    // carries no drift signature — real drift would be silently skipped.
    const adapter = await resolvedDevice();
    runShell.mockClear();
    runShell.mockImplementation(async () => okResult);

    await adapter.install(IPHONE_FLUTTER_ECID, { noLaunch: true });

    const dryCheck = runShell.mock.calls.find(([c]) =>
      (c as string).includes("pod install --deployment")
    );
    expect(dryCheck).toBeDefined();
    const opts = dryCheck![1] as { env?: Record<string, string> };
    expect(opts.env).toMatchObject({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    });
  });

  it("runs the pod preflight on a SIMULATOR target too (drift breaks a sim build the same way)", async () => {
    const adapter = iosDevice();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("pod install --deployment")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined:
            "[!] The sandbox is not in sync with the Podfile.lock. Run 'pod install'",
        };
      }
      return okResult;
    });
    const res = await adapter.install("SIM-UDID-1", { noLaunch: true });
    expect(res.success).toBe(true);
    // The mutating repair ran — the simulator no longer skips the preflight.
    const podInstall = runShell.mock.calls.find(
      ([c]) =>
        (c as string).includes("pod install") &&
        !(c as string).includes("--deployment")
    );
    expect(podInstall).toBeDefined();
  });

  it("build() honors the 3-way mode, which outranks the debug boolean", async () => {
    const adapter = iosDevice();
    runShell.mockResolvedValue(okResult);
    await adapter.build({ mode: "profile", debug: true });
    const built = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("flutter build ios"))!;
    // Silently dropping `mode` on one platform is worse than not supporting it.
    expect(built).toContain("--profile");
    expect(built).not.toContain("--debug");
  });

  it("build() repairs pod drift BEFORE running flutter build", async () => {
    const adapter = iosDevice();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("pod install --deployment")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined:
            "[!] The sandbox is not in sync with the Podfile.lock. Run 'pod install'",
        };
      }
      return okResult;
    });
    const build = await adapter.build({});
    expect(build.result.success).toBe(true);
    const ran = runShell.mock.calls.map(([c]) => c as string);
    const repairIdx = ran.findIndex(
      (c) => c.includes("pod install") && !c.includes("--deployment")
    );
    const buildIdx = ran.findIndex((c) => c.includes("flutter build ios"));
    expect(repairIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(repairIdx);
  });

  it("build({profile:'simulator'}) also runs the pod preflight", async () => {
    const adapter = iosDevice();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("pod install --deployment")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined: "The sandbox is not in sync with the Podfile.lock.",
        };
      }
      return okResult;
    });
    await adapter.build({ profile: "simulator" });
    const ran = runShell.mock.calls.map(([c]) => c as string);
    expect(
      ran.some((c) => c.includes("pod install") && !c.includes("--deployment"))
    ).toBe(true);
    expect(ran.some((c) => c.includes("flutter build ios --simulator"))).toBe(
      true
    );
  });

  it("build() happy path costs only the cheap dry check (no mutating pod install)", async () => {
    const adapter = iosDevice();
    runShell.mockResolvedValue(okResult); // dry check passes: sandbox in sync
    await adapter.build({});
    const ran = runShell.mock.calls.map(([c]) => c as string);
    expect(ran.some((c) => c.includes("pod install --deployment"))).toBe(true);
    expect(
      ran.filter((c) => c.includes("pod install") && !c.includes("--deployment"))
    ).toHaveLength(0);
    expect(ran.some((c) => c.includes("flutter build ios"))).toBe(true);
  });

  it("build() surfaces a failed pod repair as the blocker and does NOT run flutter build", async () => {
    const adapter = iosDevice();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("pod install --deployment")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined: "The sandbox is not in sync with the Podfile.lock.",
        };
      }
      if (cmd.includes("pod install")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined:
            "Unicode Normalization not appropriate for ASCII-8BIT (Encoding::CompatibilityError)",
        };
      }
      return okResult;
    });
    const build = await adapter.build({});
    expect(build.result.success).toBe(false);
    expect(build.result.combined).toMatch(/pod install/i);
    const ran = runShell.mock.calls.map(([c]) => c as string);
    expect(ran.some((c) => c.includes("flutter build ios"))).toBe(false);
  });

  it("surfaces pod install's OWN failure as the blocker (not a signing hint)", async () => {
    const adapter = await resolvedDevice();
    runShell.mockClear();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("pod install --deployment")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined: "The sandbox is not in sync with the Podfile.lock.",
        };
      }
      if (cmd.includes("pod install")) {
        return {
          ...okResult,
          success: false,
          code: 1,
          combined:
            "Unicode Normalization not appropriate for ASCII-8BIT (Encoding::CompatibilityError)",
        };
      }
      return okResult;
    });

    const res = await adapter.install(IPHONE_FLUTTER_ECID, { noLaunch: true });
    expect(res.success).toBe(false);
    // The diagnostic must be the pod cause, NOT the misleading signing hint.
    const diag = adapter.installFailureDiagnostic!(res.combined)!;
    expect(diag).toMatch(/pod install/i);
    expect(diag).not.toMatch(/code-signed/i);
  });

  it("does NOT run a mutating pod install when the sandbox is in sync", async () => {
    const adapter = await resolvedDevice();
    runShell.mockClear();
    runShell.mockImplementation(async () => okResult); // dry check passes
    const res = await adapter.install(IPHONE_FLUTTER_ECID, { noLaunch: true });
    expect(res.success).toBe(true);
    const mutating = runShell.mock.calls.filter(
      ([c]) => (c as string).includes("pod install") && !(c as string).includes("--deployment")
    );
    expect(mutating).toHaveLength(0);
  });

  it("recoverLaunchFailure runs the provisioning xcodebuild on a provisioning failure", async () => {
    const adapter = await resolvedDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    const rec = await adapter.recoverLaunchFailure!(
      IPHONE_FLUTTER_ECID,
      "error: Runner requires a provisioning profile."
    );
    expect(rec.recovered).toBe(true);
    const xcodebuild = runShell.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("xcodebuild"))!;
    expect(xcodebuild).toContain("-allowProvisioningUpdates");
    expect(xcodebuild).toContain("-allowProvisioningDeviceRegistration");
    // Uses the raw hardware (devicectl) UDID in the destination, not the flutter id.
    expect(xcodebuild).toContain(IPHONE_DEVICECTL_ID);
    expect(xcodebuild).toContain("Runner.xcworkspace");
  });

  it("recoverLaunchFailure is a no-op for a non-provisioning launch failure", async () => {
    const adapter = await resolvedDevice();
    runShell.mockClear();
    const rec = await adapter.recoverLaunchFailure!(
      IPHONE_FLUTTER_ECID,
      "Some unrelated build error"
    );
    expect(rec.recovered).toBe(false);
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("xcodebuild"))
    ).toBe(false);
  });

  it("recoverLaunchFailure is a no-op on a simulator target", async () => {
    const adapter = iosDevice();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    const rec = await adapter.recoverLaunchFailure!(
      "SIM-UDID-1",
      "requires a provisioning profile"
    );
    expect(rec.recovered).toBe(false);
  });

  it("recoverLaunchFailure uninstalls + retries on ENOSPC at launch-time install", async () => {
    const adapter = await resolvedDevice();
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    const rec = await adapter.recoverLaunchFailure!(
      IPHONE_FLUTTER_ECID,
      "Could not install com.example.app on iPhone. No space left on device"
    );
    expect(rec.recovered).toBe(true);
    // It uninstalled to free space (devicectl uninstall on a physical device).
    expect(
      runShell.mock.calls.some(([c]) =>
        (c as string).includes("devicectl device uninstall app")
      )
    ).toBe(true);
    // ENOSPC recovery must NOT run the slow provisioning xcodebuild.
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("xcodebuild"))
    ).toBe(false);
  });
});

describe("IOS_FAILURE_SIGNATURES", () => {
  it("matches terminal iOS launch failures", () => {
    const combined = "code signing error: no valid provisioning profile";
    expect(IOS_FAILURE_SIGNATURES.some((re) => re.test(combined))).toBe(true);
  });

  it("does not match a benign progress line", () => {
    const combined = "Installing and launching...";
    expect(IOS_FAILURE_SIGNATURES.some((re) => re.test(combined))).toBe(false);
  });

  it("treats CocoaPods sandbox drift as terminal (stops the launch poll early)", () => {
    const combined =
      "[!] The sandbox is not in sync with the Podfile.lock. Run 'pod install'";
    expect(IOS_FAILURE_SIGNATURES.some((re) => re.test(combined))).toBe(true);
  });
});
