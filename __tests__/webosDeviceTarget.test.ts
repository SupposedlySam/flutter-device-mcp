import {
  parseAresDevices,
  resolveWebosDeviceTarget,
} from "../src/webos/webosDeviceTarget.js";

const LIST = [
  "name       deviceinfo             connection  profile",
  "----       ----------             ----------  -------",
  "tv-26      prisoner@192.168.1.50  ssh         tv",
  "emulator   developer@127.0.0.1    ssh         tv",
].join("\n");

describe("parseAresDevices", () => {
  it("skips the header and parses name + connection", () => {
    const devices = parseAresDevices(LIST);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      name: "tv-26",
      connection: "prisoner@192.168.1.50",
      host: "192.168.1.50",
      online: true,
    });
  });

  it("skips the dashed separator row under the header (not a device)", () => {
    // The separator row (`----  ----  ----`) must never become a device — it
    // would otherwise be a bogus `{name:"----", online:true}` that discovery
    // and self-heal could select.
    const names = parseAresDevices(LIST).map((d) => d.name);
    expect(names).toEqual(["tv-26", "emulator"]);
    expect(names).not.toContain("----");
  });

  it("returns an empty list for empty output", () => {
    expect(parseAresDevices("")).toEqual([]);
    expect(parseAresDevices("\n\n")).toEqual([]);
  });

  it("marks a device with no connection column as offline", () => {
    const devices = parseAresDevices("name deviceinfo connection profile\nplaceholder");
    expect(devices).toEqual([
      { name: "placeholder", connection: undefined, host: undefined, online: false },
    ]);
  });

  it("parses the bare host out of a user@host:port connection", () => {
    const devices = parseAresDevices(
      "name deviceinfo connection profile\ntv developer@10.0.0.9:9922 ssh tv"
    );
    expect(devices[0].host).toBe("10.0.0.9");
  });
});

describe("resolveWebosDeviceTarget", () => {
  it("honors a pin that is a registered device (and carries its host)", () => {
    const resolution = resolveWebosDeviceTarget("emulator", LIST);
    expect(resolution).toEqual({
      target: "emulator",
      source: "pin",
      host: "127.0.0.1",
    });
  });

  it("falls back to the first listed device for a stale pin (self-heal)", () => {
    const resolution = resolveWebosDeviceTarget("moved-away", LIST);
    expect(resolution?.target).toBe("tv-26");
    expect(resolution?.source).toBe("discovered");
    expect(resolution?.warning).toMatch(/stale pin/i);
  });

  it("keeps a stale pin when nothing else is listed", () => {
    const resolution = resolveWebosDeviceTarget("moved-away", "");
    expect(resolution).toEqual(
      expect.objectContaining({ target: "moved-away", source: "stale-pin" })
    );
    expect(resolution?.warning).toMatch(/no other device/i);
  });

  it("discovers the first device with no pin (and carries its host)", () => {
    const resolution = resolveWebosDeviceTarget(undefined, LIST);
    expect(resolution).toEqual({
      target: "tv-26",
      source: "discovered",
      host: "192.168.1.50",
    });
  });

  it("prefers the ONLINE device over an earlier offline row", () => {
    const mixed = [
      "name  deviceinfo  connection  profile",
      "offline-first",
      "tv-online  developer@192.168.1.77  ssh  tv",
    ].join("\n");
    const resolution = resolveWebosDeviceTarget(undefined, mixed);
    expect(resolution).toEqual({
      target: "tv-online",
      source: "discovered",
      host: "192.168.1.77",
    });
  });

  it("reports discovered-offline when only an offline device is listed", () => {
    const offlineOnly = [
      "name  deviceinfo  connection  profile",
      "placeholder",
    ].join("\n");
    const resolution = resolveWebosDeviceTarget(undefined, offlineOnly);
    expect(resolution).toEqual({
      target: "placeholder",
      source: "discovered-offline",
      host: undefined,
    });
  });

  it("returns null when no device is configured at all", () => {
    expect(resolveWebosDeviceTarget(undefined, "")).toBeNull();
  });
});
