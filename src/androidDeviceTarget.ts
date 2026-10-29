/**
 * Resolution of the Android device/emulator target used for build/install/launch.
 *
 * KEY SIMPLIFICATION vs iOS: on Android the adb serial IS flutter's device id.
 * `flutter run -d <serial>` accepts the same serial `adb devices` reports, and
 * `flutter devices --machine` echoes that serial back as the device `id`. There
 * is therefore NO two-id-namespace problem (the iOS ECID-vs-devicectl-UUID split
 * does not exist here), so a resolved target carries a SINGLE id used by every
 * consumer — deploy/launch, install, uninstall, and lifecycle alike.
 *
 * This module is pure parsing/selection over the raw `adb devices -l` output the
 * adapter captures — it never spawns anything. A named device that is not
 * online is refused, never replaced (see deviceRequest.ts).
 */
import {
  ambiguousNameRefused,
  OnlineDevice,
  pickNamedMatch,
  RequestedDeviceUnavailableError,
  targetClassUnavailable,
  unnamedChoiceRefused,
} from "./deviceRequest.js";
import { DeviceResolution } from "./types.js";

export type { DeviceResolution } from "./types.js";

/**
 * One parsed Android device from `adb devices -l`.
 *
 * `serial` is the single id every consumer uses (adb `-s <serial>` AND
 * `flutter run -d <serial>`). `state` is adb's connection state — only `device`
 * is usable; `offline`/`unauthorized`/`no permissions` are surfaced but never
 * selected. `model`/`product`/`device` are the descriptors adb prints in the
 * `-l` (long) form (e.g. `model:Pixel_7 product:panther device:panther`).
 */
export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
}

/**
 * Parse the table printed by `adb devices -l`.
 *
 * The first line is the `List of devices attached` header; each remaining
 * non-empty line is `<serial> <state> [key:value ...]` where the key/value pairs
 * carry `model:` and `product:` in the long form. Daemon start-up chatter
 * (`* daemon not running`, `* daemon started successfully`) is skipped.
 */
export function parseAdbDevices(output: string): AdbDevice[] {
  if (!output) return [];

  const devices: AdbDevice[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("List of devices")) continue;
    if (trimmed.startsWith("* ")) continue; // daemon start-up chatter
    // adb can emit a leading "adb server version ... killing..." notice line.
    if (/^adb server/i.test(trimmed)) continue;

    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    if (!serial) continue;
    // adb reports "no permissions" as a two-word state; join everything up to
    // the first key:value token as the state so it is captured intact.
    const rest = parts.slice(1);
    const firstKvIndex = rest.findIndex((p) => p.includes(":"));
    const stateTokens = firstKvIndex === -1 ? rest : rest.slice(0, firstKvIndex);
    const state = stateTokens.join(" ") || "unknown";

    let model: string | undefined;
    let product: string | undefined;
    let device: string | undefined;
    for (const token of rest) {
      const [key, value] = token.split(":");
      if (!value) continue;
      if (key === "model") model = value;
      else if (key === "product") product = value;
      else if (key === "device") device = value;
    }
    devices.push({ serial, state, model, product, device });
  }
  return devices;
}

/** True when a device is in adb's usable `device` state (not offline/unauthorized). */
export function isOnline(d: AdbDevice): boolean {
  return d.state === "device";
}

/** Whether an adb target is an emulator or real hardware. */
export type AndroidTargetClass = "emulator" | "physical";

// Emulator system images report sdk_*/generic*/emu* descriptors (ranchu and
// goldfish are the emulator kernels); a phone reports its own codename.
const EMULATOR_DESCRIPTOR =
  /^(sdk_|sdk$|generic|emu|ranchu|goldfish|vbox86)|Android_SDK_built_for/i;
const EMULATOR_SERIAL = /^emulator-\d+$/;

/**
 * Classify a listed device, or a bare name that is not listed at all (an
 * `emulator-<port>` serial is an emulator whether or not it is running). An
 * unrecognised device counts as physical, so an emulator request can never
 * select it.
 */
export function androidTargetClass(d: AdbDevice | string): AndroidTargetClass {
  if (typeof d === "string") {
    const name = d.trim();
    return EMULATOR_SERIAL.test(name) || EMULATOR_DESCRIPTOR.test(name)
      ? "emulator"
      : "physical";
  }
  if (EMULATOR_SERIAL.test(d.serial)) return "emulator";
  return [d.product, d.model, d.device].some(
    (v) => !!v && EMULATOR_DESCRIPTOR.test(v)
  )
    ? "emulator"
    : "physical";
}

function describeDevice(d: AdbDevice): OnlineDevice {
  return {
    id: d.serial,
    detail: [androidTargetClass(d), d.model].filter(Boolean).join(", "),
  };
}

