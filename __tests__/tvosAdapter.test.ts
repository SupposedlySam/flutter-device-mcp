import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";

// Mock the shell layer so we can assert exactly which flutter-tvos / xcrun /
// dns-sd commands the TvosAdapter issues, without spawning real processes. ESM
// mocking requires unstable_mockModule + dynamic import (same pattern as
// iosAdapter.test).
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
}));

// The physical-device launch feeds the SAME neutral launch core the iOS adapter
// uses (pty-wrap + poll-a-temp-log). Mock it so the test asserts the command +
// signatures the adapter hands in, without spawning a real detached process.
const neutralLaunchAndCaptureUri =
  jest.fn<
    (
      command: string,
      cwd: string,
      timeoutMs: number,
      signatures: RegExp[],
      controlFifoPath?: string,
      settle?: unknown,
      parseUri?: (text: string) => unknown
    ) => Promise<unknown>
  >();
const CONTROL_CHANNEL = {
  fifoPath: "/tmp/flutter-device-control.fifo",
  forwarder: { python: "/usr/bin/python3", script: "/x/pty_forward.py" },
};
const allocateControlChannel = jest.fn<() => typeof CONTROL_CHANNEL | undefined>();
jest.unstable_mockModule("../src/launchCapture.js", () => ({
  launchAndCaptureUri: neutralLaunchAndCaptureUri,
  allocateControlChannel,
  // buildPtyCaptureCommand is pure; buildTvosDeviceRunCommand delegates its pty
  // wrapping to it, so the mocked module must still expose it. Use the ONE
  // shared stand-in (pinned byte-for-byte to the real helper in
  // launchCapture.test.ts) rather than a per-file copy.
  buildPtyCaptureCommand: mockBuildPtyCaptureCommand,
}));

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

const {
  TvosAdapter,
  findAppPids,
  parseDevicectlAppBundlePath,
  withFlutterTvosPath,
  defaultFlutterTvosBinDir,
  buildTvosDeviceRunCommand,
  tvosArtifactDir,
  tvosDeviceFailureSignatures,
  tvosSettleOptionsFor,
  TVOS_FAILURE_SIGNATURES,
} = await import("../src/adapters/tvos.js");
const { UnsupportedInputError } = await import("../src/types.js");
const { parseAnnouncedVmServiceUri } = await import("../src/vmServiceUri.js");
const { TVOS_PROFILE_NO_VM_SERVICE_REASON, TVOS_RELEASE_NO_VM_SERVICE_REASON } =
  await import("../src/tvosLaunchMode.js");

const ATV_ID = "A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D";
const ATV_NAME = "Example Apple TV";
const ATV_HARDWARE_UDID = "00000000-0000000000000000";
const ATV_BIN = "/opt/pyatv/bin/atvremote";
const PMD3_BIN = "/opt/pmd3/bin/pymobiledevice3";
const SIM_ID = "TV-SIM-BOOTED";
const TVOS_APP_DIR = "/repo/app";
const TVOS_APP_ID = "com.example.app";
const ATV_OS_VERSION = "27.0";
const ATV_OS_BUILD = "24J361";

type TvosConfigOverrides = Partial<ConstructorParameters<typeof TvosAdapter>[0]>;

/**
 * An adapter that never looks for atvremote or pymobiledevice3 on the host, so
 * no test depends on what this machine has installed. Pass a resolver to opt in.
 */
function tvos(device?: string, overrides: TvosConfigOverrides = {}) {
  return new TvosAdapter({
    appDir: TVOS_APP_DIR,
    appId: TVOS_APP_ID,
    device,
    flutterTvosBinDir: "/does/not/exist/flutter-tvos/bin",
    resolveAtvremote: () => undefined,
    resolvePymobiledevice3: () => ({}),
    ...overrides,
  });
}

/** A realistic `devicectl list devices --json-output` body with one paired
 * Apple TV (tunnel disconnected — still available) and one iPhone that must be
 * excluded. */
function devicectlJson(includeAppleTv: boolean) {
  const devices: unknown[] = [
    {
      identifier: "E1E2E3E4-0000-4000-8000-000000000AC4",
      deviceProperties: { name: "iPhone" },
      connectionProperties: { pairingState: "paired", tunnelState: "connected" },
      hardwareProperties: {
        deviceType: "iPhone",
        platform: "iOS",
        productType: "iPhone11,8",
      },
    },
  ];
  if (includeAppleTv) {
    devices.unshift({
      identifier: ATV_ID,
      deviceProperties: {
        name: ATV_NAME,
        osVersionNumber: ATV_OS_VERSION,
        osBuildUpdate: ATV_OS_BUILD,
      },
      connectionProperties: {
        pairingState: "paired",
        tunnelState: "disconnected",
      },
      hardwareProperties: {
        deviceType: "appleTV",
        platform: "tvOS",
        productType: "AppleTV14,1",
        udid: ATV_HARDWARE_UDID,
      },
    });
  }
  return JSON.stringify({ result: { devices } });
}

/** Extract the `--json-output <path>` temp file from a devicectl command. */
function devicectlOutputPath(cmd: string): string | undefined {
  const m = cmd.match(/--json-output\s+'([^']+)'/);
  return m?.[1];
}

/**
 * Make discoverDevice resolve to a physical Apple TV or a tvOS simulator.
 *
 * Physical discovery is devicectl-backed: `devicectl list devices --json-output
 * <tmp>` writes JSON to a temp file the adapter reads. The mock writes that file
 * (path parsed from the command) so the real fs read succeeds — proving the
 * devicectl code path end to end WITHOUT flutter-tvos on PATH.
 */
function mockDiscovery(kind: "device" | "simulator") {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.includes("devicectl list devices")) {
      const outPath = devicectlOutputPath(cmd);
      if (outPath) fs.writeFileSync(outPath, devicectlJson(kind === "device"));
      return { ...okResult, success: true };
    }
    if (cmd.includes("simctl list devices --json")) {
      return {
        ...okResult,
        stdout:
          kind === "simulator"
            ? JSON.stringify({
                devices: {
                  "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
                    {
                      udid: SIM_ID,
                      name: "Apple TV 4K",
                      state: "Booted",
                      isAvailable: true,
                    },
                  ],
                },
              })
            : "{}",
      };
    }
    return okResult;
  });
}

beforeEach(() => {
  runShell.mockReset();
  neutralLaunchAndCaptureUri.mockReset();
  allocateControlChannel.mockReset();
  allocateControlChannel.mockReturnValue(CONTROL_CHANNEL);
  runShell.mockResolvedValue(okResult);
  neutralLaunchAndCaptureUri.mockResolvedValue({
    vmServiceUriWs: "ws://127.0.0.1:53182/Vr2ii1ySMoE=/ws",
    vmServiceUriHttp: "http://127.0.0.1:53182/Vr2ii1ySMoE=/",
    logPath: "/tmp/x.log",
    pid: 999,
  });
});

describe("TvosAdapter identity", () => {
  it("reports the tvos platform and default bundle id", () => {
    const adapter = tvos();
    expect(adapter.platform).toBe("tvos");
    expect(adapter.appId).toBe("com.example.app");
  });
});

