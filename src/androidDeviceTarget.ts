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
 * adapter captures — it never spawns anything. The stale-pin fallback mirrors the
 * Tizen/iOS path: a pin (serial or name) that is not currently an online device
 * self-heals to the first online device with a warning, so a reconnected/renamed
 * target does not strand every deploy.
 */
import { DeviceResolution } from "./types.js";

export type { DeviceResolution } from "./types.js";

/**
 * One parsed Android device from `adb devices -l`.
 *
 * `serial` is the single id every consumer uses (adb `-s <serial>` AND
 * `flutter run -d <serial>`). `state` is adb's connection state — only `device`
 * is usable; `offline`/`unauthorized`/`no permissions` are surfaced but never
 * auto-selected. `model`/`product` are the display-only descriptors adb prints
 * in the `-l` (long) form (e.g. `model:Pixel_7 product:panther`).
 */
export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
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
    for (const token of rest) {
      const [key, value] = token.split(":");
      if (!value) continue;
      if (key === "model") model = value;
      else if (key === "product") product = value;
    }
    devices.push({ serial, state, model, product });
  }
  return devices;
}

/** True when a device is in adb's usable `device` state (not offline/unauthorized). */
export function isOnline(d: AdbDevice): boolean {
  return d.state === "device";
}

/** True when a pin string matches a device by serial or (case-insensitive) model. */
function pinMatches(pin: string, d: AdbDevice): boolean {
  const p = pin.trim().toLowerCase();
  return (
    d.serial.toLowerCase() === p ||
    (!!d.model && d.model.trim().toLowerCase() === p)
  );
}

/** Build a resolution payload from a chosen device. */
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

/**
 * Pick the Android device to operate on.
 *
 * A pin (serial or model name, via `FLUTTER_DEVICE_ANDROID_DEVICE`) is authoritative
 * while it matches an ONLINE device; otherwise it self-heals to the first online
 * device (with a warning), then any listed device, mirroring the Tizen/iOS
 * pattern. Offline/unauthorized devices are never auto-selected — when no online
 * device is usable, resolution still returns the best-effort first listed device
 * as `discovered-offline` with a warning. If ANY connected device is
 * unauthorized (even in a mixed offline+unauthorized state), the warning carries
 * the exact "accept the RSA prompt on the device" guidance rather than a bare
 * "no devices". Returns null when nothing is listed at all.
 */
export function resolveAndroidTarget(
  pinned: string | undefined,
  adbDevicesOutput: string | undefined
): DeviceResolution | null {
  const devices = parseAdbDevices(adbDevicesOutput ?? "");
  if (devices.length === 0) return null;

  const online = devices.find(isOnline);
  // Surface the RSA-prompt hint whenever ANY device is unauthorized — not only
  // when unauthorized is the sole state. A mixed offline+unauthorized set would
  // otherwise suppress the actionable guidance the user needs.
  const anyUnauthorized = devices.some((d) => /unauthorized/i.test(d.state));

  const unauthorizedWarning = anyUnauthorized
    ? "A connected Android device is 'unauthorized' — accept the 'Allow " +
      "USB debugging' RSA prompt ON THE DEVICE (and enable USB debugging in " +
      "Developer options), then retry."
    : undefined;

  if (pinned && pinned.trim().length > 0) {
    const pin = pinned.trim();
    const matched = devices.find((d) => pinMatches(pin, d));
    if (matched && isOnline(matched)) {
      return toResolution(matched, "pin");
    }
    if (online) {
      return toResolution(
        online,
        "discovered",
        `FLUTTER_DEVICE_ANDROID_DEVICE is pinned to ${pin}, but that target is not an ` +
          `online adb device (stale pin — it may be unplugged, offline, or ` +
          `unauthorized). Using the first online device ${online.serial} instead.`
      );
    }
    if (matched) {
      // Listed but offline/unauthorized — keep the pin, best effort.
      return toResolution(
        matched,
        "discovered-offline",
        unauthorizedWarning
      );
    }
    return {
      target: pin,
      source: "stale-pin",
      warning:
        `FLUTTER_DEVICE_ANDROID_DEVICE is pinned to ${pin}, but that target is not a ` +
        `connected adb device and none was found to fall back to. Proceeding ` +
        `with the pin; expect failures if it is not connected.`,
    };
  }

  if (online) {
    return toResolution(online, "discovered");
  }

  // No online device. Fall back to the first listed (offline/unauthorized) one
  // so the caller can surface a specific reason.
  return toResolution(devices[0], "discovered-offline", unauthorizedWarning);
}
