import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runDeployCore, type DeployAdapter } from "../src/deployFlow.js";
import { tearDownForDeploy } from "../src/killStaleFlow.js";
import { RequestedDeviceUnavailableError } from "../src/deviceRequest.js";
import type { CommandResult, DeviceResolution, LaunchOutcome } from "../src/types.js";

// The deploy's recovery and teardown decisions, against a fake adapter that
// records what it was asked to do. A real adapter's own behaviour is covered in
// the per-platform suites; these pin what runDeployCore itself enforces, so an
// adapter written later cannot opt out of it.

const result = (combined: string, success = true): CommandResult => ({
  code: success ? 0 : 1,
  stdout: combined,
  stderr: "",
  combined,
  success,
  timedOut: false,
});
const LAUNCHED: LaunchOutcome = {
  vmServiceUriWs: "ws://127.0.0.1:1/a=/ws",
  vmServiceUriHttp: "http://127.0.0.1:1/a=/",
  pid: 1,
  logPath: "/tmp/l.log",
};
const FAILED: LaunchOutcome = {
  failed: true,
  reason: "launch failed",
  pid: 1,
  logPath: "/tmp/l.log",
  logTail: "out of space on the device",
};

function fake(opts: {
  resolution?: DeviceResolution;
  install?: CommandResult[];
  launches?: LaunchOutcome[];
  recovery?: unknown;
  verifier?: boolean;
  uninstallResult?: CommandResult;
  isInstallFailure?: (c: string) => boolean;
  scope?: "device" | "platform";
  discover?: () => Promise<DeviceResolution>;
}) {
  const calls: string[] = [];
  const uninstalls: [string, string][] = [];
  const installs = [...(opts.install ?? [result("ok")])];
  const launches = [...(opts.launches ?? [LAUNCHED])];
  const adapter = {
    platform: "android",
    appId: "com.example.app",
    killStaleScope: opts.scope ?? "device",
    async killStale() {
      calls.push("killStale");
      return {};
    },
    async discoverDevice() {
      calls.push("discoverDevice");
      if (opts.discover) return opts.discover();
      return opts.resolution ?? { target: "dev-1", source: "pin" };
    },
    async install() {
      calls.push("install");
      return installs.shift() ?? result("ok");
    },
    ...(opts.isInstallFailure ? { isInstallFailure: opts.isInstallFailure } : {}),
    async uninstall(device: string, appId: string) {
      uninstalls.push([device, appId]);
      return opts.uninstallResult ?? result("Success");
    },
    async launchAndCaptureUri() {
      calls.push("launch");
      return launches.shift() ?? LAUNCHED;
    },
    ...(opts.recovery !== undefined
      ? { recoverLaunchFailure: async () => opts.recovery }
      : {}),
    ...(opts.verifier
      ? { verifyUninstallTarget: async () => ({ ok: true as const }) }
      : {}),
  } as unknown as DeployAdapter;
  return { adapter, calls, uninstalls };
}

const UNINSTALL_REQUEST = {
  action: "uninstall-and-retry",
  packageId: "com.example.app",
  note: "The device is out of storage.",
};

const deploy = (adapter: DeployAdapter, args = {}) =>
  runDeployCore({ adapter, args });

describe("launch-stage space recovery is performed by runDeployCore", () => {
  it("uninstalls the requested package on the named device, then retries the launch", async () => {
    const { adapter, calls, uninstalls } = fake({
      launches: [FAILED, LAUNCHED],
      recovery: UNINSTALL_REQUEST,
      verifier: true,
    });

    const out = await deploy(adapter);

    expect(uninstalls).toEqual([["dev-1", "com.example.app"]]);
    expect(calls.filter((c) => c === "launch")).toHaveLength(2);
    expect(out.stage).toBe("launched");
  });

  it("does not uninstall, or retry, on a device the call did not name", async () => {
    const { adapter, calls, uninstalls } = fake({
      resolution: { target: "dev-1", source: "discovered" },
      launches: [FAILED, LAUNCHED],
      recovery: UNINSTALL_REQUEST,
      verifier: true,
    });

    const out = await deploy(adapter);

    expect(uninstalls).toEqual([]);
    expect(calls.filter((c) => c === "launch")).toHaveLength(1);
    expect(out.stage === "launch-failed" && out.launchRecovery?.note).toMatch(/did not name/);
  });

  it("does not uninstall for an adapter with no way to confirm the package", async () => {
    const { adapter, uninstalls } = fake({
      launches: [FAILED, LAUNCHED],
      recovery: UNINSTALL_REQUEST,
    });

    const out = await deploy(adapter);

    expect(uninstalls).toEqual([]);
    expect(out.stage === "launch-failed" && out.launchRecovery?.note).toMatch(/cannot confirm/);
  });

  it("does not retry when the space-freeing uninstall itself fails", async () => {
    const { adapter, calls } = fake({
      launches: [FAILED, LAUNCHED],
      recovery: UNINSTALL_REQUEST,
      verifier: true,
      uninstallResult: result("Failure [DELETE_FAILED_INTERNAL_ERROR]", false),
    });

    const out = await deploy(adapter);

    expect(calls.filter((c) => c === "launch")).toHaveLength(1);
    expect(out.stage === "launch-failed" && out.launchRecovery?.note).toMatch(/uninstall.*failed/i);
  });
});