/** Adapter with the flutter-tvos PATH prefix disabled (bin dir absent) so the
 * emitted `flutter-tvos` command is exactly the bare CLI invocation — keeps these
 * command assertions independent of whether ~/flutter-tvos exists on the host. */
function tvosNoPathPrefix(device?: string, overrides: TvosConfigOverrides = {}) {
  return tvos(device, overrides);
}

/** The last runShell command containing a substring. */
function lastRunShellContaining(sub: string): string | undefined {
  return runShell.mock.calls
    .map((c) => c[0] as string)
    .find((c) => c.includes(sub));
}

describe("TvosAdapter.info / setup", () => {
  it("info runs `flutter-tvos devices` (via runShell)", async () => {
    await tvosNoPathPrefix().info();
    const cmd = lastRunShellContaining("flutter-tvos devices");
    expect(cmd).toBeDefined();
  });

  it("setup runs `flutter-tvos doctor` and writes no target file", async () => {
    const { result, wrote } = await tvosNoPathPrefix().setup({});
    const cmd = lastRunShellContaining("flutter-tvos doctor");
    expect(cmd).toBeDefined();
    expect(result.success).toBe(true);
    expect(wrote).toBeUndefined();
  });
});

describe("TvosAdapter.build", () => {
  it("builds nothing for a physical Apple TV in debug (the default) and points at flutter_deploy", async () => {
    // The debug app only starts under the lldb that `flutter-tvos run --debug`
    // attaches, so the deploy builds it.
    const build = await tvosNoPathPrefix().build({});
    expect(build.result.success).toBe(true);
    expect(build.result.combined).toContain("flutter_deploy");
    expect(lastRunShellContaining("flutter-tvos build tvos")).toBeUndefined();
  });

  it("builds a physical Apple TV with --<mode> when a non-debug mode is asked for", async () => {
    await tvosNoPathPrefix().build({ mode: "profile" });
    const profile = lastRunShellContaining("flutter-tvos build tvos");
    expect(profile).toContain("--profile");
    expect(profile).not.toContain("--simulator");
    // A physical build must be code-signed (installed via devicectl) — the
    // Xcode project's team signs it; do NOT pass --no-codesign.
    expect(profile).not.toContain("--no-codesign");

    runShell.mockClear();
    await tvosNoPathPrefix().build({ mode: "release" });
    expect(lastRunShellContaining("flutter-tvos build tvos")).toContain("--release");
  });

  it("takes the build mode from FLUTTER_DEVICE_TVOS_LAUNCH_MODE when the call names none", async () => {
    await tvosNoPathPrefix(undefined, { launchMode: "release" }).build({});
    expect(lastRunShellContaining("flutter-tvos build tvos")).toContain("--release");
  });

  it("builds for the simulator (no --profile) when profile=simulator", async () => {
    await tvosNoPathPrefix().build({ profile: "simulator" });
    const cmd = lastRunShellContaining("flutter-tvos build tvos --simulator");
    expect(cmd).toBeDefined();
    expect(cmd).not.toContain("--profile");
    expect(cmd).not.toContain("--release");
  });

  it("short-circuits skip_flutter to a no-op success without invoking the CLI", async () => {
    const build = await tvosNoPathPrefix().build({ skip_flutter: true });
    expect(build.result.success).toBe(true);
    expect(lastRunShellContaining("flutter-tvos build")).toBeUndefined();
  });
});

describe("TvosAdapter.discoverDevice", () => {
  it("resolves a physical Apple TV (never an iPhone) from devicectl — flutter-tvos NOT required", async () => {
    mockDiscovery("device");
    const r = await tvos().discoverDevice();
    expect(r.target).toBe(ATV_ID);
    expect((r as { kind?: string }).kind).toBe("device");
    // Discovery went through devicectl, never flutter-tvos (which would be off
    // PATH under a GUI-spawned server).
    const cmds = runShell.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes("devicectl list devices"))).toBe(true);
    expect(cmds.some((c) => c.includes("flutter-tvos devices"))).toBe(false);
  });

  it("prefers the paired Apple TV over a simulator even when its tunnel is disconnected", async () => {
    // The devicectl fixture reports the Apple TV with tunnelState "disconnected"
    // (the on-device reality) yet pairingState "paired" — it must still win over
    // any simulator and must never silently degrade to one.
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl list devices")) {
        const outPath = devicectlOutputPath(cmd);
        if (outPath) fs.writeFileSync(outPath, devicectlJson(true));
        return { ...okResult, success: true };
      }
      if (cmd.includes("simctl list devices --json")) {
        return {
          ...okResult,
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
                {
                  udid: SIM_ID,
                  name: "Apple TV 4K",
                  state: "Booted",
                  isAvailable: true,
                },
              ],
            },
          }),
        };
      }
      return okResult;
    });
    const r = await tvos().discoverDevice();
    expect(r.target).toBe(ATV_ID);
    expect((r as { kind?: string }).kind).toBe("device");
  });

  it("falls back to a booted tvOS simulator when no device is present", async () => {
    mockDiscovery("simulator");
    const r = await tvos().discoverDevice();
    expect(r.target).toBe(SIM_ID);
    expect((r as { kind?: string }).kind).toBe("simulator");
  });

  it("throws when neither an Apple TV nor a tvOS simulator is available", async () => {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl list devices")) {
        const outPath = devicectlOutputPath(cmd);
        // Only an iPhone paired — no Apple TV, so nothing tvOS to resolve.
        if (outPath) fs.writeFileSync(outPath, devicectlJson(false));
        return { ...okResult, success: true };
      }
      if (cmd.includes("simctl list devices --json"))
        return { ...okResult, stdout: "{}" };
      return okResult;
    });
    await expect(tvos().discoverDevice()).rejects.toThrow(/No Apple TV/i);
  });
});

