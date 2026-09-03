import {
  parseAdbDevices,
  resolveAndroidTarget,
  isOnline,
} from "../src/androidDeviceTarget.js";

// Realistic `adb devices -l` output: an online device, an offline device, and
// an unauthorized device — plus the header and daemon chatter that adb prints.
const ADB_DEVICES_L =
  "* daemon not running; starting now at tcp:5037\n" +
  "* daemon started successfully\n" +
  "List of devices attached\n" +
  "39121FDJH003AB         device product:panther model:Pixel_7 device:panther transport_id:3\n" +
  "emulator-5554          offline product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a\n" +
  "R5CT10ABCDE            unauthorized usb:1-1\n";

describe("parseAdbDevices", () => {
  it("parses serial, state, model and product for each row", () => {
    const devices = parseAdbDevices(ADB_DEVICES_L);
    expect(devices).toHaveLength(3);

    const pixel = devices[0];
    expect(pixel.serial).toBe("39121FDJH003AB");
    expect(pixel.state).toBe("device");
    expect(pixel.model).toBe("Pixel_7");
    expect(pixel.product).toBe("panther");

    const emu = devices[1];
    expect(emu.serial).toBe("emulator-5554");
    expect(emu.state).toBe("offline");

    const unauth = devices[2];
    expect(unauth.serial).toBe("R5CT10ABCDE");
    expect(unauth.state).toBe("unauthorized");
  });

  it("captures a multi-word 'no permissions' state (all tokens before the first key:value)", () => {
    const devices = parseAdbDevices(
      "List of devices attached\nABC123  no permissions user in plugdev group usb:1-1\n"
    );
    expect(devices).toHaveLength(1);
    // Everything up to the first key:value token (`usb:1-1`) is the state.
    expect(devices[0].state).toBe("no permissions user in plugdev group");
    expect(/unauthorized/i.test(devices[0].state)).toBe(false);
  });

  it("skips the header and daemon chatter, returns [] for empty", () => {
    expect(parseAdbDevices("List of devices attached\n")).toEqual([]);
    expect(parseAdbDevices("")).toEqual([]);
    expect(parseAdbDevices("* daemon started successfully\n")).toEqual([]);
  });

  it("isOnline is true only for the 'device' state", () => {
    const [pixel, emu, unauth] = parseAdbDevices(ADB_DEVICES_L);
    expect(isOnline(pixel)).toBe(true);
    expect(isOnline(emu)).toBe(false);
    expect(isOnline(unauth)).toBe(false);
  });
});

