import {
  adbReverseArgs,
  androidKindFromSerial,
  DEFAULT_LOCAL_ENV_KEY,
  DEFAULT_LOCAL_HOST_KEY,
  isLoopbackHost,
  lanCandidates,
  localBackendDefines,
  parseLocalBackendPorts,
  NetworkInterfaces,
  resolveLocalBackendHost,
} from "../src/localBackend.js";

// A realistic macOS interface set: loopback, Wi-Fi, an AirDrop link, a VPN tunnel
// and a Docker bridge. Only en0 is the LAN address; every other entry here is a
// trap that "the first non-internal IPv4" walks straight into.
const MAC_INTERFACES: NetworkInterfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
  awdl0: [{ address: "169.254.13.7", family: "IPv4", internal: false }],
  utun4: [{ address: "10.8.0.2", family: "IPv4", internal: false }],
  bridge100: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
};

describe("lanCandidates", () => {
  it("keeps only the real LAN interface on a typical Mac", () => {
    expect(lanCandidates(MAC_INTERFACES)).toEqual([
      { iface: "en0", address: "192.168.1.42" },
    ]);
  });

  it("drops loopback, link-local, VPN, AirDrop, bridge and docker addresses", () => {
    const addresses = lanCandidates(MAC_INTERFACES).map((c) => c.address);
    expect(addresses).not.toContain("127.0.0.1"); // internal
    expect(addresses).not.toContain("169.254.13.7"); // link-local
    expect(addresses).not.toContain("10.8.0.2"); // utun VPN
    expect(addresses).not.toContain("192.168.64.1"); // bridge
    expect(addresses).not.toContain("172.17.0.1"); // docker
  });

  it("accepts family as the NUMBER 4 as well as the string (node version drift)", () => {
    const numeric: NetworkInterfaces = {
      en0: [{ address: "192.168.1.9", family: 4, internal: false }],
    };
    expect(lanCandidates(numeric)).toEqual([
      { iface: "en0", address: "192.168.1.9" },
    ]);
  });

  it("ignores IPv6 addresses", () => {
    const v6: NetworkInterfaces = {
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.1.5", family: "IPv4", internal: false },
      ],
    };
    expect(lanCandidates(v6)).toEqual([
      { iface: "en0", address: "192.168.1.5" },
    ]);
  });

  it("returns [] when nothing qualifies", () => {
    expect(lanCandidates({})).toEqual([]);
    expect(
      lanCandidates({ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] })
    ).toEqual([]);
  });
});

describe("resolveLocalBackendHost", () => {
  it("iOS simulator gets localhost", () => {
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "simulator" },
      MAC_INTERFACES
    );
    expect(plan.host).toBe("localhost");
    expect(plan.reversePorts).toEqual([]);
    expect(plan.unresolved).toBeUndefined();
  });

  it("Android emulator gets 10.0.2.2, NOT localhost", () => {
    // localhost inside the emulator is the emulated device. This is the single
    // most common wrong answer and it fails looking like a dead backend.
    const plan = resolveLocalBackendHost(
      { platform: "android", kind: "emulator" },
      MAC_INTERFACES
    );
    expect(plan.host).toBe("10.0.2.2");
    expect(plan.reversePorts).toEqual([]);
  });

  it("physical Android gets localhost PLUS the reverse ports", () => {
    const plan = resolveLocalBackendHost(
      { platform: "android", kind: "device" },
      MAC_INTERFACES,
      [8080, 9099]
    );
    expect(plan.host).toBe("localhost");
    expect(plan.reversePorts).toEqual([8080, 9099]);
  });

  it("physical Android sorts the ports so the plan is stable", () => {
    const plan = resolveLocalBackendHost(
      { platform: "android", kind: "device" },
      MAC_INTERFACES,
      [9099, 8080]
    );
    expect(plan.reversePorts).toEqual([8080, 9099]);
  });

  it("physical Android with NO ports refuses rather than guessing a host", () => {
    // Without a tunnel there is no correct answer: `localhost` is the device and
    // 10.0.2.2 is nothing. Returning either would be a confident wrong answer.
    const plan = resolveLocalBackendHost(
      { platform: "android", kind: "device" },
      MAC_INTERFACES,
      []
    );
    expect(plan.host).toBeNull();
    expect(plan.unresolved).toMatch(/port/i);
  });

  it("physical iOS gets the single LAN address", () => {
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "device" },
      MAC_INTERFACES
    );
    expect(plan.host).toBe("192.168.1.42");
    expect(plan.rationale).toMatch(/en0/);
  });

  it("a TV target is treated as a separate machine on the network", () => {
    for (const platform of ["tizen", "webos", "tvos"] as const) {
      const plan = resolveLocalBackendHost(
        { platform, kind: "device" },
        MAC_INTERFACES
      );
      expect(plan.host).toBe("192.168.1.42");
    }
  });

  it("REFUSES when several LAN addresses exist, and names them", () => {
    // Wi-Fi and Ethernet both up. Which one the device is on is unknowable from
    // here, and either choice works from the host while failing from the device.
    const dual: NetworkInterfaces = {
      en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
      en1: [{ address: "10.0.5.17", family: "IPv4", internal: false }],
    };
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "device" },
      dual
    );
    expect(plan.host).toBeNull();
    expect(plan.unresolved).toContain("en0=192.168.1.42");
    expect(plan.unresolved).toContain("en1=10.0.5.17");
  });

  it("REFUSES when there is no LAN address at all", () => {
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "device" },
      { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }
    );
    expect(plan.host).toBeNull();
    expect(plan.unresolved).toMatch(/No LAN IPv4/i);
  });

  it("says the backend must listen beyond loopback for a physical target", () => {
    // A server bound to 127.0.0.1 is invisible at the LAN address, and that is
    // the next thing that goes wrong after the address is right.
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "device" },
      MAC_INTERFACES
    );
    expect(plan.rationale).toMatch(/not only on loopback/i);
  });
});