describe("TvosAdapter.install / uninstall pick the right toolchain", () => {
  it("a debug deploy that launches defers the device install to `flutter-tvos run --debug`", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    const install = await adapter.install(ATV_ID, { launchFollows: true });
    expect(install.success).toBe(true);
    expect(install.combined).toMatch(/Install deferred/);
    expect(lastRunShellContaining("devicectl device install app")).toBeUndefined();
  });

  it("a debug install with no launch refuses when no debug build exists", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    const install = await adapter.install(ATV_ID, { launchFollows: false });
    expect(install.success).toBe(false);
    expect(install.combined).toContain("Debug-appletvos/Runner.app");
    expect(lastRunShellContaining("devicectl device install app")).toBeUndefined();
  });

  it("retries a device install once after a connection reset, and says so", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    let attempts = 0;
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl device install app")) {
        attempts += 1;
        return attempts === 1
          ? { ...okResult, success: false, code: 1, combined: "Connection reset by peer" }
          : { ...okResult, combined: "App installed" };
      }
      return okResult;
    });
    const install = await adapter.install(ATV_ID, { mode: "profile" });
    expect(attempts).toBe(2);
    expect(install.success).toBe(true);
    expect(install.combined).toMatch(/retried once/);
  });

  it("does not retry a device install that failed for another reason", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    let attempts = 0;
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("devicectl device install app")) {
        attempts += 1;
        return { ...okResult, success: false, code: 1, combined: "Unable to install: bad signature" };
      }
      return okResult;
    });
    const install = await adapter.install(ATV_ID, { mode: "profile" });
    expect(attempts).toBe(1);
    expect(install.success).toBe(false);
  });

  it("device install uses devicectl with the bundle the device BUILD writes", async () => {
    // The expected directory is derived, not copied from the adapter: take the
    // mode flag the adapter's own device build passes, and map it through
    // flutter-tvos's rule (see flutterTvosStagingDir). The old assertion
    // hardcoded the adapter's first-choice constant, `Profile-appletvos` — a
    // directory flutter-tvos never writes — so it pinned the wrong path rather
    // than the build/install agreement.
    const adapter = tvosNoPathPrefix();
    mockDiscovery("device");
    await adapter.build({ mode: "profile" });
    await adapter.discoverDevice();
    await adapter.install(ATV_ID, { mode: "profile" });
    const cmds = runShell.mock.calls.map((c) => c[0] as string);
    const buildCall = cmds.find((c) => c.includes("flutter-tvos build tvos"));
    const installCall = cmds.find((c) =>
      c.includes("devicectl device install app")
    );
    expect(buildCall).toBeDefined();
    expect(installCall).toBeDefined();
    expect(installCall).toContain(ATV_ID);
    const staged = flutterTvosStagingDir(buildModeOf(buildCall!), "appletvos");
    expect(installCall).toContain(`/build/tvos/${staged}/Runner.app`);
    expect(installCall).not.toContain("Profile-appletvos");
  });

  it("simulator install uses simctl with the Debug-appletvsimulator Runner.app", async () => {
    const adapter = tvos();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    await adapter.install(SIM_ID, {});
    const installCall = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.includes("simctl install"));
    expect(installCall).toBeDefined();
    expect(installCall).toContain("Debug-appletvsimulator/Runner.app");
  });

  it("BOOTS a simulator before install so a shutdown sim never 405s (no silent degrade)", async () => {
    // Regression for the live-test failure: resolving a Shutdown sim then
    // `simctl install` → SimError 405 "Unable to lookup in current state:
    // Shutdown". install must boot the sim FIRST, and the boot must precede the
    // install in the issued command order.
    const adapter = tvos();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockClear();
    await adapter.install(SIM_ID, {});
    const cmds = runShell.mock.calls.map((c) => c[0] as string);
    const bootIdx = cmds.findIndex((c) => c.includes("simctl boot"));
    const installIdx = cmds.findIndex((c) => c.includes("simctl install"));
    expect(bootIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(bootIdx).toBeLessThan(installIdx);
    // Boot is idempotent-safe: an already-booted sim exits non-zero, tolerated.
    expect(cmds[bootIdx]).toContain("|| true");
    expect(cmds[bootIdx]).toContain(SIM_ID);
  });

  it("does NOT boot anything on a physical-device install (devicectl only)", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockClear();
    await adapter.install(ATV_ID, { mode: "profile" });
    const cmds = runShell.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes("simctl boot"))).toBe(false);
    expect(cmds.some((c) => c.includes("devicectl device install app"))).toBe(
      true
    );
  });

  it("device uninstall uses devicectl; simulator uses simctl", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    await adapter.uninstall(ATV_ID, "com.example.app");
    expect(
      runShell.mock.calls
        .map((c) => c[0] as string)
        .some((c) => c.includes("devicectl device uninstall app"))
    ).toBe(true);
  });
});

