import { jest } from "@jest/globals";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";

// Mock the shell layer so we can assert exactly which commands the TizenAdapter
// issues (behavior-identity with the former standalone server) without spawning
// real processes. ESM mocking requires unstable_mockModule + dynamic import.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  // quote/tail are pure; re-export real behavior.
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
}));

// Mock the neutral launch core so we can assert exactly what the TizenAdapter
// feeds INTO it — its own failure signatures and the appDir (not repoRoot).
const neutralLaunchAndCaptureUri =
  jest.fn<
    (
      command: string,
      cwd: string,
      timeoutMs: number,
      failureSignatures: RegExp[]
    ) => Promise<unknown>
  >();

jest.unstable_mockModule("../src/launchCapture.js", () => ({
  launchAndCaptureUri: neutralLaunchAndCaptureUri,
  // isLaunchFailure is pure; re-export real behavior for any consumer.
  isLaunchFailure: (o: { failed?: boolean }) => o?.failed === true,
  // buildPtyCaptureCommand is pure; the adapters delegate their pty wrapping to
  // it, so the mocked module must still expose it. Use the ONE shared stand-in
  // (pinned byte-for-byte to the real helper in launchCapture.test.ts) rather
  // than a per-file copy.
  buildPtyCaptureCommand: mockBuildPtyCaptureCommand,
  // allocateControlChannel mints the FIFO + pty bridge the iOS/Android launches
  // use; in tests there is no live daemon, so stand it in as "no control
  // channel" (undefined).
  allocateControlChannel: () => undefined,
}));

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

const { TizenAdapter, buildPtyLaunchCommand, TIZEN_FAILURE_SIGNATURES } =
  await import("../src/adapters/tizen.js");
const { WebOSAdapter, buildWebosPtyLaunchCommand } = await import(
  "../src/adapters/webos.js"
);
const { IosAdapter } = await import("../src/adapters/ios.js");
const { AndroidAdapter } = await import("../src/adapters/android.js");
const { AdapterRegistry } = await import("../src/adapters/registry.js");

const APP_DIR = "/repo/app";
const APP_ID = "com.example.app";

function tizen() {
  return new TizenAdapter({
    appDir: APP_DIR,
    appId: APP_ID,
    // Pin the rootstrap precheck to OK so build tests exercise the real
    // flutter-tizen invocation, not the (pure) SDK precheck — which is covered
    // separately in tizenRootstrap.test.ts.
    checkRootstrap: () => ({
      ok: true,
      requiredApiVersion: "8.0",
      installedApiVersions: ["8.0"],
      sdkPath: "/sdk/data",
    }),
  });
}

// The webOS build path is driven by a caller-supplied `preBuild` hook (there is
// no standard `flutter-webos build`); use the documented webos-build.sh wrapper
// as the packaging step so the build test exercises a real command shape.
const WEBOS_PREBUILD = ["./app/webos/webos-build.sh build webos"];

function webos(preBuild: string[] = WEBOS_PREBUILD) {
  return new WebOSAdapter({ appDir: APP_DIR, appId: APP_ID, preBuild });
}

beforeEach(() => {
  runShell.mockReset();
  neutralLaunchAndCaptureUri.mockReset();
  runShell.mockResolvedValue(okResult);
  neutralLaunchAndCaptureUri.mockResolvedValue({ failed: false });
});

describe("AdapterRegistry", () => {
  it("resolves tizen by default (auto / omitted)", () => {
    const registry = new AdapterRegistry([tizen(), webos()], "tizen");
    expect(registry.resolve().platform).toBe("tizen");
    expect(registry.resolve("auto").platform).toBe("tizen");
  });

  it("resolves an explicit platform", () => {
    const registry = new AdapterRegistry(
      [
        tizen(),
        webos(),
        new IosAdapter({ appDir: APP_DIR, appId: APP_ID }),
        new AndroidAdapter({ appDir: APP_DIR, appId: APP_ID }),
      ],
      "tizen"
    );
    expect(registry.resolve("tizen").platform).toBe("tizen");
    expect(registry.resolve("webos").platform).toBe("webos");
    expect(registry.resolve("ios").platform).toBe("ios");
    expect(registry.resolve("android").platform).toBe("android");
  });

  it("rejects an unknown platform", () => {
    const registry = new AdapterRegistry([tizen()], "tizen");
    expect(() => registry.resolve("blackberry")).toThrow(/Unknown platform/);
  });

  it("requires the default platform to be registered", () => {
    expect(() => new AdapterRegistry([tizen()], "webos")).toThrow(
      /no registered adapter/
    );
  });
});

