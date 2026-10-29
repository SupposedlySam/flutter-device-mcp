/**
 * Local-backend host resolution: pointing an app on a device at a server running
 * on THIS machine.
 *
 * WHY THIS EXISTS: `--dart-define` already carries compile-time constants, and it
 * is not the hard part. The hard part is that "the host my backend is on" is a
 * DIFFERENT STRING for every target, and each wrong answer fails in a way that
 * looks like the app rather than the address:
 *
 *   | target                | host        | why                                    |
 *   | --------------------- | ----------- | -------------------------------------- |
 *   | iOS / tvOS simulator  | localhost   | shares the host's network stack        |
 *   | Android emulator      | 10.0.2.2    | the emulator's alias for host loopback  |
 *   | Android physical      | localhost   | + `adb reverse`, which tunnels it back  |
 *   | iOS / tvOS physical   | LAN IP      | a separate machine on the network       |
 *   | Tizen / webOS (TV)    | LAN IP      | likewise — a TV is never loopback       |
 *
 * `localhost` on a physical Android device resolves to the DEVICE, so the app
 * connects to nothing and reports a connection error indistinguishable from a
 * backend that is down. `10.0.2.2` on a physical device is equally dead. This
 * module exists so the caller never has to hold that table in their head.
 *
 * Everything here is PURE — the network-interface list and the target kind are
 * passed IN, so every branch is testable without a device or a specific host.
 * The `adb reverse` side effect belongs to the adapter.
 */
import { Platform } from "./types.js";

/** How the target reaches the network, which is what decides the host. */
export type TargetKind = "simulator" | "emulator" | "device";

/** The target a local-backend host is being resolved for. */
export interface LocalBackendTarget {
  platform: Platform;
  kind: TargetKind;
}

/** One resolved plan: the host to inject, plus any tunnelling it depends on. */
export interface LocalBackendPlan {
  /** The host string to hand the app, or null when it could not be determined. */
  host: string | null;
  /**
   * Ports that MUST be reverse-forwarded for `host` to mean anything (physical
   * Android). Empty for every other target. When this is non-empty and the
   * forwards have not run, the host is a lie.
   */
  reversePorts: number[];
  /** Why this host — surfaced, because a wrong host looks like a broken app. */
  rationale: string;
  /** Set when no host could be resolved; names what the caller must supply. */
  unresolved?: string;
}

/** The default define names, matching the convention in the tracking issue. */
export const DEFAULT_LOCAL_ENV_KEY = "USE_LOCAL_ENV";
export const DEFAULT_LOCAL_HOST_KEY = "LOCAL_HOST";

/**
 * Interface names that are never the LAN address, matched as a prefix.
 *
 * macOS in particular carries a crowd of these: `utun*` for VPNs and iCloud
 * Private Relay, `awdl*`/`llw*` for AirDrop, `bridge*` for internet sharing, plus
 * whatever Docker and VirtualBox added. Several report a perfectly ordinary
 * private IPv4, so "the first non-internal IPv4" picks one of them on a normal
 * developer laptop and the address it returns is unreachable from the device.
 */
export const NON_LAN_INTERFACE_PREFIXES = [
  "utun",
  "awdl",
  "llw",
  "bridge",
  "docker",
  "vboxnet",
  "vmnet",
  "tun",
  "tap",
  "ap1",
  "anpi",
];

/** The subset of `os.networkInterfaces()` this module reads. */
export interface NetworkAddress {
  address: string;
  family?: string | number;
  internal?: boolean;
}
export type NetworkInterfaces = Record<
  string,
  NetworkAddress[] | undefined
>;

function isIpv4(addr: NetworkAddress): boolean {
  // Node has reported `family` as both the number 4 and the string "IPv4"
  // across versions; this package supports node >= 18, so accept either rather
  // than pinning one and silently finding no addresses on the other.
  return addr.family === 4 || addr.family === "IPv4";
}

/** One candidate LAN address, kept with its interface for reporting. */
export interface LanCandidate {
  iface: string;
  address: string;
}

/**
 * Every plausible LAN IPv4 on this host, in interface-name order.
 *
 * Deliberately returns ALL of them rather than picking. On a laptop with Wi-Fi
 * and Ethernet both up there is no way to know from here which one the device is
 * on, and choosing silently produces an address that is valid, reachable from
 * the host, and wrong from the phone.
 */
export function lanCandidates(interfaces: NetworkInterfaces): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const iface of Object.keys(interfaces).sort()) {
    if (
      NON_LAN_INTERFACE_PREFIXES.some((prefix) => iface.startsWith(prefix))
    ) {
      continue;
    }
    for (const addr of interfaces[iface] ?? []) {
      if (!isIpv4(addr)) continue;
      if (addr.internal) continue;
      // Link-local: what an interface self-assigns when DHCP never answered. It
      // is not a working address and must not be offered as one.
      if (addr.address.startsWith("169.254.")) continue;
      out.push({ iface, address: addr.address });
    }
  }
  return out;
}

/**
 * Resolve the host an app on `target` should use to reach a server on this host.
 *
 * `ports` are the backend ports; they matter only for physical Android, where the
 * host is a loopback name made true by `adb reverse`.
 */
