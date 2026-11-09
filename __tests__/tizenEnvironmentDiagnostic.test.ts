import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// Every shell command and the :8001 REST probe are mocked: nothing here reaches
// a TV.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
  buildTizenCliCommand: jest.fn(),
}));

const HOST = "192.0.2.210";
jest.unstable_mockModule("../src/tizenDeveloperMode.js", () => ({
  localIpForDevice: () => HOST,
}));

const { TizenAdapter } = await import("../src/adapters/tizen.js");

const MONITOR = "192.0.2.6";
const OTHER = "192.0.2.7";
const ENV_PIN = "192.0.2.8";
const ARG_IP = "192.0.2.9";

const shell = (stdout: string) => ({
  code: 0,
  stdout,
  stderr: "",
  combined: stdout,
  success: true,
  timedOut: false,
});

let dir: string;
let fetchMock: jest.Mock<(url: string) => Promise<unknown>>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tizen-env-diag-"));
  runShell.mockReset();
  fetchMock = jest.fn<(url: string) => Promise<unknown>>();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

function adapter(device?: string) {
  fs.writeFileSync(path.join(dir, ".tizen-target"), `DEVICE_IP=${MONITOR}\n`);
  const registry = path.join(dir, "launches.json");
  const record = (platform: string, ip: string) => ({
    platform,
    device: `${ip}:26101`,
    vmServiceUriWs: "ws://127.0.0.1:1/ws",
    recordedAt: 1,
  });
  fs.writeFileSync(
    registry,
    JSON.stringify([record("tizen", OTHER), record("android", "198.51.100.9"), record("tizen", MONITOR)])
  );
  return new TizenAdapter({
    appDir: dir,
    device,
    appId: "com.example.app",
    launchRegistryPath: registry,
  });
}

/** `sdb devices` lists nothing; `sdb connect` fails for every address. */
function noDeviceConnects(connected: string[] = []) {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith("sdb devices")) return shell("List of devices attached\n");
    const ip = /sdb connect '([\d.]+):26101'/.exec(cmd)?.[1];
    return shell(
      ip && connected.includes(ip)
        ? `connected to ${ip}:26101`
        : `failed to connect to ${ip}:26101`
    );
  });
}

function restAnswers(developerIP: string, answering: string[] = [MONITOR]) {
  fetchMock.mockImplementation(async (url: string) =>
    answering.some((ip) => url.includes(`//${ip}:`))
      ? { ok: true, json: async () => ({ device: { developerMode: "1", developerIP } }) }
      : Promise.reject(new Error("ECONNREFUSED"))
  );
}

describe("TizenAdapter.environmentDiagnostic", () => {
  it("reports nothing for a resolved device whose REST developerIP is not this host", async () => {
    restAnswers(OTHER);
    const resolved = { target: `${MONITOR}:26101`, source: "pin" } as never;
    await expect(adapter().environmentDiagnostic(resolved)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runShell).not.toHaveBeenCalled();
  });

  it("reports nothing when discovery finds the device online", async () => {
    restAnswers(OTHER);
    runShell.mockImplementation(async () =>
      shell(`List of devices attached\n${MONITOR}:26101\tdevice\tTV\n`)
    );
    await expect(adapter().environmentDiagnostic()).resolves.toBeNull();
    expect(runShell).not.toHaveBeenCalledWith(expect.stringContaining("sdb connect"), expect.anything());
  });

  it("probes every candidate once and gives the fix for each connect that failed", async () => {
    noDeviceConnects();
    restAnswers(OTHER);
    const text = await adapter(ENV_PIN).environmentDiagnostic(undefined, { deviceIp: ARG_IP });
    const connects = runShell.mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.startsWith("sdb connect"))
      .sort();
    expect(connects).toEqual(
      [ARG_IP, ENV_PIN, MONITOR, OTHER].sort().map((ip) => `sdb connect '${ip}:26101'`)
    );
    for (const ip of [ARG_IP, ENV_PIN, MONITOR, OTHER]) {
      expect(text).toContain(`${ip}: `);
    }
    expect(text).toContain(`${MONITOR}: :8001 answers (it reports Host PC IP ${OTHER}, a hint only), but sdb connect failed`);
    expect(text).toContain(`${OTHER}: :8001 does not answer, and sdb connect failed`);
    expect(text).toContain(
      `Apps → 12345 → Developer mode → set Host PC IP to ${HOST} → restart the TV.`
    );
    expect(text).not.toContain("198.51.100.9");
  });

  it("does not take the REST developerIP matching this host as proof the TV is fine", async () => {
    noDeviceConnects();
    restAnswers(HOST);
    const text = await adapter().environmentDiagnostic();
    expect(text).toContain(`${MONITOR}: :8001 answers (it reports Host PC IP ${HOST}, a hint only), but sdb connect failed`);
    expect(text).toContain("restart the TV");
  });

  it("says retry, with no fix, when sdb connect now succeeds", async () => {
    noDeviceConnects([MONITOR, OTHER]);
    restAnswers(OTHER);
    const text = await adapter().environmentDiagnostic();
    expect(text).toContain(`${MONITOR}: :8001 answers`);
    expect(text).toContain("sdb connect succeeded (connected to");
    expect(text).not.toContain("restart the TV");
  });
});
