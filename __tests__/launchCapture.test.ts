import fs from "fs";
import {
  allocateControlChannel,
  buildPtyCaptureCommand,
  createLogPath,
  evaluateLaunchLog,
  pollLogForUri,
} from "../src/launchCapture.js";
import { isLaunchFailure } from "../src/types.js";
import { TIZEN_FAILURE_SIGNATURES } from "../src/adapters/tizen.js";
import { mockBuildPtyCaptureCommand } from "./support/mockBuildPtyCaptureCommand.js";

// The neutral launch core takes the failure signatures as input. We exercise it
// with the Tizen signature set so the extracted-core behavior is asserted to be
// identical to the former deploy.ts.
const SIGS = TIZEN_FAILURE_SIGNATURES;

// flutter-tizen prints this while enumerating devices even when the sdb device
// is attached and found moments later. It must never be treated as terminal.
const TRANSIENT_NO_DEVICES =
  "No devices found yet. Checking for wireless devices...\n";

const DEVICES_FOUND =
  "The following devices were found:\n" +
  "Tizen ExampleTizenTV (mobile) • 192.0.2.7:26101 • flutter-tester • Tizen 6.5\n";

const URI_LINE =
  "A Dart VM Service on Tizen ExampleTizenTV is available at: " +
  "http://127.0.0.1:51182/tys47XX1iAw=/\n";

const NO_MATCHING_DEVICE =
  "No supported devices found with name or id matching '192.0.2.6:26101'.\n" +
  "The following devices were found:\n" +
  "Tizen ExampleTizenTV (mobile) • 192.0.2.7:26101 • flutter-tester • Tizen 6.5\n";

describe("evaluateLaunchLog", () => {
  it("keeps polling on the transient 'No devices found yet' progress line", () => {
    expect(evaluateLaunchLog(TRANSIENT_NO_DEVICES, SIGS).kind).toBe("pending");
    expect(
      evaluateLaunchLog(TRANSIENT_NO_DEVICES + DEVICES_FOUND, SIGS).kind
    ).toBe("pending");
  });

  it("returns the URI when it arrives after the transient line", () => {
    const evaluation = evaluateLaunchLog(
      TRANSIENT_NO_DEVICES + DEVICES_FOUND + URI_LINE,
      SIGS
    );
    expect(evaluation).toEqual({
      kind: "uri",
      uri: {
        http: "http://127.0.0.1:51182/tys47XX1iAw=/",
        ws: "ws://127.0.0.1:51182/tys47XX1iAw=/ws",
      },
    });
  });

  it("fails on a genuine terminal failure after the transient line", () => {
    const evaluation = evaluateLaunchLog(
      TRANSIENT_NO_DEVICES + "Unable to find suitable devices.\n",
      SIGS
    );
    expect(evaluation.kind).toBe("failure");
  });

  it("fails on an immediate terminal 'No devices found.' line", () => {
    expect(evaluateLaunchLog("No devices found.\n", SIGS).kind).toBe("failure");
    expect(evaluateLaunchLog("No devices connected.\n", SIGS).kind).toBe(
      "failure"
    );
  });

  it("fails on the terminal 'no matching device' output (stale -d target)", () => {
    expect(evaluateLaunchLog(NO_MATCHING_DEVICE, SIGS).kind).toBe("failure");
    expect(
      evaluateLaunchLog(TRANSIENT_NO_DEVICES + NO_MATCHING_DEVICE, SIGS).kind
    ).toBe("failure");
  });

  it("fails on install errors regardless of device chatter", () => {
    const evaluation = evaluateLaunchLog(
      TRANSIENT_NO_DEVICES + DEVICES_FOUND + "Install failed: -12\n",
      SIGS
    );
    expect(evaluation.kind).toBe("failure");
  });

  it("stays pending on empty or unremarkable output", () => {
    expect(evaluateLaunchLog("", SIGS).kind).toBe("pending");
    expect(evaluateLaunchLog("Installing TPK...\n", SIGS).kind).toBe("pending");
  });

  it("stays pending when no signatures are supplied and no URI present", () => {
    expect(evaluateLaunchLog("No devices found.\n", []).kind).toBe("pending");
  });
});

