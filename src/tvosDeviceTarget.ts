/**
 * Resolution of the Apple TV (tvOS) device/simulator target used for
 * build/install/launch.
 *
 * tvOS is the sibling of {@link ./iosDeviceTarget}: this server drives two
 * kinds behind one neutral {@link DeviceResolution} shape —
 *  - a PHYSICAL Apple TV (over CoreDevice / `xcrun devicectl`), and
 *  - a tvOS SIMULATOR (over `xcrun simctl`).
 *
 * The guardrail this module exists to encode (the exact inverse of the iOS one):
 * the toolchain lists iPhones/iPads alongside Apple TVs, and this adapter must
 * ONLY ever pick an Apple TV. Both `xcrun devicectl list devices` and
 * `flutter-tvos devices --machine` list iPhones next to Apple TVs, so an
 * iPhone/iPad row is excluded so it can never win discovery — the mirror image of
 * {@link ./iosDeviceTarget#isIphoneOrIpad}, which excludes Apple TV from the iOS
 * adapter. devicectl carries an explicit `hardwareProperties.deviceType`
 * ("appleTV") / `platform` ("tvOS") the resolver keys on ({@link
 * isDevicectlAppleTv}); flutter-tvos reports Apple TVs with `targetPlatform:
 * "ios"` (it reuses the iOS embedder identity), so there the `sdk` string
 * ("tvOS …") is the only reliable discriminator ({@link isAppleTv}).
 *
 * PHYSICAL discovery is backed by `xcrun devicectl list devices` — NOT
 * `flutter-tvos devices --machine`. devicectl is always on the standard PATH,
 * while flutter-tvos is only on PATH when the user's shell profile has been
 * sourced (the GUI-spawned MCP server runs a non-login shell and does not see
 * `~/flutter-tvos/bin`). Backing discovery on flutter-tvos therefore made a
 * connected Apple TV invisible under the server and silently fell through to a
 * simulator; devicectl removes that dependency. The legacy flutter-tvos parser is
 * retained for reference/tests but is no longer the discovery source.
 *
 * Unlike iOS, there is NO two-id-namespace problem: the CoreDevice `identifier`
 * devicectl reports is the SAME id `xcrun devicectl` uses for
 * install/launch/terminate/uninstall (and the same id flutter-tvos reports). So a
 * resolved PHYSICAL target carries a SINGLE id used by every consumer. A
 * simulator carries its simctl UUID.
 *
 * This module is pure parsing/selection over the raw command output the adapter
 * captures — it never spawns anything. A pinned target (id or name) that is not
 * connected/booted is refused, never replaced (see deviceRequest.ts).
 *
 * The pin env vars are `APPLE_TV_DEVICE` (the name the `flutter-tvos` CLI already uses) and
 * `FLUTTER_DEVICE_TVOS_DEVICE` (this server's convention, mirroring
 * `FLUTTER_DEVICE_IOS_DEVICE`). The adapter checks both.
 */
import {
  ambiguousNameRefused,
  pickNamedMatch,
  RequestedDeviceUnavailableError,
  targetClassUnavailable,
} from "./deviceRequest.js";
import { DeviceResolution } from "./types.js";

export type { DeviceResolution } from "./types.js";

/** Which tvOS toolchain a resolved target is driven by. */
export type TvosDeviceKind = "device" | "simulator";

/**
 * An Apple TV / tvOS-simulator target plus the kind that decides its toolchain.
 *
 * `target` is the id every consumer uses: for a physical Apple TV the CoreDevice
 * identifier (which both `flutter-tvos devices --machine` and `xcrun devicectl`
 * agree on), for a simulator its simctl UUID.
 */
export interface TvosDeviceResolution extends DeviceResolution {
  kind: TvosDeviceKind;
  /** Human-readable device name, when parsed (e.g. "Example Apple TV"). */
  name?: string;
  /**
   * The hardware UDID of a physical Apple TV — the id lockdown-level tools such
   * as pymobiledevice3 address it by, which is not the CoreDevice id.
   */
  hardwareUdid?: string;
  /** devicectl's `hardwareProperties.productType`, e.g. "AppleTV14,1"; physical only. */
  productType?: string;
  /** The tvOS version on a physical Apple TV, e.g. "27.0". */
  osVersion?: string;
  /** The tvOS build on a physical Apple TV, e.g. "24J361". */
  osBuild?: string;
}

