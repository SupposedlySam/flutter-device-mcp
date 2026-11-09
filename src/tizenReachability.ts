/**
 * Why a Samsung TV cannot be reached, found by trying it.
 *
 * When no Tizen device resolves there is nothing to compare against, so each
 * candidate address is probed directly: does `:8001` answer, and does
 * `sdb connect` succeed. The connect decides. The REST `developerIP` is only a
 * hint: it is the TV's setting, not proof of what this host can reach, and
 * firmware that leaves it stale would send a diagnosis after it down the wrong
 * road.
 */
import { parseDeviceTarget } from "./deviceTarget.js";

export interface CandidateProbe {
  ip: string;
  /** Whether `http://<ip>:8001/api/v2/` returned a payload. */
  restAnswered: boolean;
  /** REST `device.developerIP`, shown as a hint and never acted on. */
  restDeveloperIp?: string;
  connected: boolean;
  /** The last line `sdb connect` printed, for the reader to check. */
  connectOutput: string;
}

/** The bare hosts to probe, in the order given, once each. */
export function candidateHosts(sources: (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const source of sources) {
    const trimmed = source?.trim();
    if (!trimmed) continue;
    const { host } = parseDeviceTarget(trimmed);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** `sdb connect` prints "connected to …" or "already connected to …" on success. */
export function sdbConnectSucceeded(output: string): boolean {
  return /\bconnected to\b/i.test(output) && !/failed to connect/i.test(output);
}

export async function probeRest(
  ip: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<{ answered: boolean; developerIp?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${ip}:8001/api/v2/`, {
      signal: controller.signal,
    });
    if (!res.ok) return { answered: false };
    const json = (await res.json()) as { device?: { developerIP?: unknown } };
    const developerIp = json.device?.developerIP;
    return {
      answered: true,
      developerIp: typeof developerIp === "string" ? developerIp : undefined,
    };
  } catch {
    return { answered: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The TV-side fix for a connect that failed. Developer Mode's Host PC IP
 * is the one setting that makes sdb refuse a host, and the TV reads it only
 * at start-up.
 */
function tvFix(macIp: string | undefined): string {
  return (
    "On the TV: Apps → 12345 → Developer mode → set Host PC IP to " +
    `${macIp ?? "this host's LAN IP"} → restart the TV.`
  );
}

/**
 * One paragraph per probed address. `localIpFor` names this host's address on that
 * address's subnet (undefined when no interface is on it).
 */
export function describeProbes(
  probes: CandidateProbe[],
  localIpFor: (ip: string) => string | undefined
): string | null {
  if (probes.length === 0) return null;
  return probes
    .map((probe) => {
      const rest = probe.restAnswered
        ? `:8001 answers${
            probe.restDeveloperIp
              ? ` (it reports Host PC IP ${probe.restDeveloperIp}, a hint only)`
              : ""
          }`
        : ":8001 does not answer";
      if (probe.connected) {
        return (
          `${probe.ip}: ${rest}, and sdb connect succeeded (${probe.connectOutput}). ` +
          "The TV is reachable now; retry."
        );
      }
      const reachability = probe.restAnswered
        ? ""
        : " The TV may be off, asleep or on another address.";
      return (
        `${probe.ip}: ${rest}${probe.restAnswered ? ", but" : ", and"} sdb connect failed (${
          probe.connectOutput || "no output"
        }).${reachability} ${tvFix(localIpFor(probe.ip))}`
      );
    })
    .join("\n");
}
