import { jest } from "@jest/globals";

/**
 * The per-call device pin (`device_udid`) as it travels through the SHARED
 * command core.
 *
 * The upstream commit this ports carried this plumbing in its monolithic MCP
 * handler; this repo splits that logic into `src/core/commandCore.ts`, so the
 * forwarding landed there instead. Without this file the pin would be tested
 * only at its two ends — the schema that advertises it and the Android adapter
 * that honors it — with the layer that actually carries one to the other
 * unexercised. A handler that quietly dropped `args.device_udid` would leave
 * every one of those tests green while the tool did nothing.
 *
 * A FAKE adapter is used rather than a real one: what is under test is which
 * preference the CORE hands down, not how any platform resolves it.
 */
jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  recordLaunch: jest.fn(),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  findLaunch: jest.fn(() => undefined),
  readRecords: jest.fn(() => []),
}));

jest.unstable_mockModule("../src/marionetteProbe.js", () => ({
  probeMarionetteReady: jest.fn(async () => ({ marionetteReady: true })),
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

const PINNED = "emulator-5554";

/** Everything the core handed down that carries a device preference. */
interface Seen {
  discover: ({ udid?: string; kind?: string } | undefined)[];
  input: ({ udid?: string } | undefined)[];
  screenshot: (string | undefined)[];
  record: (string | undefined)[];
  geometry: ({ udid?: string } | undefined)[];
}

/**
 * @param inputWarning what `inputDeviceWarning()` reports after a send — the
 * seam an adapter with a lazily-resolved controller (Android) uses to surface a
 * self-healed pin, and the thing key/pointer must copy into their JSON.
 */
function fakeAdapter(inputWarning?: string) {
  const seen: Seen = {
    discover: [],
    input: [],
    screenshot: [],
    record: [],
    geometry: [],
  };
  const adapter = {
    platform: "android",
    appId: "com.example.exampleapp",
    seen,
    async discoverDevice(preference?: { udid?: string; kind?: string }) {
      seen.discover.push(preference);
      return { target: preference?.udid ?? "default-device", source: "pin" as const };
    },
    async install() {
      return okResult;
    },
    async launchAndCaptureUri() {
      return {
        vmServiceUriWs: "ws://127.0.0.1:1/ws",
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
    async screenshot(opts: { deviceUdid?: string }) {
      seen.screenshot.push(opts.deviceUdid);
      return { captured: true, savedPath: "/tmp/shot.png" };
    },
    async record(opts: { deviceUdid?: string }) {
      seen.record.push(opts.deviceUdid);
      return { recorded: true, savedPath: "/tmp/clip.mp4" };
    },
    async geometry(preference?: { udid?: string }) {
      seen.geometry.push(preference);
      return {
        device: preference?.udid ?? "default-device",
        displaySize: { width: 1080, height: 2400 },
        density: { effective: 440 },
        dpr: 2.75,
        dprSource: "density",
        logicalDisplaySize: { width: 393, height: 873 },
      };
    },
    lifecycle: {
      async terminate() {
        return okResult;
      },
      async background() {
        return okResult;
      },
      async foreground() {
        return okResult;
      },
    },
    input(preference?: { udid?: string }) {
      seen.input.push(preference);
      return {
        platform: "android",
        mode: "pointer" as const,
        setMode() {},
        async key() {},
        async text() {},
        async pointerMove() {},
        async pointerClick() {},
        async pointerScroll() {},
      };
    },
    inputDeviceWarning() {
      return inputWarning;
    },
  };
  return adapter;
}

function coreFor(adapter: ReturnType<typeof fakeAdapter>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new AdapterRegistry([adapter as any], "android" as any);
  return new CommandCore(registry, {
    appDir: "/tmp/app",
    appDirSource: "flag",
    fvm: false,
    defaultPlatform: "android",
    defaultPlatformSource: "flag",
    platforms: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe("device_udid reaches discoverDevice from every device-addressing tool", () => {
  it("uninstall", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).uninstall({ platform: "android", device_udid: PINNED });
    expect(adapter.seen.discover).toEqual([{ udid: PINNED }]);
  });

  it.each(["terminate", "background", "foreground"] as const)("%s", async (verb) => {
    const adapter = fakeAdapter();
    await coreFor(adapter)[verb]({ platform: "android", device_udid: PINNED });
    expect(adapter.seen.discover).toEqual([{ udid: PINNED }]);
  });

  it("deploy (alongside the iOS device-vs-simulator kind)", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).deploy({ platform: "android", device_udid: PINNED });
    expect(adapter.seen.discover[0]).toMatchObject({ udid: PINNED });
  });

  it("geometry", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).geometry({ platform: "android", device_udid: PINNED });
    expect(adapter.seen.geometry).toEqual([{ udid: PINNED }]);
  });

  it("screenshot forwards it as the adapter's deviceUdid option", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).screenshot({ platform: "android", device_udid: PINNED });
    expect(adapter.seen.screenshot).toEqual([PINNED]);
  });

  it("record forwards it as the adapter's deviceUdid option", async () => {
    const adapter = fakeAdapter();
    await coreFor(adapter).record({ platform: "android", device_udid: PINNED });
    expect(adapter.seen.record).toEqual([PINNED]);
  });

  it("key and pointer pin the input controller for the call", async () => {
    const adapter = fakeAdapter();
    const core = coreFor(adapter);
    await core.key({ platform: "android", key: "HOME", device_udid: PINNED });
    await core.pointer({ platform: "android", action: "click", device_udid: PINNED });
    expect(adapter.seen.input).toEqual([{ udid: PINNED }, { udid: PINNED }]);
  });

  it("passes undefined — not a pin — when the call names no device", async () => {
    // The pin must not be invented: an adapter that saw `{ udid: "" }` or a
    // stale value would resolve somewhere the caller never asked for.
    const adapter = fakeAdapter();
    const core = coreFor(adapter);
    await core.uninstall({ platform: "android" });
    await core.key({ platform: "android", key: "HOME" });
    expect(adapter.seen.discover).toEqual([{ udid: undefined }]);
    expect(adapter.seen.input).toEqual([{ udid: undefined }]);
  });
});