/** One parsed Apple TV / tvOS-simulator target. */
export interface TvosDevice {
  /** CoreDevice id (physical) or simctl UUID (simulator). */
  id: string;
  name?: string;
  kind: TvosDeviceKind;
  /** True when the device is connected (devicectl) / booted (simctl). */
  available: boolean;
  /** devicectl's `hardwareProperties.udid`; physical devices only. */
  hardwareUdid?: string;
  productType?: string;
  osVersion?: string;
  osBuild?: string;
}

/**
 * True when a `flutter-tvos devices --machine` entry is an Apple TV (tvOS), NOT
 * an iPhone/iPad. The fork reports Apple TVs with `targetPlatform: "ios"` just
 * like iPhones, so the ONLY reliable discriminator is the `sdk` string carrying
 * "tvOS". This is the mirror of {@link ./iosDeviceTarget#isIphoneOrIpad}: where
 * that excludes Apple TV, this excludes iPhone/iPad so a connected iPhone can
 * never be picked for a tvOS deploy.
 */
export function isAppleTv(sdk: string | undefined): boolean {
  return /tvOS/i.test(sdk ?? "");
}

/** One raw entry from `flutter-tvos devices --machine`. */
interface FlutterTvosMachineDevice {
  name?: unknown;
  id?: unknown;
  targetPlatform?: unknown;
  emulator?: unknown;
  sdk?: unknown;
  isSupported?: unknown;
}

/**
 * Parse `flutter-tvos devices --machine` (JSON array) into the PHYSICAL Apple TVs
 * flutter-tvos can target.
 *
 * Keeps only real (non-emulator) devices whose `sdk` carries "tvOS" (see {@link
 * isAppleTv}); an iPhone/iPad (`sdk` "iOS …") is dropped, and simulators
 * (`emulator: true`) are handled via simctl instead. The CoreDevice `id` is used
 * by both flutter-tvos and devicectl, so it is the single target id.
 */
export function parseFlutterTvosDevices(jsonOutput: string): TvosDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TvosDevice[] = [];
  for (const entry of parsed as FlutterTvosMachineDevice[]) {
    if (typeof entry.id !== "string") continue;
    if (entry.emulator === true) continue; // tvOS simulator handled via simctl
    if (entry.isSupported === false) continue;
    const sdk = typeof entry.sdk === "string" ? entry.sdk : undefined;
    if (!isAppleTv(sdk)) continue; // exclude iPhone/iPad — tvOS only
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : undefined,
      kind: "device",
      // flutter-tvos only lists a device it can currently reach.
      available: true,
    });
  }
  return out;
}

/**
 * True when an `xcrun devicectl list devices` entry is a physical Apple TV, NOT
 * an iPhone/iPad. devicectl reports an explicit device class, so — unlike the
 * flutter-tvos path — this keys on `hardwareProperties.deviceType`/`platform`
 * directly: `deviceType` is "appleTV" (vs "iPhone"/"iPad") and `platform` is
 * "tvOS" (vs "iOS"). Either signal alone is authoritative; requiring both is
 * belt-and-suspenders against a shape drift on one field. The mirror of the iOS
 * adapter's Apple-TV exclusion — a connected iPhone can never win a tvOS deploy.
 */
export function isDevicectlAppleTv(
  deviceType: string | undefined,
  platform: string | undefined
): boolean {
  return /^appleTV$/i.test(deviceType ?? "") || /^tvOS$/i.test(platform ?? "");
}

/** One raw device entry from `xcrun devicectl list devices --json-output`. */
interface DevicectlDevice {
  identifier?: unknown;
  deviceProperties?:
    | { name?: unknown; osVersionNumber?: unknown; osBuildUpdate?: unknown }
    | null;
  connectionProperties?: { pairingState?: unknown } | null;
  hardwareProperties?:
    | {
        deviceType?: unknown;
        platform?: unknown;
        productType?: unknown;
        udid?: unknown;
      }
    | null;
}

