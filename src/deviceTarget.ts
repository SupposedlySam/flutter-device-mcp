/**
 * Resolution of the sdb device target (host:port) used for install/launch.
 *
 * The target comes from a device pin (env var) when set AND currently online,
 * otherwise it is discovered by parsing `sdb devices` output. Devices connect
 * over TCP as `host:port`; when a bare host is supplied the default sdb port
 * 26101 is appended.
 *
 * This is sdb/Tizen-specific (it parses `sdb devices`); the Tizen adapter owns
 * it. The neutral {@link DeviceResolution} shape lives in `types.ts` so other
 * platforms can return the same shape from their own discovery.
 */
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
 * An explicit device pin (normalized to host:port) is authoritative only while
 * it appears as an ONLINE device in the `sdb devices` output. A stale pin —
 * e.g. the Smart Monitor moved DHCP address — would otherwise route every
 * deploy to a dead address, so a pin that is not online falls back to the first
 * online sdb device (with a warning). When nothing online exists the pin is
 * kept as a best effort.
 *
 * Without a pin, the first device in `device` state is used, then any listed
 * device (may be offline) so callers can surface a more specific error than
 * "no devices at all". Returns null when nothing is usable.
 */
export function resolveDeviceTarget(
  explicitDevice: string | undefined,
  sdbDevicesOutput: string | undefined
): DeviceResolution | null {
  const devices = parseSdbDevices(sdbDevicesOutput ?? "");
  const online = devices.find((d) => d.state === "device");

  if (explicitDevice && explicitDevice.trim().length > 0) {
    const pinned = normalizeDeviceTarget(explicitDevice);
    const pinnedOnline = devices.some(
      (d) => d.state === "device" && normalizeDeviceTarget(d.serial) === pinned
    );
    if (pinnedOnline) return { target: pinned, source: "pin" };

    if (online) {
      const fallback = normalizeDeviceTarget(online.serial);
      return {
        target: fallback,
        source: "discovered",
        warning:
          `FLUTTER_DEVICE_TIZEN_DEVICE is pinned to ${pinned}, but that target is not an ` +
          `online sdb device (stale pin — the device may have moved DHCP ` +
          `address). Using the first online sdb device ${fallback} instead.`,
      };
    }

    return {
      target: pinned,
      source: "stale-pin",
      warning:
        `FLUTTER_DEVICE_TIZEN_DEVICE is pinned to ${pinned}, but that target is not an ` +
        `online sdb device and no online device was found to fall back to. ` +
        `Proceeding with the pin; expect failures if the device moved.`,
    };
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