/** How a fragment of the inner command reads once the pty wrapper has single-quoted it. */
const ptyQuoted = (fragment: string) => fragment.replace(/'/g, "'\\''");

describe("TvosAdapter.launchAndCaptureUri — physical device (flutter-tvos run via pty)", () => {
  async function deviceAdapter(overrides: TvosConfigOverrides = {}) {
    const adapter = tvos(undefined, overrides);
    mockDiscovery("device");
    await adapter.discoverDevice();
    return adapter;
  }

  it("runs `flutter-tvos run -d <id> --debug` in the app dir by default, never the CLI", async () => {
    const adapter = await deviceAdapter();
    const outcome = await adapter.launchAndCaptureUri(ATV_ID, 4242);

    expect(neutralLaunchAndCaptureUri).toHaveBeenCalledTimes(1);
    const [command, cwd, timeoutMs, signatures, fifo, settle, parseUri] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    expect(cwd).toBe(TVOS_APP_DIR);
    expect(command).toContain(
      ptyQuoted(`cd '${TVOS_APP_DIR}' && flutter-tvos run -d '${ATV_ID}' --debug`)
    );
    expect(command).not.toContain("--dart-define");
    expect(timeoutMs).toBe(4242);
    expect(signatures).toEqual(tvosDeviceFailureSignatures("debug"));
    expect(fifo).toBe(CONTROL_CHANNEL.fifoPath);
    expect(settle).toBeUndefined();
    expect(parseUri).toBe(parseAnnouncedVmServiceUri);

    expect(outcome).toMatchObject({
      vmServiceUriWs: "ws://127.0.0.1:53182/Vr2ii1ySMoE=/ws",
      launchMode: "debug",
      reloadNeedsOwningRun: true,
    });
    expect((outcome as { launchModeCaveat?: string }).launchModeCaveat).toBeUndefined();
  });

  it("holds a debug run behind the pty control channel so hot reload reaches it", async () => {
    const adapter = await deviceAdapter();
    await adapter.launchAndCaptureUri(ATV_ID, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain(`'${CONTROL_CHANNEL.forwarder.script}' '${CONTROL_CHANNEL.fifoPath}'`);
  });

  it("launches the mode asked for, with no control channel and a settle that names why there is no URI", async () => {
    const adapter = await deviceAdapter();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce({
      vmServiceUriWs: "",
      vmServiceUriHttp: "",
      logPath: "/tmp/x.log",
      pid: 1,
      noVmServiceReason: TVOS_RELEASE_NO_VM_SERVICE_REASON,
    });
    const outcome = await adapter.launchAndCaptureUri(ATV_ID, 1000, "release");
    const [command, , , signatures, fifo, settle] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain(ptyQuoted(`flutter-tvos run -d '${ATV_ID}' --release`));
    expect(command).not.toContain("--debug");
    expect(allocateControlChannel).not.toHaveBeenCalled();
    expect(fifo).toBeUndefined();
    expect(signatures).toEqual(tvosDeviceFailureSignatures("release"));
    expect(settle).toEqual(tvosSettleOptionsFor("release"));
    expect(outcome).toMatchObject({ launchMode: "release" });
    expect((outcome as { launchModeCaveat?: string }).launchModeCaveat).toMatch(/--release/);
  });

  it("takes the launch mode from FLUTTER_DEVICE_TVOS_LAUNCH_MODE when the call names none", async () => {
    const adapter = await deviceAdapter({ launchMode: "profile" });
    const outcome = await adapter.launchAndCaptureUri(ATV_ID, 1000);
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain("--profile");
    expect(outcome).toMatchObject({ launchMode: "profile" });
  });

  it("passes the call's dart-defines through to flutter-tvos", async () => {
    const adapter = await deviceAdapter();
    await adapter.launchAndCaptureUri(ATV_ID, 1000, undefined, { API_HOST: "192.168.1.20" });
    const [command] = neutralLaunchAndCaptureUri.mock.calls[0];
    expect(command).toContain(ptyQuoted("'--dart-define=API_HOST=192.168.1.20'"));
  });

  it("tears the run down when a debug launch fails, so the Xcode fallback never starts", async () => {
    const adapter = await deviceAdapter();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce({
      failed: true,
      reason: "Launch failed: matched /lldb debugging did not attach/i",
      logPath: "/tmp/x.log",
      pid: 7,
      logTail: "lldb debugging did not attach — falling back to the Xcode debugger.",
    });
    runShell.mockClear();
    const outcome = await adapter.launchAndCaptureUri(ATV_ID, 5);
    expect("failed" in outcome && outcome.failed).toBe(true);
    expect(
      runShell.mock.calls.some((c) => (c[0] as string).startsWith("ps -Awwo pid=,ppid=,command="))
    ).toBe(true);
  });

  it("wakes the Apple TV with atvremote before a device launch when it is installed", async () => {
    const adapter = await deviceAdapter({ resolveAtvremote: () => ATV_BIN });
    runShell.mockClear();
    await adapter.launchAndCaptureUri(ATV_ID, 1000);
    expect(lastRunShellContaining("turn_on")).toBe(`'${ATV_BIN}' -n '${ATV_NAME}' turn_on`);
  });

  it("answers a profile request on a simulator in debug and says so", async () => {
    const adapter = tvos();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockImplementation(async (cmd: string) =>
      cmd.includes("simctl launch")
        ? {
            ...okResult,
            combined:
              "A Dart VM Service on Apple TV is available at: http://127.0.0.1:51182/tys47XX1iAw=/",
          }
        : okResult
    );
    const outcome = await adapter.launchAndCaptureUri(SIM_ID, 1000, "profile");
    expect(outcome).toMatchObject({ launchMode: "debug" });
    expect((outcome as { reloadNeedsOwningRun?: boolean }).reloadNeedsOwningRun).toBeUndefined();
    expect((outcome as { launchModeCaveat?: string }).launchModeCaveat).toMatch(
      /Requested --profile, launched --debug/
    );
  });
});

describe("TvosAdapter.recoverLaunchFailure", () => {
  async function deviceAdapter(overrides: TvosConfigOverrides = {}) {
    const adapter = tvos(undefined, overrides);
    mockDiscovery("device");
    await adapter.discoverDevice();
    return adapter;
  }

  it("wakes a sleeping Apple TV with atvremote and asks for one retry", async () => {
    const adapter = await deviceAdapter({ resolveAtvremote: () => ATV_BIN });
    runShell.mockClear();
    const recovery = await adapter.recoverLaunchFailure(ATV_ID, "ERROR: System is asleep");
    expect(recovery.action).toBe("retry");
    expect(lastRunShellContaining("turn_on")).toContain(ATV_BIN);
  });

  it("addresses atvremote by FLUTTER_DEVICE_TVOS_ATV_ID when it is set", async () => {
    const adapter = await deviceAdapter({ resolveAtvremote: () => ATV_BIN, atvId: "AA:BB:CC" });
    runShell.mockClear();
    await adapter.recoverLaunchFailure(ATV_ID, "System is asleep");
    expect(lastRunShellContaining("turn_on")).toBe(`'${ATV_BIN}' -i 'AA:BB:CC' turn_on`);
  });

  it("reports how to wake a sleeping box when atvremote is not installed", async () => {
    const adapter = await deviceAdapter();
    const recovery = await adapter.recoverLaunchFailure(ATV_ID, "System is asleep");
    expect(recovery.action).toBe("none");
    expect(recovery.note).toMatch(/pipx install pyatv/);
  });

  it("reports a failed wake instead of retrying into the same refusal", async () => {
    const adapter = await deviceAdapter({ resolveAtvremote: () => ATV_BIN });
    runShell.mockImplementation(async (cmd: string) =>
      cmd.includes("turn_on")
        ? { ...okResult, success: false, code: 1, combined: "pyatv.exceptions.NoCredentialsError" }
        : okResult
    );
    const recovery = await adapter.recoverLaunchFailure(ATV_ID, "System is asleep");
    expect(recovery.action).toBe("none");
    expect(recovery.note).toMatch(/not paired/);
  });

  it("retries once after a connection reset", async () => {
    const adapter = await deviceAdapter();
    const recovery = await adapter.recoverLaunchFailure(ATV_ID, "Connection reset by peer");
    expect(recovery.action).toBe("retry");
  });

  it("leaves any other failure to the caller", async () => {
    const adapter = await deviceAdapter();
    const recovery = await adapter.recoverLaunchFailure(ATV_ID, "Could not build the application");
    expect(recovery.action).toBe("none");
  });
});

describe("TvosAdapter.defaultLaunchTimeoutMs", () => {
  it("gives a device launch room for a cold build and leaves the simulator on the shared default", async () => {
    const device = tvos();
    mockDiscovery("device");
    await device.discoverDevice();
    expect(device.defaultLaunchTimeoutMs()).toBe(40 * 60 * 1000);

    const sim = tvos();
    mockDiscovery("simulator");
    await sim.discoverDevice();
    expect(sim.defaultLaunchTimeoutMs()).toBeUndefined();
  });
});

describe("TvosAdapter.launchAndCaptureUri — simulator (loopback URI)", () => {
  it("captures the loopback VM-service URI simctl launch prints", async () => {
    const adapter = tvos();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl launch")) {
        return {
          ...okResult,
          combined:
            "A Dart VM Service on Apple TV is available at: http://127.0.0.1:51182/tys47XX1iAw=/",
        };
      }
      return okResult;
    });
    const outcome = await adapter.launchAndCaptureUri(SIM_ID, 5000);
    expect("vmServiceUriWs" in outcome).toBe(true);
    if ("vmServiceUriWs" in outcome) {
      expect(outcome.vmServiceUriWs).toBe(
        "ws://127.0.0.1:51182/tys47XX1iAw=/ws"
      );
    }
  });

  it("passes --console-pty so the app's stdout (incl. the VM-service URI) streams back", async () => {
    const adapter = tvos();
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("simctl launch")) {
        return {
          ...okResult,
          combined:
            "A Dart VM Service on Apple TV is available at: http://127.0.0.1:51182/tys47XX1iAw=/",
        };
      }
      return okResult;
    });
    await adapter.launchAndCaptureUri(SIM_ID, 5000);
    const launchCall = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.includes("simctl launch"));
    expect(launchCall).toBeDefined();
    expect(launchCall).toContain("--console-pty");
  });
});

