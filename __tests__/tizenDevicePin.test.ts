import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// A pinned Tizen device (per-call device_udid, the configured device, or
// .tizen-target) is the only device a call acts on; an offline pin is refused
// rather than replaced. Every shell command and the Developer Mode REST probe
// are mocked, so nothing here reaches a TV.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
  buildTizenCliCommand: jest.fn(),
}));

jest.unstable_mockModule("../src/tizenDeveloperMode.js", () => ({
  diagnoseDeveloperMode: () => null,
  fetchDeveloperModeFacts: async () => ({}),
  localIpForDevice: () => undefined,
}));

const { TizenAdapter } = await import("../src/adapters/tizen.js");
const { runDeployCore, runUninstallCore } = await import("../src/deployFlow.js");

const MONITOR = "192.0.2.6:26101";
const OTHER_TV = "192.0.2.7:26101";
const APP_ID = "com.example.app";

const ok = (stdout = "") => ({
  code: 0,
  stdout,
  stderr: "",
  combined: stdout,
  success: true,
  timedOut: false,
});
const enospc = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "Install failed: No space left on device",
  success: false,
  timedOut: false,
};

let appDir: string;

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "tizen-pin-"));
  runShell.mockReset();
});
afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

function targetFile(ip: string) {
  fs.writeFileSync(
    path.join(appDir, ".tizen-target"),
    `DEVICE_IP=${ip}\n`
  );
}

function tpk(name: string) {
  const dir = path.join(appDir, "build", "tizen", "tpk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "");
}

let installResults: unknown[] = [];

/** `flutter-tizen install` returns each of `results` in turn, the last one repeating. */
function installs(...results: unknown[]) {
  installResults = results;
}

/** `sdb devices` lists `before`, then `after` once an `sdb connect` has run. */
function sdb(before: string[], after = before) {
  let connected = false;
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith("flutter-tizen install")) {
      return installResults.length > 1 ? installResults.shift() : installResults[0] ?? ok();
    }
    if (cmd.startsWith("sdb connect")) {
      connected = true;
      return ok();
    }
    if (cmd === "sdb devices") {
      const rows = (connected ? after : before).map((s) => `${s}\tdevice\tQE55`);
      return ok(`List of devices attached\n${rows.join("\n")}\n`);
    }
    return ok();
  });
}

function tizen(device?: string) {
  return new TizenAdapter({ appDir, device, appId: APP_ID });
}

const commands = () => runShell.mock.calls.map(([cmd]) => cmd);

describe("Tizen device pin", () => {
  it("resolves the device .tizen-target names, not the first online one", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV, MONITOR]);

    const r = await tizen().discoverDevice();

    expect(r).toEqual({ target: MONITOR, source: "pin" });
  });

  it("refuses when the .tizen-target device is offline, even with another TV online", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV]);

    await expect(tizen().discoverDevice()).rejects.toThrow(
      new RegExp(`"${MONITOR}" \\(from .*\\.tizen-target\\) is not online\\. Online Tizen devices: ${OTHER_TV}`)
    );
  });

  it("connects a pinned device that is not listed yet, as the CLI would, before deciding", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV], [OTHER_TV, MONITOR]);

    const r = await tizen().discoverDevice();

    expect(commands()).toContain(`sdb connect '${MONITOR}'`);
    expect(r.target).toBe(MONITOR);
  });

  it("takes the configured device over .tizen-target", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV, MONITOR]);

    const r = await tizen(OTHER_TV).discoverDevice();

    expect(r).toEqual({ target: OTHER_TV, source: "pin" });
  });

  it("takes the configured device when it agrees with .tizen-target", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV, MONITOR]);

    const r = await tizen("192.0.2.6").discoverDevice();

    expect(r).toEqual({ target: MONITOR, source: "pin" });
  });
});

