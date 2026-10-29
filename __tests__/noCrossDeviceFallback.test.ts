import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";
import {
  androidAppTree,
  removeAndroidTrees,
  unreadableAndroidTree,
} from "./support/androidTree.js";

// Replays the incident: an unattended deploy named an emulator, the emulators
// had just died, and the deploy landed on the developer's personal phone, where
// the Play Store copy of the app was uninstalled. Every shell command the real
// AndroidAdapter issues goes through this mock, so nothing here can reach an
// attached device and each test can say exactly which adb verbs ran.
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
  allocateControlChannel: () => undefined,
  buildPtyCaptureCommand: mockBuildPtyCaptureCommand,
}));

jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  findLaunch: () => undefined,
  recordLaunch: jest.fn(),
  readRecords: jest.fn(() => []),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  defaultRegistryPath: () => "/tmp/never-used-by-this-suite.json",
}));

const { AndroidAdapter, parseInstalledCopy, DEVICE_IDENTITY_PROBE } =
  await import("../src/adapters/android.js");
const { findDeployedPackage, recordDeployedPackage } = await import("../src/deployedPackages.js");
const { runDeployCore, runUninstallCore } = await import("../src/deployFlow.js");
const { runLifecycleCore } = await import("../src/lifecycleFlow.js");
const { runOpenUrlCore } = await import("../src/openUrlFlow.js");
type DeployArgs = import("../src/deployFlow.js").DeployArgs;

const PHONE = "RFCR902W0TT";
const EMULATOR = "emulator-5554";
const PHONE_LINE = `${PHONE}            device usb:1-1 product:q2qsqw model:SM_F926U1 device:q2q transport_id:2`;
const EMULATOR_LINE = `${EMULATOR}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1`;
const APP_ID = "com.example.app";

const ok = (stdout = "") => ({
  code: 0,
  stdout,
  stderr: "",
  combined: stdout,
  success: true,
  timedOut: false,
});

const STORAGE_FAILURE = {
  failed: true,
  reason: "launch failed",
  logPath: "/tmp/launch.log",
  logTail:
    "Installing build/app/outputs/flutter-apk/app-debug.apk...\n" +
    "adb: failed to install app-debug.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
};
const LAUNCHED = {
  vmServiceUriWs: "ws://127.0.0.1:50000/abc=/ws",
  vmServiceUriHttp: "http://127.0.0.1:50000/abc=/",
  pid: 4242,
  logPath: "/tmp/launch.log",
};

afterAll(removeAndroidTrees);

/**
 * Wire the fake host: which devices adb lists, which installer each device
 * reports for `pmPackage`, and what package the built apk carries. The `pm`
 * reply ends with the exit-status sentinel the adapter asks the device shell for.
 */
function host(opts: {
  devices: string[];
  installer?: Record<string, string>;
  apkPackage?: string;
  pmPackage?: string;
  pmReply?: string;
}) {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith("adb devices")) {
      return ok(`List of devices attached\n${opts.devices.join("\n")}\n`);
    }
    const pm = cmd.match(/^adb -s '([^']+)' shell .*pm list packages -i/);
    if (pm) {
      if (opts.pmReply !== undefined) return ok(opts.pmReply);
      const installer = opts.installer?.[pm[1]];
      const pkg = opts.pmPackage ?? APP_ID;
      return ok(
        (installer ? `package:${pkg}  installer=${installer}\n` : "") + "__pm_exit=0\n"
      );
    }
    if (/aapt2'? dump packagename/.test(cmd)) {
      return ok(`${opts.apkPackage ?? APP_ID}\n`);
    }
    return ok();
  });
}

let defaultTree: string;
beforeAll(() => {
  defaultTree = androidAppTree(APP_ID);
});

function adapter(device?: string, root = defaultTree) {
  return new AndroidAdapter(
    { appDir: root, appId: APP_ID, device, flutterCommand: "flutter", aaptCommand: "aapt2" }
  );
}

function deploy(a: InstanceType<typeof AndroidAdapter>, args: DeployArgs) {
  return runDeployCore({ adapter: a, args });
}

