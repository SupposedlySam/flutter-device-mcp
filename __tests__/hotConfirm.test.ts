import fs from "fs";
import os from "os";
import path from "path";

import { ackPatternFor, confirmHotAction } from "../src/hotConfirm.js";

const noSleep = async () => {};

describe("ackPatternFor", () => {
  it("accepts the in-progress line as well as the completed one", () => {
    expect(ackPatternFor("reload").test("Performing hot reload...")).toBe(true);
    expect(ackPatternFor("reload").test("Reloaded 1 of 1234 libraries in 312ms")).toBe(true);
    expect(ackPatternFor("restart").test("Restarted application in 900ms")).toBe(true);
  });

  it("does not accept flutter's startup key legend as an acknowledgement", () => {
    // The legend is printed once at launch and says nothing about a reload
    // having run. Treating it as proof is exactly the bug this guards.
    const legend = "Flutter run key commands.\nr Hot reload. \nR Hot restart.\n";
    expect(ackPatternFor("reload").test(legend)).toBe(false);
    expect(ackPatternFor("restart").test(legend)).toBe(false);
  });
});

describe("confirmHotAction", () => {
  it("confirms when the acknowledgement is appended after the send", async () => {
    const ok = await confirmHotAction({
      logPath: "/x.log",
      action: "reload",
      fromByte: 10,
      deps: {
        read: async () => "0123456789Performing hot reload...",
        sleep: noSleep,
      },
    });
    expect(ok).toBe(true);
  });

  it("confirms an acknowledgement that follows multi-byte log output", async () => {
    // The offset is the log's size in BYTES. An Apple TV run's log is full of
    // emoji level markers, so cutting the decoded text at that offset skipped
    // the new lines and a reload the flutter tool had performed read as unconfirmed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-confirm-"));
    const logPath = path.join(dir, "launch.log");
    fs.writeFileSync(logPath, "flutter: 🟢 DEBUG pushed\n".repeat(200));
    const fromByte = fs.statSync(logPath).size;
    fs.appendFileSync(logPath, "Performing hot reload...\nReloaded 197 of 7518 libraries\n");

    const ok = await confirmHotAction({ logPath, action: "reload", fromByte, timeoutMs: 0 });

    fs.rmSync(dir, { recursive: true });
    expect(ok).toBe(true);
  });

  it("does NOT confirm from an acknowledgement that predates the send", async () => {
    // A previous reload's line is still in the log. Reading the whole file would
    // confirm a reload that never happened this time.
    const ok = await confirmHotAction({
      logPath: "/x.log",
      action: "reload",
      fromByte: 40,
      timeoutMs: 0,
      deps: {
        read: async () => "Reloaded 1 of 1234 libraries in 312ms\n\n\nnothing since",
        sleep: noSleep,
      },
    });
    expect(ok).toBe(false);
  });

  it("returns false when nothing acknowledges within the timeout", async () => {
    let t = 0;
    const ok = await confirmHotAction({
      logPath: "/x.log",
      action: "reload",
      fromByte: 0,
      timeoutMs: 1000,
      deps: {
        read: async () => "app logs only, no reload here",
        sleep: noSleep,
        now: () => (t += 400),
      },
    });
    expect(ok).toBe(false);
  });

  it("keeps waiting rather than failing when the log cannot be read", async () => {
    let reads = 0;
    let t = 0;
    const ok = await confirmHotAction({
      logPath: "/missing.log",
      action: "reload",
      fromByte: 0,
      timeoutMs: 1000,
      deps: {
        read: async () => {
          reads += 1;
          throw new Error("ENOENT");
        },
        sleep: noSleep,
        now: () => (t += 400),
      },
    });
    expect(ok).toBe(false);
    expect(reads).toBeGreaterThan(1);
  });
});
