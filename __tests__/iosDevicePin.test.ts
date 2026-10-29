import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";

// iOS device choice and space recovery driven through the real IosAdapter and
// runDeployCore, with every xcrun/flutter/plutil command mocked: nothing here
// can reach a phone or boot a simulator.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  runTizenCli: jest.fn(),
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
  buildTizenCliCommand: jest.fn(),
}));

const neutralLaunchAndCaptureUri = jest.fn<(command: string) => Promise<unknown>>();

jest.unstable_mockModule("../src/launchCapture.js", () => ({
  launchAndCaptureUri: neutralLaunchAndCaptureUri,
  buildPtyCaptureCommand: mockBuildPtyCaptureCommand,
  allocateControlChannel: () => undefined,
}));

jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  findLaunch: () => undefined,
  recordLaunch: jest.fn(),
  readRecords: jest.fn(() => []),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  defaultRegistryPath: () => "/tmp/never-used-by-this-suite.json",
}));

const { IosAdapter } = await import("../src/adapters/ios.js");
const { runDeployCore } = await import("../src/deployFlow.js");
type DeployArgs = import("../src/deployFlow.js").DeployArgs;

const PHONE_ECID = "00008020-000000000000AAAA";
const PHONE_CTL = "E1E2E3E4-0000-4000-8000-000000000AC4";
const SIM_A = "AAAA1111-1111-1111-1111-111111111111";
const SIM_B = "BBBB2222-2222-2222-2222-222222222222";
const APP_ID = "com.example.app";

const ok = (stdout = "") => ({
  code: 0,
  stdout,
  stderr: "",
  combined: stdout,
  success: true,
  timedOut: false,
});

const LAUNCHED = {
  vmServiceUriWs: "ws://127.0.0.1:50000/abc=/ws",
  vmServiceUriHttp: "http://127.0.0.1:50000/abc=/",
  pid: 4242,
  logPath: "/tmp/launch.log",
};
const failedWith = (logTail: string) => ({
  failed: true,
  reason: "launch failed",
  logPath: "/tmp/launch.log",
  logTail,
});
const DEVICE_ENOSPC = failedWith(
  `Could not install build/ios/iphoneos/Runner.app on ${PHONE_ECID}.\n` +
    "ERROR: Failed to install the app on the device. (com.apple.dt.CoreDeviceError error 3002 (0xBBA))\n" +
    '    NSUnderlyingError = Error Domain=MIInstallerErrorDomain Code=4 "No space left on device"'
);
const HOST_ENOSPC = failedWith(
  "Error (Xcode): error: couldn't write output file /Users/dev/Library/Developer/Xcode/DerivedData/Runner/Build/x.o: No space left on device\n" +
    "Could not build the precompiled application for the device.\n" +
    "Error launching application on iPhone."
);

let appDir: string;
beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-pin-"));
  runShell.mockReset();
  neutralLaunchAndCaptureUri.mockReset();
  neutralLaunchAndCaptureUri.mockResolvedValue(LAUNCHED);
});
afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

function ios(device?: string) {
  return new IosAdapter({ appDir, appId: APP_ID, device, flutterCommand: "flutter" });
}

/** Leave a built device bundle behind whose bundle id `plutil` (mocked) reports. */
function builtBundle() {
  const plist = path.join(appDir, "build", "ios", "iphoneos", "Runner.app", "Info.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "");
}

function host(opts: {
  phone?: boolean;
  sims?: { udid: string; name: string; booted: boolean }[];
  destinations?: string[];
  bundleId?: string;
  /** What devicectl reports about the copy of the app installed on the phone. */
  installedApp?: { builtByDeveloper: boolean } | "absent";
}) {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.includes("devicectl list devices")) {
      return ok(
        opts.phone
          ? `Name  Host  Identifier  State  Model\nMy iPhone  h  ${PHONE_CTL}  connected  (iPhone11,8)\n`
          : ""
      );
    }
    if (cmd.includes("devices --machine")) {
      return ok(
        JSON.stringify(
          opts.phone
            ? [{ id: PHONE_ECID, name: "My iPhone", targetPlatform: "ios", emulator: false, isSupported: true }]
            : []
        )
      );
    }
    if (cmd.includes("simctl list devices --json")) {
      return ok(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": (opts.sims ?? []).map((s) => ({
              udid: s.udid,
              name: s.name,
              state: s.booted ? "Booted" : "Shutdown",
              isAvailable: true,
            })),
          },
        })
      );
    }
    if (cmd.includes("-showdestinations")) {
      return ok(
        `Available destinations for the "Runner" scheme:\n` +
          (opts.destinations ?? [])
            .map((id) => `  { platform:iOS Simulator, id:${id}, OS:18.0, name:iPhone 15 }`)
            .join("\n")
      );
    }
    if (cmd.startsWith("plutil -extract CFBundleIdentifier")) {
      return ok(`${opts.bundleId ?? APP_ID}\n`);
    }
    if (cmd.includes("devicectl device info apps")) {
      const apps =
        opts.installedApp === undefined || opts.installedApp === "absent"
          ? []
          : [{ bundleIdentifier: APP_ID, builtByDeveloper: opts.installedApp.builtByDeveloper }];
      return ok(JSON.stringify({ result: { apps } }));
    }
    return ok();
  });
}

