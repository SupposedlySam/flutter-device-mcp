import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  clearLaunch,
  clearLaunches,
  findLaunch,
  readRecords,
  recordLaunch,
  resolveLaunch,
} from "../src/launchRegistry.js";

function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-mcp-reg-"));
  return path.join(dir, "launches.json");
}

const base = {
  platform: "tizen",
  device: "192.0.2.7:26101",
  vmServiceUriWs: "ws://127.0.0.1:51182/tok/ws",
  recordedAt: 1000,
};

describe("launchRegistry", () => {
  it("records a launch and finds it by platform+device", () => {
    const store = tempStore();
    recordLaunch(base, store);
    const found = findLaunch("tizen", "192.0.2.7:26101", store);
    expect(found?.vmServiceUriWs).toBe("ws://127.0.0.1:51182/tok/ws");
  });

  it("returns undefined when nothing is recorded", () => {
    expect(findLaunch("tizen", undefined, tempStore())).toBeUndefined();
  });

  it("keeps only the latest record per platform+device (latest wins)", () => {
    const store = tempStore();
    recordLaunch(base, store);
    recordLaunch(
      { ...base, vmServiceUriWs: "ws://127.0.0.1:60000/new/ws", recordedAt: 2000 },
      store
    );
    expect(readRecords(store)).toHaveLength(1);
    expect(findLaunch("tizen", undefined, store)?.vmServiceUriWs).toBe(
      "ws://127.0.0.1:60000/new/ws"
    );
  });

  it("keeps distinct records for different devices", () => {
    const store = tempStore();
    recordLaunch(base, store);
    recordLaunch({ ...base, device: "10.0.0.9:26101" }, store);
    expect(readRecords(store)).toHaveLength(2);
    expect(findLaunch("tizen", "10.0.0.9:26101", store)?.device).toBe(
      "10.0.0.9:26101"
    );
  });

  it("without a device, returns the most recent record for the platform", () => {
    const store = tempStore();
    recordLaunch({ ...base, device: "a", recordedAt: 1 }, store);
    recordLaunch({ ...base, device: "b", recordedAt: 5 }, store);
    expect(findLaunch("tizen", undefined, store)?.device).toBe("b");
  });

  it("clearLaunches drops all records for a platform only", () => {
    const store = tempStore();
    recordLaunch(base, store);
    recordLaunch({ ...base, platform: "webos", device: "w" }, store);
    clearLaunches("tizen", store);
    expect(findLaunch("tizen", undefined, store)).toBeUndefined();
    expect(findLaunch("webos", undefined, store)?.device).toBe("w");
  });

  it("clearLaunch drops only the target device, leaving other devices intact", () => {
    const store = tempStore();
    recordLaunch(base, store);
    recordLaunch({ ...base, device: "10.0.0.9:26101" }, store);
    clearLaunch("tizen", "192.0.2.7:26101", store);
    // The targeted device's record is gone…
    expect(findLaunch("tizen", "192.0.2.7:26101", store)).toBeUndefined();
    // …but the other device's healthy record survives.
    expect(findLaunch("tizen", "10.0.0.9:26101", store)?.device).toBe(
      "10.0.0.9:26101"
    );
    expect(readRecords(store)).toHaveLength(1);
  });

  it("clearLaunch matches on platform too, sparing a same-device on another platform", () => {
    const store = tempStore();
    recordLaunch(base, store);
    recordLaunch({ ...base, platform: "webos" }, store);
    clearLaunch("tizen", base.device, store);
    expect(findLaunch("tizen", base.device, store)).toBeUndefined();
    expect(findLaunch("webos", base.device, store)?.platform).toBe("webos");
  });

  it("clearLaunch: on a failed atomic write, preserves the prior store and leaves no temp", () => {
    const store = tempStore();
    recordLaunch(base, store);
    const dir = path.dirname(store);
    const spy = jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EXDEV");
    });
    expect(() => clearLaunch("tizen", base.device, store)).not.toThrow();
    spy.mockRestore();
    expect(readRecords(store)).toEqual([base]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("degrades to no-record on a corrupt store rather than throwing", () => {
    const store = tempStore();
    fs.writeFileSync(store, "{ not json");
    expect(readRecords(store)).toEqual([]);
    expect(findLaunch("tizen", undefined, store)).toBeUndefined();
  });

  it("recordLaunch: on a failed atomic write, preserves the prior store and leaves no temp", () => {
    const store = tempStore();
    recordLaunch(base, store);
    const dir = path.dirname(store);
    const spy = jest
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw new Error("EXDEV");
      });
    // Best-effort: the write failure is swallowed, not thrown.
    expect(() =>
      recordLaunch({ ...base, recordedAt: 2000 }, store)
    ).not.toThrow();
    spy.mockRestore();
    // Old-file-or-new-file: the prior record survives intact (an in-place write
    // would have truncated/corrupted it here).
    expect(readRecords(store)).toEqual([base]);
    // The finally cleanup removes the temp on the failure path.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("clearLaunches: on a failed atomic write, preserves the prior store and leaves no temp", () => {
    const store = tempStore();
    recordLaunch(base, store);
    const dir = path.dirname(store);
    const spy = jest
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw new Error("EXDEV");
      });
    expect(() => clearLaunches("tizen", store)).not.toThrow();
    spy.mockRestore();
    expect(readRecords(store)).toEqual([base]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("resolveLaunch — two devices live at once", () => {
  // Per-device teardown means a deploy no longer ends the other device's
  // session, so two live daemons is the normal state rather than a rarity.
  const emulator = {
    platform: "android",
    device: "emulator-5554",
    vmServiceUriWs: "ws://127.0.0.1:1/ws",
    recordedAt: 1000,
  };
  const phone = {
    platform: "android",
    device: "988a1b413950494c49",
    vmServiceUriWs: "ws://127.0.0.1:2/ws",
    recordedAt: 2000,
  };

  it("refuses to guess which of two live launches a caller meant", () => {
    const store = tempStore();
    recordLaunch(emulator, store);
    recordLaunch(phone, store);
    const lookup = resolveLaunch("android", undefined, store);
    expect(lookup.kind).toBe("ambiguous");
    if (lookup.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(lookup.devices.sort()).toEqual([
      "988a1b413950494c49",
      "emulator-5554",
    ]);
    // findLaunch's own answer is the one that made this a coin toss: it returns
    // the most recently recorded launch, which is not the caller's choice.
    expect(findLaunch("android", undefined, store)?.device).toBe(
      "988a1b413950494c49"
    );
  });

  it("resolves the named device even while another is live", () => {
    const store = tempStore();
    recordLaunch(emulator, store);
    recordLaunch(phone, store);
    const lookup = resolveLaunch("android", "emulator-5554", store);
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") throw new Error("expected found");
    expect(lookup.record.vmServiceUriWs).toBe("ws://127.0.0.1:1/ws");
  });

  it("resolves without a device when only one launch is live", () => {
    const store = tempStore();
    recordLaunch(emulator, store);
    expect(resolveLaunch("android", undefined, store).kind).toBe("found");
  });

  it("reports none when nothing is recorded", () => {
    expect(resolveLaunch("android", undefined, tempStore()).kind).toBe("none");
  });
});

describe("launchRegistry concurrency", () => {
  it("keeps every device's record when several are written in sequence", async () => {
    // What this actually pins: the read-modify-write merges rather than
    // replaces, so a live daemon never loses its record (and its hot reload)
    // to a later deploy on another device.
    //
    // It does NOT witness the lock. Each write is synchronous, so two writes
    // from THIS process cannot interleave however they are scheduled; the lock
    // is for two MCP processes (two agents, two sessions) writing the same store,
    // which this suite cannot create. The test below pins the part of the lock
    // that is observable here — that an abandoned one is broken rather than
    // stranding every later write.
    const store = tempStore();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() =>
          recordLaunch(
            {
              platform: "android",
              device: `device-${i}`,
              vmServiceUriWs: `ws://127.0.0.1:${i}/ws`,
              recordedAt: 1000 + i,
            },
            store
          )
        )
      )
    );
    expect(readRecords(store).map((r) => r.device).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `device-${i}`).sort()
    );
  });

  it("breaks an abandoned lock rather than stranding every later write", () => {
    // A crashed writer leaves the lock directory behind; a store that waited on
    // it forever would fail every deploy afterwards.
    const store = tempStore();
    fs.mkdirSync(`${store}.lock`);
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(`${store}.lock`, stale, stale);
    recordLaunch(
      {
        platform: "android",
        device: "emulator-5554",
        vmServiceUriWs: "ws://127.0.0.1:1/ws",
        recordedAt: 1,
      },
      store
    );
    expect(findLaunch("android", "emulator-5554", store)).toBeDefined();
    expect(fs.existsSync(`${store}.lock`)).toBe(false);
  });
});