describe("TvosAdapter.killStale", () => {
  // The tvOS teardown used to `pkill -f flutter_tools` and `pkill -f
  // frontend_server`, which on this host is every OTHER platform's session (an
  // iOS/Android `flutter run` IS a flutter_tools snapshot) and the IDE's flutter
  // daemon besides. Only the tvOS-named driver is matched now; the Dart
  // snapshot and compiler come down as its children.
  const PS_ROWS = [
    "40011     1 /Users/dev/flutter-tvos/bin/flutter-tvos run --profile -d ATV",
    "40012 40011 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --profile -d ATV",
    "40013 40012 /Users/dev/dartaotruntime /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /x/",
    "60010     1 fvm flutter run --debug -d 988a1b413950494c49",
    "60011 60010 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --debug -d 988a1b413950494c49",
    "60012 60011 /Users/dev/dartaotruntime /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /x/",
    "11668 10348 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot daemon",
  ];

  function mockProcesses(rows: string[]) {
    const psTable = rows.join("\n") + "\n";
    const psPairs =
      rows.map((r) => r.trim().split(/\s+/).slice(0, 2).join(" ")).join("\n") +
      "\n";
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith("ps -Awwo pid=,ppid=,command=")) {
        return { ...okResult, stdout: psTable, combined: psTable };
      }
      if (cmd.startsWith("ps -Awwo pid=,ppid=")) {
        return { ...okResult, stdout: psPairs, combined: psPairs };
      }
      return okResult;
    });
  }

  function killedPids(): number[] {
    const kill = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.startsWith("kill "));
    if (!kill) return [];
    return kill
      .replace(/^kill\s+/, "")
      .replace(/2>&1$/, "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .sort((a, b) => a - b);
  }

  it("kills the flutter-tvos driver and its children only", async () => {
    mockProcesses(PS_ROWS);
    const killed = await tvos().killStale({ kind: "all-devices" });
    expect(killedPids()).toEqual([40011, 40012, 40013]);
    // The iPhone/Android session and the IDE's daemon are untouched: they are
    // exactly what the old `pkill -f flutter_tools` took down.
    for (const pid of [60010, 60011, 60012, 11668]) {
      expect(killedPids()).not.toContain(pid);
    }
    expect(
      runShell.mock.calls.some((c) => (c[0] as string).includes("pkill"))
    ).toBe(false);
    expect(killed.flutterTvos.code).toBe(0);
    expect(killed.frontendServer.code).toBe(0);
  });

  it("REPORTS an orphaned Dart snapshot it can no longer identify", async () => {
    // Its parent is gone, so nothing links it to tvOS rather than to an iPhone
    // or an Android phone. Matching it by name is what killed those; naming it
    // at least tells the caller what may still hold the device.
    mockProcesses([
      "40020     1 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --profile -d ATV",
    ]);
    const killed = await tvos().killStale({ kind: "all-devices" });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterTvos.combined).toContain("no longer identifiable");
    expect(killed.flutterTvos.combined).toContain("40020");
  });

  it("declares a platform-wide teardown (one Apple TV is modelled)", () => {
    expect(tvos().killStaleScope).toBe("platform");
  });
});

describe("buildTvosDeviceRunCommand", () => {
  const base = {
    appDir: TVOS_APP_DIR,
    device: "ATV",
    mode: "debug" as const,
    flutterTvosBinDir: undefined,
    dirExists: () => false,
  };

  it("runs flutter-tvos in the app dir with the mode, inside a pty", () => {
    const inner = `cd '${TVOS_APP_DIR}' && flutter-tvos run -d 'ATV' --debug`;
    expect(buildTvosDeviceRunCommand({ ...base, platform: "darwin" })).toBe(
      `exec script -q /dev/null /bin/sh -c '${inner.replace(/'/g, "'\\''")}'`
    );
    expect(buildTvosDeviceRunCommand({ ...base, platform: "linux" })).toBe(
      `exec script -q -c '${inner.replace(/'/g, "'\\''")}' /dev/null`
    );
  });

  it("quotes extra dart-defines and appends them after the mode", () => {
    const out = buildTvosDeviceRunCommand({
      ...base,
      mode: "profile",
      extraArgs: ["--dart-define=API_HOST=10.0.0.2"],
      platform: "darwin",
    });
    expect(out).toContain("--profile '\\''--dart-define=API_HOST=10.0.0.2'\\''");
  });

  it("prepends the flutter-tvos bin dir to PATH inside the pty when it exists", () => {
    const out = buildTvosDeviceRunCommand({
      ...base,
      flutterTvosBinDir: "/Users/dev/flutter-tvos/bin",
      dirExists: () => true,
      platform: "darwin",
    });
    expect(out).toContain('export PATH="/Users/dev/flutter-tvos/bin:$PATH"; cd ');
  });

  it("hands the terminal to the control-channel bridge when one is given", () => {
    const out = buildTvosDeviceRunCommand({ ...base, controlChannel: CONTROL_CHANNEL });
    expect(out.startsWith(`exec '${CONTROL_CHANNEL.forwarder.python}' '${CONTROL_CHANNEL.forwarder.script}' '${CONTROL_CHANNEL.fifoPath}' `)).toBe(true);
    expect(out).toContain("flutter-tvos run -d");
  });
});

describe("tvosArtifactDir", () => {
  it("maps debug to Debug-appletvos, every other device mode to Release-appletvos, and the simulator to its debug dir", () => {
    expect(tvosArtifactDir("device", "debug")).toBe("Debug-appletvos");
    expect(tvosArtifactDir("device", "profile")).toBe("Release-appletvos");
    expect(tvosArtifactDir("device", "release")).toBe("Release-appletvos");
    expect(tvosArtifactDir("simulator", "release")).toBe("Debug-appletvsimulator");
  });
});

describe("tvOS launch signatures", () => {
  const matches = (signatures: RegExp[], line: string) => signatures.some((s) => s.test(line));

  it("ends on terminal failures but NOT on transient startup lines", () => {
    expect(matches(TVOS_FAILURE_SIGNATURES, "No supported devices connected.")).toBe(true);
    expect(
      matches(tvosDeviceFailureSignatures("debug"), "Waiting for a connection from Flutter on Example Apple TV...")
    ).toBe(false);
    expect(matches(TVOS_FAILURE_SIGNATURES, "Error: flutter-tvos not found")).toBe(true);
  });

  it("ends a debug launch on flutter-tvos's Xcode-debugger fallback", () => {
    const line = "lldb debugging did not attach — falling back to the Xcode debugger.";
    expect(matches(tvosDeviceFailureSignatures("debug"), line)).toBe(true);
    expect(matches(tvosDeviceFailureSignatures("profile"), line)).toBe(false);
  });

  it("ends any device launch on a sleeping Apple TV, and never on a connection reset", () => {
    for (const mode of ["debug", "profile", "release"] as const) {
      expect(matches(tvosDeviceFailureSignatures(mode), "ERROR: System is asleep")).toBe(true);
      expect(matches(tvosDeviceFailureSignatures(mode), "Connection reset by peer")).toBe(false);
    }
  });

  it("settles a profile or release run on the key help, with the mode's reason", () => {
    expect(tvosSettleOptionsFor("debug")).toBeUndefined();
    expect(tvosSettleOptionsFor("profile")?.reason).toBe(TVOS_PROFILE_NO_VM_SERVICE_REASON);
    expect(tvosSettleOptionsFor("release")?.reason).toBe(TVOS_RELEASE_NO_VM_SERVICE_REASON);
    expect(
      tvosSettleOptionsFor("release")?.signatures.some((s) => s.test("Flutter run key commands."))
    ).toBe(true);
  });
});

