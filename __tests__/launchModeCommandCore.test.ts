import { jest } from "@jest/globals";

/**
 * How the SHARED deploy core reports a non-debug launch.
 *
 * The upstream commit placed these branches in its monolithic MCP handler; here
 * the deploy response is built in `src/core/commandCore.ts`, so that is where
 * they landed and what this file drives. A FAKE adapter stands in: what is under
 * test is the core's reporting GIVEN an adapter that says which mode it launched
 * and why there is (or is not) a URI — not how iOS produces those fields.
 */
jest.unstable_mockModule("../src/launchRegistry.js", () => ({
  recordLaunch: jest.fn(),
  clearLaunch: jest.fn(),
  clearLaunches: jest.fn(),
  findLaunch: jest.fn(() => undefined),
  resolveLaunch: jest.fn(() => ({ kind: "none" })),
  readRecords: jest.fn(() => []),
}));

const PROBE_ABSENT_HINT = "marionette extension absent";
const probeMarionetteReady = jest.fn(async () => ({
  marionetteReady: false as boolean | null,
  marionetteHint: PROBE_ABSENT_HINT,
}));
jest.unstable_mockModule("../src/marionetteProbe.js", () => ({
  probeMarionetteReady,
  MARIONETTE_ABSENT_HINT: PROBE_ABSENT_HINT,
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

function fakeIosAdapter(outcome: AnyRecord) {
  const launchModes: unknown[] = [];
  const adapter = {
    platform: "ios",
    appId: "com.example.app",
    killStaleScope: "platform" as const,
    launchModes,
    async discoverDevice() {
      return { target: "SIM-UDID-1", source: "pin" as const };
    },
    async install() {
      return okResult;
    },
    async launchAndCaptureUri(_device: string, _timeout: number, mode?: unknown) {
      launchModes.push(mode);
      return { logPath: "/tmp/l.log", pid: 1, ...outcome };
    },
    async killStale() {
      return {};
    },
  };
  return adapter;
}

function coreFor(adapter: ReturnType<typeof fakeIosAdapter>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new AdapterRegistry([adapter as any], "ios" as any);
  return new CommandCore(registry, {
    appDir: "/tmp/app",
    appDirSource: "flag",
    fvm: false,
    defaultPlatform: "ios",
    defaultPlatformSource: "flag",
    platforms: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => probeMarionetteReady.mockClear());

describe("deploy of a PROFILE launch (real URI, no Marionette)", () => {
  const CAVEAT = "Launched --profile: … kDebugMode …";
  const profileOutcome = {
    vmServiceUriWs: "ws://127.0.0.1:1/tok=/ws",
    vmServiceUriHttp: "http://127.0.0.1:1/tok=/",
    launchMode: "profile",
    launchModeCaveat: CAVEAT,
  };

  it("hands the caller's mode to the adapter's launch", async () => {
    const adapter = fakeIosAdapter(profileOutcome);
    await coreFor(adapter).deploy({ mode: "profile" });
    expect(adapter.launchModes).toEqual(["profile"]);
  });

  it("reports the launched mode and carries the caveat into the Marionette hint", async () => {
    const result = (await coreFor(fakeIosAdapter(profileOutcome)).deploy(
      {}
    )) as AnyRecord;
    expect(result.vmServiceUriWs).toBe("ws://127.0.0.1:1/tok=/ws");
    expect(result.launchMode).toBe("profile");
    expect(result.launchModeCaveat).toBe(CAVEAT);
    // The probe's bare "absent" alone would send the caller hunting for a broken
    // URI; the caveat names the missing half.
    expect(result.marionetteHint).toBe(`${PROBE_ABSENT_HINT} ${CAVEAT}`);
  });

  it("does not blame the host for the control channel a cold run never gets", async () => {
    const result = (await coreFor(fakeIosAdapter(profileOutcome)).deploy(
      {}
    )) as AnyRecord;
    expect(result.controlChannelWarning).toBeUndefined();
  });

  it("still warns about a missing control channel on a DEBUG launch", async () => {
    const result = (await coreFor(
      fakeIosAdapter({
        vmServiceUriWs: "ws://127.0.0.1:1/tok=/ws",
        vmServiceUriHttp: "http://127.0.0.1:1/tok=/",
        launchMode: "debug",
      })
    ).deploy({})) as AnyRecord;
    expect(result.controlChannelWarning).toBeDefined();
    expect(result.marionetteHint).toBe(PROBE_ABSENT_HINT);
  });
});

describe("deploy of a launch with an EXPLAINED empty URI (release / settled)", () => {
  const REASON = "No Dart VM service URI: this launch is --release …";
  const releaseOutcome = {
    vmServiceUriWs: "",
    vmServiceUriHttp: "",
    launchMode: "release",
    launchModeCaveat: "Launched --release …",
    noVmServiceReason: REASON,
  };

  it("answers marionetteReady:false with the adapter's reason, not the macOS null", async () => {
    const result = (await coreFor(fakeIosAdapter(releaseOutcome)).deploy(
      {}
    )) as AnyRecord;
    expect(result.success).toBe(true);
    expect(probeMarionetteReady).not.toHaveBeenCalled();
    expect(result.marionetteReady).toBe(false);
    expect(result.marionetteHint).toBe(REASON);
    expect(result.noVmServiceReason).toBe(REASON);
    expect(result.launchMode).toBe("release");
  });
});
