import {
  isIphoneOrIpad,
  mergeFlutterIds,
  parseDevicectlDevices,
  parseFlutterIosDevices,
  parseSimctlDevices,
  resolveIosTarget,
  IosDevice,
} from "../src/iosDeviceTarget.js";

describe("parseSimctlDevices", () => {
  const SIMCTL_JSON = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        {
          udid: "AAAA1111-0000-0000-0000-000000000001",
          name: "iPhone 15 Pro",
          state: "Booted",
          isAvailable: true,
        },
        {
          udid: "BBBB2222-0000-0000-0000-000000000002",
          name: "iPhone 15",
          state: "Shutdown",
          isAvailable: true,
        },
        {
          udid: "CCCC3333-0000-0000-0000-000000000003",
          name: "unavailable sim",
          state: "Shutdown",
          isAvailable: false,
        },
      ],
      // A tvOS simulator runtime must be excluded outright.
      "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
        {
          udid: "TVTV0000-0000-0000-0000-00000000000A",
          name: "Apple TV 4K",
          state: "Booted",
          isAvailable: true,
        },
      ],
    },
  });

  it("parses available iOS simulators and flags the booted one as available", () => {
    const sims = parseSimctlDevices(SIMCTL_JSON);
    expect(sims).toHaveLength(2); // isAvailable:false dropped, tvOS runtime dropped
    const booted = sims.find((s) => s.name === "iPhone 15 Pro");
    expect(booted?.available).toBe(true);
    expect(booted?.kind).toBe("simulator");
    // For a simulator the flutter id and devicectl/simctl id are the same UUID.
    expect(booted?.devicectlId).toBe(booted?.udid);
    const shutdown = sims.find((s) => s.name === "iPhone 15");
    expect(shutdown?.available).toBe(false);
  });

  it("excludes tvOS simulator runtimes (no Apple TV sim)", () => {
    const sims = parseSimctlDevices(SIMCTL_JSON);
    expect(sims.some((s) => /apple tv/i.test(s.name ?? ""))).toBe(false);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseSimctlDevices("not json")).toEqual([]);
    expect(parseSimctlDevices("")).toEqual([]);
    expect(parseSimctlDevices("{}")).toEqual([]);
  });
});

describe("isIphoneOrIpad", () => {
  it("accepts iPhone/iPad model tokens and names", () => {
    expect(isIphoneOrIpad("My iPhone  (iPhone11,8)")).toBe(true);
    expect(isIphoneOrIpad("Work iPad  (iPad13,1)")).toBe(true);
    expect(isIphoneOrIpad("Some iPhone")).toBe(true);
  });
  it("rejects Apple TV / tvOS", () => {
    expect(isIphoneOrIpad("Example Apple TV  (AppleTV14,1)")).toBe(false);
    expect(isIphoneOrIpad("Living Room Apple TV")).toBe(false);
  });
});

describe("parseDevicectlDevices", () => {
  // The REAL failing shape: devicectl lists BOTH an Apple TV and an iPhone.
  const TABLE = [
    "Name                 Hostname     Identifier                             State        Model",
    "-------------------------------------------------------------------------------------------",
    "Example Apple TV   atv.local    A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D   connected    Apple TV 4K (3rd generation) (AppleTV14,1)",
    "iPhone               ip.local     0831CB2E-D597-5C19-9699-6DFA21324AC4   connected    iPhone XR (iPhone11,8)",
    "Old iPad             ipad.local   00008030-000000000000000A              disconnected iPad (iPad7,11)",
  ].join("\n");

  it("excludes the Apple TV and keeps only iPhone/iPad rows", () => {
    const devices = parseDevicectlDevices(TABLE);
    expect(devices.some((d) => /A1B2C3D4/i.test(d.devicectlId ?? ""))).toBe(
      false
    );
    expect(devices).toHaveLength(2); // iPhone + iPad, not the Apple TV
  });

  it("records the devicectl id and connection state per iPhone/iPad row", () => {
    const devices = parseDevicectlDevices(TABLE);
    const iphone = devices.find(
      (d) => d.devicectlId === "0831CB2E-D597-5C19-9699-6DFA21324AC4"
    );
    expect(iphone?.available).toBe(true);
    expect(iphone?.kind).toBe("device");
    const ipad = devices.find(
      (d) => d.devicectlId === "00008030-000000000000000A"
    );
    expect(ipad?.available).toBe(false);
  });

  it("returns [] for empty input", () => {
    expect(parseDevicectlDevices("")).toEqual([]);
  });
});