describe("TizenAdapter delegates to the shared shell (flutter-tizen)", () => {
  it("info runs `flutter-tizen devices` + `sdb devices` (never sdb shell)", async () => {
    await tizen().info();
    expect(runShell).toHaveBeenCalledWith("flutter-tizen devices", {
      cwd: APP_DIR,
      timeoutMs: 60000,
    });
    expect(runShell).toHaveBeenCalledWith("sdb devices", {
      cwd: APP_DIR,
      timeoutMs: 15000,
    });
    // Guardrail: never a device-side shell.
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("sdb shell"))
    ).toBe(false);
  });

  it("build maps the profile + debug flag and parses the TPK path + signatures", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      combined:
        "Built TPK: /repo/app/build/tizen/out.tpk\nNo space left on device\n",
    });
    const build = await tizen().build({ debug: true, skip_rust: true });
    expect(runShell).toHaveBeenCalledWith(
      "flutter-tizen build tpk --device-profile 'tv' --debug",
      { cwd: APP_DIR, timeoutMs: 2400000 }
    );
    expect(build.artifactPath).toBe("/repo/app/build/tizen/out.tpk");
    expect(build.enospc).toBe(true);
  });

  it("build with neither mode nor debug states --release EXPLICITLY", async () => {
    // The mode is never left to flutter-tizen's default: the launch's
    // `--no-build --<mode>` has to name the same mode to reuse this artifact,
    // so the artifact's mode must be a stated fact.
    await tizen().build({});
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("flutter-tizen build tpk --device-profile 'tv' --release");
    expect(cmd).not.toContain("--debug");
  });

  it("build honors the 3-way mode, which wins over the legacy debug boolean", async () => {
    await tizen().build({ mode: "profile" });
    expect(runShell.mock.calls[0][0]).toContain("--profile");

    runShell.mockClear();
    // `mode` wins: debug:true would have produced --debug on its own.
    await tizen().build({ mode: "release", debug: true });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toContain("--release");
    expect(cmd).not.toContain("--debug");
  });

  it("applies --dart-define at BUILD time (the launch has nothing to compile)", async () => {
    // Tizen relaunches an already-built TPK with `--no-build`, so a define
    // supplied at launch time could not reach the compiled artifact.
    await tizen().build({ dartDefine: { API: "staging" } });
    expect(runShell.mock.calls[0][0] as string).toContain(
      "'--dart-define=API=staging'"
    );
  });

  it("build runs any configured preBuild hooks first (in order, cwd=appDir)", async () => {
    const adapter = new TizenAdapter({
      appDir: APP_DIR,
      appId: APP_ID,
      preBuild: ["echo prep"],
      checkRootstrap: () => ({
        ok: true,
        requiredApiVersion: "8.0",
        installedApiVersions: ["8.0"],
        sdkPath: "/sdk/data",
      }),
    });
    await adapter.build({});
    expect(runShell.mock.calls[0][0]).toBe("echo prep");
    expect(runShell.mock.calls[1][0]).toBe(
      "flutter-tizen build tpk --device-profile 'tv' --release"
    );
  });

  it("setup normalizes a bare host and runs `sdb connect <host>:26101`", async () => {
    await tizen().setup({ deviceAddr: "192.0.2.6" });
    expect(runShell).toHaveBeenCalledWith("sdb connect '192.0.2.6:26101'", {
      cwd: APP_DIR,
      timeoutMs: 180000,
    });
  });

  it("setup rejects a non-default sdb port", async () => {
    await expect(tizen().setup({ deviceAddr: "192.0.2.6:4444" })).rejects.toThrow(
      /Unsupported sdb port/
    );
  });

  it("install runs `flutter-tizen install -d <device>` (install-only)", async () => {
    await tizen().install("192.0.2.6:26101", { noLaunch: true });
    expect(runShell).toHaveBeenCalledWith(
      "flutter-tizen install -d '192.0.2.6:26101'",
      { cwd: APP_DIR, timeoutMs: 300000 }
    );
  });

  it("discoverDevice consults `sdb devices` and resolves a target", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      stdout: "List of devices attached\n192.0.2.6:26101\tdevice\tExampleTV\n",
    });
    const resolution = await tizen().discoverDevice();
    expect(runShell).toHaveBeenCalledWith("sdb devices", { timeoutMs: 15000 });
    expect(resolution.target).toBe("192.0.2.6:26101");
  });

  it("discoverDevice throws when no device is present", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      stdout: "List of devices attached\n",
    });
    await expect(tizen().discoverDevice()).rejects.toThrow(/No Tizen device/);
  });

  it("uninstall shells out to sdb -s <device> uninstall <appId>", async () => {
    await tizen().uninstall("192.0.2.6:26101", "com.example.app");
    expect(runShell).toHaveBeenCalledWith(
      "sdb -s '192.0.2.6:26101' uninstall 'com.example.app'",
      { timeoutMs: 120000 }
    );
  });

  // Tizen's teardown is PLATFORM-WIDE (`flutter-tizen` names this toolchain and
  // no other), so the scope it is handed is all-devices and it still uses pkill
  // on that name — unlike the mobile adapters, whose sessions are all the same
  // `flutter run` and can only be told apart by device.
  it("killStale pkills the flutter-tizen driver process", async () => {
    const killed = await tizen().killStale({ kind: "all-devices" });
    expect(runShell).toHaveBeenCalledWith("pkill -f 'flutter-tizen'", {
      timeoutMs: 10000,
    });
    expect(killed.flutterTizen).toBeDefined();
  });
});