describe("what runDeployCore tells the adapter about the launch to come", () => {
  function recording(defaultLaunchTimeoutMs?: (mode?: string) => number | undefined) {
    const seen: { installOptions?: { launchFollows?: boolean }; timeoutMs?: number; mode?: string } = {};
    const { adapter } = fake({});
    const recorded = {
      ...adapter,
      async install(_device: string, options: { launchFollows?: boolean }) {
        seen.installOptions = options;
        return result("ok");
      },
      async launchAndCaptureUri(_device: string, timeoutMs: number, _local: unknown, mode?: string) {
        seen.timeoutMs = timeoutMs;
        seen.mode = mode;
        return LAUNCHED;
      },
      ...(defaultLaunchTimeoutMs ? { defaultLaunchTimeoutMs } : {}),
    } as unknown as DeployAdapter;
    return { adapter: recorded, seen };
  }

  it("marks the install as followed by a launch, unless no_launch is set", async () => {
    const launching = recording();
    await deploy(launching.adapter);
    expect(launching.seen.installOptions?.launchFollows).toBe(true);

    const installOnly = recording();
    await deploy(installOnly.adapter, { no_launch: true });
    expect(installOnly.seen.installOptions?.launchFollows).toBe(false);
  });

  it("uses the adapter's launch timeout when the caller passes none, for the requested mode", async () => {
    const modes: (string | undefined)[] = [];
    const { adapter, seen } = recording((mode) => {
      modes.push(mode);
      return 2400000;
    });
    await deploy(adapter, { mode: "debug" });
    expect(seen.timeoutMs).toBe(2400000);
    expect(modes).toEqual(["debug"]);
  });

  it("lets an explicit timeout_ms win, and falls back to 180000 when the adapter has no default", async () => {
    const explicit = recording(() => 2400000);
    await deploy(explicit.adapter, { timeout_ms: 5000 });
    expect(explicit.seen.timeoutMs).toBe(5000);

    const shared = recording(() => undefined);
    await deploy(shared.adapter);
    expect(shared.seen.timeoutMs).toBe(180000);
  });
});

describe("install-stage space recovery", () => {
  it("is refused for an adapter with no verifier, naming why", async () => {
    const { adapter, uninstalls } = fake({
      install: [result("No space left on device", false)],
    });

    const out = await deploy(adapter, { no_launch: true });

    expect(uninstalls).toEqual([]);
    expect(out.enospcRecoveryRefused).toMatch(/cannot confirm the build being installed/);
  });

  it("does not treat a bare 'Install failed' as a full device", async () => {
    const { adapter, uninstalls } = fake({
      install: [result("Install failed: certificate mismatch", false)],
      verifier: true,
    });

    const out = await deploy(adapter, { no_launch: true });

    expect(uninstalls).toEqual([]);
    expect(out.enospcRecoveryAttempted).toBe(false);
    expect(out.enospcRecoveryRefused).toBeUndefined();
  });
});

describe("tearDownForDeploy on a platform-scoped adapter", () => {
  it("does not kill anything when device resolution refuses", async () => {
    const { adapter, calls } = fake({
      scope: "platform",
      discover: async () => {
        throw new RequestedDeviceUnavailableError({
          platform: "Tizen",
          requested: "192.0.2.6:26101",
          origin: "the FLUTTER_DEVICE_TIZEN_DEVICE env var",
          online: [],
        });
      },
    });

    await expect(tearDownForDeploy({ adapter, preference: {} })).rejects.toThrow(/is not online/);
    expect(calls).not.toContain("killStale");
  });

  it("kills, then resolves again, when discovery fails for another reason", async () => {
    let attempts = 0;
    const { adapter, calls } = fake({
      scope: "platform",
      discover: async () => {
        attempts += 1;
        if (attempts === 1) throw new McpError(ErrorCode.InvalidParams, "No Tizen device found.");
        return { target: "192.0.2.6:26101", source: "pin" };
      },
    });

    const out = await tearDownForDeploy({ adapter, preference: {} });

    expect(calls).toEqual(["discoverDevice", "killStale", "discoverDevice"]);
    expect(out.resolution.target).toBe("192.0.2.6:26101");
  });
});
