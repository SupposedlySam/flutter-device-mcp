/**
 * This host's LAN address as the Samsung TV sees it, for naming in the
 * Developer Mode "Host PC IP" fix. The TV-side setting must hold this
 * address or sdb refuses the connection.
 */
import os from "os";

/**
 * This host's IPv4 LAN address that shares the most-significant octets with the
 * device — i.e. the address the TV's Host PC IP should point at.
 *
 * Requires an interface IP on the SAME /24 as the device — the only reliable
 * signal for which of a Mac's several interfaces (VPN, Docker/bridge, Wi-Fi) is
 * the real Host-PC binding. When the device IP is known but NO candidate is on
 * its /24, returns undefined ("unknown") rather than guessing `candidates[0]`:
 * on a host where a docker/bridge/VPN interface enumerates first, guessing would
 * yield an IP that isn't the real binding and drive a false "Host PC IP mismatch"
 * diagnostic (a wild-goose-chase). Undefined makes that diagnostic degrade to
 * null instead. Only when the device IP is unknown (no basis to filter) does it
 * fall back to the first non-internal IPv4. Undefined also when no usable IPv4
 * exists at all.
 *
 * `deviceIp` is the TV's IP (from the sdb target). The interface list is
 * injectable so the /24 selection can be unit-tested without real NICs.
 */
export function localIpForDevice(
  deviceIp: string | undefined,
  interfaces: Record<string, os.NetworkInterfaceInfo[] | undefined> = os.networkInterfaces()
): string | undefined {
  const candidates: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // Node <18 typed `family` as "IPv4"; >=18 also allows the number 4.
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (isV4 && !info.internal) candidates.push(info.address);
    }
  }
  if (candidates.length === 0) return undefined;
  if (deviceIp) {
    // The device IP is a basis to filter — only a same-/24 candidate is the real
    // Host-PC binding. No match → unknown (avoid a false mismatch), NOT a guess.
    const prefix = deviceIp.split(".").slice(0, 3).join(".") + ".";
    return candidates.find((ip) => ip.startsWith(prefix));
  }
  // Device IP unknown: no basis to filter, so fall back to the first IPv4.
  return candidates[0];
}