describe("buildPtyCaptureCommand", () => {
  // Standardized on `/bin/sh -c` for ALL platforms so the bare-vs-compound-inner
  // distinction (the historical bug class) disappears. `platform` is injected so
  // no assertion depends on the host's process.platform.
  const SIMPLE = "flutter run --no-build --debug -d 'SIM-1'";
  const COMPOUND = "export PATH='/opt/bin:'\"$PATH\"; ares-launch -d 'tv1' && echo ok";
  // A control channel = the durable FIFO + the pty bridge that carries it into
  // flutter's terminal. Both halves are fixed values here so the composed launch
  // command can be asserted byte-for-byte.
  const CHANNEL = {
    fifoPath: "/tmp/ctl.fifo",
    forwarder: {
      python: "/usr/bin/python3",
      script: "/pkg/scripts/pty-control-forward.py",
    },
  };

  it("uses the darwin `script -q /dev/null /bin/sh -c '<inner>'` form", () => {
    expect(buildPtyCaptureCommand({ inner: SIMPLE, platform: "darwin" })).toBe(
      `exec script -q /dev/null /bin/sh -c '${SIMPLE.replace(/'/g, "'\\''")}'`
    );
  });

  it("uses the util-linux `script -q -c '<inner>' /dev/null` form on linux", () => {
    expect(buildPtyCaptureCommand({ inner: SIMPLE, platform: "linux" })).toBe(
      `exec script -q -c '${SIMPLE.replace(/'/g, "'\\''")}' /dev/null`
    );
  });

  it("prepends `cd <quoted cwd> &&` only when cwd is supplied", () => {
    expect(
      buildPtyCaptureCommand({ inner: SIMPLE, cwd: "/repo/app", platform: "darwin" })
    ).toBe(
      `cd '/repo/app' && exec script -q /dev/null /bin/sh -c '${SIMPLE.replace(/'/g, "'\\''")}'`
    );
    // No cwd → no leading `cd`.
    expect(buildPtyCaptureCommand({ inner: SIMPLE, platform: "darwin" })).not.toContain(
      "cd "
    );
  });

  it("survives a compound inner on darwin (single `/bin/sh -c` payload)", () => {
    const cmd = buildPtyCaptureCommand({ inner: COMPOUND, platform: "darwin" });
    // The whole compound is one `/bin/sh -c` argument — `export` is NOT handed to
    // `script` as argv[0] (the historical BSD defect).
    expect(cmd).toBe(
      `exec script -q /dev/null /bin/sh -c '${COMPOUND.replace(/'/g, "'\\''")}'`
    );
    expect(cmd).not.toContain("/dev/null export PATH");
  });

  it("survives a compound inner on linux (quoted `-c` payload)", () => {
    const cmd = buildPtyCaptureCommand({ inner: COMPOUND, platform: "linux" });
    expect(cmd).toBe(
      `exec script -q -c '${COMPOUND.replace(/'/g, "'\\''")}' /dev/null`
    );
  });

  it("always preserves the leading `exec` (pty owner outlives the poll)", () => {
    expect(
      buildPtyCaptureCommand({ inner: SIMPLE, platform: "darwin" }).startsWith("exec ")
    ).toBe(true);
    expect(
      buildPtyCaptureCommand({ inner: SIMPLE, platform: "linux" }).startsWith("exec ")
    ).toBe(true);
    // With a cwd the exec follows the `cd … &&`.
    expect(
      buildPtyCaptureCommand({ inner: SIMPLE, cwd: "/x", platform: "linux" })
    ).toContain("&& exec script -q");
  });

  // Drift guard for the adapter tests. Those suites mock the whole
  // launchCapture.js module (to stub the side-effecting launchAndCaptureUri), and
  // this jest 29 native-ESM setup has no requireActual/importActual for ES modules
  // (an in-factory dynamic import of the mocked specifier re-enters the factory),
  // so the pure buildPtyCaptureCommand cannot be pulled from source inside the
  // mock. They therefore share ONE stand-in
  // (__tests__/support/mockBuildPtyCaptureCommand). This test — which imports the
  // REAL helper (this file does NOT mock launchCapture.js) — pins that stand-in
  // byte-for-byte against the real implementation across every input shape, so any
  // future drift in the source fails HERE loudly instead of silently in the mock.
  it("the shared adapter-test stand-in matches the real buildPtyCaptureCommand", () => {
    const platforms: NodeJS.Platform[] = ["darwin", "linux"];
    const inners = [SIMPLE, COMPOUND];
    const cwds: (string | undefined)[] = [undefined, "/repo/app"];
    const channels = [undefined, CHANNEL];
    for (const platform of platforms) {
      for (const inner of inners) {
        for (const cwd of cwds) {
          for (const controlChannel of channels) {
            expect(
              mockBuildPtyCaptureCommand({ inner, cwd, platform, controlChannel })
            ).toBe(
              buildPtyCaptureCommand({ inner, cwd, platform, controlChannel })
            );
          }
        }
      }
    }
  });

  it("launches through the FIFO→pty bridge (NOT `script`) when a control channel is supplied", () => {
    const cmd = buildPtyCaptureCommand({
      inner: SIMPLE,
      platform: "darwin",
      controlChannel: CHANNEL,
    });
    // The bridge owns the pty and takes the FIFO as its own stdin source, so the
    // runner's stdin is a TERMINAL — the only way the flutter tool reads `r`/`R`.
    expect(cmd).toBe(
      `exec '/usr/bin/python3' '/pkg/scripts/pty-control-forward.py' '/tmp/ctl.fifo' ` +
        `'${SIMPLE.replace(/'/g, "'\\''")}'`
    );
    // `script` is NOT involved: it ioctls its own stdin, which is why handing it
    // the FIFO failed ("tcgetattr/ioctl: Operation not supported on socket").
    expect(cmd).not.toContain("script -q");
    // And no plain stdin redirect — a FIFO on fd 0 never reaches flutter's key
    // handler (singleCharMode requires a terminal), which is the defect this fixes.
    expect(cmd).not.toContain("<&3");
  });

  it("keeps the bridge form on linux too (the host `script` split no longer applies)", () => {
    expect(
      buildPtyCaptureCommand({
        inner: SIMPLE,
        platform: "linux",
        controlChannel: CHANNEL,
      })
    ).toBe(
      buildPtyCaptureCommand({
        inner: SIMPLE,
        platform: "darwin",
        controlChannel: CHANNEL,
      })
    );
  });

  it("still prepends the cwd when launching through the bridge", () => {
    expect(
      buildPtyCaptureCommand({
        inner: SIMPLE,
        cwd: "/repo/app",
        platform: "darwin",
        controlChannel: CHANNEL,
      }).startsWith("cd '/repo/app' && exec '/usr/bin/python3'")
    ).toBe(true);
  });
});

