/**
 * Resolution of the iOS device/simulator target used for build/install/launch.
 *
 * The frontend MCP drives two distinct iOS device kinds behind one neutral
 * {@link DeviceResolution} shape:
 *  - a PHYSICAL device (iPhone/iPad), and
 *  - a SIMULATOR.
 *
 * The subtlety this module exists to encode is that a physical iOS device is
 * addressed by TWO DIFFERENT identifiers in two different id spaces, and the
 * consumers do not agree on which:
 *
 *  - `flutter run -d <id>` (the deploy/launch path — see {@link buildIosPtyLaunchCommand})
 *    uses FLUTTER's id, which for a physical device is its ECID
 *    (e.g. `00008020-001A2D021AF3002E`). This is sourced from
 *    `flutter devices --machine`.
 *  - `xcrun devicectl` (the lifecycle/uninstall path — launch/terminate by
 *    bundle id, uninstall) uses devicectl's own UUID
 *    (e.g. `0831CB2E-D597-5C19-9699-6DFA21324AC4`). This is sourced from
 *    `xcrun devicectl list devices`.
 *
 * Feeding a devicectl UUID to `flutter run -d` fails ("No supported devices
 * found with name or id matching …") — that was the live on-device bug. So a
 * resolved PHYSICAL target carries BOTH ids and each consumer reads the one it
 * needs (see {@link IosDeviceResolution}). Simulators use a single UUID that
 * both flutter and simctl accept, so both ids collapse to it.
 *
 * The other guardrail encoded here: devicectl lists tvOS/Apple TV devices
 * alongside iPhone/iPad. The iOS adapter must NEVER pick an Apple TV. Physical
 * devices are filtered to iPhone/iPad only ({@link isIphoneOrIpad}); a tvOS
 * device is excluded so it can never win discovery.
 *
 * This module is pure parsing/selection over the raw command output the adapter
 * captures — it never spawns anything.
 *
 * The stale-pin fallback mirrors the Tizen path: a pin (flutter id, devicectl
 * id, or name) that is not currently connected/booted falls back to the first
 * available device with a warning, so a moved/rebooted target does not strand
 * every deploy.
 */
import { DeviceResolution } from "./types.js";

/** Which iOS toolchain a resolved target is driven by. */
export type IosDeviceKind = "device" | "simulator";

/**
 * An iOS device/simulator target plus the kind that decides its toolchain.
 *
 * `target` is the FLUTTER id — the deploy/launch path (`flutter run -d`) is the
 * primary consumer and it is what the neutral server threads through
 * install/launch/uninstall. `devicectlId` is the id the lifecycle/uninstall
 * path must use with `xcrun devicectl`; for a simulator it equals `target`
 * (simctl accepts the same UUID flutter uses).
 */
export interface IosDeviceResolution extends DeviceResolution {
  kind: IosDeviceKind;
  /** Human-readable device name, when parsed (e.g. "iPhone 15 Pro"). */
  name?: string;
  /**
   * The id to use with `xcrun devicectl`/`simctl` for lifecycle + uninstall.
   * Differs from `target` (the flutter id) for a physical device; equal for a
   * simulator. Undefined only for a stale pin with no matched device.
   */
  devicectlId?: string;
}

/** One parsed iOS target, carrying both id spaces where they differ. */
export interface IosDevice {
  /** The FLUTTER id (`flutter run -d`); ECID for a physical device. */
  udid: string;
  /**
   * The `xcrun devicectl` UUID for a physical device. Undefined for a
   * simulator (simctl reuses the flutter/simctl UUID) or when devicectl did not
   * list the device.
   */
  devicectlId?: string;
  name?: string;
  kind: IosDeviceKind;
  /** True when the device is connected (devicectl) / booted (simctl). */
  available: boolean;
  /**
   * True when this device could NOT be safely joined to a flutter id because its
   * name was ambiguous (matched more than one candidate on either side). An
   * ambiguous device carries only its devicectl id (no reliable flutter id), so
   * it must never be auto-selected — driving it via `flutter run -d` could hit
   * the wrong phone. {@link resolveIosTarget} excludes it from discovery and only
   * honors it when a pin names it explicitly.
   */
  ambiguous?: boolean;
}