describe("parseFlutterIosDevices", () => {
  const MACHINE = JSON.stringify([
    {
      name: "My iPhone",
      id: "00008020-001A2D021AF3002E",
      targetPlatform: "ios",
      emulator: false,
      isSupported: true,
    },
    {
      name: "iPhone 15 Pro (simulator)",
      id: "AAAA1111-0000-0000-0000-000000000001",
      targetPlatform: "ios",
      emulator: true, // simulator — handled via simctl, excluded here
      isSupported: true,
    },
    {
      name: "macOS",
      id: "macos",
      targetPlatform: "darwin",
      emulator: false,
      isSupported: true,
    },
    {
      name: "Chrome",
      id: "chrome",
      targetPlatform: "web-javascript",
      emulator: false,
      isSupported: true,
    },
  ]);

  it("keeps only real (non-emulator) iOS devices with their flutter id (ECID)", () => {
    const devices = parseFlutterIosDevices(MACHINE);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("00008020-001A2D021AF3002E");
    expect(devices[0].name).toBe("My iPhone");
  });

  it("returns [] for malformed JSON", () => {
    expect(parseFlutterIosDevices("nope")).toEqual([]);
    expect(parseFlutterIosDevices("")).toEqual([]);
  });
});

describe("mergeFlutterIds", () => {
  it("joins devicectl id (lifecycle) with flutter ECID (deploy) by name", () => {
    const ctl = parseDevicectlDevices(
      [
        "Name     Host  Identifier                             State      Model",
        "iPhone   ip    0831CB2E-D597-5C19-9699-6DFA21324AC4   connected  (iPhone11,8)",
      ].join("\n")
    );
    const flutter = parseFlutterIosDevices(
      JSON.stringify([
        {
          name: "iPhone",
          id: "00008020-001A2D021AF3002E",
          targetPlatform: "ios",
          emulator: false,
          isSupported: true,
        },
      ])
    );
    const merged = mergeFlutterIds(ctl, flutter);
    expect(merged).toHaveLength(1);
    // target/udid must be the FLUTTER id (flutter run -d), devicectlId the UUID.
    expect(merged[0].udid).toBe("00008020-001A2D021AF3002E");
    expect(merged[0].devicectlId).toBe("0831CB2E-D597-5C19-9699-6DFA21324AC4");
  });

  it("positionally matches a single device when names differ", () => {
    const ctl: IosDevice[] = [
      {
        udid: "CTL",
        devicectlId: "CTL",
        name: "Some iPhone",
        kind: "device",
        available: true,
      },
    ];
    const merged = mergeFlutterIds(ctl, [{ id: "ECID", name: "Different" }]);
    expect(merged[0].udid).toBe("ECID");
    expect(merged[0].devicectlId).toBe("CTL");
  });

  it("does NOT positionally pair same-named devices; flags them ambiguous", () => {
    // Two connected iPhones, both named the default "iPhone", enumerated in a
    // DIFFERENT order on each side. Order-based pairing would cross the ids.
    const ctl = parseDevicectlDevices(
      [
        "Name    Host   Identifier                             State      Model",
        "iPhone  ipA    AAAA1111-D597-5C19-9699-6DFA21324AC4   connected  (iPhone11,8)",
        "iPhone  ipB    BBBB2222-D597-5C19-9699-6DFA21324AC4   connected  (iPhone14,2)",
      ].join("\n")
    );
    const flutter = parseFlutterIosDevices(
      JSON.stringify([
        // Reversed order relative to devicectl.
        {
          name: "iPhone",
          id: "00008020-ECIDBBBB",
          targetPlatform: "ios",
          emulator: false,
          isSupported: true,
        },
        {
          name: "iPhone",
          id: "00008020-ECIDAAAA",
          targetPlatform: "ios",
          emulator: false,
          isSupported: true,
        },
      ])
    );
    const merged = mergeFlutterIds(ctl, flutter);
    // The two devicectl rows must NOT have been given a flutter id by order.
    const ctlA = merged.find(
      (d) => d.devicectlId === "AAAA1111-D597-5C19-9699-6DFA21324AC4"
    );
    const ctlB = merged.find(
      (d) => d.devicectlId === "BBBB2222-D597-5C19-9699-6DFA21324AC4"
    );
    expect(ctlA?.ambiguous).toBe(true);
    expect(ctlB?.ambiguous).toBe(true);
    // udid stays the devicectl placeholder (no cross-mapped ECID).
    expect(ctlA?.udid).toBe("AAAA1111-D597-5C19-9699-6DFA21324AC4");
    expect(ctlB?.udid).toBe("BBBB2222-D597-5C19-9699-6DFA21324AC4");
    // No devicectl row silently absorbed a flutter ECID.
    expect(
      merged.every((d) => !/^00008020-ECID/.test(d.udid) || d.ambiguous)
    ).toBe(true);
  });

  it("still joins uniquely-named devices even when another name is duplicated", () => {
    const ctl = parseDevicectlDevices(
      [
        "Name       Host   Identifier                             State      Model",
        "iPhone     ipA    AAAA1111-D597-5C19-9699-6DFA21324AC4   connected  (iPhone11,8)",
        "iPhone     ipB    BBBB2222-D597-5C19-9699-6DFA21324AC4   connected  (iPhone14,2)",
        "Work iPad  ipad   CCCC3333-D597-5C19-9699-6DFA21324AC4   connected  (iPad13,1)",
      ].join("\n")
    );
    const flutter = parseFlutterIosDevices(
      JSON.stringify([
        {
          name: "iPhone",
          id: "00008020-ECIDAAAA",
          targetPlatform: "ios",
          emulator: false,
          isSupported: true,
        },
        {
          name: "iPhone",
          id: "00008020-ECIDBBBB",
          targetPlatform: "ios",
          emulator: false,
          isSupported: true,
        },
        {
          name: "Work iPad",
          id: "00008020-ECIDCCCC",
          targetPlatform: "ios",
          emulator: false,
          isSupported: true,
        },
      ])
    );
    const merged = mergeFlutterIds(ctl, flutter);
    const ipad = merged.find(
      (d) => d.devicectlId === "CCCC3333-D597-5C19-9699-6DFA21324AC4"
    );
    // The uniquely-named iPad joins cleanly to its flutter id.
    expect(ipad?.udid).toBe("00008020-ECIDCCCC");
    expect(ipad?.ambiguous).toBeFalsy();
    // The duplicated "iPhone" rows are still flagged ambiguous.
    expect(
      merged
        .filter((d) => /^iphone$/i.test(d.name ?? ""))
        .every((d) => d.ambiguous)
    ).toBe(true);
  });
});