describe("TvosAdapter.lifecycle", () => {
  it("background foregrounds the tvOS Settings app on a device", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    await adapter.lifecycle!.background(ATV_ID, "com.example.app");
    const launched = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.includes("com.apple.TVSettings"));
    expect(launched).toBeDefined();
    expect(launched).toContain("devicectl device process launch");
  });
});

const APP_BUNDLE_URL =
  "file:///private/var/containers/Bundle/Application/11111111-2222-4333-8444-555555555555/Runner.app/";
const OTHER_FLUTTER_APP_EXE =
  "file:///private/var/containers/Bundle/Application/0000AAAA-0000-0000-0000-000000000000/Runner.app/Runner";

function installedAppsJson(installed: boolean) {
  return JSON.stringify({
    info: { outcome: "success" },
    result: {
      apps: installed
        ? [{ bundleIdentifier: TVOS_APP_ID, name: "App", url: APP_BUNDLE_URL }]
        : [],
    },
  });
}

function processesJson(appPids: number[]) {
  return JSON.stringify({
    result: {
      runningProcesses: [
        { processIdentifier: 1, executable: "file:///sbin/launchd" },
        { processIdentifier: 77, executable: OTHER_FLUTTER_APP_EXE },
        ...appPids.map((pid) => ({
          processIdentifier: pid,
          executable: `${APP_BUNDLE_URL}Runner`,
        })),
      ],
    },
  });
}

/**
 * A resolved physical Apple TV whose `device info processes` answers come from
 * `processReads` in order (the last one repeats); `null` is a failed read.
 */
async function deviceForTerminate(opts: {
  apps?: string | null;
  processReads: Array<number[] | null>;
}) {
  const adapter = tvos(undefined, { terminatePollMs: 0 });
  mockDiscovery("device");
  await adapter.discoverDevice();
  const discovery = runShell.getMockImplementation()!;
  let read = 0;
  runShell.mockImplementation(async (cmd: string, runOpts?: unknown) => {
    if (cmd.includes("device info apps")) {
      const apps = opts.apps === undefined ? installedAppsJson(true) : opts.apps;
      return apps === null
        ? { ...okResult, success: false, code: 1 }
        : { ...okResult, stdout: apps };
    }
    if (cmd.includes("device info processes")) {
      const pids = opts.processReads[Math.min(read, opts.processReads.length - 1)];
      read++;
      return pids === null
        ? { ...okResult, success: false, code: 1 }
        : { ...okResult, stdout: processesJson(pids) };
    }
    return discovery(cmd, runOpts);
  });
  runShell.mockClear();
  return adapter;
}

function commandsIssued(): string[] {
  return runShell.mock.calls.map((c) => c[0] as string);
}

describe("TvosAdapter terminate on a physical Apple TV", () => {
  it("reports not running when only another Flutter app's Runner is up", async () => {
    const adapter = await deviceForTerminate({ processReads: [[]] });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(true);
    expect(result.combined).toBe(`${TVOS_APP_ID} was not running on ${ATV_ID}.`);
    expect(commandsIssued().some((c) => c.includes("process terminate"))).toBe(false);
  });

  it("reads the app's pids before ending the resident run, and reports that the run's end took the app with it", async () => {
    const adapter = await deviceForTerminate({ processReads: [[4242], []] });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(true);
    expect(result.combined).toMatch(
      /^com\.example\.app \(pid 4242\) exited when its resident flutter-tvos run was ended\./
    );
    const commands = commandsIssued();
    const firstRead = commands.findIndex((c) => c.includes("device info processes"));
    const teardown = commands.findIndex((c) => c.startsWith("ps -Awwo pid=,ppid=,command="));
    expect(firstRead).toBeGreaterThanOrEqual(0);
    expect(teardown).toBeGreaterThan(firstRead);
    expect(commands.some((c) => c.includes("process terminate"))).toBe(false);
  });

  it("terminates the app's own pid when it outlives the run, and confirms it is gone", async () => {
    const adapter = await deviceForTerminate({ processReads: [[4242], [4242], []] });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(true);
    expect(result.combined).toBe(`Terminated ${TVOS_APP_ID} (pid 4242) on ${ATV_ID}.`);
    expect(commandsIssued().filter((c) => c.includes("process terminate"))).toEqual([
      `xcrun devicectl device process terminate --device '${ATV_ID}' --pid 4242`,
    ]);
  });

  it("fails when the app is still running after terminate", async () => {
    const adapter = await deviceForTerminate({ processReads: [[4242]] });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/still running .*\(pid 4242\) after terminate/);
  });

  it("fails rather than reporting not running when the process list cannot be read", async () => {
    const adapter = await deviceForTerminate({ processReads: [null] });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/Could not read the processes .* unknown\. Nothing was terminated\./);
  });

  it("fails when the installed apps cannot be read", async () => {
    const adapter = await deviceForTerminate({ apps: null, processReads: [[]] });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/Could not read the apps installed/);
  });

  it("reports an app that is not installed as nothing to terminate", async () => {
    const adapter = await deviceForTerminate({
      apps: installedAppsJson(false),
      processReads: [[]],
    });
    const result = await adapter.lifecycle!.terminate(ATV_ID, TVOS_APP_ID);
    expect(result.success).toBe(true);
    expect(result.combined).toBe(
      `${TVOS_APP_ID} is not installed on ${ATV_ID}; nothing to terminate.`
    );
  });
});

describe("parseDevicectlAppBundlePath", () => {
  it("returns the bundle directory with /private/var folded to /var", () => {
    expect(parseDevicectlAppBundlePath(installedAppsJson(true), TVOS_APP_ID)).toEqual({
      kind: "installed",
      bundlePath:
        "/var/containers/Bundle/Application/11111111-2222-4333-8444-555555555555/Runner.app/",
    });
  });

  it("tells an absent app from an unreadable answer", () => {
    expect(parseDevicectlAppBundlePath(installedAppsJson(false), TVOS_APP_ID)).toEqual({
      kind: "absent",
    });
    expect(parseDevicectlAppBundlePath("", TVOS_APP_ID)).toEqual({ kind: "unreadable" });
  });
});

describe("findAppPids", () => {
  const bundlePath =
    "/var/containers/Bundle/Application/11111111-2222-4333-8444-555555555555/Runner.app/";

  it("matches the app's executable under either /var or /private/var, and no other Runner", () => {
    const json = JSON.stringify({
      result: {
        runningProcesses: [
          { processIdentifier: 77, executable: OTHER_FLUTTER_APP_EXE },
          { processIdentifier: 909, executable: `${APP_BUNDLE_URL}Runner` },
          {
            processIdentifier: 910,
            executable: `file://${bundlePath}Frameworks/helper`,
          },
        ],
      },
    });
    expect(findAppPids(json, bundlePath)).toEqual([909, 910]);
  });

  it("returns an empty list when the app is not running, and undefined when the output is not a list", () => {
    expect(findAppPids(processesJson([]), bundlePath)).toEqual([]);
    expect(findAppPids("not json", bundlePath)).toBeUndefined();
  });
});