const commands = () => runShell.mock.calls.map(([cmd]) => cmd);
const uninstallsAnywhere = () => commands().filter((c) => / uninstall /.test(c));
const uninstallsOn = (serial: string) =>
  commands().filter((c) => c.startsWith(`adb -s '${serial}' uninstall`));
const launches = () => neutralLaunchAndCaptureUri.mock.calls.map(([c]) => c);

beforeEach(() => {
  // The record of what deploy installed is durable, so each test gets its own.
  process.env.FLUTTER_DEVICE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "no-fallback-state-"));
  runShell.mockReset();
  neutralLaunchAndCaptureUri.mockReset();
  neutralLaunchAndCaptureUri.mockResolvedValue(LAUNCHED);
});

describe("a requested emulator that is offline while a physical phone is online", () => {
  it("refuses the deploy, naming both devices, before any install, launch or uninstall", async () => {
    host({ devices: [PHONE_LINE] });

    await expect(
      deploy(adapter(), { device_udid: EMULATOR })
    ).rejects.toThrow(
      /"emulator-5554" \(from the device_udid argument\) is not online\. Online Android devices: RFCR902W0TT \(physical, SM_F926U1\)/
    );

    expect(launches()).toEqual([]);
    expect(commands().filter((c) => /uninstall|install|flutter run/.test(c))).toEqual([]);
  });

  it("refuses the same way when the emulator is pinned by FLUTTER_DEVICE_ANDROID_DEVICE", async () => {
    host({ devices: [PHONE_LINE] });

    await expect(deploy(adapter(EMULATOR), {})).rejects.toThrow(
      /"emulator-5554" \(from the FLUTTER_DEVICE_ANDROID_DEVICE env var\) is not online\. Online Android devices: RFCR902W0TT/
    );
    expect(launches()).toEqual([]);
    expect(uninstallsAnywhere()).toEqual([]);
  });

  it("refuses a `target: simulator` request rather than resolving the phone", async () => {
    host({ devices: [PHONE_LINE] });

    await expect(deploy(adapter(), { target: "simulator" })).rejects.toThrow(
      /No Android emulator to use: an emulator was requested and none is online\. Online Android devices: RFCR902W0TT \(physical, SM_F926U1\)/
    );
    expect(launches()).toEqual([]);
  });

  it("honours the env pin when device_udid is passed blank", async () => {
    host({ devices: [PHONE_LINE, EMULATOR_LINE] });

    const result = await deploy(adapter(EMULATOR), { device_udid: "  " });

    expect(result.resolution.target).toBe(EMULATOR);
  });
});

describe("a deploy that names no device", () => {
  it("refuses when more than one device is online, listing them, and launches nothing", async () => {
    host({ devices: [PHONE_LINE, EMULATOR_LINE] });

    await expect(deploy(adapter(), {})).rejects.toThrow(
      /2 Android devices are online and none was named: RFCR902W0TT \(physical, SM_F926U1\), emulator-5554 \(emulator, sdk_gphone64_arm64\)/
    );
    expect(launches()).toEqual([]);
  });

  it("uses the only online device when there is exactly one", async () => {
    host({ devices: [EMULATOR_LINE] });

    const result = await deploy(adapter(), {});

    expect(result.resolution.target).toBe(EMULATOR);
  });
});

