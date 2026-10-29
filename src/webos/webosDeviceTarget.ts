/**
 * Resolution of the webOS device target used for install/launch.
 *
 * The webOS ares SDK addresses devices by their configured NAME (as registered
 * with `ares-setup-device`), not by raw IP as Tizen's sdb does. So the "target"
 * here is that device name, and discovery parses `ares-setup-device --list
 * --full` rather than `sdb devices`.
 *
 * This mirrors the Tizen `deviceTarget.ts` contract — a pin (env var) is used
 * only while it is present with a connection in the live device list, and is
 * refused otherwise, never replaced — and returns the same neutral
 * {@link DeviceResolution} shape from `types.ts`.
 *
 * SCAFFOLD NOTE: parsing is written against the documented `--full` table
 * columns; there is no webOS-26 device to confirm the exact spacing on, so the
 * parser is intentionally tolerant (header/blank-line skipping, whitespace
 * splitting) the way the sdb parser is.
 */
import { RequestedDeviceUnavailableError } from "../deviceRequest.js";
import { DeviceResolution } from "../types.js";

export type { DeviceResolution } from "../types.js";

export interface AresDevice {
  /** The device name ares addresses it by (the `-d` value). */
  name: string;
  /** The `user@host` (or host) connection string, when present. */
  connection?: string;
  /** The bare host parsed out of {@link connection} (`user@host:port` → `host`). */
  host?: string;
  /** True unless the row is explicitly flagged as the emulator/default only. */
  online: boolean;
}

/**
 * Extract the bare host from an ares connection string.
 *
 * The connection column is `user@host`, `host`, or either with a trailing
 * `:port`. ssap dials the bare host on its own port, so both the `user@` prefix
 * and any `:port` suffix are stripped. Returns undefined when there is nothing
 * host-like (e.g. a non-network transport token).
 */
export function hostFromAresConnection(connection: string | undefined): string | undefined {
  if (!connection) return undefined;
  const afterUser = connection.includes("@")
    ? connection.slice(connection.lastIndexOf("@") + 1)
    : connection;
  const host = afterUser.split(":")[0]?.trim();
  return host && host.length > 0 ? host : undefined;
}

/**
 * Parse the table printed by `ares-setup-device --list --full`.
 *
 * The first row is a `name  deviceinfo  connection  profile` header; each
 * remaining non-empty line is whitespace-separated with the device name first
 * and the `user@host` connection second. Rows are treated as usable unless the
 * connection column is missing (an unconfigured placeholder).
 */
export function parseAresDevices(output: string): AresDevice[] {
  if (!output) return [];

  const devices: AresDevice[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip the column header row.
    if (/^name\b/i.test(trimmed) && /deviceinfo|connection/i.test(trimmed)) {
      continue;
    }
    // Skip the dashed separator row printed under the header
    // (`----  ----  ----`); it must not become a bogus device.
    if (/^[-\s]+$/.test(trimmed)) continue;

    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    if (!name) continue;
    const connection = parts[1];
    devices.push({
      name,
      connection,
      host: hostFromAresConnection(connection),
      online: Boolean(connection),
    });
  }
  return devices;
}

/**
 * Pick the webOS device target to operate on.
 *
 * An explicit pin (device name) is used only while it appears, with a
 * connection, in the live `ares-setup-device --list` output; otherwise this
 * throws RequestedDeviceUnavailableError. Without a pin the first listed device
 * is used. Returns null when no
 * device is configured at all.
 */
export function resolveWebosDeviceTarget(
  explicitDevice: string | undefined,
  aresDeviceListOutput: string | undefined
): DeviceResolution | null {
  const devices = parseAresDevices(aresDeviceListOutput ?? "");
  const first = devices.find((d) => d.online) ?? devices[0];

  if (explicitDevice && explicitDevice.trim().length > 0) {
    const pin = explicitDevice.trim();
    const pinned = devices.find((d) => d.name === pin);
    if (pinned?.online) return { target: pin, source: "pin", host: pinned.host };
    throw new RequestedDeviceUnavailableError({
      platform: "webOS",
      requested: pin,
      origin: "the FLUTTER_DEVICE_WEBOS_DEVICE env var",
      state: pinned ? "registered without a connection" : undefined,
      online: devices.filter((d) => d.online).map((d) => ({ id: d.name, detail: d.host })),
      hint: "Register it with `ares-setup-device`, or update the pin.",
    });
  }

  if (!first) return null;
  const online = devices.filter((d) => d.online);
  return {
    target: first.name,
    source: first.online ? "discovered" : "discovered-offline",
    host: first.host,
    ...(online.length > 1
      ? { unnamedAmong: online.map((d) => ({ id: d.name, detail: d.host })) }
      : {}),
  };
}