describe("allocateControlChannel", () => {
  it("returns undefined when the host has no pty bridge, so no half-built channel is recorded", () => {
    // A FIFO with no bridge accepts every write and delivers none of them.
    // Recording that as a control channel is what let flutter_hot_restart
    // report a restart it had not performed, so the FIFO is not even created.
    expect(allocateControlChannel({ forwarder: () => undefined })).toBeUndefined();
  });

  it("pairs a real FIFO with the bridge when one is available", () => {
    const forwarder = {
      python: "/usr/bin/python3",
      script: "/pkg/scripts/pty-control-forward.py",
    };
    const channel = allocateControlChannel({ forwarder: () => forwarder });
    expect(channel).toBeDefined();
    try {
      expect(channel!.forwarder).toBe(forwarder);
      // The FIFO half must exist on disk — it is the durable, cross-process end.
      expect(fs.existsSync(channel!.fifoPath)).toBe(true);
      expect(fs.statSync(channel!.fifoPath).isFIFO()).toBe(true);
    } finally {
      fs.rmSync(channel!.fifoPath, { force: true });
    }
  });
});

describe("createLogPath", () => {
  it("produces a unique .log path under a temp dir", () => {
    const a = createLogPath();
    expect(a.endsWith(".log")).toBe(true);
    expect(a).toContain("flutter-device-mcp-launch-");
  });
});

