import { jest } from "@jest/globals";
import fs from "fs";
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
      signatures: RegExp[]
    ) => Promise<unknown>
  >();
jest.unstable_mockModule("../src/launchCapture.js", () => ({
  launchAndCaptureUri: neutralLaunchAndCaptureUri,
  // buildPtyCaptureCommand is pure; buildTvosPtyLaunchCommand delegates its pty
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
  findRunnerPid,
  withFlutterTvosPath,
  defaultFlutterTvosBinDir,
  buildTvosPtyLaunchCommand,
  TVOS_FAILURE_SIGNATURES,
} = await import("../src/adapters/tvos.js");
const { UnsupportedInputError } = await import("../src/types.js");

const ATV_ID = "A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D";
const SIM_ID = "TV-SIM-BOOTED";
const TVOS_APP_DIR = "/repo/app";
const TVOS_APP_ID = "com.example.app";

function tvos(device?: string) {
  return new TvosAdapter({
    appDir: TVOS_APP_DIR,
    appId: TVOS_APP_ID,
    device,
  });
}

/** A realistic `devicectl list devices --json-output` body with one paired
 * Apple TV (tunnel disconnected — still available) and one iPhone that must be
 * excluded. */
function devicectlJson(includeAppleTv: boolean) {
  const devices: unknown[] = [
    {
      identifier: "0831CB2E-D597-5C19-9699-6DFA21324AC4",
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
      deviceProperties: { name: "Example Apple TV" },
      connectionProperties: {
        pairingState: "paired",
        tunnelState: "disconnected",
      },
      hardwareProperties: {
        deviceType: "appleTV",
        platform: "tvOS",
        productType: "AppleTV14,1",
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
function tvosNoPathPrefix(device?: string) {
  return new TvosAdapter({
    appDir: TVOS_APP_DIR,
    appId: TVOS_APP_ID,
    device,
    flutterTvosBinDir: "/does/not/exist/flutter-tvos/bin",
  });
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
  it("builds a physical Apple TV (AOT, drivable) with --profile by default", async () => {
    // Profile — NOT release: a release AOT build strips the Dart VM service, so
    // there would be nothing for Marionette to attach to. Profile keeps it.
    await tvosNoPathPrefix().build({});
    const cmd = lastRunShellContaining("flutter-tvos build tvos");
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--profile");
    expect(cmd).not.toContain("--simulator");
    expect(cmd).not.toContain("--release");
    // A physical build must be code-signed (installed via devicectl) — the
    // Xcode project's team signs it; do NOT pass --no-codesign.
    expect(cmd).not.toContain("--no-codesign");
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
  it("device install uses devicectl with the Profile-appletvos Runner.app", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    await adapter.install(ATV_ID, {});
    const installCall = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.includes("devicectl device install app"));
    expect(installCall).toBeDefined();
    expect(installCall).toContain(ATV_ID);
    // Matches launchDevice's `--profile` run — a debug device launch segfaults
    // and release strips the VM service, so Profile-appletvos is the only
    // config the device path actually produces.
    expect(installCall).toContain("Profile-appletvos/Runner.app");
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
    await adapter.install(ATV_ID, {});
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

describe("TvosAdapter.launchAndCaptureUri — physical device (flutter-tvos run --profile via pty)", () => {
  it("feeds the neutral core the pty-wrapped `flutter-tvos run -d <id> --profile` + tvOS signatures", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();

    const outcome = await adapter.launchAndCaptureUri(ATV_ID, 4242);

    // The launch went through the SAME neutral pty-capture core the iOS adapter
    // uses (NOT the old devicectl-launch + dns-sd path).
    expect(neutralLaunchAndCaptureUri).toHaveBeenCalledTimes(1);
    const [command, cwd, timeoutMs, signatures] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    expect(cwd).toBe("/repo/app");
    expect(command).toMatch(/\bscript -q\b/);
    expect(command).toContain("flutter-tvos run");
    expect(command).toContain("-d");
    expect(command).toContain(ATV_ID);
    expect(command).toContain("--profile");
    expect(timeoutMs).toBe(4242);
    expect(signatures).toBe(TVOS_FAILURE_SIGNATURES);

    // The URI the neutral core returns is passed straight through.
    expect("vmServiceUriWs" in outcome).toBe(true);
    if ("vmServiceUriWs" in outcome) {
      expect(outcome.vmServiceUriWs).toBe(
        "ws://127.0.0.1:53182/Vr2ii1ySMoE=/ws"
      );
    }

    // The OLD wrong mechanism must be gone: no devicectl launch, no dns-sd.
    const cmds = runShell.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes("devicectl device process launch"))).toBe(
      false
    );
    expect(cmds.some((c) => c.includes("dns-sd"))).toBe(false);
    expect(cmds.some((c) => c.includes("--vm-service-port"))).toBe(false);
  });

  it("surfaces the neutral core's failure outcome (e.g. flutter-tvos not running a profile build)", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    neutralLaunchAndCaptureUri.mockResolvedValueOnce({
      failed: true,
      reason: "Launch failed: matched /No supported devices connected/i",
      logPath: "/tmp/x.log",
      pid: undefined,
      logTail: "No supported devices connected.",
    });
    const outcome = await adapter.launchAndCaptureUri(ATV_ID, 5);
    expect("failed" in outcome && outcome.failed).toBe(true);
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

describe("buildTvosPtyLaunchCommand", () => {
  // This adapter owns only the PATH-guarded `flutter-tvos run` inner; the
  // cross-platform `script` wrapping (and the leading `exec`) is
  // buildPtyCaptureCommand's concern (see its own tests). Assert only this
  // adapter's contribution here. The inner is a bare `flutter-tvos run …`
  // command (no `cd …`), so no separate cwd is passed to the helper.
  const cli = "flutter-tvos run -d 'ATV' --profile";

  it("composes the PATH-guarded flutter-tvos inner and delegates the pty wrap", () => {
    const out = buildTvosPtyLaunchCommand(cli, undefined, () => false, "darwin");
    expect(out).toContain("flutter-tvos run -d ");
    expect(out).toContain("--profile");
    // Delegates the pty wrap rather than emitting its own `script` branch.
    expect(out).toMatch(/\bexec script -q\b/);
  });

  it("delegates the darwin wrap to buildPtyCaptureCommand's `/bin/sh -c` form", () => {
    // The inner is a bare `flutter-tvos run …` command, so buildTvosPtyLaunch
    // Command passes NO cwd — the helper emits the bare `exec script … /bin/sh
    // -c '<inner>'` form with no extra `cd` prefix.
    const out = buildTvosPtyLaunchCommand(cli, undefined, () => false, "darwin");
    expect(out).toBe(
      `exec script -q /dev/null /bin/sh -c '${cli.replace(/'/g, "'\\''")}'`
    );
  });

  it("delegates the linux wrap to buildPtyCaptureCommand's util-linux `-c` form", () => {
    const out = buildTvosPtyLaunchCommand(cli, undefined, () => false, "linux");
    expect(out).toBe(
      `exec script -q -c '${cli.replace(/'/g, "'\\''")}' /dev/null`
    );
  });

  it("prepends the flutter-tvos bin dir to PATH inside the pty when it exists", () => {
    const out = buildTvosPtyLaunchCommand(
      cli,
      "/Users/dev/flutter-tvos/bin",
      () => true,
      "darwin"
    );
    expect(out).toContain("exec script -q /dev/null /bin/sh -c ");
    // `export` so the PATH reaches the whole `flutter-tvos …` invocation.
    expect(out).toContain('export PATH="/Users/dev/flutter-tvos/bin:$PATH";');
  });
});

describe("TVOS_FAILURE_SIGNATURES", () => {
  it("matches terminal failures but NOT transient startup lines", () => {
    const terminal = "No supported devices connected.";
    const transient = "Waiting for a connection from Flutter on Example Apple TV...";
    expect(TVOS_FAILURE_SIGNATURES.some((s) => s.test(terminal))).toBe(true);
    expect(TVOS_FAILURE_SIGNATURES.some((s) => s.test(transient))).toBe(false);
  });

  it("flags a device debug-mode rejection and a missing flutter-tvos", () => {
    expect(
      TVOS_FAILURE_SIGNATURES.some((s) =>
        s.test("Error: physical Apple TV runs must be --release or --profile (AOT)")
      )
    ).toBe(true);
    expect(
      TVOS_FAILURE_SIGNATURES.some((s) => s.test("Error: flutter-tvos not found"))
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

  it("terminate no-ops cleanly when the app is not running on a device", async () => {
    const adapter = tvos();
    mockDiscovery("device");
    await adapter.discoverDevice();
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("device info processes"))
        return { ...okResult, stdout: JSON.stringify({ result: { runningProcesses: [] } }) };
      return okResult;
    });
    const r = await adapter.lifecycle!.terminate(ATV_ID, "com.example.app");
    expect(r.success).toBe(true);
    expect(r.combined).toMatch(/nothing to terminate/i);
  });
});

describe("TvosAdapter input is unsupported (Marionette drives the app)", () => {
  it("key/pointer throw UnsupportedInputError", async () => {
    const input = tvos().input();
    await expect(input.key("UP")).rejects.toBeInstanceOf(UnsupportedInputError);
    await expect(input.pointerMove(1, 2)).rejects.toBeInstanceOf(
      UnsupportedInputError
    );
    await expect(input.pointerClick()).rejects.toBeInstanceOf(
      UnsupportedInputError
    );
    await expect(input.pointerScroll(3)).rejects.toBeInstanceOf(
      UnsupportedInputError
    );
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

describe("findRunnerPid", () => {
  it("finds the Runner pid by its executable path", () => {
    const json = JSON.stringify({
      result: {
        runningProcesses: [
          { processIdentifier: 1, executable: "file:///sbin/launchd" },
          {
            processIdentifier: 909,
            executable:
              "file:///private/var/containers/Bundle/Application/X/Runner.app/Runner",
          },
        ],
      },
    });
    expect(findRunnerPid(json)).toBe(909);
  });

  it("returns undefined when not running or on malformed JSON", () => {
    expect(
      findRunnerPid(JSON.stringify({ result: { runningProcesses: [] } }))
    ).toBeUndefined();
    expect(findRunnerPid("not json")).toBeUndefined();
  });
});
