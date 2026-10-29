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

  it("refuses a stale pin, naming the registered devices, rather than switching to one", () => {
    expect(() => resolveWebosDeviceTarget("moved-away", LIST)).toThrow(
      /"moved-away" \(from the FLUTTER_DEVICE_WEBOS_DEVICE env var\) is not online\. Online webOS devices: tv-26 \(192\.168\.1\.50\), emulator \(127\.0\.0\.1\)/
    );
  });

  it("refuses a stale pin when nothing is registered either", () => {
    expect(() => resolveWebosDeviceTarget("moved-away", "")).toThrow(
      /Online webOS devices: none/
    );
  });

  it("discovers the first device with no pin (and carries its host)", () => {
    const resolution = resolveWebosDeviceTarget(undefined, LIST);
    expect(resolution).toEqual({
      target: "tv-26",
      source: "discovered",
      host: "192.168.1.50",
      unnamedAmong: [
        { id: "tv-26", detail: "192.168.1.50" },
        { id: "emulator", detail: "127.0.0.1" },
      ],
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

describe("resolveWebosDeviceTarget: a registered device with no connection", () => {
  it("refuses the pin rather than acting on a device it cannot reach", () => {
    const withPlaceholder = LIST + "\nbedroom";
    expect(() => resolveWebosDeviceTarget("bedroom", withPlaceholder)).toThrow(
      /"bedroom" \(from the FLUTTER_DEVICE_WEBOS_DEVICE env var\) is not online \(it is listed, in state "registered without a connection"\)/
    );
  });
});
