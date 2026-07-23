/**
 * Samsung Developer Mode "Host PC IP" auto-diagnosis.
 *
 * WHY: sdb connects to a Samsung Smart Monitor/TV only when the monitor's
 * Developer Mode is ON and its "Host PC IP" is set to THIS Mac. If the field is
 * bound to a different machine (a teammate's, or a stale address), `sdb connect`
 * fails with a cryptic "failed to connect"/"already connected to another host",
 * and diagnosing it previously required manually inspecting the :8001 REST
 * payload. The device advertises both facts in `GET http://<ip>:8001/api/v2/`
 * (`device.developerMode` = "1"/"0", `device.developerIP` = the bound host), so
 * we fetch them and compare to this host's LAN IP, surfacing an actionable
 * diagnostic when they don't line up.
 *
 * The COMPARISON is pure and unit-tested ({@link diagnoseDeveloperMode}); the
 * fetch + local-IP resolution are thin IO wrappers around it.
 */
import os from "os";

/** The Developer-Mode facts read from the Samsung `:8001/api/v2/` payload. */
export interface DeveloperModeFacts {
  /** `device.developerMode` — "1" when Developer Mode is enabled. */
  developerMode?: string;
  /** `device.developerIP` — the Host PC IP the monitor is bound to. */
  developerIP?: string;
}

/**
 * Compare the device's Developer-Mode facts to this host's LAN IP and return an
 * actionable diagnostic string, or `null` when everything lines up (Developer
 * Mode on AND the bound Host PC IP is this Mac).
 *
 * Pure over its three inputs so it is fully unit-testable. Cases:
 *  - Developer Mode off/unknown → tell the caller to enable it.
 *  - Bound Host PC IP differs from this Mac → tell them to rebind + reboot.
 *  - Match → `null` (no diagnostic).
 *
 * `localIp` is this host's address on the device's subnet (undefined when it
 * couldn't be determined — then a mismatch can't be asserted, only the raw
 * bound IP is echoed for the human to check).
 */
export function diagnoseDeveloperMode(
  developerMode: string | undefined,
  developerIP: string | undefined,
  localIp: string | undefined
): string | null {
  if (developerMode !== "1") {
    return (
      "Samsung Developer Mode is not enabled on the monitor " +
      `(developerMode=${JSON.stringify(developerMode ?? null)}). On the ` +
      "monitor: Apps → press 1-2-3-4-5 → turn Developer Mode ON, set Host PC " +
      `IP to ${localIp ?? "this Mac's LAN IP"}, and reboot, then retry.`
    );
  }
  const boundIp = (developerIP ?? "").trim();
  if (boundIp.length === 0) {
    return (
      "Samsung Developer Mode is on but no Host PC IP is bound. On the " +
      `monitor set Developer Mode → Host PC IP to ${
        localIp ?? "this Mac's LAN IP"
      } and reboot, then retry.`
    );
  }
  if (localIp && boundIp !== localIp) {
    return (
      `Samsung Developer Mode Host PC IP is ${boundIp} but this Mac is ` +
      `${localIp} — on the monitor set Developer Mode → Host PC IP to ` +
      `${localIp} and reboot, then retry.`
    );
  }
  // Match (or local IP unknown so a mismatch can't be asserted).
  return null;
}

/**
 * This host's IPv4 LAN address that shares the most-significant octets with the
 * device — i.e. the address the monitor's Host PC IP should point at.
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
 * `deviceIp` is the monitor's IP (from the sdb target). The interface list is
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

/** Shape of the fields we read out of the Samsung `:8001/api/v2/` payload. */
interface SamsungDeviceInfoPayload {
  device?: { developerMode?: unknown; developerIP?: unknown };
}

/**
 * Fetch the Developer-Mode facts from `http://<deviceIp>:8001/api/v2/`.
 *
 * Best-effort and defensive: any network/parse error resolves to empty facts
 * ({}), never a throw — the pre-check must never turn a transient REST hiccup
 * into a deploy failure. `fetchImpl` is injectable for tests.
 */
export async function fetchDeveloperModeFacts(
  deviceIp: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<DeveloperModeFacts> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${deviceIp}:8001/api/v2/`, {
      signal: controller.signal,
    });
    if (!res.ok) return {};
    const json = (await res.json()) as SamsungDeviceInfoPayload;
    const device = json.device ?? {};
    return {
      developerMode:
        typeof device.developerMode === "string"
          ? device.developerMode
          : device.developerMode != null
            ? String(device.developerMode)
            : undefined,
      developerIP:
        typeof device.developerIP === "string" ? device.developerIP : undefined,
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