/**
 * Where a pin came from, so a refusal names the knob the caller can actually
 * turn: the `FLUTTER_DEVICE_ANDROID_DEVICE` env var (which only a host reload can
 * change) or the per-call `device_udid` argument (which needs no reload).
 */
export type AndroidPinOrigin = "env" | "call";

function describeOrigin(origin: AndroidPinOrigin): string {
  return origin === "call"
    ? "the device_udid argument"
    : "the FLUTTER_DEVICE_ANDROID_DEVICE env var";
}

/** True when a pin string matches a device by serial or (case-insensitive) model. */
function pinMatches(pin: string, d: AdbDevice): boolean {
  const p = pin.trim().toLowerCase();
  return (
    d.serial.toLowerCase() === p ||
    (!!d.model && d.model.trim().toLowerCase() === p)
  );
}

function toResolution(
  d: AdbDevice,
  source: DeviceResolution["source"],
  warning?: string
): DeviceResolution {
  return {
    target: d.serial,
    source,
    ...(warning ? { warning } : {}),
  };
}

const UNAUTHORIZED_HINT =
  "An 'unauthorized' device needs the 'Allow USB debugging' RSA prompt accepted " +
  "ON THE DEVICE (with USB debugging enabled in Developer options).";

/**
 * Pick the Android device to operate on.
 *
 * A named device — a per-call `device_udid` or the `FLUTTER_DEVICE_ANDROID_DEVICE` env
 * pin, matched by serial or model — is used only while exactly one match is
 * ONLINE. No online match throws {@link RequestedDeviceUnavailableError} naming it
 * and the online devices; several (two emulators booted from one image report
 * the same model) is refused as ambiguous. It never substitutes another device.
 * A blank pin counts as no pin.
 *
 * `kind` ("simulator" meaning an emulator, "device" meaning real hardware)
 * restricts the choice to that class: a named device of the other class is
 * refused, and so is a request for a class with no online member.
 *
 * With nothing named, the single online device of the requested class (any
 * class when none was requested) is used; several online are refused rather
 * than taking the first, because the first is how a personal phone gets picked
 * over the emulator beside it. With none online, the first listed one comes back
 * as `discovered-offline` so the caller can surface a specific reason. Returns
 * null when nothing is listed at all.
 */
export function resolveAndroidTarget(
  pinned: string | undefined,
  adbDevicesOutput: string | undefined,
  pinOrigin: AndroidPinOrigin = "env",
  kind?: "device" | "simulator"
): DeviceResolution | null {
  const devices = parseAdbDevices(adbDevicesOutput ?? "");
  const wanted: AndroidTargetClass | undefined =
    kind === "simulator" ? "emulator" : kind === "device" ? "physical" : undefined;
  const onlineDevices = devices.filter(isOnline).map(describeDevice);
  const pin = pinned?.trim();

  if (pin) {
    const picked = pickNamedMatch(
      devices.filter((d) => pinMatches(pin, d)),
      isOnline
    );
    if (picked.kind === "several") {
      throw ambiguousNameRefused({
        platform: "Android",
        requested: pin,
        origin: describeOrigin(pinOrigin),
        matches: picked.devices.map(describeDevice),
      });
    }
    if (picked.kind === "none") {
      throw new RequestedDeviceUnavailableError({
        platform: "Android",
        requested: pin,
        origin: describeOrigin(pinOrigin),
        state: picked.listed?.state,
        listedAs: picked.listed?.serial,
        online: onlineDevices,
        hint:
          picked.listed && /unauthorized/i.test(picked.listed.state)
            ? UNAUTHORIZED_HINT
            : undefined,
      });
    }
    const matched = picked.device;
    const matchedClass = androidTargetClass(matched);
    if (wanted && matchedClass !== wanted) {
      throw targetClassUnavailable({
        platform: "Android",
        wanted,
        requested: pin,
        resolvedClass: matchedClass,
        online: onlineDevices,
      });
    }
    return toResolution(matched, "pin");
  }

  const pool = wanted
    ? devices.filter((d) => androidTargetClass(d) === wanted)
    : devices;
  const online = pool.filter(isOnline);
  if (online.length > 1) {
    throw unnamedChoiceRefused({
      platform: "Android",
      online: online.map(describeDevice),
      hint:
        "Name one with device_udid (a serial or model name), or pass target: " +
        "\"simulator\" / \"device\" when only one of that class is online.",
    });
  }
  if (online.length === 1) return toResolution(online[0], "discovered");
  if (wanted) {
    throw targetClassUnavailable({
      platform: "Android",
      wanted,
      online: onlineDevices,
    });
  }
  if (devices.length === 0) return null;
  const anyUnauthorized = devices.some((d) => /unauthorized/i.test(d.state));
  return toResolution(
    devices[0],
    "discovered-offline",
    anyUnauthorized
      ? `A connected Android device is 'unauthorized'. ${UNAUTHORIZED_HINT} Then retry.`
      : undefined
  );
}