describe("localBackendDefines", () => {
  it("produces the conventional pair", () => {
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "simulator" },
      MAC_INTERFACES
    );
    expect(localBackendDefines(plan)).toEqual({
      [DEFAULT_LOCAL_ENV_KEY]: "true",
      [DEFAULT_LOCAL_HOST_KEY]: "localhost",
    });
  });

  it("honours custom key names", () => {
    const plan = resolveLocalBackendHost(
      { platform: "android", kind: "emulator" },
      MAC_INTERFACES
    );
    expect(
      localBackendDefines(plan, { envKey: "USE_LOCAL", hostKey: "API_HOST" })
    ).toEqual({ USE_LOCAL: "true", API_HOST: "10.0.2.2" });
  });

  it("injects NOTHING when the host is unresolved", () => {
    // An absent define leaves the app on its own default, which is recoverable.
    // A define naming a broken host is the failure this module exists to prevent.
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "device" },
      {}
    );
    expect(plan.host).toBeNull();
    expect(localBackendDefines(plan)).toEqual({});
  });
});

describe("androidKindFromSerial", () => {
  it("names emulator-NNNN an emulator", () => {
    expect(androidKindFromSerial("emulator-5554")).toBe("emulator");
  });

  it("names a hardware serial a device", () => {
    expect(androidKindFromSerial("R58M12ABCDE")).toBe("device");
    // A network-attached device is still hardware, not an emulator.
    expect(androidKindFromSerial("192.168.1.50:5555")).toBe("device");
    // Close-but-not-the-convention must not be read as an emulator.
    expect(androidKindFromSerial("emulator-abc")).toBe("device");
  });
});

describe("adbReverseArgs", () => {
  it("builds one reverse per port", () => {
    const plan = resolveLocalBackendHost(
      { platform: "android", kind: "device" },
      MAC_INTERFACES,
      [8080, 9099]
    );
    expect(adbReverseArgs(plan)).toEqual([
      ["reverse", "tcp:8080", "tcp:8080"],
      ["reverse", "tcp:9099", "tcp:9099"],
    ]);
  });

  it("builds nothing for a target that needs no tunnel", () => {
    const plan = resolveLocalBackendHost(
      { platform: "ios", kind: "simulator" },
      MAC_INTERFACES
    );
    expect(adbReverseArgs(plan)).toEqual([]);
  });
});

describe("parseLocalBackendPorts", () => {
  it("parses a comma-separated list, with or without spaces", () => {
    expect(parseLocalBackendPorts("8080,9099")).toEqual([8080, 9099]);
    expect(parseLocalBackendPorts("8080, 9099")).toEqual([8080, 9099]);
  });

  it("accepts a single already-numeric value (the CLI coerces those)", () => {
    expect(parseLocalBackendPorts(8080)).toEqual([8080]);
    expect(parseLocalBackendPorts("8080")).toEqual([8080]);
  });

  it("returns undefined for absent/empty input", () => {
    expect(parseLocalBackendPorts(undefined)).toBeUndefined();
    expect(parseLocalBackendPorts("")).toBeUndefined();
    expect(parseLocalBackendPorts(null)).toBeUndefined();
  });

  it("THROWS on a non-numeric token rather than dropping it", () => {
    // A dropped port is a tunnel that never gets made, and the app then fails on
    // that one port while the others work — which reads as an app bug.
    expect(() => parseLocalBackendPorts("8080,http")).toThrow(/expected a/i);
    expect(() => parseLocalBackendPorts("80 80")).toThrow();
    expect(() => parseLocalBackendPorts("-1")).toThrow();
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])(
    "%s is loopback",
    (h) => expect(isLoopbackHost(h)).toBe(true)
  );
  it.each(["192.168.1.20", "10.0.2.2", "api.test", "localhost.example.com", "128.0.0.1"])(
    "%s is not",
    (h) => expect(isLoopbackHost(h)).toBe(false)
  );
});