describe("space recovery", () => {
  it("does not uninstall on a device the call never named, even the only one attached", async () => {
    host({ devices: [PHONE_LINE] });
    neutralLaunchAndCaptureUri
      .mockResolvedValueOnce(STORAGE_FAILURE)
      .mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(adapter(), {});

    expect(uninstallsOn(PHONE)).toEqual([]);
    expect(result.stage).toBe("launch-failed");
  });

  it("uninstalls on the named emulator, and nowhere else, when the build carries the same package", async () => {
    host({ devices: [PHONE_LINE, EMULATOR_LINE], installer: { [EMULATOR]: "null" } });
    neutralLaunchAndCaptureUri
      .mockResolvedValueOnce(STORAGE_FAILURE)
      .mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(adapter(), { device_udid: EMULATOR });

    expect(uninstallsAnywhere()).toEqual([`adb -s '${EMULATOR}' uninstall '${APP_ID}'`]);
    expect(result.stage).toBe("launched");
  });

  it("frees the suffixed package a dev-suffixed build installs, and only that one", async () => {
    const devId = `${APP_ID}.dev`;
    host({
      devices: [EMULATOR_LINE],
      installer: { [EMULATOR]: "null" },
      pmPackage: devId,
      apkPackage: devId,
    });
    neutralLaunchAndCaptureUri
      .mockResolvedValueOnce(STORAGE_FAILURE)
      .mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(adapter(undefined, androidAppTree(APP_ID, { debug: "dev" })), {
      device_udid: EMULATOR,
    });

    expect(uninstallsAnywhere()).toEqual([`adb -s '${EMULATOR}' uninstall '${devId}'`]);
    expect(result.stage).toBe("launched");
  });

  it("does not free space when the tree cannot say which package the build carries", async () => {
    host({ devices: [EMULATOR_LINE], installer: { [EMULATOR]: "null" } });
    neutralLaunchAndCaptureUri
      .mockResolvedValueOnce(STORAGE_FAILURE)
      .mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(adapter(undefined, unreadableAndroidTree()), {
      device_udid: EMULATOR,
      allow_store_app_removal: true,
    });

    expect(uninstallsAnywhere()).toEqual([]);
    expect(result.stage).toBe("launch-failed");
    expect(result.stage === "launch-failed" && result.launchRecovery?.note).toMatch(
      /out of storage\..*Space recovery was not attempted\./s
    );
  });

  it("does not uninstall when the build being installed carries a different package id", async () => {
    host({
      devices: [EMULATOR_LINE],
      installer: { [EMULATOR]: "null" },
      apkPackage: "com.example.app.debug",
    });
    neutralLaunchAndCaptureUri
      .mockResolvedValueOnce(STORAGE_FAILURE)
      .mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(adapter(), { device_udid: EMULATOR });

    expect(uninstallsOn(EMULATOR)).toEqual([]);
    expect(result.stage).toBe("launch-failed");
  });

  it("with a store copy installed, is only reached with the override, and then acts on the named device", async () => {
    host({ devices: [PHONE_LINE, EMULATOR_LINE], installer: { [PHONE]: "com.android.vending" } });
    neutralLaunchAndCaptureUri
      .mockResolvedValueOnce(STORAGE_FAILURE)
      .mockResolvedValueOnce(LAUNCHED);

    const result = await deploy(adapter(), {
      device_udid: PHONE,
      allow_store_app_removal: true,
    });

    expect(uninstallsAnywhere()).toEqual([`adb -s '${PHONE}' uninstall '${APP_ID}'`]);
    expect(result.stage).toBe("launched");
  });

  it("refuses at the recovery guard itself for a store copy without the override", async () => {
    host({ devices: [PHONE_LINE], installer: { [PHONE]: "com.android.vending" } });

    const verdict = await adapter().verifyUninstallTarget(PHONE, {
      purpose: "space-recovery",
      allowStoreAppRemoval: false,
      buildLog: STORAGE_FAILURE.logTail,
      packageId: APP_ID,
    } as Parameters<InstanceType<typeof AndroidAdapter>["verifyUninstallTarget"]>[1]);

    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/com\.android\.vending/) });
  });
});