describe("launchAndCaptureUri feeds the neutral core Tizen's own inputs", () => {
  it("passes the Tizen failure signatures and the appDir (not repoRoot)", async () => {
    const adapter = new TizenAdapter({ appDir: APP_DIR, appId: APP_ID });
    await adapter.launchAndCaptureUri("192.0.2.6:26101", 12345);

    expect(neutralLaunchAndCaptureUri).toHaveBeenCalledTimes(1);
    const [command, cwd, timeoutMs, failureSignatures] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    // cwd is the app dir.
    expect(cwd).toBe(APP_DIR);
    // The command is the pty-wrapped flutter-tizen run for this device. Assert
    // only what holds on BOTH `script` variants (the per-platform quoting of the
    // inner command differs — that's covered by the buildPtyLaunchCommand tests
    // below); here we just confirm the pty wrap and the target are wired in,
    // independent of the host's process.platform.
    expect(command).toMatch(/\bscript -q\b/);
    expect(command).toContain("flutter-tizen run --no-build --debug");
    expect(command).toContain("192.0.2.6:26101");
    expect(timeoutMs).toBe(12345);
    // It hands the core ITS OWN signatures (same array identity).
    expect(failureSignatures).toBe(TIZEN_FAILURE_SIGNATURES);
  });
});

describe("TizenAdapter.screenshot is unsupported (sdb shell disabled — guardrail)", () => {
  it("returns {supported:false} with a reason + Marionette hint, shelling nothing", async () => {
    const res = await tizen().screenshot!();
    expect(res.captured).toBe(false);
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/sdb shell is disabled|not available/i);
    expect(res.hint).toMatch(/Marionette/i);
    // It must never attempt a device-side screencap over sdb shell.
    expect(
      runShell.mock.calls.some(([c]) => (c as string).includes("screencap"))
    ).toBe(false);
  });
});

describe("WebOSAdapter.screenshot is unsupported (no wired capture path)", () => {
  it("returns {supported:false} with a reason", async () => {
    const res = await webos().screenshot!();
    expect(res.captured).toBe(false);
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/not wired|no reliable/i);
  });
});

