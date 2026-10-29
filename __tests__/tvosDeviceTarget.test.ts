import {
  isAppleTv,
  isDevicectlAppleTv,
  parseDevicectlAppleTvs,
  parseFlutterTvosDevices,
  parseTvosSimulators,
  resolveTvosTarget,
  TvosDevice,
} from "../src/tvosDeviceTarget.js";

describe("isAppleTv", () => {
  it("accepts a tvOS sdk string (the fork reports Apple TVs as targetPlatform ios)", () => {
    expect(isAppleTv("tvOS 26.5 (23L...)")).toBe(true);
    expect(isAppleTv("TVOS 18.0")).toBe(true);
  });
  it("rejects an iOS/iPadOS sdk string", () => {
    expect(isAppleTv("iOS 18.0 (22A...)")).toBe(false);
    expect(isAppleTv("iPadOS 18.0")).toBe(false);
    expect(isAppleTv(undefined)).toBe(false);
    expect(isAppleTv("")).toBe(false);
  });
});

describe("parseFlutterTvosDevices", () => {
  // The KEY failing shape: flutter-tvos lists an Apple TV AND an iPhone, both
  // with targetPlatform "ios"; only the `sdk` string tells them apart.
  const MACHINE = JSON.stringify([
    {
      name: "Example Apple TV",
      id: "A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D",
      targetPlatform: "ios",
      emulator: false,
      sdk: "tvOS 26.5 (23L...)",
      isSupported: true,
    },
    {
      name: "My iPhone",
      id: "00008020-000000000000AAAA",
      targetPlatform: "ios",
      emulator: false,
      sdk: "iOS 18.0 (22A...)",
      isSupported: true,
    },
    {
      name: "Apple TV 4K sim",
      id: "SIM-TVOS-UUID",
      targetPlatform: "ios",
      emulator: true, // simulator — handled via simctl, excluded here
      sdk: "tvOS 18.0",
      isSupported: true,
    },
    {
      name: "macOS",
      id: "macos",
      targetPlatform: "darwin",
      emulator: false,
      isSupported: true,
    },
  ]);

  it("keeps ONLY the physical Apple TV (tvOS sdk, non-emulator)", () => {
    const devices = parseFlutterTvosDevices(MACHINE);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
    expect(devices[0].name).toBe("Example Apple TV");
    expect(devices[0].kind).toBe("device");
    expect(devices[0].available).toBe(true);
  });

  it("does NOT pick the iPhone even though it reports targetPlatform ios", () => {
    const devices = parseFlutterTvosDevices(MACHINE);
    expect(devices.some((d) => /iPhone/i.test(d.name ?? ""))).toBe(false);
    expect(
      devices.some((d) => d.id === "00008020-000000000000AAAA")
    ).toBe(false);
  });

  it("excludes the tvOS SIMULATOR entry (emulator:true)", () => {
    const devices = parseFlutterTvosDevices(MACHINE);
    expect(devices.some((d) => d.id === "SIM-TVOS-UUID")).toBe(false);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseFlutterTvosDevices("nope")).toEqual([]);
    expect(parseFlutterTvosDevices("")).toEqual([]);
  });
});

describe("isDevicectlAppleTv", () => {
  it("accepts an Apple TV by deviceType or platform", () => {
    expect(isDevicectlAppleTv("appleTV", "tvOS")).toBe(true);
    expect(isDevicectlAppleTv("appleTV", undefined)).toBe(true);
    expect(isDevicectlAppleTv(undefined, "tvOS")).toBe(true);
  });
  it("rejects iPhone/iPad", () => {
    expect(isDevicectlAppleTv("iPhone", "iOS")).toBe(false);
    expect(isDevicectlAppleTv("iPad", "iOS")).toBe(false);
    expect(isDevicectlAppleTv(undefined, undefined)).toBe(false);
  });
});