describe("a copy of the app not installed by adb", () => {
  it.each([
    ["the Play Store", "com.android.vending"],
    ["the Galaxy Store", "com.sec.android.app.samsungapps"],
    ["Firebase App Distribution", "dev.firebase.appdistribution"],
    ["a sideloaded package installer", "com.google.android.packageinstaller"],
  ])("from %s blocks the deploy before flutter run can replace it", async (_label, installer) => {
    host({ devices: [PHONE_LINE], installer: { [PHONE]: installer } });

    const result = await deploy(adapter(), { device_udid: PHONE });

    // flutter run replaces an install it cannot update by uninstalling it first,
    // so a launch over this copy is itself the uninstall.
    expect(launches()).toEqual([]);
    expect(uninstallsAnywhere()).toEqual([]);
    expect(result.stage).toBe("install-failed");
    expect(result.install.combined).toContain(installer);
  });

  it.each(["null", "com.android.shell"])(
    "installed by adb (installer %s) does not block the deploy",
    async (installer) => {
      host({ devices: [EMULATOR_LINE], installer: { [EMULATOR]: installer } });

      const result = await deploy(adapter(), { device_udid: EMULATOR });

      expect(result.stage).toBe("launched");
    }
  );

  it("is checked under the package id the build produces, read from the tree", async () => {
    host({
      devices: [EMULATOR_LINE],
      installer: { [EMULATOR]: "com.android.vending" },
      pmPackage: "com.example.app.dev",
    });

    const result = await deploy(adapter(undefined, androidAppTree("com.example.app", { debug: "dev" })), {
      device_udid: EMULATOR,
    });

    expect(commands().filter((c) => c.includes("pm list packages"))).toEqual([
      `adb -s '${EMULATOR}' shell 'pm list packages -i com.example.app.dev; echo __pm_exit=$?'`,
    ]);
    expect(result.stage).toBe("install-failed");
  });

  it("blocks the deploy when pm's answer cannot be read", async () => {
    host({ devices: [PHONE_LINE], pmReply: "Error: Could not access the Package Manager.\n" });

    const result = await deploy(adapter(), { device_udid: PHONE });

    expect(launches()).toEqual([]);
    expect(result.stage).toBe("install-failed");
  });
});

describe("parseInstalledCopy", () => {
  it("reads the installer of exactly the app id, ignoring a longer id the filter also matched", () => {
    const out =
      "package:com.example.app.debug  installer=null\n" +
      "package:com.example.app  installer=com.android.vending\n__pm_exit=0\n";
    expect(parseInstalledCopy(out, APP_ID)).toEqual({
      kind: "installed",
      installer: "com.android.vending",
    });
  });

  it("reads the installer of exactly the app id when the longer id is listed after it", () => {
    const out =
      "package:com.example.app  installer=com.android.vending\n" +
      "package:com.example.app.dev  installer=null\n__pm_exit=0\n";
    expect(parseInstalledCopy(out, APP_ID)).toEqual({
      kind: "installed",
      installer: "com.android.vending",
    });
    expect(parseInstalledCopy(out, `${APP_ID}.dev`)).toEqual({ kind: "installed", installer: "null" });
  });

  it("reads the installer of exactly the app id when the longer id is listed first", () => {
    const out =
      "package:com.example.app.dev  installer=null\n" +
      "package:com.example.app  installer=com.android.vending\n__pm_exit=0\n";
    expect(parseInstalledCopy(out, `${APP_ID}.dev`)).toEqual({ kind: "installed", installer: "null" });
  });

  it("reports absent only when pm ran, exited 0 and listed nothing for the id", () => {
    expect(parseInstalledCopy("__pm_exit=0\n", APP_ID)).toEqual({ kind: "absent" });
    expect(
      parseInstalledCopy("package:com.example.app.debug  installer=null\n__pm_exit=0\n", APP_ID)
    ).toEqual({ kind: "absent" });
  });

  it.each([
    ["empty output", ""],
    ["no exit status", "package:com.example.app  installer=null\n"],
    ["a non-zero exit", "__pm_exit=1\n"],
    ["a line that is not a package line", "Error: java.lang.SecurityException\n__pm_exit=0\n"],
  ])("reports unknown for %s", (_label, out) => {
    expect(parseInstalledCopy(out, APP_ID)).toMatchObject({ kind: "unknown" });
  });
});