describe("the input path's deviceWarning is reported back to the caller", () => {
  const WARNING =
    "The per-call device pin (device_udid) names emulator-5554, but that " +
    "target is not an online adb device.";

  it("flutter_key reports it on a key send", async () => {
    const result = (await coreFor(fakeAdapter(WARNING)).key({
      platform: "android",
      key: "HOME",
      device_udid: PINNED,
    })) as AnyRecord;
    expect(result.deviceWarning).toBe(WARNING);
  });

  it("flutter_key reports it on a text send", async () => {
    const result = (await coreFor(fakeAdapter(WARNING)).key({
      platform: "android",
      text: "hello",
      device_udid: PINNED,
    })) as AnyRecord;
    expect(result.deviceWarning).toBe(WARNING);
  });

  it.each(["move", "click", "scroll"] as const)(
    "flutter_pointer reports it on %s",
    async (action) => {
      const result = (await coreFor(fakeAdapter(WARNING)).pointer({
        platform: "android",
        action,
        x: 10,
        y: 20,
        dy: 30,
        device_udid: PINNED,
      })) as AnyRecord;
      expect(result.deviceWarning).toBe(WARNING);
    }
  );

  it("reports no warning when the adapter has none", async () => {
    const result = (await coreFor(fakeAdapter()).key({
      platform: "android",
      key: "HOME",
    })) as AnyRecord;
    expect(result.deviceWarning).toBeUndefined();
  });

  it("survives an adapter that does not implement the optional seam", async () => {
    // inputDeviceWarning is OPTIONAL on PlatformAdapter — a TV adapter omits it
    // entirely, and the core must read it through the optional-call form rather
    // than throwing on a platform that never had a per-call device concept.
    const adapter = fakeAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (adapter as any).inputDeviceWarning;
    const result = (await coreFor(adapter).key({
      platform: "android",
      key: "HOME",
    })) as AnyRecord;
    expect(result.sent).toBe(true);
    expect(result.deviceWarning).toBeUndefined();
  });
});