describe("parseDevicectlAppleTvs", () => {
  // The real `devicectl list devices --json-output` shape (trimmed): a paired
  // Apple TV whose on-demand tunnel is DISCONNECTED (still usable) next to a
  // paired iPhone that must be excluded — the exact live-device situation.
  const DEVICECTL = JSON.stringify({
    result: {
      devices: [
        {
          identifier: "A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D",
          deviceProperties: {
            name: "Example Apple TV",
            osVersionNumber: "27.0",
            osBuildUpdate: "24J361",
          },
          connectionProperties: {
            pairingState: "paired",
            tunnelState: "disconnected",
          },
          hardwareProperties: {
            deviceType: "appleTV",
            platform: "tvOS",
            productType: "AppleTV14,1",
            udid: "00000000-0000000000000000",
          },
        },
        {
          identifier: "E1E2E3E4-0000-4000-8000-000000000AC4",
          deviceProperties: { name: "iPhone" },
          connectionProperties: {
            pairingState: "paired",
            tunnelState: "connected",
          },
          hardwareProperties: {
            deviceType: "iPhone",
            platform: "iOS",
            productType: "iPhone11,8",
          },
        },
      ],
    },
  });

  it("keeps ONLY the AppleTV14,1 entry and reports it available while paired", () => {
    const devices = parseDevicectlAppleTvs(DEVICECTL);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
    expect(devices[0].name).toBe("Example Apple TV");
    expect(devices[0].kind).toBe("device");
    // Paired => available, even though the tunnel is disconnected.
    expect(devices[0].available).toBe(true);
  });

  it("carries the hardware UDID through to the resolution, for pymobiledevice3", () => {
    const devices = parseDevicectlAppleTvs(DEVICECTL);
    expect(devices[0].hardwareUdid).toBe("00000000-0000000000000000");
    const resolution = resolveTvosTarget(undefined, devices, []);
    expect(resolution?.target).toBe("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
    expect(resolution?.hardwareUdid).toBe("00000000-0000000000000000");
  });

  it("carries the product type, tvOS version and build through to the resolution", () => {
    const resolution = resolveTvosTarget(undefined, parseDevicectlAppleTvs(DEVICECTL), []);
    expect(resolution).toMatchObject({
      productType: "AppleTV14,1",
      osVersion: "27.0",
      osBuild: "24J361",
    });
  });

  it("does NOT pick the iPhone (excluded by deviceType/platform)", () => {
    const devices = parseDevicectlAppleTvs(DEVICECTL);
    expect(devices.some((d) => /iPhone/i.test(d.name ?? ""))).toBe(false);
    expect(
      devices.some((d) => d.id === "E1E2E3E4-0000-4000-8000-000000000AC4")
    ).toBe(false);
  });

  it("marks an unpaired Apple TV as unavailable", () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            identifier: "UNPAIRED-ATV",
            deviceProperties: { name: "Bedroom" },
            connectionProperties: { pairingState: "unpaired" },
            hardwareProperties: { deviceType: "appleTV", platform: "tvOS" },
          },
        ],
      },
    });
    const devices = parseDevicectlAppleTvs(json);
    expect(devices).toHaveLength(1);
    expect(devices[0].available).toBe(false);
  });

  it("returns [] for malformed JSON or an unexpected shape", () => {
    expect(parseDevicectlAppleTvs("nope")).toEqual([]);
    expect(parseDevicectlAppleTvs("")).toEqual([]);
    expect(parseDevicectlAppleTvs("{}")).toEqual([]);
    expect(parseDevicectlAppleTvs(JSON.stringify({ result: {} }))).toEqual([]);
  });
});

