import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * `local_backend` and `flutter_diagnose` as they travel through the SHARED
 * command core.
 *
 * `localBackend.test.ts` and `iosRuntimeDiagnostics.test.ts` prove the pure
 * resolvers. They cannot prove the wiring, and the wiring is where this feature
 * was actually broken: the first version merged the injected host into the
 * INSTALL's defines and handed the LAUNCH the caller's raw `dart_define`. On
 * iOS/Android the launch is the `flutter run` that compiles the app, so the
 * host never reached the binary, and every resolver test stayed green.
 *
 * A FAKE adapter is used: what is under test is what the core hands down.
 */
const launchRecords: Record<string, unknown>[] = [];
jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  recordLaunch: jest.fn(),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  findLaunch: jest.fn(() => undefined),
  resolveLaunch: jest.fn(() =>
    launchRecords.length > 0
      ? { kind: "found", record: launchRecords[launchRecords.length - 1] }
      : { kind: "none" }
  ),
  readRecords: jest.fn(() => []),
}));

jest.unstable_mockModule("../src/marionetteProbe.js", () => ({
  probeMarionetteReady: jest.fn(async () => ({ marionetteReady: true })),
  MARIONETTE_ABSENT_HINT: "",
}));

const { CommandCore } = await import("../src/core/commandCore.js");
const { AdapterRegistry } = await import("../src/adapters/registry.js");
const { androidKindFromSerial } = await import("../src/localBackend.js");

type Defines = Record<string, string> | undefined;

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

interface FakeOpts {
  platform?: string;
  serial?: string;
  compiles?: boolean;
  /** Force a target kind; by default Android's serial convention decides. */
  kind?: "simulator" | "emulator" | "device";
  tunnelOk?: boolean;
  crashClassifier?: boolean;
}

function fakeAdapter(o: FakeOpts = {}) {
  const seen = {
    install: [] as Defines[],
    launch: [] as Defines[],
    tunnels: [] as { device: string; ports: number[] }[],
  };
  const adapter: Record<string, unknown> = {
    platform: o.platform ?? "android",
    appId: "com.example.app",
    killStaleScope: "device" as const,
    seen,
    async discoverDevice() {
      return { target: o.serial ?? "emulator-5554", source: "pin" as const };
    },
    async install(_d: string, opts: { dartDefine?: Defines }) {
      seen.install.push(opts.dartDefine);
      return okResult;
    },
    async launchAndCaptureUri(_d: string, _t: number, _m: unknown, defines: Defines) {
      seen.launch.push(defines);
      return { vmServiceUriWs: "ws://127.0.0.1:1/ws", vmServiceUriHttp: "", logPath: "", pid: 1 };
    },
    async uninstall() {
      return okResult;
    },
    async killStale() {
      return {};
    },
    targetKind(device: string) {
      return o.kind ?? androidKindFromSerial(device);
    },
    async setupReverseTunnels(device: string, ports: number[]) {
      seen.tunnels.push({ device, ports });
      return o.tunnelOk === false
        ? { ok: false, detail: "adb reverse FAILED for tcp:8080 (boom)." }
        : { ok: true, detail: `adb reverse established for ${ports.join(", ")}.` };
    },
  };
  if (o.compiles !== false) adapter.deployCompilesDefines = true;
  if (o.crashClassifier !== false) {
    adapter.runtimeCrashDiagnostic = (log: string) =>
      /constant buffers/.test(log) ? "Impeller constant-buffer overflow" : null;
  }
  return adapter as typeof adapter & { seen: typeof seen };
}

