import os from "os";
import {
  buildAdbScreencapCommand,
  buildPymobiledevice3ScreenshotCommand,
  buildSimctlScreenshotCommand,
  defaultScreenshotPath,
  readPngDimensions,
} from "../src/screenshot.js";

describe("buildSimctlScreenshotCommand", () => {
  it("builds `xcrun simctl io <udid> screenshot <path>` with quoting", () => {
    expect(
      buildSimctlScreenshotCommand("AAAA-1111", "/tmp/out.png")
    ).toBe("xcrun simctl io 'AAAA-1111' screenshot '/tmp/out.png'");
  });

  it("safely quotes a path with spaces", () => {
    expect(
      buildSimctlScreenshotCommand("u", "/tmp/my shots/a.png")
    ).toContain("screenshot '/tmp/my shots/a.png'");
  });
});

describe("buildPymobiledevice3ScreenshotCommand", () => {
  it("builds `<bin> developer dvt screenshot <path>` with the binary + path quoted", () => {
    expect(
      buildPymobiledevice3ScreenshotCommand(
        "/opt/homebrew/bin/pymobiledevice3",
        "/tmp/out.png"
      )
    ).toBe(
      "'/opt/homebrew/bin/pymobiledevice3' developer dvt screenshot '/tmp/out.png'"
    );
  });

  it("appends a quoted --udid when a device udid is given (multi-device targeting)", () => {
    expect(
      buildPymobiledevice3ScreenshotCommand(
        "pymobiledevice3",
        "/tmp/out.png",
        "00008020-001A2D021AF3002E"
      )
    ).toBe(
      "'pymobiledevice3' developer dvt screenshot '/tmp/out.png' --udid '00008020-001A2D021AF3002E'"
    );
  });

  it("omits --udid entirely when no udid is given (single-device assumption)", () => {
    expect(
      buildPymobiledevice3ScreenshotCommand("pymobiledevice3", "/tmp/out.png")
    ).not.toContain("--udid");
  });

  it("safely quotes a path with spaces", () => {
    expect(
      buildPymobiledevice3ScreenshotCommand("pymobiledevice3", "/tmp/my shots/a.png")
    ).toContain("screenshot '/tmp/my shots/a.png'");
  });
});

describe("buildAdbScreencapCommand", () => {
  it("uses exec-out (not shell) and redirects the raw PNG to the quoted path", () => {
    expect(
      buildAdbScreencapCommand("emulator-5554", "/tmp/a.png")
    ).toBe("adb -s 'emulator-5554' exec-out screencap -p > '/tmp/a.png'");
  });
});

describe("defaultScreenshotPath", () => {
  it("produces a unique .png path under the temp dir, tagged by platform", () => {
    const p = defaultScreenshotPath("ios");
    expect(p.endsWith(".png")).toBe(true);
    expect(p).toContain("flutter-device-mcp-screenshot-ios-");
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });
});

describe("readPngDimensions", () => {
  /** A PNG signature + IHDR declaring `width`x`height` (no pixel data needed). */
  function pngHeader(width: number, height: number): Buffer {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
  }

  it("reads the IHDR width/height, which identify WHICH device answered a capture", () => {
    // An iPhone XR vs a booted iPhone 15 simulator — the live wrong-device pair.
    expect(readPngDimensions(pngHeader(828, 1792))).toEqual({
      width: 828,
      height: 1792,
    });
    expect(readPngDimensions(pngHeader(1179, 2556))).toEqual({
      width: 1179,
      height: 2556,
    });
  });

  it("accepts a Uint8Array as well as a Buffer", () => {
    expect(readPngDimensions(new Uint8Array(pngHeader(10, 20)))).toEqual({
      width: 10,
      height: 20,
    });
  });

  it("returns undefined for bytes that are not a PNG (a tool that wrote an error page)", () => {
    expect(readPngDimensions(Buffer.from("not a png at all, but long enough"))).toBeUndefined();
  });

  it("returns undefined for a truncated PNG rather than guessing", () => {
    expect(
      readPngDimensions(pngHeader(828, 1792).subarray(0, 16))
    ).toBeUndefined();
  });

  it("returns undefined when the first chunk is not IHDR", () => {
    const wrong = pngHeader(828, 1792);
    wrong.write("IDAT", 12, "ascii");
    expect(readPngDimensions(wrong)).toBeUndefined();
  });

  it("returns undefined for a zero dimension (a degenerate header is not a size)", () => {
    expect(readPngDimensions(pngHeader(0, 1792))).toBeUndefined();
  });
});