describe("TvosAdapter.environmentDiagnostic", () => {
  function deviceSupportRoot(dirs: Record<string, boolean>): string {
    const root = fs.mkdtempSync(`${os.tmpdir()}/tvos-device-support-`);
    for (const [name, finalized] of Object.entries(dirs)) {
      fs.mkdirSync(`${root}/${name}`);
      if (finalized) fs.writeFileSync(`${root}/${name}/.finalized`, "");
    }
    return root;
  }

  it("names the missing tvOS release and the Xcode step for a physical Apple TV", async () => {
    const root = deviceSupportRoot({ "AppleTV14,1 26.5 (23L471)": true });
    mockDiscovery("device");
    const diagnostic = await tvos(undefined, { deviceSupportRoot: root }).environmentDiagnostic();
    expect(diagnostic).toMatch(/no debug symbols for tvOS 27\.0 \(24J361\)/);
    expect(diagnostic).toMatch(/Window > Devices and Simulators, select "Example Apple TV"/);
  });

  it("is silent once Xcode has finalized the symbols", async () => {
    const root = deviceSupportRoot({ "AppleTV14,1 27.0 (24J361)": true });
    mockDiscovery("device");
    expect(
      await tvos(undefined, { deviceSupportRoot: root }).environmentDiagnostic()
    ).toBeNull();
  });

  it("is silent for a simulator", async () => {
    const root = deviceSupportRoot({});
    mockDiscovery("simulator");
    expect(
      await tvos(undefined, { deviceSupportRoot: root }).environmentDiagnostic()
    ).toBeNull();
  });
});

describe("TvosAdapter.vmServiceReloadRefusal", () => {
  it("refuses a physical Apple TV, naming the missing kernel compiler", async () => {
    mockDiscovery("device");
    expect(await tvos().vmServiceReloadRefusal(ATV_ID)).toMatch(
      /physical Apple TV: the debug app has no on-device kernel compiler/
    );
  });

  it("lets a tvOS simulator launch try", async () => {
    mockDiscovery("simulator");
    expect(await tvos().vmServiceReloadRefusal(SIM_ID)).toBeUndefined();
  });

  it("lets the reload try when devicectl cannot be read", async () => {
    runShell.mockImplementation(async () => ({
      stdout: "",
      stderr: "devicectl timed out",
      code: 1,
      success: false,
    }));
    expect(await tvos().vmServiceReloadRefusal(ATV_ID)).toBeUndefined();
  });
});

describe("TvosAdapter input — Siri Remote through atvremote", () => {
  it("sends a key to the resolved Apple TV by its devicectl name", async () => {
    const adapter = tvos(undefined, { resolveAtvremote: () => ATV_BIN });
    mockDiscovery("device");
    await adapter.input().key("UP");
    await adapter.input().key("ENTER");
    expect(lastRunShellContaining(" up")).toBe(`'${ATV_BIN}' -n '${ATV_NAME}' up`);
    expect(lastRunShellContaining(" select")).toBe(`'${ATV_BIN}' -n '${ATV_NAME}' select`);
  });

  it("reports keys unsupported, with the install steps, when atvremote is missing", async () => {
    mockDiscovery("device");
    await expect(tvos().input().key("UP")).rejects.toThrow(/pipx install pyatv/);
  });

  it("reports keys unsupported on a simulator", async () => {
    const adapter = tvos(undefined, { resolveAtvremote: () => ATV_BIN });
    mockDiscovery("simulator");
    await expect(adapter.input().key("UP")).rejects.toThrow(/simulator/);
    expect(lastRunShellContaining(ATV_BIN)).toBeUndefined();
  });

  it("turns an unpaired atvremote into the pairing steps", async () => {
    const adapter = tvos(undefined, { resolveAtvremote: () => ATV_BIN });
    mockDiscovery("device");
    const discovery = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string, opts?: unknown) =>
      cmd.startsWith(`'${ATV_BIN}'`)
        ? { ...okResult, success: false, code: 1, combined: "NoCredentialsError: not paired" }
        : discovery(cmd, opts)
    );
    await expect(adapter.input().key("DOWN")).rejects.toThrow(/companion pair/);
  });

  it("has no free cursor: pointer move, click and scroll are unsupported", async () => {
    const input = tvos().input();
    await expect(input.pointerMove(1, 2)).rejects.toBeInstanceOf(UnsupportedInputError);
    await expect(input.pointerClick()).rejects.toBeInstanceOf(UnsupportedInputError);
    await expect(input.pointerScroll(3)).rejects.toBeInstanceOf(UnsupportedInputError);
  });
});

describe("withFlutterTvosPath", () => {
  it("prepends the flutter-tvos bin dir to PATH when the dir exists", () => {
    const out = withFlutterTvosPath(
      "flutter-tvos info",
      "/Users/dev/flutter-tvos/bin",
      () => true
    );
    expect(out).toBe(
      'export PATH="/Users/dev/flutter-tvos/bin:$PATH"; flutter-tvos info'
    );
  });

  it("leaves the command unchanged when the dir is missing", () => {
    const cmd = "flutter-tvos info";
    expect(withFlutterTvosPath(cmd, "/nope", () => false)).toBe(cmd);
  });

  it("leaves the command unchanged when no dir is configured", () => {
    const cmd = "flutter-tvos build";
    expect(withFlutterTvosPath(cmd, undefined, () => true)).toBe(cmd);
  });

  it("defaultFlutterTvosBinDir points at ~/flutter-tvos/bin (the documented location)", () => {
    expect(defaultFlutterTvosBinDir("/Users/dev")).toBe(
      "/Users/dev/flutter-tvos/bin"
    );
  });
});

describe("TvosAdapter flutter-tvos invocations prepend flutter-tvos to PATH", () => {
  it("info prepends the bin dir to PATH when it exists", async () => {
    // A bin dir the fs check will report as present (the repo root always
    // exists) exercises the prefix branch without depending on ~/flutter-tvos.
    const adapter = new TvosAdapter({
      appDir: TVOS_APP_DIR,
      appId: TVOS_APP_ID,
      flutterTvosBinDir: process.cwd(),
    });
    await adapter.info();
    const infoCall = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.includes("flutter-tvos devices"));
    expect(infoCall).toBeDefined();
    expect(infoCall).toContain(`export PATH="${process.cwd()}:$PATH";`);
  });
});

/**
 * Where flutter-tvos stages a build, restated here from the toolchain rather
 * than from the adapter so the tests can disagree with it.
 * `lib/build_targets/application.dart` in flutter-tvos:
 *   final configuration = buildInfo.buildInfo.isDebug ? 'Debug' : 'Release';
 *   ... '$configuration-appletvos' / '$configuration-appletvsimulator'
 * under `build/tvos/`. Profile is never a configuration it selects.
 */
function flutterTvosStagingDir(
  mode: "debug" | "profile" | "release",
  sdk: "appletvos" | "appletvsimulator"
): string {
  return `${mode === "debug" ? "Debug" : "Release"}-${sdk}`;
}

/** The Flutter build mode a `flutter-tvos build` command line selects. */
function buildModeOf(cmd: string): "debug" | "profile" | "release" {
  const m = cmd.match(/--(debug|profile|release)\b/);
  if (!m) throw new Error(`no build-mode flag in: ${cmd}`);
  return m[1] as "debug" | "profile" | "release";
}