function coreFor(adapter: ReturnType<typeof fakeAdapter>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new AdapterRegistry([adapter as any], adapter.platform as any);
  return new CommandCore(registry, {
    appDir: "/tmp/app",
    appDirSource: "flag",
    fvm: false,
    defaultPlatform: adapter.platform,
    defaultPlatformSource: "flag",
    platforms: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = any;

describe("local_backend through deploy", () => {
  it("hands the injected host to the LAUNCH, not only the install", async () => {
    // The regression this file exists for. The launch is the compile on
    // iOS/Android; a define that reaches only the install never runs.
    const adapter = fakeAdapter({ serial: "emulator-5554" });
    const out: Out = await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
    } as Out);
    expect(out.success).toBe(true);
    const expected = { USE_LOCAL_ENV: "true", LOCAL_HOST: "10.0.2.2" };
    expect(adapter.seen.launch).toEqual([expected]);
    expect(adapter.seen.install).toEqual([expected]);
    expect(out.localBackend).toMatchObject({ targetKind: "emulator", host: "10.0.2.2" });
  });

  it("injects nothing when local_backend is off (control)", async () => {
    // Without this, the test above would also pass for a core that injected a
    // host into every deploy.
    const adapter = fakeAdapter();
    const out: Out = await coreFor(adapter).deploy({
      platform: "android",
      dart_define: { FLAVOR: "dev" },
    } as Out);
    expect(adapter.seen.launch).toEqual([{ FLAVOR: "dev" }]);
    expect(out.localBackend).toBeUndefined();
  });

  it("lets an explicit dart_define for the same key win", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
      dart_define: { LOCAL_HOST: "api.test", FLAVOR: "dev" },
    } as Out);
    expect(adapter.seen.launch).toEqual([
      { USE_LOCAL_ENV: "true", LOCAL_HOST: "api.test", FLAVOR: "dev" },
    ]);
  });

  it("honours renamed define keys", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
      local_backend_keys: { env: "LOCAL", host: "API_HOST" },
    } as Out);
    expect(adapter.seen.launch).toEqual([{ LOCAL: "true", API_HOST: "10.0.2.2" }]);
  });

  it("tunnels every port on Android hardware before installing", async () => {
    const adapter = fakeAdapter({ serial: "R58M123ABC" });
    const out: Out = await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
      local_backend_ports: [9099, 8080],
    } as Out);
    expect(out.success).toBe(true);
    expect(adapter.seen.tunnels).toEqual([{ device: "R58M123ABC", ports: [8080, 9099] }]);
    expect(adapter.seen.launch[0]).toMatchObject({ LOCAL_HOST: "localhost" });
  });

  it("stops before installing when the tunnel fails", async () => {
    const adapter = fakeAdapter({ serial: "R58M123ABC", tunnelOk: false });
    const out: Out = await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
      local_backend_ports: [8080],
    } as Out);
    expect(out).toMatchObject({ success: false, stage: "local-backend" });
    expect(out.reason).toMatch(/adb reverse FAILED/);
    expect(adapter.seen.install).toEqual([]);
    expect(adapter.seen.launch).toEqual([]);
  });

  it("refuses Android hardware with no ports rather than guessing", async () => {
    const adapter = fakeAdapter({ serial: "R58M123ABC" });
    const out: Out = await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
    } as Out);
    expect(out).toMatchObject({ success: false, stage: "local-backend" });
    expect(adapter.seen.install).toEqual([]);
  });

  it("skips the tunnel for an explicit ROUTABLE host, even with ports", async () => {
    // The tunnel only makes a loopback name true. A LAN host never needed it,
    // so a failing `adb reverse` must not be able to abort this deploy.
    const adapter = fakeAdapter({ serial: "R58M123ABC", tunnelOk: false });
    const out: Out = await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
      local_backend_ports: [8080],
      local_backend_host: "192.168.1.20",
    } as Out);
    expect(out.success).toBe(true);
    expect(adapter.seen.tunnels).toEqual([]);
    expect(adapter.seen.launch[0]).toMatchObject({ LOCAL_HOST: "192.168.1.20" });
  });

  it("still tunnels for an explicit LOOPBACK host (control)", async () => {
    const adapter = fakeAdapter({ serial: "R58M123ABC" });
    await coreFor(adapter).deploy({
      platform: "android",
      local_backend: true,
      local_backend_ports: [8080],
      local_backend_host: "127.0.0.1",
    } as Out);
    expect(adapter.seen.tunnels).toEqual([{ device: "R58M123ABC", ports: [8080] }]);
  });

  it("refuses on a platform whose deploy does not compile, and hands over the host", async () => {
    // `kind: simulator` keeps resolution independent of this machine's network
    // interfaces. What matters is the refusal, not which host was resolved.
    const adapter = fakeAdapter({ platform: "tizen", compiles: false, kind: "simulator" });
    const out: Out = await coreFor(adapter).deploy({
      platform: "tizen",
      local_backend: true,
    } as Out);
    expect(out).toMatchObject({ success: false, stage: "local-backend" });
    expect(out.reason).toMatch(/compiled EARLIER/);
    expect(out.reason).toMatch(/flutter_build/);
    expect(out.localBackend.buildDartDefine).toEqual({
      USE_LOCAL_ENV: "true",
      LOCAL_HOST: "localhost",
    });
    expect(adapter.seen.install).toEqual([]);
    expect(adapter.seen.tunnels).toEqual([]);
  });
});

describe("flutter_diagnose through the core", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdm-diagnose-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    launchRecords.length = 0;
  });

  it("names a crash in an explicit log", async () => {
    const log = write("crash.log", "Syncing...\nexpected only 14 constant buffers, but 16 were used\n");
    const out: Out = await coreFor(fakeAdapter({ platform: "ios" })).diagnose({
      platform: "ios",
      log_path: log,
    } as Out);
    expect(out).toMatchObject({ success: true, crashFound: true });
    expect(out.runtimeDiagnostic).toMatch(/Impeller/);
  });

  it("reads the most recent recorded launch's log when none is given", async () => {
    const log = write("recorded.log", "expected only 14 constant buffers, but 16 were used");
    launchRecords.push({ device: "sim-1", logPath: log });
    const out: Out = await coreFor(fakeAdapter({ platform: "ios" })).diagnose({
      platform: "ios",
    } as Out);
    expect(out).toMatchObject({ crashFound: true, device: "sim-1", logPath: log });
  });

  it("says no KNOWN class matched for a clean log, never 'healthy'", async () => {
    const log = write("clean.log", "Syncing files to device...\n");
    const out: Out = await coreFor(fakeAdapter({ platform: "ios" })).diagnose({
      platform: "ios",
      log_path: log,
    } as Out);
    expect(out).toMatchObject({ success: true, crashFound: false });
    expect(out.note).toMatch(/not the same as the app being healthy/);
  });

  it("fails when the log cannot be read, instead of reporting it clean", async () => {
    const out: Out = await coreFor(fakeAdapter({ platform: "ios" })).diagnose({
      platform: "ios",
      log_path: path.join(dir, "missing.log"),
    } as Out);
    expect(out.success).toBe(false);
    expect(out.crashFound).toBeUndefined();
    expect(out.reason).toMatch(/NOT a finding that the log is clean/);
  });

  it("says the log was NOT examined on a platform with no classifier", async () => {
    const log = write("android.log", "expected only 14 constant buffers, but 16 were used");
    const out: Out = await coreFor(fakeAdapter({ crashClassifier: false })).diagnose({
      platform: "android",
      log_path: log,
    } as Out);
    expect(out.crashFound).toBe(false);
    expect(out.note).toMatch(/NOT\s+examined/);
  });

  it("fails with no recorded launch and no log_path", async () => {
    const out: Out = await coreFor(fakeAdapter({ platform: "ios" })).diagnose({
      platform: "ios",
    } as Out);
    expect(out.success).toBe(false);
    expect(out.reason).toMatch(/No launch is recorded/);
  });
});
