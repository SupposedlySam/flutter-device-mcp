import { jest } from "@jest/globals";

/**
 * What a hot RESTART is allowed to CLAIM.
 *
 * Three states have to stay distinguishable in `flutter_hot_restart`'s payload,
 * and a test that only checks "a result came back" passes for all three:
 *
 *   confirmed   (`confirmed === true`)  — flutter was seen to act on the `R`
 *   contradicted(`confirmed === false`) — the window passed with no ack
 *   unwatched   (`confirmed === undefined`) — there was no launch log to watch
 *
 * The defect this pins is the third one reading as the first: the write landing
 * on the FIFO is not the restart happening, so an unwatched restart must say
 * UNVERIFIED rather than assert that main() re-ran. It must still be a success
 * (no evidence is not evidence of failure, and there is no VM-service restart to
 * fall back to), which is why the confirmed case is asserted alongside it —
 * otherwise the honest qualifier would be indistinguishable from a regression.
 *
 * This goes one step BEYOND the upstream source, which qualifies an unconfirmed
 * hot reload but not an unconfirmed hot restart. See the commit message.
 *
 * `src/core/commandCore.ts` is this repo's home for logic the source tree keeps
 * in its monolithic MCP handler, so the assertions are against `CommandCore`
 * with a FAKE adapter: what is under test is what the core reports, not how any
 * platform drives a pty.
 */
const findLaunch = jest.fn<(...a: unknown[]) => unknown>(() => undefined);
jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  recordLaunch: jest.fn(),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  findLaunch,
  readRecords: jest.fn(() => []),
}));

// The write to the FIFO always succeeds here: every case below is about what is
// reported AFTER the bytes land, which is precisely the fact `triggered` covers
// and `confirmed` does not.
const sendControlChar = jest.fn(() => true);
jest.unstable_mockModule("../src/ptyControl.js", () => ({
  sendControlChar,
  removeControlFifo: jest.fn(),
  createControlFifoPath: jest.fn(() => "/tmp/fifo"),
  makeControlFifo: jest.fn(() => true),
}));

const confirmHotAction = jest.fn<() => Promise<boolean>>(async () => true);
jest.unstable_mockModule("../src/hotConfirm.js", () => ({
  confirmHotAction,
  logSize: jest.fn(async () => 0),
  ackPatternFor: jest.fn(() => /x/),
}));

jest.unstable_mockModule("../src/marionetteProbe.js", () => ({
  probeMarionetteReady: jest.fn(async () => ({ marionetteReady: true })),
  MARIONETTE_ABSENT_HINT: "",
}));

const { CommandCore } = await import("../src/core/commandCore.js");
const { AdapterRegistry } = await import("../src/adapters/registry.js");

type AnyRecord = Record<string, unknown>;

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

/** The minimum adapter surface `hotRestart` touches: a platform and a name. */
function fakeAdapter(platform = "ios") {
  return {
    platform,
    appId: "com.example.exampleapp",
    async info() {
      return okResult;
    },
    async setup() {
      return { result: okResult };
    },
    async discoverDevice() {
      return { target: "device-1", source: "pin" as const };
    },
    async killStale() {
      return {};
    },
  };
}