describe("TizenAdapter.record is unsupported (sdb shell disabled — guardrail)", () => {
  it("returns {supported:false} with a reason + Marionette hint, shelling nothing", async () => {
    const res = await tizen().record!({
      durationSeconds: 5,
      fps: 2,
      format: "mp4",
    });
    expect(res.recorded).toBe(false);
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/sdb shell is disabled|not available/i);
    expect(res.hint).toMatch(/Marionette/i);
    // It must never attempt a device-side screenrecord over sdb shell.
    expect(
      runShell.mock.calls.some(([c]) =>
        (c as string).includes("screenrecord")
      )
    ).toBe(false);
  });
});

describe("WebOSAdapter.record is unsupported (no wired recording path)", () => {
  it("returns {supported:false} with a reason", async () => {
    const res = await webos().record!({
      durationSeconds: 5,
      fps: 2,
      format: "mp4",
    });
    expect(res.recorded).toBe(false);
    expect(res.supported).toBe(false);
    expect(res.reason).toMatch(/not wired|no reliable/i);
  });
});

describe("buildPtyLaunchCommand (Tizen-supplied launch command)", () => {
  // This adapter owns only the flutter-tizen inner + the appDir cwd; the
  // cross-platform `script` wrapping is buildPtyCaptureCommand's concern (see
  // its own tests). Assert only this adapter's contribution here.
  const INNER = "flutter-tizen run --no-build --debug -d '192.0.2.6:26101'";

  it("composes the flutter-tizen inner with the appDir cwd (platform-agnostic)", () => {
    const cmd = buildPtyLaunchCommand(
      "/repo/app",
      "192.0.2.6:26101",
      "debug",
      "darwin"
    );
    expect(cmd).toContain("cd '/repo/app'");
    // The inner is passed to `/bin/sh -c` (which escapes its single-quotes), so
    // assert on the unquoted fragment + the target rather than the raw INNER.
    expect(cmd).toContain("flutter-tizen run --no-build --debug -d");
    expect(cmd).toContain("192.0.2.6:26101");
    // Delegates the pty wrap rather than emitting its own `script` branch.
    expect(cmd).toMatch(/\bexec script -q\b/);
  });

  it("delegates the darwin wrap to buildPtyCaptureCommand's `/bin/sh -c` form", () => {
    // BEHAVIOR DELTA (deliberate, visible): the prior BSD form spliced the inner
    // bare — `exec script -q /dev/null flutter-tizen …`. Standardizing on
    // buildPtyCaptureCommand inserts a single `/bin/sh -c '<inner>'` layer and
    // changes NOTHING else. Snapshot both to prove that is the only difference.
    const before = `cd '/repo/app' && exec script -q /dev/null ${INNER}`;
    const after =
      `cd '/repo/app' && exec script -q /dev/null /bin/sh -c ` +
      "'flutter-tizen run --no-build --debug -d '\\''192.0.2.6:26101'\\'''";
    // The only edit from before→after is the inserted `/bin/sh -c '<inner>'`: the
    // produced command is the `after` form and no longer the bare-splice `before`.
    const produced = buildPtyLaunchCommand(
      "/repo/app",
      "192.0.2.6:26101",
      "debug",
      "darwin"
    );
    expect(produced).toBe(after);
    expect(produced).not.toBe(before);
  });

  it("names the launch mode so `--no-build` reuses the TPK of that mode", () => {
    // THE BUG THIS FIXES: the mode was hardcoded `--debug`, so relaunching a
    // profile TPK with `--no-build` found no debug artifact to reuse and
    // flutter-tizen rebuilt -- discarding the point of --no-build and launching
    // something other than what was installed. profile keeps the VM service
    // open, so the URI is still captured.
    const profile = buildPtyLaunchCommand(
      "/repo/app",
      "192.0.2.6:26101",
      "profile",
      "linux"
    );
    expect(profile).toContain("flutter-tizen run --no-build --profile -d");
    expect(profile).not.toContain("--debug");

    // Omitted -> debug, preserving the historical launch.
    const fallback = buildPtyLaunchCommand(
      "/repo/app",
      "192.0.2.6:26101",
      undefined,
      "linux"
    );
    expect(fallback).toContain("--no-build --debug -d");
  });

  it("delegates the linux wrap to buildPtyCaptureCommand's util-linux `-c` form", () => {
    const cmd = buildPtyLaunchCommand(
      "/repo/app",
      "192.0.2.6:26101",
      "debug",
      "linux"
    );
    expect(cmd).toBe(
      `cd '/repo/app' && exec script -q -c '${INNER.replace(/'/g, "'\\''")}' /dev/null`
    );
  });
});

