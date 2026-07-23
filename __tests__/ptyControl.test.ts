import fs from "fs";
import os from "os";
import path from "path";
import {
  createControlFifoPath,
  makeControlFifo,
  removeControlFifo,
  sendControlChar,
  withControlFifoStdin,
} from "../src/ptyControl.js";

describe("withControlFifoStdin", () => {
  it("opens the FIFO read-write on fd 3 and binds the inner's stdin to it", () => {
    const wired = withControlFifoStdin(
      "flutter run --debug -d 'X'",
      "/tmp/ctl.fifo"
    );
    // read-write fd (so the reader never sees EOF) + stdin redirect from it.
    expect(wired).toBe(
      "exec 3<>'/tmp/ctl.fifo'; flutter run --debug -d 'X' <&3"
    );
  });

  it("single-quotes a FIFO path so an odd path can't break the command", () => {
    const wired = withControlFifoStdin("flutter run", "/tmp/a b/c'.fifo");
    expect(wired).toContain("exec 3<>'/tmp/a b/c'\\''.fifo'");
    expect(wired.endsWith(" <&3")).toBe(true);
  });
});

describe("createControlFifoPath", () => {
  it("produces a unique .fifo path under the temp dir", () => {
    const p = createControlFifoPath();
    expect(p.endsWith(".fifo")).toBe(true);
    expect(p).toContain("flutter-device-mcp-control-");
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });
});

describe("makeControlFifo + sendControlChar (round-trip over a real FIFO)", () => {
  let fifoPath: string;

  beforeEach(() => {
    fifoPath = path.join(
      os.tmpdir(),
      `flutter-device-mcp-test-${process.pid}-${Math.random().toString(36).slice(2)}.fifo`
    );
  });

  afterEach(() => {
    removeControlFifo(fifoPath);
  });

  it("creates a FIFO on disk", () => {
    expect(makeControlFifo(fifoPath)).toBe(true);
    expect(fs.existsSync(fifoPath)).toBe(true);
    expect(fs.statSync(fifoPath).isFIFO()).toBe(true);
  });

  it("delivers `r`/`R` to a reader holding the FIFO open read-write", async () => {
    expect(makeControlFifo(fifoPath)).toBe(true);
    // Open the FIFO read-write ourselves (the exact trick the launch command
    // uses) so it has a persistent reader+writer and never hits EOF.
    const holder = fs.openSync(fifoPath, "r+");
    try {
      const okR = await sendControlChar(fifoPath, "r", 2000);
      const okRestart = await sendControlChar(fifoPath, "R", 2000);
      expect(okR).toBe(true);
      expect(okRestart).toBe(true);
      const buf = Buffer.alloc(16);
      const n = fs.readSync(holder, buf, 0, buf.length, null);
      expect(buf.toString("utf8", 0, n)).toBe("r\nR\n");
    } finally {
      fs.closeSync(holder);
    }
  });

  it("resolves false when the FIFO does not exist (dead daemon)", async () => {
    expect(await sendControlChar(fifoPath, "r", 500)).toBe(false);
  });
});
