/**
 * Resolution of the sdb device target (host:port) used for install/launch.
 *
 * The target comes from a device pin (env var or `.tizen-target`) when set AND
 * currently online (a pin that is not online is refused, never replaced),
 * otherwise it is discovered by parsing `sdb devices` output. Devices connect
 * over TCP as `host:port`; when a bare host is supplied the default sdb port
 * 26101 is appended.
 *
 * This is sdb/Tizen-specific (it parses `sdb devices`); the Tizen adapter owns
 * it. The neutral {@link DeviceResolution} shape lives in `types.ts` so other
 * platforms can return the same shape from their own discovery.
 */
import {
  RequestedDeviceUnavailableError,
  unnamedChoiceRefused,
} from "./deviceRequest.js";
import { DeviceResolution } from "./types.js";

export type { DeviceResolution } from "./types.js";

export const DEFAULT_SDB_PORT = 26101;

export interface SdbDevice {
  /** The serial/target as sdb reports it (e.g. `<host>:26101`). */
  serial: string;
  /** Connection state: `device`, `offline`, `unauthorized`, etc. */
  state: string;
  /** The device name/model column, when present. */
  name?: string;
}

/** A device target split into its host and sdb port parts. */
export interface DeviceTargetParts {
  host: string;
  port: number;
}

/** Split a `host[:port]` target, defaulting a missing port to the sdb 26101. */
export function parseDeviceTarget(target: string): DeviceTargetParts {
  const trimmed = target.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return { host: trimmed, port: DEFAULT_SDB_PORT };

  const host = trimmed.slice(0, colonIndex);
  const port = Number(trimmed.slice(colonIndex + 1));
  if (!Number.isInteger(port) || port <= 0) {
    return { host: trimmed, port: DEFAULT_SDB_PORT };
  }
  return { host, port };
}

/** Append the default sdb port to a bare host, leaving host:port untouched. */
export function normalizeDeviceTarget(target: string): string {
  const { host, port } = parseDeviceTarget(target);
  return `${host}:${port}`;
}

/**
 * Parse the table printed by `sdb devices`. The first line is the
 * `List of devices attached` header; each remaining non-empty line is
 * whitespace-separated as `<serial> <state> [name]`.
 */
export function parseSdbDevices(output: string): SdbDevice[] {
  if (!output) return [];

  const devices: SdbDevice[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("List of devices")) continue;
    if (trimmed.startsWith("* ")) continue; // daemon start-up chatter

    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] ?? "unknown";
    const name = parts.slice(2).join(" ") || undefined;
    devices.push({ serial, state, name });
  }
  return devices;
}

/**
 * Pick the device target to operate on.
 *
 * A pinned device (normalized to host:port) is used only while it appears as an
 * ONLINE device in the `sdb devices` output; otherwise this throws
 * {@link RequestedDeviceUnavailableError} naming it and the online devices. It
 * is never replaced: a Smart Monitor that moved DHCP address is a different
 * target until someone says so (flutter_setup with its new address).
 *
 * Without a pin, the one device in `device` state is used (several are refused
 * rather than taking the first), then any listed device (may be offline) so
 * callers can surface a more specific error than "no devices at all". Returns
 * null when nothing is usable.
 */
export function resolveDeviceTarget(
  explicitDevice: string | undefined,
  sdbDevicesOutput: string | undefined,
  origin = "the configured Tizen device (FLUTTER_DEVICE_TIZEN_DEVICE)"
): DeviceResolution | null {
  const devices = parseSdbDevices(sdbDevicesOutput ?? "");
  const online = devices.find((d) => d.state === "device");

  if (explicitDevice && explicitDevice.trim().length > 0) {
    const pinned = normalizeDeviceTarget(explicitDevice);
    const listed = devices.find((d) => normalizeDeviceTarget(d.serial) === pinned);
    if (listed?.state === "device") return { target: pinned, source: "pin" };
    throw new RequestedDeviceUnavailableError({
      platform: "Tizen",
      requested: pinned,
      origin,
      state: listed?.state,
      online: devices
        .filter((d) => d.state === "device")
        .map((d) => ({ id: normalizeDeviceTarget(d.serial), detail: d.name })),
      hint:
        "If the device moved DHCP address, run flutter_setup with its new address " +
        "(it rewrites .tizen-target) or update FLUTTER_DEVICE_TIZEN_DEVICE.",
    });
  }

  const allOnline = devices.filter((d) => d.state === "device");
  if (allOnline.length > 1) {
    throw unnamedChoiceRefused({
      platform: "Tizen",
      online: allOnline.map((d) => ({ id: normalizeDeviceTarget(d.serial), detail: d.name })),
      hint:
        "Pass device_udid, run flutter_setup for the device you mean (it writes " +
        ".tizen-target), or set FLUTTER_DEVICE_TIZEN_DEVICE.",
    });
  }
  if (online) {
    return { target: normalizeDeviceTarget(online.serial), source: "discovered" };
  }

  const anyDevice = devices[0];
  return anyDevice
    ? {
        target: normalizeDeviceTarget(anyDevice.serial),
        source: "discovered-offline",
      }
    : null;
}

/**
 * The device a `.tizen-target` file names. `setup` writes the bare
 * `host:port`; a `DEVICE_IP=<host>` line is read too, so a file written by
 * another tool still pins its device.
 */
export function parseTizenTargetFile(content: string): string | undefined {
  const keyed = content.match(/^\s*DEVICE_IP=(.+)$/m)?.[1]?.trim();
  if (keyed) return keyed;
  const first = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return first && !first.includes("=") ? first : undefined;
}

/**
 * The package id a built `.tpk` carries, from the `<package>-<version>` file
 * name flutter-tizen gives it.
 */
export function tpkPackageId(fileName: string): string | undefined {
  return fileName.match(/^(.+?)-\d[^/]*\.tpk$/)?.[1];
}