describe("buildWebosPtyLaunchCommand (webOS PATH-guarded launch command)", () => {
  // Force the PATH guard on (independent of the host having the SDK on disk) so
  // the test exercises the compound `export PATH=…; ares-launch …` inner.
  const forceGuard = (cmd: string) => `export PATH='/opt/webos/bin:'"$PATH"; ${cmd}`;

  it("runs the guarded compound via `sh -c` inside `script` on macOS (BSD)", () => {
    const cmd = buildWebosPtyLaunchCommand(
      "/repo/app",
      "tv1",
      "com.example.app",
      "darwin",
      forceGuard
    );
    expect(cmd).toContain("cd '/repo/app'");
    // The guard's `export PATH=…; ares-launch …` compound must be a single
    // `/bin/sh -c` payload — NOT spliced bare after `script` (which would hand
    // `export` to BSD `script` as argv[0] and run ares-launch un-guarded).
    expect(cmd).toContain(
      "exec script -q /dev/null /bin/sh -c 'export PATH='\\''/opt/webos/bin:'\\''\"$PATH\"; ares-launch -d '\\''tv1'\\'' --inspect --display 0 '\\''com.example.app'\\'''"
    );
    // The bare-splice (unquoted) form must NOT appear.
    expect(cmd).not.toContain("script -q /dev/null export PATH");
    // The util-linux `-c` form must NOT appear on darwin.
    expect(cmd).not.toContain("script -q -c");
  });

  it("passes the guarded compound as the `-c` payload on Linux (util-linux)", () => {
    const cmd = buildWebosPtyLaunchCommand(
      "/repo/app",
      "tv1",
      "com.example.app",
      "linux",
      forceGuard
    );
    expect(cmd).toContain("cd '/repo/app'");
    // util-linux runs its `-c` argument through a shell, so the whole compound
    // is quoted there (guard preserved), with the file trailing.
    expect(cmd).toContain(
      "exec script -q -c 'export PATH='\\''/opt/webos/bin:'\\''\"$PATH\"; ares-launch -d '\\''tv1'\\'' --inspect --display 0 '\\''com.example.app'\\''' /dev/null"
    );
    // The BSD trailing-command `sh -c` form must NOT appear on linux.
    expect(cmd).not.toContain("/dev/null /bin/sh -c");
  });
});

describe("TIZEN_FAILURE_SIGNATURES", () => {
  it("is the value the adapter feeds into the neutral launch core", () => {
    expect(Array.isArray(TIZEN_FAILURE_SIGNATURES)).toBe(true);
    expect(TIZEN_FAILURE_SIGNATURES.length).toBeGreaterThan(0);
  });
});

describe("Tizen input controller (Stage 2)", () => {
  it("returns a real controller defaulting to dpad mode", () => {
    const input = tizen().input();
    expect(input.platform).toBe("tizen");
    expect(input.mode).toBe("dpad");
  });

  it("returns the same cached controller so mode is session-sticky", () => {
    const adapter = tizen();
    const first = adapter.input();
    first.setMode("pointer");
    const second = adapter.input();
    expect(second).toBe(first);
    expect(second.mode).toBe("pointer");
  });
});

