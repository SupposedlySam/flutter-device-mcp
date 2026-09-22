import { jest } from "@jest/globals";
import {
  decideKillStaleScope,
  runKillStale,
  tearDownForDeploy,
  type LaunchRecordStore,
  type TeardownAdapter,
} from "../src/killStaleFlow.js";
import type { KillStaleScope, KillStaleScopeKind } from "../src/adapters/platformAdapter.js";
import type { CommandResult, DeviceResolution } from "../src/types.js";
import type { LaunchRecord } from "../src/launchRegistry.js";

// These are the decisions that reach a real tool call: which scope a teardown
// runs with, in which order, and what it reports having done. Nothing tested
// them while they lived inline in the handler — a mutation that killed every
// session on the host inside the REFUSAL branch, then reported
// `killed: false, reason: "…nothing was killed…"`, passed the whole suite.

const killResult = (combined: string): CommandResult => ({
  code: 0,
  stdout: combined,
  stderr: "",
  combined,
  success: true,
  timedOut: false,
});

/** An adapter that records the scope it was asked to tear down, in call order. */
function fakeAdapter(opts: {
  scopeKind: KillStaleScopeKind;
  resolve?: () => Promise<DeviceResolution>;
}) {
  const calls: string[] = [];
  const scopes: KillStaleScope[] = [];
  const adapter: TeardownAdapter = {
    platform: opts.scopeKind === "platform" ? "tizen" : "android",
    killStaleScope: opts.scopeKind,
    async killStale(scope) {
      calls.push("killStale");
      scopes.push(scope);
      return { flutterRun: killResult("torn down") };
    },
    async discoverDevice() {
      calls.push("discoverDevice");
      if (opts.resolve) return opts.resolve();
      return { target: "emulator-5554", source: "discovered" };
    },
  };
  return { adapter, calls, scopes };
}

function fakeStore(records: LaunchRecord[] = []) {
  const removedFifos: (string | undefined)[] = [];
  const cleared: string[] = [];
  const store: LaunchRecordStore = {
    readRecords: () => records,
    removeControlFifo: (fifoPath) => removedFifos.push(fifoPath),
    clearLaunch: (platform, device) => cleared.push(`launch:${platform}:${device}`),
    clearLaunches: (platform) => cleared.push(`launches:${platform}`),
  };
  return { store, removedFifos, cleared };
}

const record = (device: string, fifo: string): LaunchRecord => ({
  platform: "android",
  device,
  vmServiceUriWs: `ws://127.0.0.1/${device}/ws`,
  controlFifoPath: fifo,
  recordedAt: 1,
});

describe("tearDownForDeploy", () => {
  it("scopes the teardown to the device it just resolved", async () => {
    const { adapter, calls, scopes } = fakeAdapter({ scopeKind: "device" });
    const { resolution } = await tearDownForDeploy({ adapter, preference: {} });
    expect(resolution.target).toBe("emulator-5554");
    // The literal reported bug: a deploy aimed at the emulator killing the
    // phone's session. An all-devices scope here IS that bug.
    expect(scopes).toEqual([{ kind: "device", device: "emulator-5554" }]);
    // And it must resolve BEFORE tearing down: the scope cannot be known first.
    expect(calls).toEqual(["discoverDevice", "killStale"]);
  });

  it("passes the resolved device through even when a per-call pin redirected it", async () => {
    const { adapter, scopes } = fakeAdapter({
      scopeKind: "device",
      resolve: async () => ({
        target: "988a1b413950494c49",
        source: "pin",
        warning: "the pinned emulator was not online",
      }),
    });
    await tearDownForDeploy({ adapter, preference: { udid: "emulator-5554" } });
    // The device INSTALLED to is the device torn down — a teardown aimed at the
    // requested target rather than the resolved one is the same mismatch.
    expect(scopes).toEqual([
      { kind: "device", device: "988a1b413950494c49" },
    ]);
  });

  it("tears down BEFORE discovery on a platform whose teardown needs no device", async () => {
    // A wedged `flutter-tizen` can be why `sdb devices` answers wrongly, so the
    // order that platform can support is the one it gets.
    const { adapter, calls, scopes } = fakeAdapter({ scopeKind: "platform" });
    await tearDownForDeploy({ adapter, preference: {} });
    expect(calls).toEqual(["killStale", "discoverDevice"]);
    expect(scopes).toEqual([{ kind: "all-devices" }]);
  });
});

