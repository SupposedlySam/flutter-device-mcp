import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  mapUnsupportedInput,
  resolvePlatform,
  resolvePointerTarget,
  resolveScrollDelta,
  summarizeKillStale,
} from "../src/handlerLogic.js";
import { logicalToDevicePx } from "../src/input/dpr.js";
import { UnsupportedInputError } from "../src/types.js";
import { routeTool } from "../src/toolRouting.js";

describe("resolvePlatform", () => {
  it("honors the caller arg for a flutter_* tool", () => {
    expect(
      resolvePlatform(routeTool("flutter_deploy")!, { platform: "webos" })
    ).toBe("webos");
  });

  it("returns undefined (registry default) when the arg is omitted", () => {
    expect(resolvePlatform(routeTool("flutter_info")!, {})).toBeUndefined();
  });
});

describe("resolvePointerTarget", () => {
  it("defaults coordinateSpace to device and passes coordinates through", () => {
    expect(resolvePointerTarget({ x: 100, y: 200 })).toEqual({
      point: { x: 100, y: 200 },
      coordinateSpace: "device",
    });
  });

  it("keeps an explicit device space unchanged", () => {
    expect(
      resolvePointerTarget({ x: 5, y: 6, coordinateSpace: "device" })
    ).toEqual({ point: { x: 5, y: 6 }, coordinateSpace: "device" });
  });

  it("converts logical coordinates via the DPR helper", () => {
    const result = resolvePointerTarget({
      x: 1200,
      y: 675,
      coordinateSpace: "logical",
      dpr: 1.6,
    });
    expect(result.coordinateSpace).toBe("logical");
    expect(result.point).toEqual(logicalToDevicePx({ x: 1200, y: 675 }, 1.6));
    expect(result.point).toEqual({ x: 1920, y: 1080 });
  });

  it("throws InvalidParams for logical without dpr", () => {
    try {
      resolvePointerTarget({ x: 1, y: 2, coordinateSpace: "logical" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((e as McpError).message).toMatch(/dpr/);
    }
  });

  it("throws InvalidParams when x/y are not numeric", () => {
    expect(() => resolvePointerTarget({ x: 1 })).toThrow(McpError);
    expect(() => resolvePointerTarget({})).toThrow(/numeric x and y/);
  });
});

describe("resolveScrollDelta", () => {
  it("defaults to device and passes dy through", () => {
    expect(resolveScrollDelta({ dy: 40 })).toEqual({
      dy: 40,
      coordinateSpace: "device",
    });
  });

  it("converts a logical dy via the DPR helper", () => {
    const result = resolveScrollDelta({
      dy: 100,
      coordinateSpace: "logical",
      dpr: 2,
    });
    expect(result).toEqual({ dy: 200, coordinateSpace: "logical" });
  });

  it("throws InvalidParams for logical without dpr", () => {
    expect(() =>
      resolveScrollDelta({ dy: 10, coordinateSpace: "logical" })
    ).toThrow(/dpr/);
  });

  it("throws InvalidParams when dy is not numeric", () => {
    expect(() => resolveScrollDelta({})).toThrow(/numeric dy/);
  });
});

describe("mapUnsupportedInput", () => {
  it("maps an UnsupportedInputError to a clean supported:false payload carrying the action", () => {
    const payload = mapUnsupportedInput(
      new UnsupportedInputError("free cursor has no effect on Tizen"),
      "tizen",
      "move"
    );
    expect(payload).toEqual({
      platform: "tizen",
      action: "move",
      sent: false,
      supported: false,
      reason: "free cursor has no effect on Tizen",
    });
  });

  it("reflects the real action (key/click) rather than a hardcoded verb", () => {
    expect(
      mapUnsupportedInput(new UnsupportedInputError("no key channel on iOS"), "ios", "key")
    ).toMatchObject({ platform: "ios", action: "key", supported: false });
    expect(
      mapUnsupportedInput(new UnsupportedInputError("no click on iOS"), "ios", "click")
    ).toMatchObject({ action: "click", supported: false });
  });

  it("returns undefined for any other error so the caller rethrows", () => {
    expect(mapUnsupportedInput(new Error("boom"), "tizen", "move")).toBeUndefined();
    expect(mapUnsupportedInput("nope", "tizen", "click")).toBeUndefined();
  });
});

describe("summarizeKillStale", () => {
  const ok = (): import("../src/types.js").CommandResult => ({
    code: 0,
    stdout: "",
    stderr: "",
    combined: "",
    success: true,
    timedOut: false,
  });
  const nothingMatched = (): import("../src/types.js").CommandResult => ({
    code: 1,
    stdout: "",
    stderr: "",
    combined: "",
    success: false,
    timedOut: false,
  });

  it("reports iOS keys (flutterRun/frontendServer) as killed when pkill exited 0", () => {
    const summary = summarizeKillStale({
      flutterRun: ok(),
      frontendServer: ok(),
    });
    expect(summary).toEqual({
      flutterRunKilled: true,
      frontendServerKilled: true,
      detail: { flutterRunExit: 0, frontendServerExit: 0 },
    });
  });

  it("preserves the Tizen field contract (flutterTizenKilled only)", () => {
    const summary = summarizeKillStale({
      flutterTizen: nothingMatched(),
    });
    expect(summary).toEqual({
      flutterTizenKilled: false,
      detail: { flutterTizenExit: 1 },
    });
  });

  it("marks a key not-killed when nothing matched (pkill exit 1)", () => {
    const summary = summarizeKillStale({ flutterRun: nothingMatched() });
    expect(summary).toMatchObject({
      flutterRunKilled: false,
      detail: { flutterRunExit: 1 },
    });
  });
});