describe("resolveAndroidTarget (single-id: serial === flutter id)", () => {
  it("returns null when no devices are listed at all", () => {
    expect(resolveAndroidTarget(undefined, "List of devices attached\n")).toBeNull();
    expect(resolveAndroidTarget(undefined, "")).toBeNull();
  });

  it("discovers the first ONLINE device, skipping offline/unauthorized", () => {
    const r = resolveAndroidTarget(undefined, ADB_DEVICES_L)!;
    expect(r.target).toBe("39121FDJH003AB"); // the online Pixel, not the emulator/unauth
    expect(r.source).toBe("discovered");
    expect(r.warning).toBeUndefined();
    // The single carried id is BOTH the adb serial and the flutter run -d id —
    // there is no second id space to translate to (unlike iOS).
  });

  it("carries a single id — no separate devicectl-style id field", () => {
    const r = resolveAndroidTarget(undefined, ADB_DEVICES_L)!;
    expect(Object.keys(r).sort()).toEqual(["source", "target"]);
  });

  it("surfaces a clear message when the ONLY device is unauthorized", () => {
    const onlyUnauth =
      "List of devices attached\nR5CT10ABCDE  unauthorized usb:1-1\n";
    const r = resolveAndroidTarget(undefined, onlyUnauth)!;
    expect(r.target).toBe("R5CT10ABCDE");
    expect(r.source).toBe("discovered-offline");
    expect(r.warning).toMatch(/unauthorized/i);
    expect(r.warning).toMatch(/RSA prompt/i);
  });

  it("still surfaces the RSA hint in a MIXED offline + unauthorized state", () => {
    // Neither device is online: one offline, one unauthorized. The hint must not
    // be suppressed just because unauthorized isn't the SOLE state.
    const mixed =
      "List of devices attached\n" +
      "emulator-5554  offline product:x model:y\n" +
      "R5CT10ABCDE    unauthorized usb:1-1\n";
    const r = resolveAndroidTarget(undefined, mixed)!;
    expect(r.source).toBe("discovered-offline");
    expect(r.warning).toMatch(/unauthorized/i);
    expect(r.warning).toMatch(/RSA prompt/i);
  });

  it("honors a pin by serial when that device is online", () => {
    const r = resolveAndroidTarget("39121FDJH003AB", ADB_DEVICES_L)!;
    expect(r.target).toBe("39121FDJH003AB");
    expect(r.source).toBe("pin");
  });

  it("honors a pin by model name when that device is online", () => {
    const r = resolveAndroidTarget("Pixel_7", ADB_DEVICES_L)!;
    expect(r.target).toBe("39121FDJH003AB");
    expect(r.source).toBe("pin");
  });

  it("self-heals a stale pin to the first online device with a warning", () => {
    // Pin points at the offline emulator; the online Pixel should win.
    const r = resolveAndroidTarget("emulator-5554", ADB_DEVICES_L)!;
    expect(r.target).toBe("39121FDJH003AB");
    expect(r.source).toBe("discovered");
    expect(r.warning).toMatch(/stale pin/i);
    expect(r.warning).toMatch(/emulator-5554/);
  });

  it("names the PER-CALL pin, not the env var, when a call-supplied pin self-heals", () => {
    // The two pins fail identically but are fixed differently: the env var needs
    // a host reload, the argument does not. A warning that always blames
    // FLUTTER_DEVICE_ANDROID_DEVICE sends an unattended caller to the wrong knob.
    const r = resolveAndroidTarget("emulator-5554", ADB_DEVICES_L, "call")!;
    expect(r.target).toBe("39121FDJH003AB");
    expect(r.warning).toMatch(/device_udid/);
    expect(r.warning).not.toMatch(/FLUTTER_DEVICE_ANDROID_DEVICE/);
  });

  it("defaults to the env wording when no origin is given (existing callers)", () => {
    const r = resolveAndroidTarget("emulator-5554", ADB_DEVICES_L)!;
    expect(r.warning).toMatch(/FLUTTER_DEVICE_ANDROID_DEVICE/);
    expect(r.warning).not.toMatch(/device_udid/);
  });

  it("honors a per-call pin over the online-first default with no warning", () => {
    // Both online, the Pixel listed first: an emulator can only be reached by
    // naming it, which is the whole point of the per-call pin.
    const bothOnline =
      "List of devices attached\n" +
      "39121FDJH003AB  device product:panther model:Pixel_7\n" +
      "emulator-5554   device product:sdk_gphone64 model:sdk_gphone64_arm64\n";
    const r = resolveAndroidTarget("emulator-5554", bothOnline, "call")!;
    expect(r.target).toBe("emulator-5554");
    expect(r.source).toBe("pin");
    expect(r.warning).toBeUndefined();
  });

  it("keeps a pin that names no listed device when nothing online exists", () => {
    const offlineOnly =
      "List of devices attached\nemulator-5554  offline product:x model:y\n";
    const r = resolveAndroidTarget("39121FDJH003AB", offlineOnly)!;
    expect(r.target).toBe("39121FDJH003AB");
    expect(r.source).toBe("stale-pin");
    expect(r.warning).toMatch(/Proceeding with the pin/i);
    expect(r.warning).toMatch(/FLUTTER_DEVICE_ANDROID_DEVICE/);

    // Same selection from a per-call pin — only the wording changes, so a caller
    // who names a device that just went offline is never hard-failed.
    const call = resolveAndroidTarget("39121FDJH003AB", offlineOnly, "call")!;
    expect(call.target).toBe("39121FDJH003AB");
    expect(call.source).toBe("stale-pin");
    expect(call.warning).toMatch(/device_udid/);
  });
});