export function resolveLocalBackendHost(
  target: LocalBackendTarget,
  interfaces: NetworkInterfaces,
  ports: number[] = []
): LocalBackendPlan {
  const { platform, kind } = target;

  // A simulator IS this machine — its loopback is the host's loopback.
  if (kind === "simulator") {
    return {
      host: "localhost",
      reversePorts: [],
      rationale:
        `The ${platform} simulator shares this machine's network stack, so ` +
        "loopback reaches your backend directly.",
    };
  }

  // The Android emulator runs behind a NAT whose gateway aliases the host.
  if (kind === "emulator" && platform === "android") {
    return {
      host: "10.0.2.2",
      reversePorts: [],
      rationale:
        "The Android emulator reaches the host through the special alias " +
        "10.0.2.2 (its own `localhost` is the emulated device).",
    };
  }

  // A physical Android device is reachable the other way round: adb tunnels a
  // device-side port back to the host, so loopback becomes true ON the device.
  if (kind === "device" && platform === "android") {
    if (ports.length === 0) {
      return {
        host: null,
        reversePorts: [],
        rationale:
          "A physical Android device needs `adb reverse` to reach this host, " +
          "which is per-PORT.",
        unresolved:
          "No backend ports were given, so no tunnel can be set up. Pass the " +
          "port(s) your backend listens on. (Without a tunnel, `localhost` on " +
          "the device means the DEVICE, and `10.0.2.2` means nothing at all.)",
      };
    }
    return {
      host: "localhost",
      reversePorts: [...ports].sort((a, b) => a - b),
      rationale:
        `adb reverse tunnels ${ports.length === 1 ? "port" : "ports"} ` +
        `${[...ports].sort((a, b) => a - b).join(", ")} from the device back to ` +
        "this host, which makes `localhost` on the device mean this machine.",
    };
  }

  // Everything else is a separate machine on the network: a physical iPhone,
  // an Apple TV, a Samsung or LG television. It needs a routable address.
  const candidates = lanCandidates(interfaces);
  if (candidates.length === 0) {
    return {
      host: null,
      reversePorts: [],
      rationale: `A physical ${platform} target must reach this host over the network.`,
      unresolved:
        "No LAN IPv4 address was found on this machine, so there is no address " +
        "to give the device. Check that Wi-Fi/Ethernet is up, and supply the " +
        "host explicitly if this machine is reachable at an address this cannot see.",
    };
  }
  if (candidates.length > 1) {
    const listed = candidates.map((c) => `${c.iface}=${c.address}`).join(", ");
    return {
      host: null,
      reversePorts: [],
      rationale: `A physical ${platform} target must reach this host over the network.`,
      unresolved:
        `This machine has more than one LAN address (${listed}), and which one ` +
        "the device can reach is not knowable from here — picking one would " +
        "produce an address that works from this host and fails from the device. " +
        "Supply the host explicitly.",
    };
  }
  return {
    host: candidates[0].address,
    reversePorts: [],
    rationale:
      `A physical ${platform} target reaches this host over the network at ` +
      `${candidates[0].address} (interface ${candidates[0].iface}). Your backend ` +
      "must be listening on that interface, not only on loopback.",
  };
}

/**
 * The dart-defines for a resolved plan.
 *
 * Returns `{}` when the host is unresolved, so a caller that ignores
 * `unresolved` injects NOTHING rather than a define naming a broken host — an
 * absent define leaves the app on its own default, which is recoverable; a
 * present-and-wrong one is the failure this module exists to prevent.
 */
export function localBackendDefines(
  plan: LocalBackendPlan,
  keys: { envKey?: string; hostKey?: string } = {}
): Record<string, string> {
  if (!plan.host) return {};
  return {
    [keys.envKey ?? DEFAULT_LOCAL_ENV_KEY]: "true",
    [keys.hostKey ?? DEFAULT_LOCAL_HOST_KEY]: plan.host,
  };
}

/**
 * Whether `host` names this machine's loopback, the only kind of host an `adb
 * reverse` tunnel makes true. Anything else is routable already and needs no
 * tunnel. Covers `localhost`, all of 127.0.0.0/8 and `::1` (bracketed or not).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Infer the target kind from an Android serial.
 *
 * adb names emulators `emulator-<port>`; anything else is hardware. This is a
 * convention rather than a guarantee, which is why it is a named function a
 * caller can override rather than something buried in the resolver.
 */
export function androidKindFromSerial(serial: string): TargetKind {
  return /^emulator-\d+$/.test(serial) ? "emulator" : "device";
}

/** The `adb reverse` commands a plan needs, in a stable order. */
export function adbReverseArgs(plan: LocalBackendPlan): string[][] {
  return plan.reversePorts.map((port) => [
    "reverse",
    `tcp:${port}`,
    `tcp:${port}`,
  ]);
}

/**
 * Parse a caller-supplied ports value into numbers.
 *
 * Accepts a single number, `"8080"`, `"8080,9099"` and `"8080, 9099"` — the CLI's
 * flag coercion turns a lone numeric value into a number before this sees it, so
 * both shapes arrive here.
 *
 * A token that is not a positive integer is REJECTED rather than dropped. A
 * silently-ignored port is a tunnel that never gets made, and the app then fails
 * on that one port while every other port works — which reads as an app bug, not
 * as a typo in a flag.
 */
export function parseLocalBackendPorts(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return [value];
  const tokens = String(value)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const ports = tokens.map((t) => {
    if (!/^\d+$/.test(t)) {
      throw new Error(
        `Invalid local-backend ports value ${JSON.stringify(t)}: expected a ` +
          "comma-separated list of port numbers (e.g. 8080,9099)."
      );
    }
    return Number(t);
  });
  return ports.length > 0 ? ports : undefined;
}
