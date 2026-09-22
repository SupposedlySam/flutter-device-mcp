import { jest } from "@jest/globals";

/**
 * The scroll branch of the SHARED command core — the layer between the tool
 * argument and the controller.
 *
 * Upstream this lives in a monolithic MCP handler; this repo splits it into
 * `src/core/commandCore.ts`, so the port landed there. Three things happen in
 * that one case block and nothing else in the suite constructs a CommandCore to
 * watch them: `duration_ms` reaches the controller as `durationMs`, `verify`
 * reaches it at all, and the outcome the controller returns is merged into the
 * response as `gesture`. The controller's own tests prove it can REPORT a
 * bounded gesture; only this file proves the report survives the trip out.
 *
 * A FAKE adapter is used rather than the real AndroidAdapter: what is under
 * test is the core's handling of an input controller that returns an outcome,
 * not how Android produces one.
 */
jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  recordLaunch: jest.fn(),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  findLaunch: jest.fn(() => undefined),
  readRecords: jest.fn(() => []),
}));
jest.unstable_mockModule("../src/marionetteProbe.js", () => ({
  probeMarionetteReady: jest.fn(async () => ({ marionetteReady: true })),
  MARIONETTE_ABSENT_HINT: "",
}));

const { CommandCore } = await import("../src/core/commandCore.js");
const { AdapterRegistry } = await import("../src/adapters/registry.js");

type AnyRecord = Record<string, unknown>;

/** What the fake controller was asked to scroll, and what it answers with. */
const OUTCOME = {
  requestedDy: 9000,
  appliedDy: 1600,
  clamped: true,
  from: { x: 720, y: 1600 },
  to: { x: 720, y: 0 },
  durationMs: 600,
  speedPxPerMs: 2.667,
  notes: ["Raising dy CANNOT scroll further"],
};

function fakeAdapter(scrollCalls: { dy: number; opts?: unknown }[]) {
  return {
    platform: "android",
    input() {
      return {
        platform: "android",
        mode: "pointer" as const,
        setMode() {},
        async key() {},
        async pointerMove() {},
        async pointerClick() {},
        async pointerScroll(dy: number, o?: unknown) {
          scrollCalls.push({ dy, opts: o });
          return OUTCOME;
        },
      };
    },
  };
}

function coreFor(adapter: ReturnType<typeof fakeAdapter>) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const registry = new AdapterRegistry([adapter as any], "android" as any);
  return new CommandCore(registry, {
    appDir: "/tmp/app",
    appDirSource: "flag",
    fvm: false,
    defaultPlatform: "android",
    defaultPlatformSource: "flag",
    platforms: {},
  } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe("flutter_pointer scroll through the command core", () => {
  it("hands duration_ms to the controller as durationMs, and verify through", async () => {
    const calls: { dy: number; opts?: unknown }[] = [];
    await coreFor(fakeAdapter(calls)).pointer({
      action: "scroll",
      dy: 9000,
      duration_ms: 600,
      verify: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].dy).toBe(9000);
    expect(calls[0].opts).toMatchObject({ durationMs: 600, verify: true });
  });

  it("reports the gesture the controller returned, not just sent:true", async () => {
    // The whole point of the port: `sent: true` alone cannot distinguish a
    // scroll that worked from one the screen's bounds truncated to a third of
    // what was asked for, and a caller who cannot tell reasonably concludes the
    // input plane is dead and goes looking in the wrong place.
    const result = (await coreFor(fakeAdapter([])).pointer({
      action: "scroll",
      dy: 9000,
    })) as AnyRecord;

    expect(result.sent).toBe(true);
    expect(result.gesture).toEqual(OUTCOME);
  });

  it("omits gesture entirely for a controller that reports nothing", async () => {
    // webOS scrolls by sending a frame and has nothing to report. An ABSENT
    // gesture must read as "no detail", never as "nothing happened", so the key
    // is left off rather than set to a falsy stand-in.
    const adapter = fakeAdapter([]);
    const input = adapter.input();
    jest
      .spyOn(adapter, "input")
      .mockReturnValue({ ...input, async pointerScroll() {} } as ReturnType<
        typeof adapter.input
      >);

    const result = (await coreFor(adapter).pointer({
      action: "scroll",
      dy: 400,
    })) as AnyRecord;

    expect(result.sent).toBe(true);
    expect(result).not.toHaveProperty("gesture");
  });
});
