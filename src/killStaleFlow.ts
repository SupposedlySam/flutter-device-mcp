/**
 * The teardown WIRING: which scope a `flutter_kill_stale` call runs with, what
 * a deploy tears down before it installs, and in which order.
 *
 * WHY this is a module and not two methods on {@link CommandCore}: every
 * device-scoping decision that reaches a real tool call lives here, and nothing
 * could test it while it lived inline in the handler. A mutation that made the
 * refusal branch call `killStale({ kind: "all-devices" })` before returning
 * `killed: false, reason: "…nothing was killed…"` passed the whole suite: a
 * refusal that lies, with nothing watching. The dependencies are injected for
 * exactly that reason — a fake adapter can record that the teardown was NOT
 * called.
 */
import { summarizeKillStale } from "./handlerLogic.js";
import { LaunchRecord } from "./launchRegistry.js";
import { CommandResult, DeviceResolution } from "./types.js";
import type {
  DeviceTargetPreference,
  KillStaleScope,
  KillStaleScopeKind,
} from "./adapters/platformAdapter.js";

/** The slice of a {@link PlatformAdapter} a teardown needs. */
export interface TeardownAdapter {
  readonly platform: string;
  readonly killStaleScope: KillStaleScopeKind;
  killStale(scope: KillStaleScope): Promise<Record<string, CommandResult>>;
  discoverDevice(preference?: DeviceTargetPreference): Promise<DeviceResolution>;
}

/** The launch-record side effects a teardown performs. */
export interface LaunchRecordStore {
  readRecords(): LaunchRecord[];
  removeControlFifo(fifoPath?: string): void;
  clearLaunch(platform: string, device: string): void;
  clearLaunches(platform: string): void;
}

/** What scope a teardown should run with, and what to tell the caller. */
export type KillStaleScopeDecision =
  | { kind: "all-devices"; note: string }
  | { kind: "device"; device: string; warning?: string }
  | { kind: "refuse"; reason: string };

/**
 * Decide the scope of a `flutter_kill_stale` call.
 *
 * Three things it must not confuse. A PLATFORM-scoped adapter (Tizen, webOS,
 * tvOS, macOS) always tears down platform-wide, so reporting the resolved device
 * as its scope would describe something it did not do — a Tizen call that killed
 * both TVs used to report one device. A DEVICE-scoped adapter with a resolved
 * device scopes to it. A device-scoped adapter with NO resolvable device refuses:
 * every session there is a `flutter run` on this host, so with nothing to
 * attribute them to a teardown could only kill them all, including one someone
 * else is using.
 *
 * Resolution failing is not a reason to widen the blast radius, which is why the
 * refusal names `all_devices` as the way to ask for that deliberately.
 */
export function decideKillStaleScope(opts: {
  scopeKind: KillStaleScopeKind;
  allDevices?: boolean;
  deviceUdid?: string;
  resolution?: { target: string; warning?: string };
  resolutionError?: string;
}): KillStaleScopeDecision {
  if (opts.scopeKind === "platform") {
    return {
      kind: "all-devices",
      note:
        "This platform's launch drivers are named after its own toolchain and cannot " +
        "belong to another platform, and one target is modelled, so the teardown is " +
        "platform-wide and needs no device." +
        (opts.deviceUdid
          ? ` The device_udid (${opts.deviceUdid}) does not narrow it.`
          : ""),
    };
  }
  if (opts.allDevices) {
    return {
      kind: "all-devices",
      note:
        "all_devices was requested: every launch driver on this host was torn down " +
        "regardless of which device it was serving, orphaned compilers included.",
    };
  }
  if (opts.resolution) {
    return {
      kind: "device",
      device: opts.resolution.target,
      warning: opts.resolution.warning,
    };
  }
  return {
    kind: "refuse",
    reason:
      `No device could be resolved, so NOTHING was killed: ${opts.resolutionError ?? "device resolution failed"} ` +
      "Every session on this platform is a `flutter run` on this host, so with no device " +
      "to attribute them to a teardown could only kill them all — including one someone " +
      "else is using. Attach the device (or name it with device_udid), or pass " +
      "all_devices: true to tear down every session deliberately.",
  };
}

