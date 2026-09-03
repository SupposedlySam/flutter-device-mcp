import {
  appleScriptString,
  buildOsascriptActivateCommand,
  buildOsascriptQuitCommand,
  buildScreencaptureProbeCommand,
  buildScreencaptureWindowCommand,
  buildSystemEventsWindowBoundsCommand,
  parseSystemEventsWindowBounds,
  windowRelativeToAbsolute,
} from "../src/macosWindow.js";

describe("appleScriptString", () => {
  it("wraps in double quotes", () => {
    expect(appleScriptString("hello")).toBe('"hello"');
  });

  it("escapes embedded double quotes and backslashes", () => {
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""');
    expect(appleScriptString("a\\b")).toBe('"a\\\\b"');
  });
});

describe("buildSystemEventsWindowBoundsCommand", () => {
  it("targets the process by NAME (not display name) via System Events", () => {
    const cmd = buildSystemEventsWindowBoundsCommand("example-app");
    expect(cmd).toContain('tell process "example-app"');
    expect(cmd).toContain("get {position, size} of front window");
    expect(cmd.startsWith("osascript -e ")).toBe(true);
  });
});

describe("parseSystemEventsWindowBounds", () => {
  it("parses a reading of the shape a real device produced (100, 100, 1400, 900)", () => {
    expect(parseSystemEventsWindowBounds("100, 100, 1400, 900")).toEqual({
      x: 100,
      y: 100,
      width: 1400,
      height: 900,
    });
  });

  it("tolerates a trailing newline", () => {
    expect(parseSystemEventsWindowBounds("0, 0, 800, 600\n")).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("rejects zero/negative width or height (a half-read bounds is worse than none)", () => {
    expect(parseSystemEventsWindowBounds("0, 0, 0, 600")).toBeUndefined();
    expect(parseSystemEventsWindowBounds("0, 0, 800, -1")).toBeUndefined();
  });

  it("returns undefined for anything that doesn't parse as four integers", () => {
    expect(parseSystemEventsWindowBounds("")).toBeUndefined();
    expect(
      parseSystemEventsWindowBounds("error: Application isn't running")
    ).toBeUndefined();
  });
});

describe("windowRelativeToAbsolute", () => {
  const bounds = { x: 100, y: 100, width: 1400, height: 900 };

  it("translates a window-relative point by the window's origin", () => {
    expect(windowRelativeToAbsolute(bounds, 0, 0)).toEqual({ x: 100, y: 100 });
    expect(windowRelativeToAbsolute(bounds, 50, 60)).toEqual({ x: 150, y: 160 });
  });

  it("reproduces the translation an on-device click was predicted from", () => {
    // A predicted point-space target (914.9, 243.6 rounded to 915, 244) against
    // a window at (100,100). The upstream commit verified on a live signed app
    // that the resulting absolute point landed exactly where predicted; this
    // test pins the ARITHMETIC that produced it, not the on-device landing.
    expect(windowRelativeToAbsolute(bounds, 915, 244)).toEqual({ x: 1015, y: 344 });
  });
});

describe("buildScreencaptureWindowCommand", () => {
  it("captures a rect at the window's bounds, silencing the shutter sound", () => {
    const cmd = buildScreencaptureWindowCommand(
      { x: 100, y: 100, width: 1400, height: 900 },
      "/tmp/out.png"
    );
    expect(cmd).toBe("/usr/sbin/screencapture -x -R100,100,1400,900 '/tmp/out.png'");
  });

  it("rounds fractional bounds", () => {
    const cmd = buildScreencaptureWindowCommand(
      { x: 100.4, y: 100.6, width: 1400.2, height: 900.9 },
      "/tmp/out.png"
    );
    expect(cmd).toBe("/usr/sbin/screencapture -x -R100,101,1400,901 '/tmp/out.png'");
  });
});

describe("buildScreencaptureProbeCommand", () => {
  it("captures a small square at the given origin", () => {
    expect(buildScreencaptureProbeCommand(0, 0, 40, "/tmp/probe.png", false)).toBe(
      "/usr/sbin/screencapture -x -R0,0,40,40 '/tmp/probe.png'"
    );
  });

  it("adds -C to capture the cursor when requested", () => {
    expect(buildScreencaptureProbeCommand(0, 0, 40, "/tmp/probe.png", true)).toBe(
      "/usr/sbin/screencapture -x -C -R0,0,40,40 '/tmp/probe.png'"
    );
  });
});

describe("osascript activate/quit by bundle id", () => {
  it("buildOsascriptActivateCommand targets by bundle id", () => {
    const cmd = buildOsascriptActivateCommand("com.example.exampleapp");
    expect(cmd).toContain('tell application id "com.example.exampleapp" to activate');
  });

  it("buildOsascriptQuitCommand targets by bundle id", () => {
    const cmd = buildOsascriptQuitCommand("com.example.exampleapp");
    expect(cmd).toContain('tell application id "com.example.exampleapp" to quit');
  });
});
