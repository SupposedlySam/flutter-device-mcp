import os from "os";
import {
  buildAdbScreencapCommand,
  buildPymobiledevice3ScreenshotCommand,
  buildSimctlScreenshotCommand,
  defaultScreenshotPath,
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
