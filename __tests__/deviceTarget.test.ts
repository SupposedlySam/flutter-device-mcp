import {
  DEFAULT_SDB_PORT,
  normalizeDeviceTarget,
  parseDeviceTarget,
  parseSdbDevices,
  resolveDeviceTarget,
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

  it("falls back to the first online device when the pin is stale", () => {
    const resolution = resolveDeviceTarget("192.0.2.6:26101", SAMPLE_MOVED);
    expect(resolution?.target).toBe("192.0.2.7:26101");
    expect(resolution?.source).toBe("discovered");
    expect(resolution?.warning).toContain("192.0.2.6:26101");
    expect(resolution?.warning).toContain("192.0.2.7:26101");
  });

  it("treats a pinned device that is listed but offline as stale", () => {
    const resolution = resolveDeviceTarget(
      "192.0.2.6:26101",
      SAMPLE_OFFLINE + "192.0.2.7:26101\tdevice\tExampleTV\n"
    );
    expect(resolution?.target).toBe("192.0.2.7:26101");
    expect(resolution?.source).toBe("discovered");
  });

  it("keeps a stale pin (with a warning) when nothing is online", () => {
    const resolution = resolveDeviceTarget(
      "192.0.2.6",
      "List of devices attached\n"
    );
    expect(resolution).toEqual({
      target: "192.0.2.6:26101",
      source: "stale-pin",
      warning: expect.stringContaining("no online device"),
    });
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