/**
 * Run `flutter_kill_stale`: decide the scope, tear down, and drop the launch
 * records the teardown invalidated.
 *
 * Returns the response payload. A refusal returns BEFORE any teardown runs —
 * `killStale` is not called at all, which is the property a caller reads
 * `killed: false` as meaning.
 */
export async function runKillStale(deps: {
  adapter: TeardownAdapter;
  args: { device_udid?: string; all_devices?: boolean };
  store: LaunchRecordStore;
}): Promise<Record<string, unknown>> {
  const { adapter, args, store } = deps;

  let resolution: DeviceResolution | undefined;
  let resolutionError: string | undefined;
  // A platform-scoped teardown needs no device, so it does not ask for one:
  // discovery can fail precisely BECAUSE a wedged driver holds the lock, and
  // that is the call this verb exists to answer.
  if (adapter.killStaleScope === "device" && !args.all_devices) {
    try {
      resolution = await adapter.discoverDevice({ udid: args.device_udid });
    } catch (error) {
      resolutionError = error instanceof Error ? error.message : String(error);
    }
  }

  const decision = decideKillStaleScope({
    scopeKind: adapter.killStaleScope,
    allDevices: args.all_devices,
    deviceUdid: args.device_udid,
    resolution,
    resolutionError,
  });

  if (decision.kind === "refuse") {
    return {
      platform: adapter.platform,
      scope: "none",
      killed: false,
      reason: decision.reason,
    };
  }

  const scopedDevice = decision.kind === "device" ? decision.device : undefined;
  const killed = await adapter.killStale(
    scopedDevice
      ? { kind: "device", device: scopedDevice }
      : { kind: "all-devices" }
  );

  // The launch daemon (and its VM service) is being killed — remove the control
  // FIFO of every record the teardown invalidated, then drop those records so
  // hot reload/restart won't chase a dead URI or a stale pipe. ONLY the records
  // for the device torn down: another device's daemon is still alive, and
  // deleting its FIFO or record would strand its hot reload.
  const invalidated = store
    .readRecords()
    .filter(
      (r) =>
        r.platform === adapter.platform &&
        (!scopedDevice || r.device === scopedDevice)
    );
  for (const record of invalidated) {
    store.removeControlFifo(record.controlFifoPath);
  }
  if (scopedDevice) store.clearLaunch(adapter.platform, scopedDevice);
  else store.clearLaunches(adapter.platform);

  return {
    platform: adapter.platform,
    scope:
      scopedDevice ??
      (adapter.killStaleScope === "platform" ? "platform-wide" : "all-devices"),
    scopeNote: decision.kind === "all-devices" ? decision.note : undefined,
    deviceWarning: decision.kind === "device" ? decision.warning : undefined,
    ...summarizeKillStale(killed),
  };
}

/**
 * The deploy's "one deploy at a time" step: resolve the device and tear down the
 * drivers holding it, in the order that platform can support.
 *
 * A DEVICE-scoped platform must resolve first — the teardown cannot be confined
 * without the device, and killing first is what let a deploy to the emulator
 * take down the phone. The cost is real and worth naming: if resolution throws
 * (nothing attached, adb wedged), the teardown never runs, so a driver holding
 * the device survives a failed deploy and `flutter_kill_stale` has to be aimed
 * at it deliberately.
 *
 * A PLATFORM-scoped platform has the opposite order available and takes it:
 * its teardown needs no device, so it runs BEFORE discovery — where a wedged
 * `flutter-tizen` may be the reason `sdb devices` answers wrongly at all.
 */
export async function tearDownForDeploy(deps: {
  adapter: TeardownAdapter;
  preference: DeviceTargetPreference;
}): Promise<{
  resolution: DeviceResolution;
  killed: Record<string, CommandResult>;
}> {
  const { adapter, preference } = deps;
  if (adapter.killStaleScope === "platform") {
    const killed = await adapter.killStale({ kind: "all-devices" });
    const resolution = await adapter.discoverDevice(preference);
    return { resolution, killed };
  }
  const resolution = await adapter.discoverDevice(preference);
  const killed = await adapter.killStale({
    kind: "device",
    device: resolution.target,
  });
  return { resolution, killed };
}