describe("Tizen space recovery", () => {
  const uninstalls = () => commands().filter((c) => c.includes(" uninstall "));

  it("uninstalls on the pinned device when every tpk carries the app id", async () => {
    targetFile("192.0.2.6");
    tpk(`${APP_ID}-1.0.4.tpk`);
    sdb([OTHER_TV, MONITOR]);
    installs(enospc, ok());

    const result = await runDeployCore({
      adapter: tizen(),
      args: { no_launch: true },
    });

    expect(uninstalls()).toEqual([`sdb -s '${MONITOR}' uninstall '${APP_ID}'`]);
    expect(result.stage).toBe("installed");
  });

  it("does not uninstall when a tpk under build/tizen/tpk carries another package", async () => {
    targetFile("192.0.2.6");
    tpk(`${APP_ID}-1.0.4.tpk`);
    tpk("com.example.other-2.0.0.tpk");
    sdb([MONITOR]);
    installs(enospc);

    const result = await runDeployCore({
      adapter: tizen(),
      args: { no_launch: true },
    });

    expect(uninstalls()).toEqual([]);
    expect(result.stage).toBe("install-failed");
    expect(result.enospcRecoveryRefused).toMatch(/com\.example\.other/);
  });

  it("does not uninstall on a device nothing named", async () => {
    tpk(`${APP_ID}-1.0.4.tpk`);
    sdb([OTHER_TV]);
    installs(enospc);

    const result = await runDeployCore({
      adapter: tizen(),
      args: { no_launch: true },
    });

    expect(uninstalls()).toEqual([]);
    expect(result.enospcRecoveryRefused).toMatch(/did not name/);
  });
});

describe("Tizen device_udid", () => {
  it("takes a device_udid over .tizen-target", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV, MONITOR]);

    expect((await tizen().discoverDevice({ udid: OTHER_TV })).target).toBe(OTHER_TV);
  });

  it("uninstalls on the device_udid device, and only there", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV, MONITOR]);

    const result = await runUninstallCore({ adapter: tizen(), args: { device_udid: "192.0.2.7" } });

    expect(result.kind).toBe("ran");
    expect(commands().filter((c) => c.includes(" uninstall "))).toEqual([
      `sdb -s '${OTHER_TV}' uninstall '${APP_ID}'`,
    ]);
  });

  it("refuses a device_udid that is offline, uninstalling nothing", async () => {
    targetFile("192.0.2.6");
    sdb([MONITOR]);

    await expect(
      runUninstallCore({ adapter: tizen(), args: { device_udid: "192.0.2.7" } })
    ).rejects.toThrow(/is not online/);
    expect(commands().filter((c) => c.includes(" uninstall "))).toEqual([]);
  });

  it("accepts a device_udid that names the resolved device", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV, MONITOR]);

    expect((await tizen().discoverDevice({ udid: "192.0.2.6" })).target).toBe(MONITOR);
  });
});

describe("Tizen with nothing named", () => {
  it("refuses when more than one sdb device is online, listing them", async () => {
    sdb([OTHER_TV, MONITOR]);

    await expect(tizen().discoverDevice()).rejects.toThrow(
      /2 Tizen devices are online and none was named: 192\.0\.2\.7:26101 \(QE55\), 192\.0\.2\.6:26101 \(QE55\)/
    );
  });
});

describe("Tizen read-only resolution", () => {
  it("does not sdb-connect a pinned device on a read-only call", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV], [OTHER_TV, MONITOR]);

    await expect(tizen().discoverDevice({ readOnly: true })).rejects.toThrow(/is not online/);
    expect(commands().filter((c) => c.startsWith("sdb connect"))).toEqual([]);
  });
});

describe("Tizen deploy refusals happen before anything is torn down", () => {
  it("refuses an offline pin without killing flutter-tizen first", async () => {
    targetFile("192.0.2.6");
    sdb([OTHER_TV]);

    await expect(
      runDeployCore({ adapter: tizen(), args: { no_launch: true } })
    ).rejects.toThrow(/is not online/);
    expect(commands().filter((c) => c.startsWith("pkill"))).toEqual([]);
  });
});

describe("Tizen space recovery only fires on a storage failure", () => {
  it("does not uninstall when the install failed for another reason (certificate mismatch)", async () => {
    targetFile("192.0.2.6");
    tpk(`${APP_ID}-1.0.4.tpk`);
    sdb([MONITOR]);
    installs({
      ...enospc,
      combined: "processing result : Certificate mismatch [-37]\nInstall failed",
    });

    const result = await runDeployCore({
      adapter: tizen(),
      args: { no_launch: true },
    });

    expect(commands().filter((c) => c.includes(" uninstall "))).toEqual([]);
    expect(result.enospcRecoveryAttempted).toBe(false);
  });

  it("does not uninstall when no .tpk exists to confirm the package", async () => {
    targetFile("192.0.2.6");
    sdb([MONITOR]);
    installs(enospc);

    const result = await runDeployCore({
      adapter: tizen(),
      args: { no_launch: true },
    });

    expect(commands().filter((c) => c.includes(" uninstall "))).toEqual([]);
    expect(result.enospcRecoveryRefused).toMatch(/No \.tpk under/);
  });
});