describe("flutter_uninstall", () => {
  it("fails for a named device that is offline, and uninstalls nothing anywhere", async () => {
    host({ devices: [PHONE_LINE] });

    await expect(
      runUninstallCore({ adapter: adapter(), args: { device_udid: EMULATOR } })
    ).rejects.toThrow(/"emulator-5554" \(from the device_udid argument\) is not online/);
    expect(uninstallsAnywhere()).toEqual([]);
  });

  it("requires a named device when more than one is online", async () => {
    host({ devices: [PHONE_LINE, EMULATOR_LINE], installer: { [EMULATOR]: "null" } });

    await expect(runUninstallCore({ adapter: adapter(), args: {} })).rejects.toThrow(
      /2 Android devices are online and none was named/
    );
    expect(uninstallsAnywhere()).toEqual([]);
  });

  it("leaves a Play Store copy alone without the override", async () => {
    host({ devices: [PHONE_LINE], installer: { [PHONE]: "com.android.vending" } });

    const outcome = await runUninstallCore({
      adapter: adapter(),
      args: { device_udid: PHONE },
    });

    expect(outcome.kind).toBe("refused");
    expect(uninstallsAnywhere()).toEqual([]);
  });

  it("removes a Play Store copy when the override is passed", async () => {
    host({ devices: [PHONE_LINE], installer: { [PHONE]: "com.android.vending" } });

    const outcome = await runUninstallCore({
      adapter: adapter(),
      args: { device_udid: PHONE, allow_store_app_removal: true },
    });

    expect(outcome.kind).toBe("ran");
    expect(uninstallsAnywhere()).toEqual([`adb -s '${PHONE}' uninstall '${APP_ID}'`]);
  });

  it("removes a copy installed by adb without needing the override", async () => {
    host({ devices: [EMULATOR_LINE], installer: { [EMULATOR]: "null" } });

    const outcome = await runUninstallCore({
      adapter: adapter(),
      args: { device_udid: EMULATOR },
    });

    expect(outcome.kind).toBe("ran");
    expect(uninstallsOn(EMULATOR)).toHaveLength(1);
  });
});

describe("screenshots resolve the device a deploy would", () => {
  it("honours target: simulator, capturing the emulator with the phone attached", async () => {
    host({ devices: [PHONE_LINE, EMULATOR_LINE] });

    await adapter().screenshot({
      outPath: path.join(os.tmpdir(), "never-written.png"),
      target: "simulator",
    } as Parameters<InstanceType<typeof AndroidAdapter>["screenshot"]>[0]);

    const captures = commands().filter((c) => c.includes("screencap"));
    expect(captures).toHaveLength(1);
    expect(captures[0]).toContain(`adb -s '${EMULATOR}'`);
  });
});