describe("runKillStale", () => {
  it("scopes to the resolved device and clears only ITS launch record + FIFO", async () => {
    const { adapter, scopes } = fakeAdapter({ scopeKind: "device" });
    const { store, removedFifos, cleared } = fakeStore([
      record("emulator-5554", "/tmp/emu.fifo"),
      record("988a1b413950494c49", "/tmp/phone.fifo"),
    ]);
    const payload = await runKillStale({ adapter, args: {}, store });

    expect(scopes).toEqual([{ kind: "device", device: "emulator-5554" }]);
    // The other device's daemon is still alive: deleting its FIFO or dropping
    // its record would strand its hot reload.
    expect(removedFifos).toEqual(["/tmp/emu.fifo"]);
    expect(cleared).toEqual(["launch:android:emulator-5554"]);
    expect(payload.scope).toBe("emulator-5554");
    expect(payload.flutterRunKilled).toBe(true);
  });

  it("honors all_devices: no discovery, host-wide scope, every record cleared", async () => {
    const { adapter, calls, scopes } = fakeAdapter({ scopeKind: "device" });
    const { store, removedFifos, cleared } = fakeStore([
      record("emulator-5554", "/tmp/emu.fifo"),
      record("988a1b413950494c49", "/tmp/phone.fifo"),
    ]);
    const payload = await runKillStale({
      adapter,
      args: { all_devices: true },
      store,
    });
    expect(calls).toEqual(["killStale"]);
    expect(scopes).toEqual([{ kind: "all-devices" }]);
    expect(removedFifos).toEqual(["/tmp/emu.fifo", "/tmp/phone.fifo"]);
    expect(cleared).toEqual(["launches:android"]);
    expect(payload.scope).toBe("all-devices");
    expect(String(payload.scopeNote)).toContain("all_devices");
  });

  it("reports the PLATFORM-WIDE scope it actually applied, not a device", async () => {
    // A Tizen teardown kills every `flutter-tizen` on the host. It
    // used to resolve a device and report it as the scope — describing something
    // it had not done, which is the failure this whole change is about.
    const { adapter, calls, scopes } = fakeAdapter({ scopeKind: "platform" });
    const { store } = fakeStore();
    const payload = await runKillStale({
      adapter,
      args: { device_udid: "192.168.1.50:26101" },
      store,
    });
    expect(calls).toEqual(["killStale"]);
    expect(scopes).toEqual([{ kind: "all-devices" }]);
    expect(payload.scope).toBe("platform-wide");
    expect(String(payload.scopeNote)).toContain("does not narrow it");
  });

  it("REFUSES when no device resolves — and does not tear anything down", async () => {
    // The property a caller reads `killed: false` as meaning. A refusal that
    // kills the host anyway is worse than either honest answer.
    const { adapter, calls } = fakeAdapter({
      scopeKind: "device",
      resolve: async () => {
        throw new Error("No Android device found.");
      },
    });
    const { store, removedFifos, cleared } = fakeStore([
      record("emulator-5554", "/tmp/emu.fifo"),
    ]);
    const payload = await runKillStale({ adapter, args: {}, store });

    expect(calls).toEqual(["discoverDevice"]);
    expect(calls).not.toContain("killStale");
    expect(payload).toMatchObject({ scope: "none", killed: false });
    expect(String(payload.reason)).toContain("No Android device found.");
    expect(String(payload.reason)).toContain("all_devices: true");
    // A refusal changes nothing: the records and FIFOs are still valid.
    expect(removedFifos).toEqual([]);
    expect(cleared).toEqual([]);
    expect(payload.flutterRunKilled).toBeUndefined();
  });

  it("surfaces a stale-pin warning alongside the scope it used", async () => {
    const { adapter } = fakeAdapter({
      scopeKind: "device",
      resolve: async () => ({
        target: "988a1b413950494c49",
        source: "discovered",
        warning: "the pin was stale",
      }),
    });
    const { store } = fakeStore();
    const payload = await runKillStale({ adapter, args: {}, store });
    expect(payload.deviceWarning).toBe("the pin was stale");
    expect(payload.scope).toBe("988a1b413950494c49");
  });

  it("passes the teardown's own note through, so a `false` is readable", async () => {
    const calls: KillStaleScope[] = [];
    const adapter: TeardownAdapter = {
      platform: "android",
      killStaleScope: "device",
      async killStale(scope) {
        calls.push(scope);
        return {
          flutterRun: {
            ...killResult(
              "No launch driver found for emulator-5554 — nothing to kill. " +
                "Left running, on another device: pid 86631."
            ),
            code: 1,
            success: false,
          },
        };
      },
      async discoverDevice() {
        return { target: "emulator-5554", source: "discovered" };
      },
    };
    const { store } = fakeStore();
    const payload = await runKillStale({ adapter, args: {}, store });
    expect(payload.flutterRunKilled).toBe(false);
    const detail = payload.detail as Record<string, unknown>;
    expect(String(detail.flutterRunNote)).toContain("Left running, on another device");
    expect(detail.flutterRunExit).toBe(1);
  });
});

describe("decideKillStaleScope", () => {
  it("never reports a device scope for a platform-wide teardown", () => {
    const decision = decideKillStaleScope({ scopeKind: "platform" });
    expect(decision.kind).toBe("all-devices");
  });

  it("refuses a device-scoped platform with no resolvable device", () => {
    const decision = decideKillStaleScope({
      scopeKind: "device",
      resolutionError: "No Android device found.",
    });
    expect(decision.kind).toBe("refuse");
  });

  it("scopes to the resolved device when there is one", () => {
    expect(
      decideKillStaleScope({
        scopeKind: "device",
        resolution: { target: "emulator-5554" },
      })
    ).toEqual({ kind: "device", device: "emulator-5554", warning: undefined });
  });
});