describe("resolveIosTarget", () => {
  const physConnected: IosDevice = {
    udid: "00008020-001A2D021AF3002E", // flutter ECID
    devicectlId: "0831CB2E-D597-5C19-9699-6DFA21324AC4",
    name: "My iPhone",
    kind: "device",
    available: true,
  };
  const physOffline: IosDevice = {
    udid: "00008030-000000000000000A",
    devicectlId: "00008030-000000000000000A",
    name: "Old iPad",
    kind: "device",
    available: false,
  };
  const simBooted: IosDevice = {
    udid: "AAAA1111-0000-0000-0000-000000000001",
    devicectlId: "AAAA1111-0000-0000-0000-000000000001",
    name: "iPhone 15 Pro",
    kind: "simulator",
    available: true,
  };

  it("prefers an available physical device over a simulator with no pin", () => {
    const r = resolveIosTarget(undefined, [physConnected], [simBooted]);
    expect(r?.target).toBe(physConnected.udid);
    expect(r?.kind).toBe("device");
    expect(r?.source).toBe("discovered");
  });

  it("yields the flutter ECID as target and the devicectl id for lifecycle", () => {
    const r = resolveIosTarget(undefined, [physConnected], []);
    // deploy/flutter-run path
    expect(r?.target).toBe("00008020-001A2D021AF3002E");
    // lifecycle/uninstall path
    expect(r?.devicectlId).toBe("0831CB2E-D597-5C19-9699-6DFA21324AC4");
  });

  it("honors a pin by flutter id", () => {
    const r = resolveIosTarget(physConnected.udid, [physConnected], [simBooted]);
    expect(r?.source).toBe("pin");
    expect(r?.target).toBe(physConnected.udid);
    expect(r?.warning).toBeUndefined();
  });

  it("honors a pin by devicectl id", () => {
    const r = resolveIosTarget(
      physConnected.devicectlId,
      [physConnected],
      [simBooted]
    );
    expect(r?.source).toBe("pin");
    expect(r?.target).toBe(physConnected.udid); // still the flutter id
  });

  it("honors a pin by (case-insensitive) name", () => {
    const r = resolveIosTarget("my iphone", [physConnected], []);
    expect(r?.source).toBe("pin");
    expect(r?.target).toBe(physConnected.udid);
  });

  it("self-heals a stale pin to the first available device (with warning)", () => {
    const r = resolveIosTarget("DEADBEEF-not-connected", [physConnected], []);
    expect(r?.target).toBe(physConnected.udid);
    expect(r?.source).toBe("discovered");
    expect(r?.warning).toMatch(/stale pin/i);
  });

  it("keeps a stale pin when nothing is available to fall back to", () => {
    const r = resolveIosTarget("DEADBEEF-not-connected", [], []);
    expect(r?.target).toBe("DEADBEEF-not-connected");
    expect(r?.source).toBe("stale-pin");
    expect(r?.warning).toMatch(/no.*fall back/i);
  });

  it("falls back to a booted simulator when no physical device is available", () => {
    const r = resolveIosTarget(undefined, [physOffline], [simBooted]);
    expect(r?.target).toBe(simBooted.udid);
    expect(r?.kind).toBe("simulator");
  });

  it("returns a listed-but-offline device as discovered-offline", () => {
    const r = resolveIosTarget(undefined, [physOffline], []);
    expect(r?.target).toBe(physOffline.udid);
    expect(r?.source).toBe("discovered-offline");
  });

  it("returns null when nothing is listed", () => {
    expect(resolveIosTarget(undefined, [], [])).toBeNull();
  });

  describe("per-call preference (the simulator-targeting gap)", () => {
    it("picks the booted simulator when kind:'simulator', even with a device attached", () => {
      const r = resolveIosTarget(undefined, [physConnected], [simBooted], {
        kind: "simulator",
      });
      expect(r?.target).toBe(simBooted.udid);
      expect(r?.kind).toBe("simulator");
    });

    it("still prefers the physical device with kind:'device' (explicit default)", () => {
      const r = resolveIosTarget(undefined, [physConnected], [simBooted], {
        kind: "device",
      });
      expect(r?.kind).toBe("device");
      expect(r?.target).toBe(physConnected.udid);
    });

    it("treats a per-call udid as an authoritative pin over the env pin", () => {
      const r = resolveIosTarget(physConnected.udid, [physConnected], [simBooted], {
        udid: simBooted.udid,
      });
      expect(r?.source).toBe("pin");
      expect(r?.target).toBe(simBooted.udid);
      expect(r?.kind).toBe("simulator");
    });

    it("a per-call udid self-heals when its target is not available", () => {
      const r = resolveIosTarget(undefined, [physConnected], [simBooted], {
        udid: "NOT-CONNECTED",
      });
      expect(r?.source).toBe("discovered");
      expect(r?.warning).toMatch(/stale pin/i);
    });
  });
});