describe("parseTvosSimulators", () => {
  const SIMCTL_JSON = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
        {
          udid: "TV-SIM-BOOTED",
          name: "Apple TV 4K (3rd generation)",
          state: "Booted",
          isAvailable: true,
        },
        {
          udid: "TV-SIM-SHUTDOWN",
          name: "Apple TV",
          state: "Shutdown",
          isAvailable: true,
        },
        {
          udid: "TV-SIM-UNAVAILABLE",
          name: "Apple TV old",
          state: "Shutdown",
          isAvailable: false,
        },
      ],
      // An iOS simulator runtime must be excluded outright.
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        {
          udid: "IPHONE-SIM",
          name: "iPhone 15 Pro",
          state: "Booted",
          isAvailable: true,
        },
      ],
    },
  });

  it("parses available tvOS simulators and flags the booted one as available", () => {
    const sims = parseTvosSimulators(SIMCTL_JSON);
    expect(sims).toHaveLength(2); // unavailable dropped, iOS runtime dropped
    const booted = sims.find((s) => s.id === "TV-SIM-BOOTED");
    expect(booted?.available).toBe(true);
    expect(booted?.kind).toBe("simulator");
    const shutdown = sims.find((s) => s.id === "TV-SIM-SHUTDOWN");
    expect(shutdown?.available).toBe(false);
  });

  it("excludes iOS simulator runtimes (no iPhone sim)", () => {
    const sims = parseTvosSimulators(SIMCTL_JSON);
    expect(sims.some((s) => s.id === "IPHONE-SIM")).toBe(false);
    expect(sims.some((s) => /iPhone/i.test(s.name ?? ""))).toBe(false);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseTvosSimulators("not json")).toEqual([]);
    expect(parseTvosSimulators("")).toEqual([]);
    expect(parseTvosSimulators("{}")).toEqual([]);
  });
});

describe("resolveTvosTarget", () => {
  const physConnected: TvosDevice = {
    id: "A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D",
    name: "Example Apple TV",
    kind: "device",
    available: true,
  };
  const simBooted: TvosDevice = {
    id: "TV-SIM-BOOTED",
    name: "Apple TV 4K (3rd generation)",
    kind: "simulator",
    available: true,
  };
  const physOffline: TvosDevice = {
    id: "OFFLINE-ATV",
    name: "Bedroom Apple TV",
    kind: "device",
    available: false,
  };

  it("prefers an available physical Apple TV over a simulator with no pin", () => {
    const r = resolveTvosTarget(undefined, [physConnected], [simBooted]);
    expect(r?.target).toBe(physConnected.id);
    expect(r?.kind).toBe("device");
    expect(r?.source).toBe("discovered");
  });

  it("falls back to a booted simulator when no physical device is available", () => {
    const r = resolveTvosTarget(undefined, [physOffline], [simBooted]);
    expect(r?.target).toBe(simBooted.id);
    expect(r?.kind).toBe("simulator");
  });

  it("honors a pin by CoreDevice id", () => {
    const r = resolveTvosTarget(physConnected.id, [physConnected], [simBooted]);
    expect(r?.source).toBe("pin");
    expect(r?.target).toBe(physConnected.id);
    expect(r?.warning).toBeUndefined();
  });

  it("honors a pin by (case-insensitive) name", () => {
    const r = resolveTvosTarget("example apple tv", [physConnected], []);
    expect(r?.source).toBe("pin");
    expect(r?.target).toBe(physConnected.id);
  });

  it("refuses a stale pin, naming it and the available Apple TV, rather than switching to it", () => {
    expect(() => resolveTvosTarget("NOT-CONNECTED", [physConnected], [])).toThrow(
      /"NOT-CONNECTED" \(from the APPLE_TV_DEVICE\/FLUTTER_DEVICE_TVOS_DEVICE env var\) is not online\. Online tvOS devices: A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D \(device, Example Apple TV\)/
    );
  });

  it("refuses a stale pin when nothing is available either", () => {
    expect(() => resolveTvosTarget("NOT-CONNECTED", [], [])).toThrow(
      /Online tvOS devices: none/
    );
  });

  it("treats a per-call udid as the pin, and refuses it by that name when it is gone", () => {
    const r = resolveTvosTarget(physConnected.id, [physConnected], [simBooted], {
      udid: simBooted.id,
    });
    expect(r?.target).toBe(simBooted.id);
    expect(r?.source).toBe("pin");
    expect(() =>
      resolveTvosTarget(undefined, [physConnected], [], { udid: simBooted.id })
    ).toThrow(/"TV-SIM-BOOTED" \(from the device_udid argument\)/);
  });

  it("refuses kind:'simulator' when no simulator is booted, rather than using the Apple TV", () => {
    expect(() =>
      resolveTvosTarget(undefined, [physConnected], [], { kind: "simulator" })
    ).toThrow(/a simulator was requested and none is online/);
  });

  it("returns a listed-but-offline device as discovered-offline", () => {
    const r = resolveTvosTarget(undefined, [physOffline], []);
    expect(r?.target).toBe(physOffline.id);
    expect(r?.source).toBe("discovered-offline");
  });

  it("returns null when nothing is listed", () => {
    expect(resolveTvosTarget(undefined, [], [])).toBeNull();
  });
});