describe("pollLogForUri", () => {
  it("resolves with the URI once it appears in the log file", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, TRANSIENT_NO_DEVICES + DEVICES_FOUND + URI_LINE);
    const outcome = await pollLogForUri(logPath, 2000, 1234, SIGS);
    expect(isLaunchFailure(outcome)).toBe(false);
    if (!isLaunchFailure(outcome)) {
      expect(outcome.vmServiceUriWs).toBe(
        "ws://127.0.0.1:51182/tys47XX1iAw=/ws"
      );
      expect(outcome.pid).toBe(1234);
    }
    fs.rmSync(logPath, { force: true });
  });

  it("fails fast on a terminal failure signature", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Install failed: -12\n");
    const outcome = await pollLogForUri(logPath, 2000, 99, SIGS);
    expect(isLaunchFailure(outcome)).toBe(true);
    fs.rmSync(logPath, { force: true });
  });

  it("times out when neither a URI nor a failure appears", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Installing...\n");
    const outcome = await pollLogForUri(logPath, 200, undefined, SIGS);
    expect(isLaunchFailure(outcome)).toBe(true);
    if (isLaunchFailure(outcome)) {
      expect(outcome.reason).toContain("Timed out");
    }
    fs.rmSync(logPath, { force: true });
  });
});

describe("pollLogForUri settle contract (a launch with no URI coming)", () => {
  const SETTLE = {
    signatures: [/Flutter run key commands\./],
    reason: "no VM service in this mode",
    graceMs: 0,
  };

  it("ends the wait with an EXPLAINED empty URI instead of a timeout failure", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Installing...\nFlutter run key commands.\n");
    // The timeout is far longer than this test takes: it is the settle match,
    // not the deadline, that ends the wait — which is the whole point.
    const outcome = await pollLogForUri(logPath, 60000, 7, SIGS, undefined, SETTLE);
    expect(isLaunchFailure(outcome)).toBe(false);
    if (!isLaunchFailure(outcome)) {
      expect(outcome.vmServiceUriWs).toBe("");
      expect(outcome.noVmServiceReason).toBe("no VM service in this mode");
      expect(outcome.pid).toBe(7);
    }
    fs.rmSync(logPath, { force: true });
  });

  it("still prefers a URI printed alongside the settle line", async () => {
    // flutter's printHelp emits the settle line and the VM service line in ONE
    // synchronous burst, so a settle match must never beat a URI that is there.
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Flutter run key commands.\n" + URI_LINE);
    const outcome = await pollLogForUri(logPath, 2000, 7, SIGS, undefined, SETTLE);
    expect(isLaunchFailure(outcome)).toBe(false);
    if (!isLaunchFailure(outcome)) {
      expect(outcome.vmServiceUriWs).toBe("ws://127.0.0.1:51182/tys47XX1iAw=/ws");
      expect(outcome.noVmServiceReason).toBeUndefined();
    }
    fs.rmSync(logPath, { force: true });
  });

  it("keeps looking for the grace window before concluding no URI is coming", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Flutter run key commands.\n");
    // The URI lands after the settle line but well inside the grace window.
    setTimeout(() => fs.appendFileSync(logPath, URI_LINE), 250);
    const outcome = await pollLogForUri(logPath, 5000, 7, SIGS, undefined, {
      ...SETTLE,
      graceMs: 3000,
    });
    expect(isLaunchFailure(outcome)).toBe(false);
    if (!isLaunchFailure(outcome)) {
      expect(outcome.vmServiceUriWs).toBe("ws://127.0.0.1:51182/tys47XX1iAw=/ws");
    }
    fs.rmSync(logPath, { force: true });
  });

  it("still fails on a terminal signature rather than settling", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Flutter run key commands.\nInstall failed: -12\n");
    const outcome = await pollLogForUri(logPath, 2000, 7, SIGS, undefined, SETTLE);
    expect(isLaunchFailure(outcome)).toBe(true);
    fs.rmSync(logPath, { force: true });
  });

  it("leaves a launch with NO settle contract timing out exactly as before", async () => {
    const logPath = createLogPath();
    fs.writeFileSync(logPath, "Flutter run key commands.\n");
    const outcome = await pollLogForUri(logPath, 200, undefined, SIGS);
    expect(isLaunchFailure(outcome)).toBe(true);
    fs.rmSync(logPath, { force: true });
  });
});
