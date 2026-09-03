import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_STAGE_ENTRIES,
  filePointerStage,
  memoryPointerStage,
  parseStageStore,
  readStageStore,
  stageKey,
  stagePath,
  stateDir,
  withStagedPosition,
  writeStageStore,
} from "../src/input/pointerStage.js";

function tmpFile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pointer-stage-test-")),
    "pointer-stage.json"
  );
}

describe("stateDir / stagePath", () => {
  const saved = process.env.FLUTTER_DEVICE_STATE_DIR;
  afterEach(() => {
    process.env.FLUTTER_DEVICE_STATE_DIR = saved;
  });

  it("honors FLUTTER_DEVICE_STATE_DIR", () => {
    process.env.FLUTTER_DEVICE_STATE_DIR = "/tmp/somewhere-else";
    expect(stateDir()).toBe("/tmp/somewhere-else");
    expect(stagePath()).toBe("/tmp/somewhere-else/pointer-stage.json");
  });

  it("falls back to the per-developer config dir under $HOME", () => {
    delete process.env.FLUTTER_DEVICE_STATE_DIR;
    expect(stateDir()).toBe(
      path.join(os.homedir(), ".config", "flutter-device-mcp")
    );
  });
});

describe("stageKey", () => {
  it("keys by platform AND device so two platforms' ids cannot collide", () => {
    expect(stageKey("android", "emulator-5554")).toBe("android:emulator-5554");
    expect(stageKey("android", "emulator-5554")).not.toBe(
      stageKey("tizen", "emulator-5554")
    );
  });
});

describe("parseStageStore", () => {
  it("reads back well-formed entries", () => {
    expect(
      parseStageStore(
        '{"android:x":{"x":756,"y":2268,"stagedAt":"2026-09-02T00:00:00.000Z"}}'
      )
    ).toEqual({
      "android:x": { x: 756, y: 2268, stagedAt: "2026-09-02T00:00:00.000Z" },
    });
  });

  it("degrades to nothing-staged on corrupt JSON rather than throwing", () => {
    expect(parseStageStore("{not json")).toEqual({});
  });

  it("drops entries whose coordinates are unusable", () => {
    const store = parseStageStore(
      JSON.stringify({
        good: { x: 1, y: 2, stagedAt: "z" },
        missingY: { x: 1 },
        stringX: { x: "1", y: 2 },
        notFinite: { x: 1, y: Number.NaN },
        nested: { x: { deep: 1 }, y: 2 },
      })
    );
    expect(Object.keys(store)).toEqual(["good"]);
  });

  it("keeps a position whose stagedAt is missing (still usable)", () => {
    expect(parseStageStore('{"k":{"x":5,"y":6}}')).toEqual({
      k: { x: 5, y: 6, stagedAt: "" },
    });
  });

  it("rejects a non-object document", () => {
    expect(parseStageStore("[1,2,3]")).toEqual({});
    expect(parseStageStore("null")).toEqual({});
  });
});

