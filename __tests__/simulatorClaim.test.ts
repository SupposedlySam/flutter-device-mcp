import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// Simulator claims driven through the real IosAdapter, with every xcrun/flutter/ps
// command mocked. "Another MCP process" is a claim written under a different
// pid, since every adapter in this suite shares the test runner's pid.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  runTizenCli: jest.fn(),
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
  resolveFlutterCommand: () => "flutter",
  buildTizenCliCommand: jest.fn(),
}));

const { IosAdapter } = await import("../src/adapters/ios.js");
const { claimSimulator, readClaimOwner, releaseClaim } = await import(
  "../src/simulatorClaim.js"
);

const SIM_A = "AAAA1111-1111-1111-1111-111111111111";
const SIM_B = "BBBB2222-2222-2222-2222-222222222222";
const SIM_C = "CCCC3333-3333-3333-3333-333333333333";
// The adapter checks liveness for real, so the other owner must be a live pid.
const OTHER_LIVE_PID = process.ppid;
// Above macOS's and Linux's default pid ceilings, so never a live process.
const DEAD_PID = 4_999_999;
const isAlive = (pid: number) => pid === process.pid || pid === OTHER_LIVE_PID;

const ok = (stdout = "") => ({
  code: 0,
  stdout,
  stderr: "",
  combined: stdout,
  success: true,
  timedOut: false,
});

let appDir: string;
let claimDir: string;
beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-claim-repo-"));
  claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-claim-dir-"));
  runShell.mockReset();
});
afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(claimDir, { recursive: true, force: true });
});

function ios() {
  return new IosAdapter(
    { appDir, appId: "com.example.app", flutterCommand: "flutter", simulatorClaimDir: claimDir }
  );
}

/** A claim held by some other MCP process. */
function claimAs(pid: number, udid: string) {
  const outcome = claimSimulator({ candidates: [{ udid }], dir: claimDir, pid, isAlive });
  expect(outcome).toEqual({ kind: "claimed", udid });
}

function host(opts: { booted: string[]; processTable?: string }) {
  const sims = [SIM_A, SIM_B, SIM_C];
  runShell.mockImplementation(async (cmd: string) => {
    if (cmd.includes("devicectl list devices")) return ok("");
    if (cmd.includes("devices --machine")) return ok("[]");
    if (cmd.includes("simctl list devices --json")) {
      return ok(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": sims.map((udid, i) => ({
              udid,
              name: `Sim Q${i + 1}`,
              state: opts.booted.includes(udid) ? "Booted" : "Shutdown",
              isAvailable: true,
            })),
          },
        })
      );
    }
    if (cmd.includes("-showdestinations")) {
      return ok(
        `Available destinations for the "Runner" scheme:\n` +
          sims
            .map((id) => `  { platform:iOS Simulator, id:${id}, OS:18.0, name:iPhone 15 }`)
            .join("\n")
      );
    }
    if (cmd === "ps -Awwo pid=,ppid=,command=") return ok(opts.processTable ?? "");
    if (cmd === "ps -Awwo pid=,ppid=") {
      const rows = (opts.processTable ?? "")
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)/.exec(line))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => `${m[1]} ${m[2]}`);
      return ok([`${process.pid} 1`, ...rows].join("\n"));
    }
    return ok();
  });
}

describe("simulator claims", () => {
  it("gives a second MCP process a different booted simulator than the first", async () => {
    host({ booted: [SIM_A, SIM_B] });
    claimAs(OTHER_LIVE_PID, SIM_A);

    const resolution = await ios().discoverDevice();

    expect(resolution.target).toBe(SIM_B);
    expect(resolution.source).toBe("claimed");
    expect(readClaimOwner(SIM_B, { dir: claimDir })?.pid).toBe(process.pid);
  });

  it("keeps the same simulator for every later call from the same process", async () => {
    host({ booted: [SIM_A, SIM_B, SIM_C] });
    const first = await ios().discoverDevice();
    // A call carrying app_dir builds a fresh adapter; the process's claim must hold.
    const later = ios();

    const second = await later.discoverDevice();

    expect(first.target).toBe(SIM_A);
    expect(second.target).toBe(SIM_A);
    expect(later.deviceClaim()).toMatchObject({ device: SIM_A, name: "Sim Q1" });
  });

  it("moves to another simulator when the claimed one is shut down, releasing the old claim", async () => {
    host({ booted: [SIM_A, SIM_B, SIM_C] });
    await ios().discoverDevice();
    host({ booted: [SIM_B, SIM_C] });

    const resolution = await ios().discoverDevice();

    expect(resolution.target).toBe(SIM_B);
    expect(readClaimOwner(SIM_A, { dir: claimDir })).toBeUndefined();
  });

  it("takes over a claim whose owner pid is dead", async () => {
    host({ booted: [SIM_A, SIM_B] });
    claimAs(DEAD_PID, SIM_A);
    claimAs(OTHER_LIVE_PID, SIM_B);

    const resolution = await ios().discoverDevice();

    expect(resolution.target).toBe(SIM_A);
    expect(readClaimOwner(SIM_A, { dir: claimDir })?.pid).toBe(process.pid);
  });

  it("skips a simulator another session's flutter run is attached to", async () => {
    host({
      booted: [SIM_A, SIM_B],
      processTable: `5100 1 /bin/zsh flutter run --debug -d ${SIM_A}\n`,
    });

    const resolution = await ios().discoverDevice();

    expect(resolution.target).toBe(SIM_B);
  });

  it("honors an explicit device_udid even when another process holds that simulator", async () => {
    host({ booted: [SIM_A, SIM_B] });
    claimAs(OTHER_LIVE_PID, SIM_A);
    const adapter = ios();

    const resolution = await adapter.discoverDevice({ udid: SIM_A });

    expect(resolution.target).toBe(SIM_A);
    expect(resolution.source).toBe("pin");
    expect(adapter.deviceClaim()).toBeUndefined();
    expect(readClaimOwner(SIM_A, { dir: claimDir })?.pid).toBe(OTHER_LIVE_PID);
  });

  it("uses the only booted simulator as before, without claiming it", async () => {
    host({ booted: [SIM_A] });
    claimAs(OTHER_LIVE_PID, SIM_A);
    const adapter = ios();

    const resolution = await adapter.discoverDevice();

    expect(resolution.target).toBe(SIM_A);
    expect(resolution.source).toBe("discovered");
    expect(adapter.deviceClaim()).toBeUndefined();
  });

  it("refuses, naming every booted simulator and its holder, when none is free", async () => {
    host({
      booted: [SIM_A, SIM_B],
      processTable: `5100 1 /bin/zsh flutter run --debug -d ${SIM_B}\n`,
    });
    claimAs(OTHER_LIVE_PID, SIM_A);

    const refusal = ios().discoverDevice();

    await expect(refusal).rejects.toThrow(
      new RegExp(
        `${SIM_A} \\(Sim Q1\\): claimed by flutter-device-mcp pid ${OTHER_LIVE_PID}; ` +
          `${SIM_B} \\(Sim Q2\\): another session's flutter run is attached \\(pid 5100\\)`
      )
    );
    await expect(ios().discoverDevice()).rejects.toThrow(/Pass device_udid.*boot another simulator/);
  });

  it("releases only a claim this process holds", () => {
    claimAs(OTHER_LIVE_PID, SIM_A);

    releaseClaim(SIM_A, { dir: claimDir, isAlive });

    expect(readClaimOwner(SIM_A, { dir: claimDir, isAlive })?.pid).toBe(OTHER_LIVE_PID);
  });
});
