import { jest } from "@jest/globals";

/**
 * The macOS-specific branches in the SHARED command core.
 *
 * The upstream commit this ports carried these as conditionals in its
 * monolithic MCP handler; this repo splits that logic into
 * `src/core/commandCore.ts`, so they landed there instead. Nothing else in the
 * suite constructs a CommandCore, so without this file the macOS wiring —
 * "skip the Marionette probe and the launch record when there is no VM
 * service", the macOS deploy note, the macOS geometry contract, and the
 * `absolute`/`double` pointer passthrough — would be entirely unexercised.
 *
 * A FAKE adapter is used rather than the real MacosAdapter: what is under test
 * is the core's behavior GIVEN an adapter that reports no VM service, not how
 * macOS produces one.
 */
const recordLaunch = jest.fn<(record: unknown) => void>();
jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  recordLaunch,
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  findLaunch: jest.fn(() => undefined),
  readRecords: jest.fn(() => []),
}));

// The probe must never be reached on a platform with no VM service; calling it
// with an empty ws:// URI is exactly the failure this branch prevents.
const probeMarionetteReady = jest.fn(async () => ({
  marionetteReady: true as boolean | null,
}));
jest.unstable_mockModule("../src/marionetteProbe.js", () => ({
  probeMarionetteReady,
  MARIONETTE_ABSENT_HINT: "",
}));

const { CommandCore } = await import("../src/core/commandCore.js");
const { AdapterRegistry } = await import("../src/adapters/registry.js");

type AnyRecord = Record<string, unknown>;

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

/** Records what the core handed the input controller, per verb. */
interface InputCalls {
  move: { x: number; y: number; opts?: unknown }[];
  click: { opts?: unknown }[];
  scroll: { dy: number; opts?: unknown }[];
}

function fakeAdapter(platform: string, opts: { vmServiceUriWs?: string } = {}) {
  const inputCalls: InputCalls = { move: [], click: [], scroll: [] };
  const adapter = {
    platform,
    appId: "com.example.exampleapp",
    inputCalls,
    async info() {
      return okResult;
    },
    async setup() {
      return { result: okResult };
    },
    async build() {
      return {
        result: { ...okResult, success: false, combined: "no build path here" },
        enospc: false,
        installFailed: false,
        launchedDisplay: false,
        supported: false as const,
      };
    },
    async discoverDevice() {
      return { target: "example-app", source: "pin" as const };
    },
    async install() {
      return okResult;
    },
    async launchAndCaptureUri() {
      return {
        vmServiceUriWs: opts.vmServiceUriWs ?? "",
        vmServiceUriHttp: "",
        logPath: "",
        pid: 4242,
      };
    },
    async uninstall() {
      return okResult;
    },
    async killStale() {
      return {};
    },
    async geometry() {
      return {
        device: "example-app",
        displaySize: { width: 1400, height: 900 },
        density: { effective: 2 },
        dpr: 2,
        dprSource: "backingScaleFactor",
        logicalDisplaySize: { width: 1400, height: 900 },
      };
    },
    input() {
      return {
        platform,
        mode: "pointer" as const,
        setMode() {},
        async key() {},
        async pointerMove(x: number, y: number, o?: unknown) {
          inputCalls.move.push({ x, y, opts: o });
        },
        async pointerClick(o?: unknown) {
          inputCalls.click.push({ opts: o });
        },
        async pointerScroll(dy: number, o?: unknown) {
          inputCalls.scroll.push({ dy, opts: o });
        },
      };
    },
  };
  return adapter;
}

