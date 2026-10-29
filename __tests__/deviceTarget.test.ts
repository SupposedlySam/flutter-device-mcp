import {
  DEFAULT_SDB_PORT,
  normalizeDeviceTarget,
  parseDeviceTarget,
  parseSdbDevices,
  parseTizenTargetFile,
  resolveDeviceTarget,
  tpkPackageId,
} from "../src/deviceTarget.js";

const SAMPLE = `List of devices attached
192.0.2.6:26101\tdevice\tExampleTV
`;

const SAMPLE_OFFLINE = `List of devices attached
192.0.2.6:26101\toffline\tExampleTV
`;

describe("parseDeviceTarget", () => {
  it("splits host:port", () => {
    expect(parseDeviceTarget("192.0.2.6:26101")).toEqual({
      host: "192.0.2.6",
      port: 26101,
    });
  });

  it("defaults the port for a bare host", () => {
    expect(parseDeviceTarget("192.0.2.6")).toEqual({
      host: "192.0.2.6",
      port: DEFAULT_SDB_PORT,
    });
  });

  it("preserves a non-default port", () => {
    expect(parseDeviceTarget("192.0.2.6:4444").port).toBe(4444);
  });

  it("treats a malformed port suffix as part of the host", () => {
    expect(parseDeviceTarget("192.0.2.6:abc")).toEqual({
      host: "192.0.2.6:abc",
      port: DEFAULT_SDB_PORT,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseDeviceTarget("  192.0.2.6:26101  ")).toEqual({
      host: "192.0.2.6",
      port: 26101,
    });
  });

  it("defaults the port when the colon is present but the port is empty", () => {
    // "host:" has an empty port suffix (Number("") === 0, non-positive), so the
    // default sdb port is applied rather than a bogus 0.
    expect(parseDeviceTarget("192.0.2.6:").port).toBe(DEFAULT_SDB_PORT);
  });
});

describe("normalizeDeviceTarget", () => {
  it("appends the default sdb port to a bare host", () => {
    expect(normalizeDeviceTarget("192.0.2.6")).toBe("192.0.2.6:26101");
  });

  it("leaves an existing host:port untouched", () => {
    expect(normalizeDeviceTarget("192.0.2.6:26101")).toBe(
      "192.0.2.6:26101"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDeviceTarget("  192.0.2.6  ")).toBe("192.0.2.6:26101");
  });
});

describe("parseSdbDevices", () => {
  it("parses the devices table, skipping the header", () => {
    expect(parseSdbDevices(SAMPLE)).toEqual([
      { serial: "192.0.2.6:26101", state: "device", name: "ExampleTV" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseSdbDevices("")).toEqual([]);
    expect(parseSdbDevices("List of devices attached\n")).toEqual([]);
  });

  it("captures the state for offline devices", () => {
    expect(parseSdbDevices(SAMPLE_OFFLINE)[0].state).toBe("offline");
  });
});

// The device moved DHCP address: the old .6 pin is dead, .7 is online.
const SAMPLE_MOVED = `List of devices attached
192.0.2.7:26101\tdevice\tExampleTV
`;

describe("resolveDeviceTarget", () => {
  it("honors an explicit pin that is online, normalizing the port", () => {
    expect(resolveDeviceTarget("192.0.2.6", SAMPLE)).toEqual({
      target: "192.0.2.6:26101",
      source: "pin",
    });
  });

  it("refuses a stale pin, naming it and the device now online, rather than switching to it", () => {
    expect(() => resolveDeviceTarget("192.0.2.6:26101", SAMPLE_MOVED)).toThrow(
      /"192\.0\.2\.6:26101" \(from the configured Tizen device \(FLUTTER_DEVICE_TIZEN_DEVICE\)\) is not online\. Online Tizen devices: 192\.0\.2\.7:26101/
    );
  });

  it("refuses a pinned device that is listed but offline, naming its state", () => {
    expect(() =>
      resolveDeviceTarget(
        "192.0.2.6:26101",
        SAMPLE_OFFLINE + "192.0.2.7:26101\tdevice\tExampleTV\n"
      )
    ).toThrow(/is not online \(it is listed, in state "offline"\)/);
  });

  it("refuses a pin when nothing is online, and names the pin's source", () => {
    expect(() =>
      resolveDeviceTarget(
        "192.0.2.6",
        "List of devices attached\n",
        "/repo/app/.tizen-target"
      )
    ).toThrow(/"192\.0\.2\.6:26101" \(from \/repo\/app\/\.tizen-target\).*Online Tizen devices: none/);
  });

  it("reads the device out of a .tizen-target file, bare or as a DEVICE_IP line", () => {
    expect(parseTizenTargetFile("192.0.2.6:26101\n")).toBe("192.0.2.6:26101");
    expect(
      parseTizenTargetFile("DEVICE_ARCH=arm\nDEVICE_IP=192.0.2.6\nRUST_TARGET=x\n")
    ).toBe("192.0.2.6");
    expect(parseTizenTargetFile("DEVICE_ARCH=arm\n")).toBeUndefined();
  });

  it("reads the package id out of a flutter-tizen tpk file name", () => {
    expect(tpkPackageId("com.example.app-1.0.4.tpk")).toBe("com.example.app");
    expect(tpkPackageId("com.example.app-1.0.4-arm.tpk")).toBe("com.example.app");
    expect(tpkPackageId("notes.txt")).toBeUndefined();
  });

  it("falls back to the first online device from sdb output", () => {
    expect(resolveDeviceTarget(undefined, SAMPLE)).toEqual({
      target: "192.0.2.6:26101",
      source: "discovered",
    });
  });

  it("falls back to an offline device when none are online", () => {
    expect(resolveDeviceTarget(undefined, SAMPLE_OFFLINE)).toEqual({
      target: "192.0.2.6:26101",
      source: "discovered-offline",
    });
  });

  it("returns null when no device is available", () => {
    expect(resolveDeviceTarget(undefined, "List of devices attached\n")).toBeNull();
    expect(resolveDeviceTarget(undefined, undefined)).toBeNull();
  });
});