/**
 * Parse `xcrun devicectl list devices --json-output <file>` (the file's JSON
 * body) into the PHYSICAL Apple TVs paired with this Mac.
 *
 * devicectl lists ONLY paired devices, and the CoreDevice `identifier` it reports
 * is the id every consumer (install/launch/terminate/uninstall) uses — so it is
 * the single target id. Keeps only Apple TV / tvOS entries ({@link
 * isDevicectlAppleTv}); an iPhone/iPad is dropped. A device is `available` when
 * its `pairingState` is "paired" — devicectl reports a paired Apple TV as usable
 * even while its on-demand tunnel is `disconnected` (the tunnel is established
 * lazily on the first install/launch), so tunnel state is deliberately NOT part
 * of availability. A defensive parse: malformed JSON or an unexpected shape
 * yields [] rather than throwing.
 */
export function parseDevicectlAppleTvs(jsonOutput: string): TvosDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  const devices = (parsed as { result?: { devices?: unknown } })?.result
    ?.devices;
  if (!Array.isArray(devices)) return [];
  const out: TvosDevice[] = [];
  for (const entry of devices as DevicectlDevice[]) {
    if (typeof entry.identifier !== "string") continue;
    const hw = entry.hardwareProperties ?? undefined;
    const deviceType =
      typeof hw?.deviceType === "string" ? hw.deviceType : undefined;
    const platform = typeof hw?.platform === "string" ? hw.platform : undefined;
    if (!isDevicectlAppleTv(deviceType, platform)) continue; // tvOS only
    const name =
      typeof entry.deviceProperties?.name === "string"
        ? entry.deviceProperties.name
        : undefined;
    const pairingState =
      typeof entry.connectionProperties?.pairingState === "string"
        ? entry.connectionProperties.pairingState
        : undefined;
    out.push({
      id: entry.identifier,
      name,
      kind: "device",
      available: pairingState === "paired",
      ...(typeof hw?.udid === "string" ? { hardwareUdid: hw.udid } : {}),
      ...stringField("productType", hw?.productType),
      ...stringField("osVersion", entry.deviceProperties?.osVersionNumber),
      ...stringField("osBuild", entry.deviceProperties?.osBuildUpdate),
    });
  }
  return out;
}

function stringField<K extends string>(
  key: K,
  value: unknown
): Partial<Record<K, string>> {
  return typeof value === "string" && value.length > 0
    ? ({ [key]: value } as Record<K, string>)
    : {};
}

/**
 * Parse `xcrun simctl list devices --json` into tvOS SIMULATOR targets.
 *
 * simctl groups devices by runtime; only tvOS runtimes are considered (iOS and
 * watchOS runtimes are excluded so an iPhone simulator can never be picked). A
 * Booted simulator is preferred (available=true). `isAvailable: false` entries
 * (missing runtime) are dropped.
 */
export function parseTvosSimulators(jsonOutput: string): TvosDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  const devices = (parsed as { devices?: Record<string, unknown> })?.devices;
  if (!devices || typeof devices !== "object") return [];

  const out: TvosDevice[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!Array.isArray(entries)) continue;
    // Keep ONLY tvOS simulator runtimes (key like "...SimRuntime.tvOS-18-0");
    // iOS/watchOS/visionOS runtimes are excluded so a non-tvOS sim can't win.
    if (!/SimRuntime\.tvOS/i.test(runtime)) continue;
    for (const entry of entries) {
      const d = entry as {
        udid?: unknown;
        name?: unknown;
        state?: unknown;
        isAvailable?: unknown;
      };
      if (typeof d.udid !== "string") continue;
      if (d.isAvailable === false) continue;
      out.push({
        id: d.udid,
        name: typeof d.name === "string" ? d.name : undefined,
        kind: "simulator",
        available: d.state === "Booted",
      });
    }
  }
  return out;
}