describe("WebOSAdapter delegates to ares/webos-build via the shared shell", () => {
  const ARES_LIST =
    "name       deviceinfo             connection  profile\n" +
    "tv-26      prisoner@192.168.1.50  ssh         tv\n";

  it("build runs the configured preBuild packaging hook and parses the IPK path", async () => {
    runShell.mockResolvedValue({
      ...okResult,
      combined: "IPK: /repo/build/webos/out/app.ipk\n",
    });
    const build = await webos().build({ debug: true });
    const cmd = runShell.mock.calls[0][0] as string;
    expect(cmd).toBe("./app/webos/webos-build.sh build webos");
    expect(build.artifactPath).toBe("/repo/build/webos/out/app.ipk");
    expect(build.launchedDisplay).toBe(false);
  });

  it("build reports an actionable error when no preBuild hook is configured", async () => {
    const build = await webos([]).build({});
    expect(build.result.success).toBe(false);
    expect(build.result.combined).toMatch(/preBuild/);
    expect(build.artifactPath).toBeUndefined();
  });

  it("discoverDevice consults `ares-setup-device --list --full` and resolves", async () => {
    runShell.mockResolvedValue({ ...okResult, stdout: ARES_LIST });
    const resolution = await webos().discoverDevice();
    expect(runShell).toHaveBeenCalledWith("ares-setup-device --list --full", {
      timeoutMs: 15000,
    });
    expect(resolution.target).toBe("tv-26");
    expect(resolution.host).toBe("192.168.1.50");
  });

  it("discoverDevice throws an actionable error when no device is registered", async () => {
    runShell.mockResolvedValue({ ...okResult, stdout: "" });
    await expect(webos().discoverDevice()).rejects.toThrow(
      /register.*ares-setup-device|FLUTTER_DEVICE_WEBOS_DEVICE/i
    );
  });

  it("install requires a prior build (explicit ipk path, unlike Tizen)", async () => {
    await expect(webos().install("tv-26", {})).rejects.toThrow(
      /No webOS .ipk is available/i
    );
  });

  it("install runs `ares-install` with the built ipk once a build has produced one", async () => {
    const adapter = webos();
    runShell.mockResolvedValue({
      ...okResult,
      combined: "IPK: /repo/build/webos/out/app.ipk\n",
    });
    await adapter.build({});
    runShell.mockClear();
    runShell.mockResolvedValue(okResult);
    await adapter.install("tv-26", {});
    expect(runShell).toHaveBeenCalledWith(
      "ares-install -d 'tv-26' '/repo/build/webos/out/app.ipk'",
      { timeoutMs: 300000 }
    );
  });

  it("isInstallFailure recognizes ares 'Failed to install' (not Tizen's wording)", () => {
    const adapter = webos();
    expect(adapter.isInstallFailure("Failed to install app")).toBe(true);
    expect(adapter.isInstallFailure("No space left on device")).toBe(true);
    // Tizen's phrasing is NOT the webOS signal.
    expect(adapter.isInstallFailure("Install failed")).toBe(false);
  });

  it("uninstall runs `ares-install --remove`", async () => {
    await webos().uninstall("tv-26", "com.example.app");
    expect(runShell).toHaveBeenCalledWith(
      "ares-install -d 'tv-26' --remove 'com.example.app'",
      { timeoutMs: 120000 }
    );
  });

  it("launchAndCaptureUri feeds the shared core a pty ares-launch + webOS signatures", async () => {
    await webos().launchAndCaptureUri("tv-26", 1234);
    const [command, cwd, timeoutMs, signatures] =
      neutralLaunchAndCaptureUri.mock.calls[0];
    // Runs through a `script` pty. On darwin the (possibly PATH-guarded) inner is
    // wrapped in `/bin/sh -c` so a guard compound is honored (the quoting escapes
    // the inner's single-quotes), so assert on the shape + un-escaped fragments
    // rather than a raw substring of the inner command.
    expect(command).toContain("exec script -q");
    expect(command).toContain("ares-launch");
    expect(command).toContain("--inspect --display 0");
    expect(command).toContain("tv-26");
    expect(cwd).toBe("/repo/app"); // appDir, not repoRoot
    expect(timeoutMs).toBe(1234);
    expect(signatures).toEqual(
      expect.arrayContaining([expect.any(RegExp)])
    );
  });

  it("killStale pkills the ares-launch + flutter-webos drivers", async () => {
    await webos().killStale({ kind: "all-devices" });
    const patterns = runShell.mock.calls.map((c) => c[0]);
    expect(patterns).toContain("pkill -f 'ares-launch'");
    expect(patterns).toContain("pkill -f 'flutter-webos'");
  });

  it("input controller is cached (session-sticky mode)", () => {
    runShell.mockResolvedValue({ ...okResult, stdout: ARES_LIST });
    const adapter = webos();
    const first = adapter.input();
    first.setMode("pointer");
    const second = adapter.input();
    expect(second).toBe(first);
    expect(second.mode).toBe("pointer");
    expect(second.platform).toBe("webos");
  });
});
