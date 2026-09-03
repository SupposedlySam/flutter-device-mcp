import {
  buildCliclickClickAtCurrentCommand,
  buildCliclickDoubleClickAtCurrentCommand,
  buildCliclickKeyCommand,
  buildCliclickMoveCommand,
  buildCliclickPositionCommand,
  buildCliclickRelativeMoveCommand,
  buildCliclickTextCommand,
  CLICLICK_VALID_KP_KEYS,
  MACOS_KEY_MAP,
  normalizeMacosKey,
  parseCliclickPosition,
} from "../src/cliclickCommands.js";

const BIN = "/opt/homebrew/bin/cliclick";

describe("cliclick command builders", () => {
  it("buildCliclickPositionCommand shells `p:`", () => {
    expect(buildCliclickPositionCommand(BIN)).toBe(`'${BIN}' p:`);
  });

  it("buildCliclickMoveCommand rounds and shells an absolute `m:x,y`", () => {
    expect(buildCliclickMoveCommand(BIN, 100.4, 200.6)).toBe(`'${BIN}' m:100,201`);
  });

  it("buildCliclickRelativeMoveCommand formats a signed relative offset", () => {
    expect(buildCliclickRelativeMoveCommand(BIN, 3, 3)).toBe(`'${BIN}' m:+3,+3`);
    expect(buildCliclickRelativeMoveCommand(BIN, -3, -3)).toBe(`'${BIN}' m:-3,-3`);
    expect(buildCliclickRelativeMoveCommand(BIN, 0, 0)).toBe(`'${BIN}' m:+0,+0`);
  });

  it("buildCliclickClickAtCurrentCommand shells `c:.`", () => {
    expect(buildCliclickClickAtCurrentCommand(BIN)).toBe(`'${BIN}' c:.`);
  });

  it("buildCliclickDoubleClickAtCurrentCommand shells `dc:.`", () => {
    expect(buildCliclickDoubleClickAtCurrentCommand(BIN)).toBe(`'${BIN}' dc:.`);
  });

  it("buildCliclickTextCommand quotes the whole `t:<text>` token together", () => {
    const cmd = buildCliclickTextCommand(BIN, "hello world");
    expect(cmd).toBe(`'${BIN}' 't:hello world'`);
  });

  it("buildCliclickKeyCommand shells `kp:<token>`", () => {
    expect(buildCliclickKeyCommand(BIN, "arrow-up")).toBe(`'${BIN}' kp:arrow-up`);
  });
});

describe("parseCliclickPosition", () => {
  it("parses cliclick's `p:` output", () => {
    expect(parseCliclickPosition("123, 456")).toEqual({ x: 123, y: 456 });
  });

  it("tolerates trailing whitespace/newline", () => {
    expect(parseCliclickPosition("20,20\n")).toEqual({ x: 20, y: 20 });
  });

  it("returns undefined for unparseable output", () => {
    expect(parseCliclickPosition("")).toBeUndefined();
    expect(parseCliclickPosition("not a position")).toBeUndefined();
  });
});

describe("normalizeMacosKey", () => {
  it("maps every short name (case-insensitively) to its cliclick token", () => {
    for (const [short, token] of Object.entries(MACOS_KEY_MAP)) {
      expect(normalizeMacosKey(short)).toBe(token);
      expect(normalizeMacosKey(short.toLowerCase())).toBe(token);
    }
  });

  it("passes a cliclick-native token straight through, case-insensitively", () => {
    expect(normalizeMacosKey("f1")).toBe("f1");
    expect(normalizeMacosKey("F1")).toBe("f1");
    expect(normalizeMacosKey("volume-up")).toBe("volume-up");
  });

  it("throws on an unknown key rather than passing it through unchecked", () => {
    expect(() => normalizeMacosKey("not-a-real-key")).toThrow(/Unknown macOS key/);
  });

  it("CLICLICK_VALID_KP_KEYS is non-empty and lowercase", () => {
    expect(CLICLICK_VALID_KP_KEYS.size).toBeGreaterThan(0);
    for (const key of CLICLICK_VALID_KP_KEYS) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