function coreFor(adapter: ReturnType<typeof fakeAdapter>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new AdapterRegistry([adapter as any], adapter.platform as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

beforeEach(() => {
  recordLaunch.mockClear();
  probeMarionetteReady.mockClear();
});

describe("deploy on a platform with NO Dart VM service (macOS)", () => {
  it("skips the Marionette probe instead of dialing an empty ws:// URI", async () => {
    const adapter = fakeAdapter("macos");
    const result = (await coreFor(adapter).deploy({})) as AnyRecord;
    expect(probeMarionetteReady).not.toHaveBeenCalled();
    expect(result.marionetteReady).toBeNull();
    expect(String(result.marionetteHint)).toMatch(/no Dart VM service/i);
  });

  it("does NOT record the launch — there is no daemon to reconnect to", async () => {
    const adapter = fakeAdapter("macos");
    await coreFor(adapter).deploy({});
    expect(recordLaunch).not.toHaveBeenCalled();
  });

  it("still records the launch, and probes, when a URI WAS captured", async () => {
    const adapter = fakeAdapter("ios", { vmServiceUriWs: "ws://127.0.0.1:1/ws" });
    await coreFor(adapter).deploy({});
    expect(recordLaunch).toHaveBeenCalledTimes(1);
    expect(probeMarionetteReady).toHaveBeenCalledTimes(1);
  });

  it("returns the macOS note (scratch dir, pointer/key/screenshot driver, no hot reload)", async () => {
    const adapter = fakeAdapter("macos");
    const result = (await coreFor(adapter).deploy({})) as AnyRecord;
    const note = String(result.note);
    expect(note).toMatch(/never \/Applications/);
    expect(note).toMatch(/flutter_pointer/);
    expect(note).toMatch(/flutter_hot_reload\/flutter_hot_restart do not apply/);
    // The VM-service note for the other platforms must NOT leak in.
    expect(note).not.toMatch(/left running to hold the VM service/);
  });

  it("threads app_path/app_url through to the adapter's install", async () => {
    const adapter = fakeAdapter("macos");
    const install = jest.fn(async () => okResult);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).install = install;
    await coreFor(adapter).deploy({
      app_path: "/tmp/Example App.app",
      app_url: "https://example.com/app.dmg",
    });
    expect(install).toHaveBeenCalledWith(
      "example-app",
      expect.objectContaining({
        appPath: "/tmp/Example App.app",
        appUrl: "https://example.com/app.dmg",
      })
    );
  });
});

describe("build on a platform with no build path", () => {
  it("surfaces the adapter's supported:false rather than dropping it", async () => {
    const adapter = fakeAdapter("macos");
    const result = (await coreFor(adapter).build({})) as AnyRecord;
    expect(result.supported).toBe(false);
  });
});

describe("geometry note per platform", () => {
  it("uses the macOS point-space contract on macos", async () => {
    const adapter = fakeAdapter("macos");
    const result = (await coreFor(adapter).geometry({})) as AnyRecord;
    expect(String(result.note)).toMatch(/TARGET WINDOW's bounds in POINTS/);
    expect(String(result.note)).toMatch(/does NOT scale/);
  });

  it("uses the device-pixel contract everywhere else", async () => {
    const adapter = fakeAdapter("android");
    const result = (await coreFor(adapter).geometry({})) as AnyRecord;
    expect(String(result.note)).toMatch(/DISPLAY device pixels/);
  });
});

describe("pointer escape hatches", () => {
  it("passes `absolute` through to pointerMove for 'move'", async () => {
    const adapter = fakeAdapter("macos");
    const result = (await coreFor(adapter).pointer({
      action: "move",
      x: 50,
      y: 60,
      absolute: true,
    })) as AnyRecord;
    expect(adapter.inputCalls.move).toEqual([
      { x: 50, y: 60, opts: { absolute: true } },
    ]);
    expect(result.absolute).toBe(true);
  });

  it("passes `absolute` through to the staging move of a coordinate 'click'", async () => {
    const adapter = fakeAdapter("macos");
    await coreFor(adapter).pointer({
      action: "click",
      x: 10,
      y: 20,
      absolute: true,
    });
    expect(adapter.inputCalls.move).toEqual([
      { x: 10, y: 20, opts: { absolute: true } },
    ]);
  });

  it("passes `double` through to pointerClick", async () => {
    const adapter = fakeAdapter("macos");
    await coreFor(adapter).pointer({ action: "click", double: true });
    expect(adapter.inputCalls.click).toEqual([{ opts: { double: true } }]);
  });

  it("leaves both undefined when the caller passes neither", async () => {
    const adapter = fakeAdapter("android");
    await coreFor(adapter).pointer({ action: "move", x: 1, y: 2 });
    await coreFor(adapter).pointer({ action: "click" });
    expect(adapter.inputCalls.move[0].opts).toEqual({ absolute: undefined });
    expect(adapter.inputCalls.click[0].opts).toEqual({ double: undefined });
  });
});