/**
 * True when a devicectl-reported device is an iPhone or iPad (NOT an Apple TV /
 * tvOS, Watch, or other class). devicectl prints the model in parentheses, e.g.
 * `(iPhone11,8)`, `(iPad13,1)`, `(AppleTV14,1)`. We include only iPhone/iPad
 * models and explicitly exclude Apple TV so a connected tvOS device can never
 * be picked for an iOS deploy.
 */
export function isIphoneOrIpad(modelOrLine: string): boolean {
  if (/apple\s*tv|\bAppleTV/i.test(modelOrLine)) return false;
  if (/\b(?:iPhone|iPad)\d/i.test(modelOrLine)) return true;
  // Fall back to the human name column when no model token is present.
  if (/\b(?:iPhone|iPad)\b/i.test(modelOrLine)) return true;
  // KNOWN GAP (follow-up): when devicectl omits the Model column AND the name
  // carries no iPhone/iPad token, a real iPhone is dropped here. We deliberately
  // do NOT loosen the include rule — a permissive default would re-admit Apple
  // TV, which must never win an iOS deploy. The correct fix is to cross-reference
  // `flutter devices --machine` (which reports `targetPlatform: ios` per device)
  // to positively classify the row instead of inferring class from this text.
  return false;
}

/**
 * Parse `xcrun simctl list devices --json` output into simulator targets.
 *
 * simctl groups devices by runtime; each entry has `udid`, `name`, `state`
 * ("Booted"/"Shutdown") and `isAvailable`. Only iOS runtimes' available devices
 * are considered (tvOS/watchOS simulator runtimes are excluded so an Apple TV
 * simulator can never be picked); a Booted simulator is preferred
 * (available=true). For a simulator the flutter id and simctl id are the same
 * UUID, so `devicectlId` mirrors `udid`.
 */
export function parseSimctlDevices(jsonOutput: string): IosDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  const devices = (parsed as { devices?: Record<string, unknown> })?.devices;
  if (!devices || typeof devices !== "object") return [];

  const out: IosDevice[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!Array.isArray(entries)) continue;
    // Exclude non-iOS simulator runtimes (tvOS/watchOS/visionOS): the runtime
    // key looks like "...SimRuntime.iOS-18-0" / "...SimRuntime.tvOS-18-0".
    if (/SimRuntime\.(?:tvOS|watchOS|xrOS|visionOS)/i.test(runtime)) continue;
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
        udid: d.udid,
        devicectlId: d.udid,
        name: typeof d.name === "string" ? d.name : undefined,
        kind: "simulator",
        available: d.state === "Booted",
      });
    }
  }
  return out;
}

/**
 * Parse `xcrun devicectl list devices` (human table) into physical targets,
 * EXCLUDING Apple TV / non-iPhone-iPad devices.
 *
 * devicectl prints a header line then one row per device; the identifier is the
 * trailing UUID column, the connection state appears as
 * "connected"/"available"/"disconnected", and the model is in trailing
 * parentheses (e.g. "(iPhone11,8)" / "(AppleTV14,1)"). Rather than rely on
 * fixed column offsets (they shift with name length), we extract the identifier
 * token and read state + model from the same line.
 *
 * NOTE: the UUID captured here is the DEVICECTL id, which is NOT what
 * `flutter run -d` accepts. It is recorded as `devicectlId`; the flutter id is
 * supplied separately from `flutter devices --machine` and merged in by
 * {@link mergeFlutterIds}. `udid` (the flutter id) is left equal to the
 * devicectl id as a best-effort placeholder until merged.
 */