// ============================================================================
// REGRESSION: the tvOS adapter must OWN Apple TV resolution and NEVER pick an
// iPhone/iPad — the exact inverse of the iOS adapter's Apple-TV exclusion.
// flutter-tvos lists both with targetPlatform "ios"; only the tvOS sdk string
// distinguishes them.
// ============================================================================
describe("regression: tvOS resolver picks Apple TV, never iPhone/iPad", () => {
  const MACHINE = JSON.stringify([
    {
      name: "My iPhone",
      id: "00008020-000000000000AAAA",
      targetPlatform: "ios",
      emulator: false,
      sdk: "iOS 18.0",
      isSupported: true,
    },
    {
      name: "Example Apple TV",
      id: "A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D",
      targetPlatform: "ios",
      emulator: false,
      sdk: "tvOS 26.5",
      isSupported: true,
    },
  ]);

  it("selects the Apple TV, never the iPhone", () => {
    const physical = parseFlutterTvosDevices(MACHINE);
    const r = resolveTvosTarget(undefined, physical, []);
    expect(r).not.toBeNull();
    expect(r?.target).toBe("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
    expect(r?.target).not.toBe("00008020-000000000000AAAA");
    expect(r?.name).toMatch(/Example Apple TV/i);
  });

  it("resolves nothing when only an iPhone is connected (no silent iOS pick)", () => {
    const iphoneOnly = JSON.stringify([
      {
        name: "My iPhone",
        id: "00008020-000000000000AAAA",
        targetPlatform: "ios",
        emulator: false,
        sdk: "iOS 18.0",
        isSupported: true,
      },
    ]);
    const physical = parseFlutterTvosDevices(iphoneOnly);
    expect(physical).toHaveLength(0);
    expect(resolveTvosTarget(undefined, physical, [])).toBeNull();
  });
});

describe("resolveTvosTarget: class and name checks on a named target", () => {
  const atv: TvosDevice = { id: "ATV-1", name: "Living Room", kind: "device", available: true };
  const sim: TvosDevice = { id: "SIM-1", name: "Apple TV 4K", kind: "simulator", available: true };

  it("refuses a named target whose class contradicts kind", () => {
    expect(() => resolveTvosTarget(undefined, [atv], [sim], { udid: "ATV-1", kind: "simulator" })).toThrow(
      /"ATV-1" is a device target, but a simulator was requested/
    );
  });

  it("refuses a name pin that matches two available Apple TVs", () => {
    const twin: TvosDevice = { ...atv, id: "ATV-2" };
    expect(() => resolveTvosTarget("Living Room", [atv, twin], [])).toThrow(
      /matches 2 online tvOS devices: ATV-1 \(device, Living Room\), ATV-2 \(device, Living Room\)/
    );
  });
});
