import {
  MARIONETTE_ABSENT_HINT,
  MarionetteProbeClient,
  probeMarionetteReady,
} from "../src/marionetteProbe.js";
import {
  extensionRpcsFromIsolate,
  hasMarionetteExtension,
} from "../src/vmServiceClient.js";

// =========== PURE HELPERS ==========

describe("extensionRpcsFromIsolate", () => {
  it("extracts extensionRPCs from a getIsolate result", () => {
    expect(
      extensionRpcsFromIsolate({
        extensionRPCs: ["ext.flutter.reassemble", "ext.flutter.marionette.getLogs"],
      })
    ).toEqual(["ext.flutter.reassemble", "ext.flutter.marionette.getLogs"]);
  });

  it("degrades a malformed/absent field to []", () => {
    expect(extensionRpcsFromIsolate({})).toEqual([]);
    expect(extensionRpcsFromIsolate(null)).toEqual([]);
    expect(extensionRpcsFromIsolate({ extensionRPCs: "nope" })).toEqual([]);
  });
});

describe("hasMarionetteExtension", () => {
  it("is true when any ext.flutter.marionette.* rpc is present", () => {
    expect(
      hasMarionetteExtension([
        "ext.flutter.reassemble",
        "ext.flutter.marionette.tap",
      ])
    ).toBe(true);
  });

  it("is false when no marionette rpc is present", () => {
    expect(hasMarionetteExtension(["ext.flutter.reassemble"])).toBe(false);
    expect(hasMarionetteExtension([])).toBe(false);
  });
});

// =========== PROBE (fake client — never dials out) ==========

/** A scriptable probe client that records whether it was closed. */
class FakeProbeClient implements MarionetteProbeClient {
  closed = false;
  isolateIdsCalls = 0;
  private readonly perAttempt: string[][];
  private readonly ids: string[];

  /**
   * @param perAttempt extensionRPCs returned per isolate-inspection attempt, in
   *   order. Each entry is one `isolateExtensionRpcs` reply.
   */
  constructor(perAttempt: string[][], ids: string[] = ["iso-1"]) {
    this.perAttempt = perAttempt;
    this.ids = ids;
  }
  private attempt = 0;
  async isolateIds(): Promise<string[]> {
    this.isolateIdsCalls++;
    return this.ids;
  }
  async isolateExtensionRpcs(): Promise<string[]> {
    const rpcs = this.perAttempt[this.attempt] ?? [];
    this.attempt++;
    return rpcs;
  }
  close(): void {
    this.closed = true;
  }
}

const noSleep = async (): Promise<void> => {};

describe("probeMarionetteReady", () => {
  it("reports ready when the marionette extension is present", async () => {
    const client = new FakeProbeClient([
      ["ext.flutter.reassemble", "ext.flutter.marionette.getLogs"],
    ]);
    const result = await probeMarionetteReady(client, { sleep: noSleep });
    expect(result).toEqual({ marionetteReady: true });
    expect(client.closed).toBe(true);
  });

  it("reports NOT ready + hint when the extension never registers", async () => {
    // Every attempt returns non-marionette extensions only.
    const client = new FakeProbeClient([
      ["ext.flutter.reassemble"],
      ["ext.flutter.reassemble"],
      ["ext.flutter.reassemble"],
    ]);
    // A tiny budget with a real-ish clock so the poll ends deterministically.
    let t = 0;
    const result = await probeMarionetteReady(client, {
      totalTimeoutMs: 30,
      intervalMs: 10,
      sleep: noSleep,
      now: () => (t += 10),
    });
    expect(result.marionetteReady).toBe(false);
    expect(result.marionetteHint).toBe(MARIONETTE_ABSENT_HINT);
    expect(client.closed).toBe(true);
  });

  it("polls: absent on the first attempt, present on a later one", async () => {
    const client = new FakeProbeClient([
      ["ext.flutter.reassemble"], // attempt 1 — not yet
      ["ext.flutter.marionette.tap"], // attempt 2 — registered
    ]);
    let t = 0;
    const result = await probeMarionetteReady(client, {
      totalTimeoutMs: 100,
      intervalMs: 10,
      sleep: noSleep,
      now: () => (t += 10),
    });
    expect(result).toEqual({ marionetteReady: true });
    expect(client.isolateIdsCalls).toBeGreaterThanOrEqual(2);
  });

  it("returns unknown (null) — not a throw — when the client errors", async () => {
    let closed = false;
    const client: MarionetteProbeClient = {
      isolateIds: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      isolateExtensionRpcs: async () => [],
      close: () => {
        closed = true;
      },
    };
    const result = await probeMarionetteReady(client, { sleep: noSleep });
    expect(result.marionetteReady).toBeNull();
    expect(result.marionetteHint).toMatch(/unknown/i);
    expect(result.marionetteHint).toMatch(/connect ECONNREFUSED/);
    expect(closed).toBe(true);
  });

  it("always closes the client, even when ready", async () => {
    const client = new FakeProbeClient([["ext.flutter.marionette.getLogs"]]);
    await probeMarionetteReady(client, { sleep: noSleep });
    expect(client.closed).toBe(true);
  });
});
