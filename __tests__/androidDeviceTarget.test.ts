import {
  androidTargetClass,
  parseAdbDevices,
  resolveAndroidTarget,
  isOnline,
} from "../src/androidDeviceTarget.js";
import { RequestedDeviceUnavailableError } from "../src/deviceRequest.js";

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

  it("refuses a pin whose device is offline, naming it, its state and the online device", () => {
    expect(() => resolveAndroidTarget("emulator-5554", ADB_DEVICES_L)).toThrow(
      /"emulator-5554" \(from the FLUTTER_DEVICE_ANDROID_DEVICE env var\) is not online \(it is listed, in state "offline"\)\. Online Android devices: 39121FDJH003AB \(physical, Pixel_7\)/
    );
  });

  it("names the per-call argument, not the env var, when the pin came from the call", () => {
    // The two pins are fixed differently: the env var needs a host reload, the
    // argument does not.
    expect(() =>
      resolveAndroidTarget("emulator-5554", ADB_DEVICES_L, "call")
    ).toThrow(/from the device_udid argument/);
  });

  it("carries the requested id on the error, for a host-side teardown scoped to it", () => {
    let caught: unknown;
    try {
      resolveAndroidTarget("emulator-5554", ADB_DEVICES_L, "call");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestedDeviceUnavailableError);
    expect((caught as RequestedDeviceUnavailableError).requested).toBe("emulator-5554");
  });

  it("adds the RSA-prompt hint when the named device is unauthorized", () => {
    expect(() => resolveAndroidTarget("R5CT10ABCDE", ADB_DEVICES_L)).toThrow(
      /RSA prompt/
    );
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

  it("refuses a pin that names no listed device, even with nothing online to confuse it with", () => {
    const offlineOnly =
      "List of devices attached\nemulator-5554  offline product:x model:y\n";
    expect(() => resolveAndroidTarget("39121FDJH003AB", offlineOnly)).toThrow(
      /"39121FDJH003AB".*is not online\. Online Android devices: none/
    );
  });
});

describe("resolveAndroidTarget target class (kind)", () => {
  const PHONE_ONLY =
    "List of devices attached\n" +
    "RFCR902W0TT  device usb:1-1 product:q2qsqw model:SM_F926U1 device:q2q transport_id:2\n";
  const BOTH =
    PHONE_ONLY +
    "emulator-5556  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a\n";

  it("refuses an emulator request when only a physical phone is online", () => {
    expect(() =>
      resolveAndroidTarget(undefined, PHONE_ONLY, "env", "simulator")
    ).toThrow(/an emulator was requested and none is online.*RFCR902W0TT \(physical, SM_F926U1\)/);
  });

  it("serves an emulator request with the emulator even when the phone is listed first", () => {
    const r = resolveAndroidTarget(undefined, BOTH, "env", "simulator")!;
    expect(r.target).toBe("emulator-5556");
  });

  it("serves a physical request with the phone even when an emulator is online", () => {
    const emulatorFirst =
      "List of devices attached\n" +
      "emulator-5556  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n" +
      "RFCR902W0TT  device usb:1-1 product:q2qsqw model:SM_F926U1\n";
    const r = resolveAndroidTarget(undefined, emulatorFirst, "env", "device")!;
    expect(r.target).toBe("RFCR902W0TT");
  });

  it("refuses a named device whose class contradicts the requested one", () => {
    expect(() =>
      resolveAndroidTarget("RFCR902W0TT", BOTH, "call", "simulator")
    ).toThrow(/"RFCR902W0TT" is a physical target, but an emulator was requested/);
  });

  it("classifies emulators by serial or system-image descriptor, and anything else as physical", () => {
    expect(androidTargetClass("emulator-5554")).toBe("emulator");
    expect(androidTargetClass({ serial: "localhost:5555", state: "device", product: "sdk_gphone64_arm64" })).toBe("emulator");
    expect(androidTargetClass({ serial: "RFCR902W0TT", state: "device", product: "q2qsqw", model: "SM_F926U1" })).toBe("physical");
    expect(androidTargetClass("RFCR902W0TT")).toBe("physical");
  });
});

describe("resolveAndroidTarget: names that match more than one device", () => {
  const TWO_SAME_MODEL =
    "List of devices attached\n" +
    "emulator-5554  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n" +
    "emulator-5556  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n";

  it("refuses a model pin that matches two online devices, listing both", () => {
    expect(() => resolveAndroidTarget("sdk_gphone64_arm64", TWO_SAME_MODEL, "call")).toThrow(
      /"sdk_gphone64_arm64" \(from the device_udid argument\) matches 2 online Android devices: emulator-5554 \(emulator, sdk_gphone64_arm64\), emulator-5556 \(emulator, sdk_gphone64_arm64\)/
    );
  });

  it("takes the online one when the model also matches an offline device listed first", () => {
    const oneOffline = TWO_SAME_MODEL.replace("emulator-5554  device", "emulator-5554  offline");
    expect(resolveAndroidTarget("sdk_gphone64_arm64", oneOffline, "call")?.target).toBe("emulator-5556");
  });

  it("names the listed serial on the refusal when a model pin's only match is offline", () => {
    const offline =
      "List of devices attached\nemulator-5554  offline product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n";
    let caught: unknown;
    try {
      resolveAndroidTarget("sdk_gphone64_arm64", offline, "call");
    } catch (error) {
      caught = error;
    }
    expect((caught as RequestedDeviceUnavailableError).listedAs).toBe("emulator-5554");
  });
});
