import os from "os";
import { localIpForDevice } from "../src/tizenDeveloperMode.js";

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

  it("is unknown for a device on a /24 with no matching local interface, not a guess", () => {
    expect(localIpForDevice("172.16.0.1", interfaces)).toBeUndefined();
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