export function parseDevicectlDevices(tableOutput: string): IosDevice[] {
  if (!tableOutput) return [];
  const out: IosDevice[] = [];
  for (const rawLine of tableOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^name\b/i.test(line)) continue; // header
    if (/^-+$/.test(line)) continue; // separator rule

    // A physical-device identifier is a 36-char dashed UUID, a
    // 8-4-4-4-12 UUID, a legacy 40-hex UDID, or the 25-char dashed ECID form.
    const udidMatch = line.match(
      /\b([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})\b/
    );
    if (!udidMatch) continue;
    // Skip tvOS / non-iPhone-iPad rows so an Apple TV can never be resolved.
    if (!isIphoneOrIpad(line)) continue;

    const devicectlId = udidMatch[1];
    const available = /\b(connected|available)\b/i.test(line);
    // Best-effort, display-only name: the column layout varies by CLT version.
    const name =
      line.slice(0, udidMatch.index).trim().split(/\s{2,}/)[0] || undefined;
    out.push({
      udid: devicectlId, // placeholder; replaced by the flutter id when merged
      devicectlId,
      name,
      kind: "device",
      available,
    });
  }
  return out;
}

/** One parsed physical iOS device from `flutter devices --machine`. */
export interface FlutterDevice {
  /** The flutter id accepted by `flutter run -d` (ECID for a physical device). */
  id: string;
  name?: string;
}

/**
 * Parse `flutter devices --machine` (JSON array) into the PHYSICAL iOS devices
 * flutter can actually target.
 *
 * Each entry has `id`, `name`, `targetPlatform` ("ios" for a real device,
 * "ios" also for simulators — simulators are told apart by `emulator: true`),
 * and `isSupported`. We keep only real (non-emulator) supported iOS devices, so
 * the ids here are exactly the flutter-run targets for physical iPhones/iPads.
 * Apple TV shows as `targetPlatform: "darwin"`/other and is naturally excluded.
 */
export function parseFlutterIosDevices(jsonOutput: string): FlutterDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FlutterDevice[] = [];
  for (const entry of parsed) {
    const d = entry as {
      id?: unknown;
      name?: unknown;
      targetPlatform?: unknown;
      emulator?: unknown;
      isSupported?: unknown;
    };
    if (typeof d.id !== "string") continue;
    if (typeof d.targetPlatform !== "string") continue;
    if (!/^ios/i.test(d.targetPlatform)) continue; // ios / ios-arm64 etc.
    if (d.emulator === true) continue; // simulator handled via simctl
    if (d.isSupported === false) continue;
    out.push({ id: d.id, name: typeof d.name === "string" ? d.name : undefined });
  }
  return out;
}

/**
 * Merge flutter-run ids into devicectl-parsed physical devices.
 *
 * `flutter devices --machine` is the authority for the deploy/launch path's id,
 * while `xcrun devicectl` is the authority for the lifecycle id. This joins the
 * two by matching on the human name (the only field both list), producing
 * physical devices whose `udid` is the flutter id and `devicectlId` is the
 * devicectl UUID.
 *
 * FAIL-SAFE ON AMBIGUOUS NAMES: neither source carries the other's id, and iOS
 * lets two connected devices share a name (the default is just "iPhone"). If a
 * normalized name matches MORE THAN ONE candidate on EITHER side, joining by
 * array order could pair device A's devicectl id with device B's flutter id —
 * a silent wrong-device drive (deploy hits one phone, lifecycle/uninstall the
 * other). So a name join happens ONLY when it is unambiguous: the name is unique
 * on both sides (a true 1:1). Devicectl devices whose name is ambiguous are
 * returned WITHOUT a flutter id and marked {@link IosDevice.ambiguous} so
 * {@link resolveIosTarget} will not auto-select them; the caller must
 * disambiguate with a `FLUTTER_DEVICE_IOS_DEVICE` pin (which still resolves them
 * exactly — the pin is the escape hatch).
 *
 * When only one source lists a device it is still returned (best effort): a
 * devicectl-only device keeps devicectl id in both slots (deploy may then fail,
 * but lifecycle works); a flutter-only device has no devicectlId (deploy works,
 * lifecycle unavailable). A single connected device on each side is matched
 * positionally as a fallback when names differ (unambiguous by count).
 */