/** True when a pin string matches a device by id or (case-insensitive) name. */
function pinMatches(pin: string, d: TvosDevice): boolean {
  const p = pin.trim().toLowerCase();
  return (
    d.id.toLowerCase() === p ||
    (!!d.name && d.name.trim().toLowerCase() === p)
  );
}

/** Build a resolution payload from a chosen device. */
function toResolution(
  d: TvosDevice,
  source: DeviceResolution["source"],
  warning?: string
): TvosDeviceResolution {
  return {
    target: d.id,
    source,
    kind: d.kind,
    name: d.name,
    ...(d.hardwareUdid ? { hardwareUdid: d.hardwareUdid } : {}),
    ...(d.productType ? { productType: d.productType } : {}),
    ...(d.osVersion ? { osVersion: d.osVersion } : {}),
    ...(d.osBuild ? { osBuild: d.osBuild } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Pick the tvOS target to operate on across physical Apple TVs and simulators.
 *
 * `physical` must already be filtered to Apple TV / tvOS (see {@link
 * parseFlutterTvosDevices}); an iPhone/iPad can therefore never appear here.
 *
 * A named target — the per-call `udid`, else the pin (`APPLE_TV_DEVICE`/
 * `FLUTTER_DEVICE_TVOS_DEVICE`), as an id or name — is used only while it is
 * AVAILABLE; otherwise this throws {@link RequestedDeviceUnavailableError}. A
 * `kind` restricts the choice to that class and is never served by the other.
 * With neither, physical Apple TVs are preferred over simulators, matching the
 * `flutter-tvos run` auto-target behavior. Returns null when nothing usable is
 * listed.
 */
export function resolveTvosTarget(
  pinned: string | undefined,
  physical: TvosDevice[],
  simulators: TvosDevice[],
  preference: { udid?: string; kind?: TvosDeviceKind } = {}
): TvosDeviceResolution | null {
  const fromCall = !!preference.udid && preference.udid.trim().length > 0;
  const pin = fromCall ? preference.udid?.trim() : pinned?.trim();
  const all = [...physical, ...simulators];
  const available = all
    .filter((d) => d.available)
    .map((d) => ({ id: d.id, detail: [d.kind, d.name].filter(Boolean).join(", ") }));

  if (pin) {
    const origin = fromCall
      ? "the device_udid argument"
      : "the APPLE_TV_DEVICE/FLUTTER_DEVICE_TVOS_DEVICE env var";
    const picked = pickNamedMatch(
      all.filter((d) => pinMatches(pin, d)),
      (d) => d.available
    );
    if (picked.kind === "several") {
      throw ambiguousNameRefused({
        platform: "tvOS",
        requested: pin,
        origin,
        matches: picked.devices.map((d) => ({
          id: d.id,
          detail: [d.kind, d.name].filter(Boolean).join(", "),
        })),
      });
    }
    if (picked.kind === "none") {
      throw new RequestedDeviceUnavailableError({
        platform: "tvOS",
        requested: pin,
        origin,
        state: picked.listed ? "not connected/booted" : undefined,
        listedAs: picked.listed?.id,
        online: available,
        hint: "An Apple TV that is asleep or off the network is not available.",
      });
    }
    const matched = picked.device;
    if (preference.kind && matched.kind !== preference.kind) {
      throw targetClassUnavailable({
        platform: "tvOS",
        wanted: preference.kind,
        requested: pin,
        resolvedClass: matched.kind,
        online: available,
      });
    }
    return toResolution(matched, "pin");
  }

  const pool =
    preference.kind === "simulator"
      ? simulators
      : preference.kind === "device"
        ? physical
        : all;
  const firstAvailable = pool.find((d) => d.available);
  if (firstAvailable) {
    return toResolution(firstAvailable, "discovered");
  }
  if (preference.kind) {
    throw targetClassUnavailable({
      platform: "tvOS",
      wanted: preference.kind,
      online: available,
    });
  }

  // No available device. Fall back to the first listed-but-offline one so the
  // caller can surface a specific reason.
  const anyOffline = pool[0];
  if (anyOffline) {
    return toResolution(anyOffline, "discovered-offline");
  }
  return null;
}