describe("withStagedPosition", () => {
  it("adds the entry without mutating the input store", () => {
    const before = { a: { x: 1, y: 1, stagedAt: "2026-01-01" } };
    const after = withStagedPosition(before, "b", {
      x: 2,
      y: 2,
      stagedAt: "2026-01-02",
    });
    expect(after.b).toEqual({ x: 2, y: 2, stagedAt: "2026-01-02" });
    expect(Object.keys(before)).toEqual(["a"]);
  });

  it("evicts the OLDEST entries past the cap, never the one just staged", () => {
    let store = {};
    for (let i = 0; i < MAX_STAGE_ENTRIES; i += 1) {
      store = withStagedPosition(store, `dev-${i}`, {
        x: i,
        y: i,
        // Zero-padded so lexical order matches chronological order.
        stagedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const full = withStagedPosition(store, "newest", {
      x: 99,
      y: 99,
      stagedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(Object.keys(full)).toHaveLength(MAX_STAGE_ENTRIES);
    expect(full.newest).toEqual({
      x: 99,
      y: 99,
      stagedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(full["dev-0"]).toBeUndefined(); // oldest evicted
    expect(full[`dev-${MAX_STAGE_ENTRIES - 1}`]).toBeDefined();
  });

  it("keeps the just-staged entry even when it is the OLDEST by timestamp", () => {
    // The eviction sorts by stagedAt, so an entry stamped in the past would be
    // first in line — and evicting the position the caller just staged would
    // reproduce the exact failure this store exists to fix: a `click` that
    // cannot find what a `move` put there one call earlier.
    let store = {};
    for (let i = 0; i < MAX_STAGE_ENTRIES; i += 1) {
      store = withStagedPosition(store, `dev-${i}`, {
        x: i,
        y: i,
        stagedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const full = withStagedPosition(store, "backdated", {
      x: 7,
      y: 8,
      stagedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(Object.keys(full)).toHaveLength(MAX_STAGE_ENTRIES);
    expect(full.backdated).toEqual({
      x: 7,
      y: 8,
      stagedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(full["dev-0"]).toBeUndefined();
  });
});

describe("readStageStore / writeStageStore", () => {
  it("round-trips through a file", () => {
    const file = tmpFile();
    writeStageStore({ k: { x: 3, y: 4, stagedAt: "2026-01-01" } }, file);
    expect(readStageStore(file)).toEqual({
      k: { x: 3, y: 4, stagedAt: "2026-01-01" },
    });
  });

  it("creates the containing directory", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pointer-stage-mk-")),
      "nested",
      "deeper",
      "pointer-stage.json"
    );
    writeStageStore({ k: { x: 1, y: 1, stagedAt: "" } }, file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("leaves no temp file behind (the write renames atomically)", () => {
    const file = tmpFile();
    writeStageStore({ k: { x: 1, y: 1, stagedAt: "" } }, file);
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings).toEqual(["pointer-stage.json"]);
  });

  it("returns nothing-staged for a missing file instead of throwing", () => {
    expect(readStageStore("/nonexistent/dir/pointer-stage.json")).toEqual({});
  });

  it("swallows an unwritable path (a move that cannot persist still succeeds)", () => {
    expect(() =>
      writeStageStore({ k: { x: 1, y: 1, stagedAt: "" } }, "/pointer-stage.json")
    ).not.toThrow();
  });
});

describe("filePointerStage", () => {
  it("a position saved by ONE stage instance is loaded by a SEPARATE one (the cross-process contract)", () => {
    const file = tmpFile();
    // Two independent instances stand in for two server processes: the whole
    // point of the store is that the reader never shared memory with the writer.
    const writer = filePointerStage(file);
    const reader = filePointerStage(file);
    writer.save(stageKey("android", "emulator-5554"), 756, 2268);
    expect(reader.load(stageKey("android", "emulator-5554"))).toMatchObject({
      x: 756,
      y: 2268,
    });
  });

  it("does not hand one device's position to another device", () => {
    const file = tmpFile();
    const stage = filePointerStage(file);
    stage.save(stageKey("android", "emulator-5554"), 10, 20);
    expect(stage.load(stageKey("android", "R5CT10ABCDE"))).toBeUndefined();
  });

  it("overwrites an earlier position for the same device", () => {
    const file = tmpFile();
    const stage = filePointerStage(file);
    stage.save(stageKey("android", "d"), 1, 2);
    stage.save(stageKey("android", "d"), 300, 400);
    expect(stage.load(stageKey("android", "d"))).toMatchObject({
      x: 300,
      y: 400,
    });
  });

  it("stamps stagedAt so a caller can see how old a staged position is", () => {
    const file = tmpFile();
    const saved = filePointerStage(file).save(stageKey("android", "d"), 1, 2);
    expect(Date.parse(saved.stagedAt)).not.toBeNaN();
  });
});

describe("memoryPointerStage", () => {
  it("round-trips in memory and stays private to the instance", () => {
    const a = memoryPointerStage();
    const b = memoryPointerStage();
    a.save("k", 5, 6);
    expect(a.load("k")).toMatchObject({ x: 5, y: 6 });
    expect(b.load("k")).toBeUndefined();
  });
});