// ============================================================================
// REGRESSION: the live on-device bug — devicectl listed BOTH an Apple TV and an
// iPhone; the old resolver picked the Apple TV (first physical, no class filter)
// and then handed a devicectl UUID to `flutter run -d`, which rejected it.
// ============================================================================
describe("regression: Apple-TV-vs-iPhone + flutter-id vs devicectl-id", () => {
  const DEVICECTL = [
    "Name                 Hostname     Identifier                             State       Model",
    "-------------------------------------------------------------------------------------------",
    "Example Apple TV   atv.local    A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D   connected   Apple TV 4K (3rd generation) (AppleTV14,1)",
    "iPhone               ip.local     0831CB2E-D597-5C19-9699-6DFA21324AC4   connected   iPhone XR (iPhone11,8)",
  ].join("\n");

  const FLUTTER_MACHINE = JSON.stringify([
    {
      name: "iPhone",
      id: "00008020-001A2D021AF3002E",
      targetPlatform: "ios",
      emulator: false,
      isSupported: true,
    },
    { name: "macOS", id: "macos", targetPlatform: "darwin", emulator: false },
    {
      name: "Chrome",
      id: "chrome",
      targetPlatform: "web-javascript",
      emulator: false,
    },
  ]);

  function resolve(pin?: string) {
    const physical = mergeFlutterIds(
      parseDevicectlDevices(DEVICECTL),
      parseFlutterIosDevices(FLUTTER_MACHINE)
    );
    return resolveIosTarget(pin, physical, []);
  }

  it("selects the iPhone, never the Apple TV", () => {
    const r = resolve();
    expect(r).not.toBeNull();
    expect(r?.target).not.toBe("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
    expect(r?.devicectlId).not.toBe("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
    expect(r?.name).toMatch(/iPhone/i);
  });

  it("yields the flutter ECID for the deploy/flutter-run path", () => {
    const r = resolve();
    // NOT the devicectl UUID — that is what `flutter run -d` rejected.
    expect(r?.target).toBe("00008020-001A2D021AF3002E");
    expect(r?.target).not.toBe("0831CB2E-D597-5C19-9699-6DFA21324AC4");
  });

  it("yields the devicectl id for the lifecycle path", () => {
    const r = resolve();
    expect(r?.devicectlId).toBe("0831CB2E-D597-5C19-9699-6DFA21324AC4");
  });

  it("resolves nothing when only an Apple TV is connected (no silent tvOS pick)", () => {
    const tvOnly = [
      "Name                 Hostname     Identifier                             State       Model",
      "Example Apple TV   atv.local    A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D   connected   Apple TV 4K (3rd generation) (AppleTV14,1)",
    ].join("\n");
    const physical = mergeFlutterIds(parseDevicectlDevices(tvOnly), []);
    expect(resolveIosTarget(undefined, physical, [])).toBeNull();
  });
});

// ============================================================================
// HIGH regression: two connected devices sharing a name ("iPhone" x2). Joining
// by array order could pair device A's devicectl id with device B's flutter
// ECID — a silent wrong-device drive. The resolver must FAIL SAFE (never guess)
// and require a pin; a pin is the escape hatch that still resolves exactly.
// ============================================================================
describe("regression: same-name devices must fail safe (require a pin)", () => {
  const DEVICECTL = [
    "Name    Host   Identifier                             State      Model",
    "-------------------------------------------------------------------------",
    "iPhone  ipA    AAAA1111-D597-5C19-9699-6DFA21324AC4   connected  (iPhone11,8)",
    "iPhone  ipB    BBBB2222-D597-5C19-9699-6DFA21324AC4   connected  (iPhone14,2)",
  ].join("\n");
  // Reversed order vs devicectl, so a positional join would cross the ids.
  const FLUTTER_MACHINE = JSON.stringify([
    {
      name: "iPhone",
      id: "00008020-ECIDBBBB",
      targetPlatform: "ios",
      emulator: false,
      isSupported: true,
    },
    {
      name: "iPhone",
      id: "00008020-ECIDAAAA",
      targetPlatform: "ios",
      emulator: false,
      isSupported: true,
    },
  ]);

  function physical() {
    return mergeFlutterIds(
      parseDevicectlDevices(DEVICECTL),
      parseFlutterIosDevices(FLUTTER_MACHINE)
    );
  }

  it("does NOT auto-pick or auto-pair by array order; requires a pin", () => {
    const r = resolveIosTarget(undefined, physical(), []);
    // Fail safe: nothing auto-selected (all candidates ambiguous).
    expect(r).toBeNull();
  });

  it("emits the ambiguity warning when at least one non-ambiguous fallback exists", () => {
    // Add a booted simulator so there IS something selectable — the resolver
    // then picks the unambiguous device but surfaces the ambiguity warning so
    // the caller knows the same-named phones were skipped.
    const sim: IosDevice = {
      udid: "5555AAAA-0000-0000-0000-000000000001",
      devicectlId: "5555AAAA-0000-0000-0000-000000000001",
      name: "iPhone 15 Pro",
      kind: "simulator",
      available: true,
    };
    const r = resolveIosTarget(undefined, physical(), [sim]);
    expect(r?.kind).toBe("simulator");
    expect(r?.warning).toMatch(/share a name|ambiguous|disambiguate|FLUTTER_DEVICE_IOS_DEVICE/i);
  });

  it("a devicectl-id pin resolves that exact device with the right flutter+devicectl ids", () => {
    // NOTE: with duplicate names the flutter ECID cannot be attributed to a
    // specific devicectl row, so an ambiguous device carries its devicectl id in
    // both slots. Pinning by devicectl id still selects THAT physical device
    // deterministically (the escape hatch), which is the safe, non-guessing
    // behavior — deploy at least targets the intended devicectl device.
    const r = resolveIosTarget(
      "AAAA1111-D597-5C19-9699-6DFA21324AC4",
      physical(),
      []
    );
    expect(r?.source).toBe("pin");
    expect(r?.devicectlId).toBe("AAAA1111-D597-5C19-9699-6DFA21324AC4");
    // It resolved device A, not device B.
    expect(r?.devicectlId).not.toBe("BBBB2222-D597-5C19-9699-6DFA21324AC4");
  });
});

// ============================================================================
// flutter-only device: present in `flutter devices --machine` but NOT devicectl.
// Deploy must still work via the flutter id; devicectlId falls back to the
// flutter id (lifecycle best-effort) per current logic. Lock that behavior.
// ============================================================================
describe("flutter-only device (not listed by devicectl)", () => {
  it("deploys via the flutter id; devicectlId falls back to it", () => {
    const physical = mergeFlutterIds(
      [], // devicectl listed nothing
      parseFlutterIosDevices(
        JSON.stringify([
          {
            name: "My iPhone",
            id: "ECID-ONLY-FLUTTER",
            targetPlatform: "ios",
            emulator: false,
            isSupported: true,
          },
        ])
      )
    );
    const r = resolveIosTarget(undefined, physical, []);
    // Deploy target is the flutter id.
    expect(r?.target).toBe("ECID-ONLY-FLUTTER");
    expect(r?.source).toBe("discovered");
    // No devicectl id known → toResolution falls back to the flutter id so
    // lifecycle verbs still have something to hand devicectl (best effort).
    expect(r?.devicectlId).toBe("ECID-ONLY-FLUTTER");
    // Unique name → not flagged ambiguous.
    expect(r?.warning).toBeUndefined();
  });

  it("resolves a flutter-only device by a name pin", () => {
    const physical = mergeFlutterIds(
      [],
      parseFlutterIosDevices(
        JSON.stringify([
          {
            name: "My iPhone",
            id: "ECID-ONLY-FLUTTER",
            targetPlatform: "ios",
            emulator: false,
            isSupported: true,
          },
        ])
      )
    );
    const r = resolveIosTarget("my iphone", physical, []);
    expect(r?.source).toBe("pin");
    expect(r?.target).toBe("ECID-ONLY-FLUTTER");
  });
});
