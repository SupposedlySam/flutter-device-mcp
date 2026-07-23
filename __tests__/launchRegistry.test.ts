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