function core(platform = "ios") {
  const adapter = fakeAdapter(platform);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new AdapterRegistry([adapter as any], platform as any);
  return new CommandCore(registry, {
    appDir: "/tmp/app",
    appDirSource: "flag",
    fvm: false,
    defaultPlatform: platform,
    defaultPlatformSource: "flag",
    platforms: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * A recorded launch with a live control channel. `logPath` is what decides
 * whether anything CAN watch: the registry marks it optional and validates a
 * record without it, so a record written before the field existed reaches the
 * restart path with a channel and nothing to confirm against.
 */
function launchRecord(opts: { logPath?: string } = {}) {
  return {
    platform: "ios",
    device: "device-1",
    vmServiceUriWs: "ws://127.0.0.1:1/ws",
    controlFifoPath: "/tmp/fifo",
    recordedAt: Date.now(),
    ...(opts.logPath === undefined ? {} : { logPath: opts.logPath }),
  };
}

beforeEach(() => {
  findLaunch.mockReset();
  sendControlChar.mockReset().mockReturnValue(true);
  confirmHotAction.mockReset().mockResolvedValue(true);
});

describe("hot restart: an unwatched restart must not read as a performed one", () => {
  it("CONFIRMED — success, confirmed:true, and the note says it was seen", async () => {
    findLaunch.mockReturnValue(launchRecord({ logPath: "/tmp/launch.log" }));
    confirmHotAction.mockResolvedValue(true);

    const result = (await core().hotRestart({})) as AnyRecord;

    expect(result.success).toBe(true);
    expect(result.triggered).toBe(true);
    expect(result.confirmed).toBe(true);
    const note = String(result.note);
    expect(note).toMatch(/SAW the flutter tool acknowledge it/);
    // A confirmed restart may assert the effect; only an unwatched one may not.
    expect(note).toMatch(/re-runs main\(\)/);
    expect(note).not.toMatch(/NOT CONFIRMED|UNVERIFIED/);
  });

  it("UNWATCHED — still a success, but confirmed is undefined, not true", async () => {
    findLaunch.mockReturnValue(launchRecord()); // no logPath: nothing to watch

    const result = (await core().hotRestart({})) as AnyRecord;

    expect(result.success).toBe(true);
    expect(result.triggered).toBe(true);
    // The whole point: absent, NOT true. `toBeFalsy` would also accept `false`,
    // which is the contradicted state and a different answer.
    expect(result.confirmed).toBeUndefined();
    expect("confirmed" in result ? result.confirmed : undefined).toBeUndefined();
    // Nobody was asked, because there was nothing to ask.
    expect(confirmHotAction).not.toHaveBeenCalled();
  });

  it("UNWATCHED — the note says UNVERIFIED instead of asserting the restart", async () => {
    findLaunch.mockReturnValue(launchRecord());

    const result = (await core().hotRestart({})) as AnyRecord;
    const note = String(result.note);

    expect(note).toMatch(/NOT CONFIRMED/);
    expect(note).toMatch(/UNVERIFIED/);
    expect(note).toMatch(/no launch log to watch/);
    // It must not tell the caller, flatly, that main() re-ran and state was
    // dropped — that is the sentence nobody watched.
    expect(note).not.toMatch(/SAW the flutter tool/);
    expect(note).toMatch(/do not assume main\(\) re-ran/);
  });

  it("CONTRADICTED — a watched restart that was never acknowledged still fails", async () => {
    findLaunch.mockReturnValue(launchRecord({ logPath: "/tmp/launch.log" }));
    confirmHotAction.mockResolvedValue(false);

    const result = (await core().hotRestart({})) as AnyRecord;

    expect(result.success).toBe(false);
    expect(result.triggered).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(String(result.reason)).toMatch(/never acknowledged/);
  });

  it("the three states are pairwise distinguishable on `confirmed` alone", async () => {
    findLaunch.mockReturnValue(launchRecord({ logPath: "/tmp/launch.log" }));
    confirmHotAction.mockResolvedValue(true);
    const confirmed = (await core().hotRestart({})) as AnyRecord;

    confirmHotAction.mockResolvedValue(false);
    const contradicted = (await core().hotRestart({})) as AnyRecord;

    findLaunch.mockReturnValue(launchRecord());
    const unwatched = (await core().hotRestart({})) as AnyRecord;

    expect([
      confirmed.confirmed,
      contradicted.confirmed,
      unwatched.confirmed,
    ]).toEqual([true, false, undefined]);
    // ...and the success flag alone is NOT enough to tell them apart, which is
    // why `confirmed` has to be on the payload at all.
    expect([confirmed.success, unwatched.success]).toEqual([true, true]);
  });
});