describe("TvosAdapter.install resolves the bundle that is actually on disk", () => {
  let appDir: string;

  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), "tvos-install-"));
  });

  afterEach(() => {
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  function stage(dir: string): string {
    const app = path.join(appDir, "build", "tvos", dir, "Runner.app");
    fs.mkdirSync(app, { recursive: true });
    return app;
  }

  function adapterIn(dir: string) {
    return new TvosAdapter({ appDir: dir, appId: TVOS_APP_ID });
  }

  function issued(sub: string): string {
    const cmd = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.includes(sub));
    expect(cmd).toBeDefined();
    return cmd!;
  }

  it("installs the profile device build even when other bundles sit beside it", async () => {
    // A Profile-appletvos from a manual Xcode Profile run, a Debug-appletvos
    // from a debug run: neither is what a `--profile` build writes, so neither
    // may win over its Release-appletvos.
    stage("Profile-appletvos");
    stage("Debug-appletvos");
    const built = stage(flutterTvosStagingDir("profile", "appletvos"));
    const adapter = adapterIn(appDir);
    mockDiscovery("device");
    await adapter.discoverDevice();
    await adapter.install(ATV_ID, { mode: "profile" });
    expect(issued("devicectl device install app")).toContain(`'${built}'`);
  });

  it("does not fall back to a bundle of another mode", async () => {
    // Only a Debug-appletvos exists. Installing it for a profile deploy would put
    // the wrong build on the Apple TV; naming the path the profile build should
    // have written makes the missing build the visible error instead.
    stage("Debug-appletvos");
    const adapter = adapterIn(appDir);
    mockDiscovery("device");
    await adapter.discoverDevice();
    await adapter.install(ATV_ID, { mode: "profile" });
    const cmd = issued("devicectl device install app");
    expect(cmd).toContain(
      path.join(appDir, "build", "tvos", "Release-appletvos", "Runner.app")
    );
    expect(cmd).not.toContain("Debug-appletvos");
  });

  it("installs the debug simulator build, the only one the adapter writes", async () => {
    const adapter = adapterIn(appDir);
    await adapter.build({ profile: "simulator", debug: false });
    const built = stage(
      flutterTvosStagingDir(
        buildModeOf(issued("flutter-tvos build tvos --simulator")),
        "appletvsimulator"
      )
    );
    mockDiscovery("simulator");
    await adapter.discoverDevice();
    await adapter.install(SIM_ID, {});
    expect(issued("simctl install")).toContain(`'${built}'`);
  });
});

/** A paired Apple TV and, optionally, a booted tvOS simulator. */
function mockAppleTvAndSimulator(simBooted: boolean) {
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.includes("devicectl list devices")) {
      const outPath = devicectlOutputPath(cmd);
      if (outPath) fs.writeFileSync(outPath, devicectlJson(true));
      return { ...okResult, success: true };
    }
    if (cmd.includes("simctl list devices --json")) {
      return {
        ...okResult,
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
              { udid: SIM_ID, name: "Apple TV 4K", state: simBooted ? "Booted" : "Shutdown", isAvailable: true },
            ],
          },
        }),
      };
    }
    return okResult;
  });
}

describe("TvosAdapter.openUrl target selection", () => {
  it("opens on the simulator when kind: simulator is asked for with an Apple TV paired", async () => {
    mockAppleTvAndSimulator(true);
    const result = await tvos().openUrl("example://home", undefined, { kind: "simulator" });
    expect(result.opened).toBe(true);
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining(`simctl openurl '${SIM_ID}'`),
      expect.anything()
    );
  });

  it("refuses kind: simulator when no simulator is booted, rather than using the Apple TV", async () => {
    mockAppleTvAndSimulator(false);
    await expect(
      tvos().openUrl("example://home", undefined, { kind: "simulator" })
    ).rejects.toThrow(/a simulator was requested and none is online/);
  });
});

describe("TvosAdapter.screenshot target selection", () => {
  it("captures the simulator a device_udid names, with an Apple TV paired", async () => {
    mockAppleTvAndSimulator(true);
    await tvos().screenshot({ outPath: "/tmp/never-written.png", deviceUdid: SIM_ID } as Parameters<
      InstanceType<typeof TvosAdapter>["screenshot"]
    >[0]);
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining(`simctl io '${SIM_ID}' screenshot`),
      expect.anything()
    );
  });

  it("captures the simulator for target: simulator, with an Apple TV paired", async () => {
    mockAppleTvAndSimulator(true);
    await tvos().screenshot({ outPath: "/tmp/never-written.png", target: "simulator" } as Parameters<
      InstanceType<typeof TvosAdapter>["screenshot"]
    >[0]);
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining(`simctl io '${SIM_ID}' screenshot`),
      expect.anything()
    );
  });
});


describe("TvosAdapter.screenshot — physical Apple TV", () => {
  /** A 1x1 PNG header is all readPngDimensions needs: signature + IHDR width/height. */
  function pngBytes(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  }

  function tmpPng(): string {
    return `${fs.mkdtempSync(`${os.tmpdir()}/tvos-shot-`)}/shot.png`;
  }

  it("captures with pymobiledevice3 --native, addressed by the hardware UDID", async () => {
    const adapter = tvos(undefined, { resolvePymobiledevice3: () => ({ binary: PMD3_BIN }) });
    const outPath = tmpPng();
    mockDiscovery("device");
    const discovery = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string, opts?: unknown) => {
      if (cmd.includes("developer dvt screenshot")) {
        fs.writeFileSync(outPath, pngBytes(3840, 2160));
        return okResult;
      }
      return discovery(cmd, opts);
    });
    const shot = await adapter.screenshot({ outPath });
    expect(lastRunShellContaining("developer dvt screenshot")).toBe(
      `'${PMD3_BIN}' developer dvt screenshot '${outPath}' --native --udid '${ATV_HARDWARE_UDID}'`
    );
    expect(shot).toMatchObject({
      captured: true,
      via: "pymobiledevice3",
      device: ATV_ID,
      deviceKind: "device",
      pixelWidth: 3840,
      pixelHeight: 2160,
    });
  });

  it("reports unsupported, with the install step, when pymobiledevice3 is missing", async () => {
    mockDiscovery("device");
    const shot = await tvos().screenshot({ outPath: tmpPng() });
    expect(shot).toMatchObject({ captured: false, supported: false, via: "pymobiledevice3" });
    expect(shot.hint).toMatch(/pipx install pymobiledevice3/);
  });

  it("reports a failed capture with the wake hint", async () => {
    const adapter = tvos(undefined, { resolvePymobiledevice3: () => ({ binary: PMD3_BIN }) });
    mockDiscovery("device");
    const discovery = runShell.getMockImplementation()!;
    runShell.mockImplementation(async (cmd: string, opts?: unknown) =>
      cmd.includes("developer dvt screenshot")
        ? { ...okResult, success: false, code: 1, combined: "ConnectionFailedError" }
        : discovery(cmd, opts)
    );
    const shot = await adapter.screenshot({ outPath: tmpPng() });
    expect(shot.captured).toBe(false);
    expect(shot.reason).toContain("ConnectionFailedError");
    expect(shot.hint).toMatch(/awake/);
  });
});