export function mergeFlutterIds(
  devicectlDevices: IosDevice[],
  flutterDevices: FlutterDevice[]
): IosDevice[] {
  const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

  // Count normalized names on each side so we can tell a unique 1:1 name join
  // from an ambiguous one BEFORE consuming any match by position.
  const countByName = (names: (string | undefined)[]) => {
    const counts = new Map<string, number>();
    for (const n of names) {
      const k = norm(n);
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const ctlNameCounts = countByName(devicectlDevices.map((d) => d.name));
  const flutterNameCounts = countByName(flutterDevices.map((f) => f.name));

  const remainingFlutter = [...flutterDevices];
  const singleEach =
    devicectlDevices.length === 1 && flutterDevices.length === 1;

  const merged: IosDevice[] = devicectlDevices.map((dev) => {
    const key = norm(dev.name);
    // A name is safe to join on only if it is unique on BOTH sides.
    const nameIsUnambiguous =
      !!key &&
      ctlNameCounts.get(key) === 1 &&
      flutterNameCounts.get(key) === 1;

    let idx = -1;
    if (nameIsUnambiguous) {
      idx = remainingFlutter.findIndex((f) => norm(f.name) === key);
    } else if (singleEach) {
      // Positional fallback is safe ONLY with exactly one device on each side
      // (there is nothing to confuse it with, even if the names differ/repeat).
      idx = 0;
    }

    if (idx >= 0) {
      const [flutter] = remainingFlutter.splice(idx, 1);
      return { ...dev, udid: flutter.id, name: dev.name ?? flutter.name };
    }

    // Ambiguous name (repeated on either side) with more than a single device:
    // do NOT guess. Keep only the devicectl id and flag it so discovery skips it
    // unless a pin names it explicitly.
    if (key && !nameIsUnambiguous && !singleEach) {
      return { ...dev, ambiguous: true };
    }

    // No flutter match (unique name that flutter didn't list, or unnamed):
    // devicectl id stays in both slots (deploy may fail, but this preserves the
    // device for lifecycle ops).
    return dev;
  });

  // flutter-only devices (not listed by devicectl): deploy works, no lifecycle.
  // These were never consumed by a name join above. A flutter-only device whose
  // name is ambiguous on the flutter side is still returned (it has a usable
  // flutter id and no devicectl id to mismatch), but flagged so an ambiguous
  // auto-pick is avoided; a pin still resolves it.
  for (const flutter of remainingFlutter) {
    const key = norm(flutter.name);
    merged.push({
      udid: flutter.id,
      devicectlId: undefined,
      name: flutter.name,
      kind: "device",
      available: true,
      ...(key && (flutterNameCounts.get(key) ?? 0) > 1
        ? { ambiguous: true }
        : {}),
    });
  }
  return merged;
}

/**
 * True when a pin string matches a device across either id space or its name.
 * The pin may be a flutter id, a devicectl id, or a (case-insensitive) name.
 */
function pinMatches(pin: string, d: IosDevice): boolean {
  const p = pin.trim().toLowerCase();
  return (
    d.udid.toLowerCase() === p ||
    (d.devicectlId?.toLowerCase() === p) ||
    (!!d.name && d.name.trim().toLowerCase() === p)
  );
}

/** Build a resolution payload from a chosen device. */
function toResolution(
  d: IosDevice,
  source: DeviceResolution["source"],
  warning?: string
): IosDeviceResolution {
  return {
    target: d.udid, // flutter id — the deploy/launch path's id
    devicectlId: d.devicectlId ?? d.udid,
    source,
    kind: d.kind,
    name: d.name,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Pick the iOS target to operate on across physical devices and simulators.
 *
 * `physical` must already be filtered to iPhone/iPad and merged with flutter
 * ids (see {@link parseDevicectlDevices} + {@link mergeFlutterIds}); an Apple TV
 * can therefore never appear here.
 *
 * A pin (flutter id, devicectl id, or name) is authoritative while it matches an
 * AVAILABLE device; otherwise it self-heals to the first available device (with
 * a warning), then any listed device. Physical devices are preferred over
 * simulators when both are available and no pin is set, matching the Tizen "real
 * device first" bias.
 *
 * Devices flagged {@link IosDevice.ambiguous} (same-named, so their flutter and
 * devicectl ids could not be matched safely) are EXCLUDED from auto-selection —
 * a pin is required to choose one. When only ambiguous devices remain, this
 * returns null (forcing a pin) rather than guessing. Returns null when nothing
 * usable is listed.
 */
/**
 * Per-call selection preference (see {@link resolveIosTarget}). `kind` biases
 * physical-vs-simulator; a `udid` is treated exactly like a pin (authoritative
 * while it matches an available target, self-healing otherwise). Both optional.
 */
export interface IosTargetPreference {
  kind?: IosDeviceKind;
  udid?: string;
}

export function resolveIosTarget(
  pinned: string | undefined,
  physical: IosDevice[],
  simulators: IosDevice[],
  preference: IosTargetPreference = {}
): IosDeviceResolution | null {
  // A per-call `udid` overrides the server-env pin for THIS call (the caller
  // opted into a specific target — the whole point of the per-call selector).
  const effectivePin =
    preference.udid && preference.udid.trim().length > 0
      ? preference.udid.trim()
      : pinned;
  pinned = effectivePin;
  // A `kind` preference reorders the auto-selection pool so the requested class
  // wins when no pin decides it. `simulator` puts simulators first (the iOS gap:
  // pick the booted sim even when a physical iPhone is attached); `device` keeps
  // the physical-first default explicit.
  const all =
    preference.kind === "simulator"
      ? [...simulators, ...physical]
      : [...physical, ...simulators];
  // Auto-selection must never land on an ambiguously-mapped device (its flutter
  // id could belong to a different same-named phone). A pin, however, still
  // resolves an ambiguous device — it is the explicit disambiguation.
  const selectable = all.filter((d) => !d.ambiguous);
  const selectablePhysical = physical.filter((d) => !d.ambiguous);
  const selectableSimulators = simulators.filter((d) => !d.ambiguous);
  // Honor a `kind` preference for the first-available pick: requested class
  // first, the other as fallback. Default stays physical-first.
  const [firstClass, secondClass] =
    preference.kind === "simulator"
      ? [selectableSimulators, selectablePhysical]
      : [selectablePhysical, selectableSimulators];
  const firstAvailable =
    firstClass.find((d) => d.available) ?? secondClass.find((d) => d.available);

  // Warn (via the same channel as the stale-pin self-heal) whenever an ambiguous
  // device exists, so the caller knows to disambiguate with a pin.
  const ambiguityWarning = all.some((d) => d.ambiguous)
    ? "Two or more connected iOS devices share a name, so their flutter and " +
      "devicectl ids cannot be matched safely (pairing by order could drive the " +
      "wrong device). Ambiguous devices were excluded from auto-selection. Set " +
      "FLUTTER_DEVICE_IOS_DEVICE to a specific flutter id, devicectl id, or unique " +
      "name to select one."
    : undefined;

  if (pinned && pinned.trim().length > 0) {
    const pin = pinned.trim();
    const matched = all.find((d) => pinMatches(pin, d));
    if (matched && matched.available) {
      return toResolution(matched, "pin");
    }
    if (firstAvailable) {
      return toResolution(
        firstAvailable,
        "discovered",
        `FLUTTER_DEVICE_IOS_DEVICE is pinned to ${pin}, but that target is not an ` +
          `available iOS device/simulator (stale pin — it may be unplugged, ` +
          `shut down, or reimaged). Using ${firstAvailable.udid} ` +
          `(${firstAvailable.kind}) instead.`
      );
    }
    if (matched) {
      // Listed but offline — keep the pin, best effort.
      return toResolution(matched, "discovered-offline");
    }
    return {
      target: pin,
      devicectlId: pin,
      source: "stale-pin",
      kind: "device",
      warning:
        `FLUTTER_DEVICE_IOS_DEVICE is pinned to ${pin}, but that target is not an ` +
        `available iOS device/simulator and none was found to fall back to. ` +
        `Proceeding with the pin; expect failures if it is not connected.`,
    };
  }

  if (firstAvailable) {
    return toResolution(firstAvailable, "discovered", ambiguityWarning);
  }

  // No available selectable device. Fall back to a listed-but-offline device,
  // still skipping ambiguous ones. If the only remaining devices are ambiguous,
  // resolve NOTHING so the caller must disambiguate with a pin rather than have
  // us guess a possibly-wrong flutter id.
  const anyOffline = selectable[0];
  if (anyOffline) {
    return toResolution(anyOffline, "discovered-offline", ambiguityWarning);
  }
  return null;
}