describe("a checkout whose debug build is com.example.app.dev, on a phone that also has the store release", () => {
  const DEV_ID = `${APP_ID}.dev`;

  /**
   * The phone as it was: the Play Store release under the base id, and the
   * debug build deploy put there under the suffixed one. `pm list packages`
   * filters by substring, so a query for the base id lists both.
   */
  function phoneWithStoreAndDevBuilds(devInstaller: string | null = "null") {
    const lines: Record<string, string> = {
      [APP_ID]: `package:${APP_ID}  installer=com.android.vending`,
    };
    if (devInstaller !== null) lines[DEV_ID] = `package:${DEV_ID}  installer=${devInstaller}`;
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith("adb devices")) {
        return ok(`List of devices attached\n${PHONE_LINE}\n`);
      }
      if (cmd === `adb -s '${PHONE}' shell '${DEVICE_IDENTITY_PROBE}'`) {
        return ok(`avd=\nserialno=${PHONE}\n`);
      }
      const removed = cmd.match(new RegExp(`^adb -s '${PHONE}' uninstall '([^']+)'$`));
      if (removed) {
        delete lines[removed[1]];
        return ok("Success");
      }
      const pm = cmd.match(/pm list packages -i ([^;']+)/);
      if (pm) {
        const listed = Object.entries(lines)
          .filter(([id]) => id.includes(pm[1].trim()))
          .map(([, line]) => `${line}\n`)
          .join("");
        return ok(`${listed}__pm_exit=0\n`);
      }
      return ok();
    });
  }

  const devTree = () => androidAppTree(APP_ID, { debug: "dev" });
  const stopsOf = (pkg: string) =>
    commands().filter((c) => c === `adb -s '${PHONE}' shell am force-stop '${pkg}'`);

  it("terminate force-stops the dev build and never the store release", async () => {
    phoneWithStoreAndDevBuilds();
    const a = adapter(undefined, devTree());

    const outcome = await runLifecycleCore({
      adapter: a,
      lifecycle: a.lifecycle,
      verb: "terminate",
      args: { device_udid: PHONE },
    });

    expect(outcome).toMatchObject({ kind: "ran", appId: DEV_ID });
    expect(stopsOf(DEV_ID)).toHaveLength(1);
    expect(commands().filter((c) => c.includes("force-stop"))).toEqual(stopsOf(DEV_ID));
  });

  it("foreground relaunches the dev build and never the store release", async () => {
    phoneWithStoreAndDevBuilds();
    const a = adapter(undefined, devTree());

    const outcome = await runLifecycleCore({
      adapter: a,
      lifecycle: a.lifecycle,
      verb: "foreground",
      args: { device_udid: PHONE },
    });

    expect(outcome).toMatchObject({ kind: "ran", appId: DEV_ID });
    expect(commands().filter((c) => c.includes("monkey"))).toEqual([
      `adb -s '${PHONE}' shell monkey -p '${DEV_ID}' -c android.intent.category.LAUNCHER 1`,
    ]);
  });

  it("uninstall removes the dev build and never the store release", async () => {
    phoneWithStoreAndDevBuilds();

    const outcome = await runUninstallCore({
      adapter: adapter(undefined, devTree()),
      args: { device_udid: PHONE },
    });

    expect(outcome).toMatchObject({ kind: "ran", appId: DEV_ID });
    expect(uninstallsAnywhere()).toEqual([`adb -s '${PHONE}' uninstall '${DEV_ID}'`]);
  });

  it("refuses to uninstall or terminate the dev id the tree guesses when deploy never put it there", async () => {
    phoneWithStoreAndDevBuilds(null);
    const a = adapter(undefined, devTree());

    const removed = await runUninstallCore({ adapter: a, args: { device_udid: PHONE } });
    const stopped = await runLifecycleCore({
      adapter: a,
      lifecycle: a.lifecycle,
      verb: "terminate",
      args: { device_udid: PHONE },
    });

    for (const outcome of [removed, stopped]) {
      expect(outcome).toMatchObject({ kind: "refused", appId: DEV_ID });
      expect(outcome.kind === "refused" && outcome.reason).toContain(
        `${DEV_ID} is not installed on ${PHONE}`
      );
    }
    expect(commands().filter((c) => /force-stop| uninstall /.test(c))).toEqual([]);
  });

  it("terminate leaves the dev id alone too when a store copy holds it", async () => {
    phoneWithStoreAndDevBuilds("com.android.vending");
    const a = adapter(undefined, devTree());

    const outcome = await runLifecycleCore({
      adapter: a,
      lifecycle: a.lifecycle,
      verb: "terminate",
      args: { device_udid: PHONE },
    });

    expect(outcome).toMatchObject({ kind: "refused", appId: DEV_ID });
    expect(outcome.kind === "refused" && outcome.reason).toContain(
      `${DEV_ID} on ${PHONE} was installed by com.android.vending`
    );
    expect(commands().filter((c) => c.includes("force-stop"))).toEqual([]);
  });

  it.each([
    ["terminate", "force-stop"],
    ["foreground", "monkey"],
  ] as const)(
    "%s acts on a store-held dev id once allow_store_app is passed, and on nothing else",
    async (verb, shellVerb) => {
      phoneWithStoreAndDevBuilds("com.android.vending");
      const a = adapter(undefined, devTree());

      const outcome = await runLifecycleCore({
        adapter: a,
        lifecycle: a.lifecycle,
        verb,
        args: { device_udid: PHONE, allow_store_app: true },
      });

      expect(outcome).toMatchObject({ kind: "ran", appId: DEV_ID });
      const acted = commands().filter((c) => c.includes(shellVerb));
      expect(acted).toHaveLength(1);
      expect(acted[0]).toContain(`'${DEV_ID}'`);
    }
  );

  it("opens a link in the dev build when no package is named", async () => {
    phoneWithStoreAndDevBuilds();
    const a = adapter(undefined, devTree());

    const result = await runOpenUrlCore({
      adapter: a,
      openUrl: a.openUrl.bind(a),
      args: { url: "https://example.com/create", device_udid: PHONE },
    });

    expect(result.opened).toBe(true);
    expect(commands().filter((c) => c.includes("am start"))).toEqual([
      `adb -s '${PHONE}' shell am start -a android.intent.action.VIEW ` +
        `-d 'https://example.com/create' '${DEV_ID}'`,
    ]);
  });

  const recordDevDeploy = () =>
    recordDeployedPackage({
      platform: "android",
      device: PHONE,
      identity: `serialno:${PHONE}`,
      packageId: DEV_ID,
    });

  it("refuses to terminate after the recorded dev build is gone, rather than report nothing to terminate", async () => {
    phoneWithStoreAndDevBuilds(null);
    recordDevDeploy();
    const a = adapter(undefined, devTree());

    const outcome = await runLifecycleCore({
      adapter: a,
      lifecycle: a.lifecycle,
      verb: "terminate",
      args: { device_udid: PHONE },
    });

    expect(outcome).toMatchObject({ kind: "refused", appId: DEV_ID });
    expect(outcome.kind === "refused" && outcome.reason).toContain(
      `${DEV_ID} is not installed on ${PHONE}. That id is what this checkout's build would produce`
    );
    expect(commands().filter((c) => c.includes("force-stop"))).toEqual([]);
  });

  it("uninstalling the recorded dev build clears the record", async () => {
    phoneWithStoreAndDevBuilds();
    recordDevDeploy();
    const a = adapter(undefined, devTree());

    const removed = await runUninstallCore({ adapter: a, args: { device_udid: PHONE } });

    expect(removed).toMatchObject({ kind: "ran", appId: DEV_ID });
    expect(findDeployedPackage("android", PHONE)).toBeUndefined();
  });

  it("keeps the record when the uninstall fails", async () => {
    phoneWithStoreAndDevBuilds();
    recordDevDeploy();
    const fallthrough = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string) =>
      / uninstall /.test(cmd)
        ? { ...ok("Failure [DELETE_FAILED_INTERNAL_ERROR]"), success: false, code: 1 }
        : fallthrough(cmd)
    );

    await runUninstallCore({ adapter: adapter(undefined, devTree()), args: { device_udid: PHONE } });

    expect(findDeployedPackage("android", PHONE)?.packageId).toBe(DEV_ID);
  });

  it("refuses to scope a link to a store-held dev id unless allow_store_app is passed", async () => {
    phoneWithStoreAndDevBuilds("com.android.vending");
    const a = adapter(undefined, devTree());
    const open = (allow_store_app?: boolean) =>
      runOpenUrlCore({
        adapter: a,
        openUrl: a.openUrl.bind(a),
        args: { url: "exampleapp://create", device_udid: PHONE, allow_store_app },
      });

    const refused = await open();
    expect(refused).toMatchObject({
      opened: false,
      reason: expect.stringContaining(`${DEV_ID} on ${PHONE} was installed by com.android.vending`),
    });
    expect(commands().filter((c) => c.includes("am start"))).toEqual([]);

    const allowed = await open(true);
    expect(allowed.opened).toBe(true);
    expect(commands().filter((c) => c.includes("am start"))).toEqual([
      `adb -s '${PHONE}' shell am start -a android.intent.action.VIEW -d 'exampleapp://create' '${DEV_ID}'`,
    ]);
  });

  it("opens no link when the package it would be scoped to cannot be named", async () => {
    phoneWithStoreAndDevBuilds();
    const a = adapter(undefined, unreadableAndroidTree());

    const result = await runOpenUrlCore({
      adapter: a,
      openUrl: a.openUrl.bind(a),
      args: { url: "https://example.com/create", device_udid: PHONE },
    });

    expect(result).toMatchObject({ opened: false, reason: expect.stringMatching(/cannot be named/) });
    expect(commands().filter((c) => c.includes("am start"))).toEqual([]);
  });

  it("refuses every verb when the tree does not say which package the build produces", async () => {
    phoneWithStoreAndDevBuilds();
    const a = adapter(undefined, unreadableAndroidTree());

    const stopped = await runLifecycleCore({
      adapter: a,
      lifecycle: a.lifecycle,
      verb: "terminate",
      args: { device_udid: PHONE },
    });
    const removed = await runUninstallCore({ adapter: a, args: { device_udid: PHONE } });

    expect(stopped).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/cannot be named, so nothing was done/),
    });
    expect(removed).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/cannot be named, so nothing was done/),
    });
    expect(commands().filter((c) => /force-stop| uninstall /.test(c))).toEqual([]);
  });
});