const commands = () => runShell.mock.calls.map(([cmd]) => cmd);
const uninstalls = () => commands().filter((c) => c.includes(" uninstall "));

function deploy(adapter: InstanceType<typeof IosAdapter>, args: DeployArgs) {
  return runDeployCore({ adapter, args });
}

describe("iOS target selection", () => {
  it("refuses a named simulator that is not a Runner destination, and boots nothing", async () => {
    host({
      sims: [
        { udid: SIM_A, name: "iPhone 13", booted: true },
        { udid: SIM_B, name: "iPhone 15", booted: true },
      ],
      destinations: [SIM_B],
    });

    await expect(ios().discoverDevice({ udid: SIM_A })).rejects.toThrow(
      new RegExp(`${SIM_A}.*not a valid Runner-scheme destination.*${SIM_B}`)
    );
    expect(commands().filter((c) => c.includes("simctl boot"))).toEqual([]);
  });

  it("passes `kind` through, so a simulator request with only a phone attached is refused", async () => {
    host({ phone: true });

    await expect(ios().discoverDevice({ kind: "simulator" })).rejects.toThrow(
      /a simulator was requested and none is online/
    );
  });

  it("refuses an unnamed call when a phone and a simulator are both available, listing both", async () => {
    host({ phone: true, sims: [{ udid: SIM_B, name: "iPhone 15", booted: true }], destinations: [SIM_B] });

    await expect(ios().discoverDevice()).rejects.toThrow(
      new RegExp(`2 iOS devices are online and none was named: ${PHONE_ECID} \\(device, My iPhone\\), ${SIM_B} \\(simulator, iPhone 15\\)`)
    );
  });
});

describe("iOS space recovery", () => {
  it("uninstalls on the named phone when the device itself rejected the install for space", async () => {
    host({ phone: true, installedApp: { builtByDeveloper: true } });
    builtBundle();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce(DEVICE_ENOSPC).mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(ios(), { device_udid: PHONE_ECID });

    expect(uninstalls()).toEqual([
      `xcrun devicectl device uninstall app --device '${PHONE_CTL}' '${APP_ID}'`,
    ]);
    expect(result.stage).toBe("launched");
  });

  it("does not uninstall anything when the Mac's disk filled during the build", async () => {
    host({ phone: true, installedApp: { builtByDeveloper: true } });
    builtBundle();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce(HOST_ENOSPC).mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(ios(), { device_udid: PHONE_ECID });

    expect(uninstalls()).toEqual([]);
    expect(result.stage).toBe("launch-failed");
  });

  it("does not uninstall a copy that was not built by a developer (App Store or TestFlight)", async () => {
    host({ phone: true, installedApp: { builtByDeveloper: false } });
    builtBundle();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce(DEVICE_ENOSPC).mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(ios(), { device_udid: PHONE_ECID });

    expect(uninstalls()).toEqual([]);
    expect(result.stage).toBe("launch-failed");
  });

  it("removes a store copy when the caller passes allow_store_app_removal", async () => {
    host({ phone: true, installedApp: { builtByDeveloper: false } });
    builtBundle();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce(DEVICE_ENOSPC).mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(ios(), { device_udid: PHONE_ECID, allow_store_app_removal: true });

    expect(uninstalls()).toHaveLength(1);
    expect(result.stage).toBe("launched");
  });

  it("does not uninstall when no built bundle can be found to confirm the bundle id", async () => {
    host({ phone: true, installedApp: { builtByDeveloper: true } });
    neutralLaunchAndCaptureUri.mockResolvedValueOnce(DEVICE_ENOSPC).mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(ios(), { device_udid: PHONE_ECID });

    expect(uninstalls()).toEqual([]);
    expect(result.stage).toBe("launch-failed");
  });
});
