import os from "os";
import {
  diagnoseDeveloperMode,
  fetchDeveloperModeFacts,
  localIpForDevice,
} from "../src/tizenDeveloperMode.js";

describe("diagnoseDeveloperMode", () => {
  it("returns null when Developer Mode is on and the bound Host PC IP matches", () => {
    expect(
      diagnoseDeveloperMode("1", "192.168.1.50", "192.168.1.50")
    ).toBeNull();
  });

  it("flags a Host PC IP mismatch with both addresses and the rebind+reboot step", () => {
    const diag = diagnoseDeveloperMode("1", "192.168.1.99", "192.168.1.50");
    expect(diag).not.toBeNull();
    expect(diag).toContain("192.168.1.99"); // the bound (wrong) IP
    expect(diag).toContain("192.168.1.50"); // this Mac
    expect(diag).toMatch(/Host PC IP/);
    expect(diag).toMatch(/reboot/i);
  });

  it("flags Developer Mode being off", () => {
    const diag = diagnoseDeveloperMode("0", "192.168.1.50", "192.168.1.50");
    expect(diag).not.toBeNull();
    expect(diag).toMatch(/Developer Mode is not enabled/i);
  });

  it("treats missing developerMode as off", () => {
    expect(
      diagnoseDeveloperMode(undefined, undefined, "192.168.1.50")
    ).toMatch(/not enabled/i);
  });

  it("flags an empty bound Host PC IP when Developer Mode is on", () => {
    const diag = diagnoseDeveloperMode("1", "", "192.168.1.50");
    expect(diag).toMatch(/no Host PC IP is bound/i);
    expect(diag).toContain("192.168.1.50");
  });

  it("does not assert a mismatch when the local IP is unknown", () => {
    // Developer Mode on, bound IP present, but we couldn't determine our own IP
    // — we can't claim a mismatch, so no diagnostic.
    expect(diagnoseDeveloperMode("1", "192.168.1.99", undefined)).toBeNull();
  });
});

describe("localIpForDevice", () => {
  const interfaces: Record<string, os.NetworkInterfaceInfo[]> = {
    lo0: [
      {
        address: "127.0.0.1",
        family: "IPv4",
        internal: true,
      } as os.NetworkInterfaceInfo,
    ],
    en0: [
      {
        address: "192.168.1.50",
        family: "IPv4",
        internal: false,
      } as os.NetworkInterfaceInfo,
    ],
    utun3: [
      {
        address: "10.8.0.2",
        family: "IPv4",
        internal: false,
      } as os.NetworkInterfaceInfo,
    ],
  };

  it("prefers the interface on the device's /24 subnet", () => {
    expect(localIpForDevice("192.168.1.42", interfaces)).toBe("192.168.1.50");
  });

  it("returns undefined (unknown) when the device IP is known but nothing is on its /24", () => {
    // A docker/bridge/VPN IP that isn't the real Host-PC binding must NOT be
    // guessed — undefined lets the diagnostic degrade to null instead of a false
    // "Host PC IP mismatch".
    expect(localIpForDevice("172.16.0.1", interfaces)).toBeUndefined();
  });

  it("no-subnet-match → unknown → no false mismatch diagnostic", () => {
    // End-to-end: device on a /24 with no matching local interface. The resolved
    // localIp is unknown, so diagnoseDeveloperMode must NOT assert a mismatch.
    const localIp = localIpForDevice("172.16.0.1", interfaces);
    expect(localIp).toBeUndefined();
    expect(diagnoseDeveloperMode("1", "172.16.0.5", localIp)).toBeNull();
  });

  it("falls back to the first non-internal IPv4 only when the device IP is unknown", () => {
    // No device IP → no basis to filter, so the first usable IPv4 is returned.
    expect(localIpForDevice(undefined, interfaces)).toBe("192.168.1.50");
  });

  it("skips internal (loopback) addresses", () => {
    expect(localIpForDevice("127.0.0.99", interfaces)).not.toBe("127.0.0.1");
  });

  it("returns undefined when there is no usable IPv4", () => {
    expect(localIpForDevice("192.168.1.1", { lo0: interfaces.lo0 })).toBeUndefined();
  });
});

describe("fetchDeveloperModeFacts", () => {
  const fakeResponse = (body: unknown): Response =>
    ({
      ok: true,
      json: async () => body,
    }) as unknown as Response;

  it("reads developerMode/developerIP from the :8001 payload", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        device: { developerMode: "1", developerIP: "192.168.1.50" },
      })) as unknown as typeof fetch;
    await expect(
      fetchDeveloperModeFacts("192.168.1.42", fetchImpl)
    ).resolves.toEqual({ developerMode: "1", developerIP: "192.168.1.50" });
  });

  it("resolves to empty facts (never throws) on a network error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      fetchDeveloperModeFacts("192.168.1.42", fetchImpl)
    ).resolves.toEqual({});
  });

  it("resolves to empty facts on a non-ok response", async () => {
    const fetchImpl = (async () =>
      ({ ok: false }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      fetchDeveloperModeFacts("192.168.1.42", fetchImpl)
    ).resolves.toEqual({});
  });
});
