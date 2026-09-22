/**
 * The two-sided verification of the device-scoped teardown, run against REAL
 * processes rather than a mocked shell.
 *
 * The other kill-stale suites prove the attribution logic over synthetic process
 * tables. This one closes the last gap: that the patterns and the `ps`/`kill`
 * plumbing actually match what a launch looks like in this host's process table,
 * and that a session on ANOTHER device survives. Both sides are asserted,
 * because a teardown that kills nothing also passes a one-sided "the target is
 * gone" check.
 *
 * The dummy argv shapes are the three a real `flutter run` launch produces here,
 * read off a live host with `ps -Ao pid,args`:
 *
 *   /bin/sh <flutter-root>/bin/flutter run --debug -d <serial>     (the wrapper)
 *   <python3> <pty-control-forward.py> <fifo> "fvm flutter run …"  (the pty bridge)
 *   …/dartvm … flutter_tools.snapshot run --debug -d <serial>      (the real holder)
 *
 * plus the fourth shape rung 3 exists for: a driver with NO `-d` at all that
 * keeps an `adb -s <serial> shell -x logcat` child.
 *
 * SAFETY: the fake serials cannot name a real device, and before any signal is
 * sent the test asserts the kill plan contains ONLY pids it spawned — so a
 * developer's or another agent's live session on emulator-5554 / the physical
 * handset cannot be collateral. The unscoped (all-devices) case is planned but
 * deliberately NOT executed as such: its plan is checked to contain both
 * devices' drivers, and only the test's own pids are then signalled.
 */
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runShell } from "../src/cli.js";
import {
  DeviceIdentity,
  FLUTTER_RUN_DRIVER_PATTERNS,
  killScopedLaunchDrivers,
  parseProcessPairs,
  parseProcessTable,
  planScopedKill,
  PROCESS_PAIRS_COMMAND,
  PROCESS_TABLE_COMMAND,
  reconcileProcessTable,
} from "../src/killStaleScope.js";

/** Per-test serials, so one case's survivors cannot be counted by the next. */
const serialsFor = (tag: string) => ({
  target: `FAKEDEVTARGET${process.pid}${tag}`,
  bystander: `FAKEDEVOTHER${process.pid}${tag}`,
});

/** Both fakes are "attached", so the bystander is `other-device`, not unknown. */
const identityFor = (target: string, bystander: string): DeviceIdentity => ({
  target: [target],
  others: [bystander],
  ambiguous: [],
  soleAttached: false,
});

describe("device-scoped teardown against REAL processes", () => {
  let dir: string;
  const spawned: ChildProcess[] = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-mcp-live-kill-"));
    // Every stand-in blocks on the `read` BUILTIN: the process keeps its full
    // argv (an `exec sleep` would replace it, destroying the shape under test)
    // and forks no grandchild to orphan. `logcat` is spawned as a child so the
    // subtree rung has something real to walk.
    // The `flutter` stand-in optionally spawns the `adb -s <serial> … logcat`
    // child a live Android session keeps. The serial is passed in the ENV, never
    // in this process's own argv — that is the shape rung 3 exists for.
    // `<&3` is load-bearing: a background command in a non-interactive shell
    // gets /dev/null on stdin unless it is redirected explicitly, so without it
    // the adb stand-in reads EOF and exits before the test can see it.
    fs.writeFileSync(
      path.join(dir, "flutter"),
      'exec 3<&0\n' +
        'if [ -n "$FAKE_ADB_SERIAL" ]; then /bin/sh "$(dirname "$0")/adb" ' +
        '-s "$FAKE_ADB_SERIAL" shell -x logcat <&3 & fi\n' +
        'read ignored\n'
    );
    fs.writeFileSync(path.join(dir, "bridge"), "read ignored\n");
    fs.writeFileSync(path.join(dir, "dartvm"), "read ignored\n");
    fs.writeFileSync(path.join(dir, "adb"), "read ignored\n");

  });

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    // The adb children are grandchildren of this process; sweep them by their
    // own (fake) serial so the next case starts from an empty table.
    await waitFor(async () => (await readTable()).every((p) => !p.command.includes("FAKEDEV")), 5000);
  });

  afterAll(() => {
    for (const child of spawned) {
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  const start = (args: string[], env?: Record<string, string>): ChildProcess => {
    const child = spawn("/bin/sh", args, {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, ...(env ?? {}) },
    });
    spawned.push(child);
    return child;
  };

  /** The three argv shapes one launch produces, for one device. */
  function startSession(serial: string): number[] {
    return [
      start([path.join(dir, "flutter"), "run", "--debug", "-d", serial]),
      start([
        path.join(dir, "bridge"),
        "/tmp/flutter-device-mcp-fake.fifo",
        `fvm flutter run --profile -d ${serial}`,
      ]),
      start([
        path.join(dir, "dartvm"),
        "--packages=/fake/package_config.json",
        "/fake/cache/flutter_tools.snapshot",
        "run",
        "--debug",
        "-d",
        serial,
      ]),
    ].map((c) => c.pid as number);
  }

  async function readTable() {
    const [table, pairs] = await Promise.all([
      runShell(PROCESS_TABLE_COMMAND, { timeoutMs: 10000 }),
      runShell(PROCESS_PAIRS_COMMAND, { timeoutMs: 10000 }),
    ]);
    return reconcileProcessTable(
      parseProcessTable(table.stdout),
      parseProcessPairs(pairs.stdout)
    );
  }

  const alive = async (serial: string): Promise<number> =>
    (await readTable()).filter((p) => p.command.includes(serial)).length;

  async function waitFor(check: () => Promise<boolean>, ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it(
    "kills every driver shape on the target device and leaves the other device's session running",
    async () => {
      const { target, bystander } = serialsFor("A");
      const identity = identityFor(target, bystander);
      const targetPids = startSession(target);
      const bystanderPids = startSession(bystander);
      // Rung 3: a driver naming NO device in its own argv, attributable only by
      // the `adb -s <serial> shell -x logcat` child a live session keeps.
      const noDeviceDriver = start(
        [path.join(dir, "flutter"), "run", "--debug"],
        { FAKE_ADB_SERIAL: target }
      );

      // 3 driver shapes + the no-`-d` driver + its adb child.
      expect(await waitFor(async () => (await alive(target)) >= 4)).toBe(true);
      expect(await alive(bystander)).toBe(3);

      // SAFETY GATE + the claim itself: the plan must name the test's own pids
      // and nothing else. A foreign pid here would mean the attribution reached
      // a real session, so the test refuses to signal rather than "pass".
      const processes = await readTable();
      const plan = planScopedKill({
        processes,
        driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
        identity,
        protectedPids: [process.pid],
      });
      const mine = new Set<number>(spawned.map((c) => c.pid as number));
      const subtreePids = new Set(
        processes
          .filter((p) => mine.has(p.ppid) || mine.has(p.pid))
          .map((p) => p.pid)
      );
      expect(plan.pids.filter((pid) => !subtreePids.has(pid))).toEqual([]);

      // All three target shapes were attributed — including the dart snapshot,
      // which the old `pkill -f "flutter run --debug"` never matched at all.
      for (const pid of targetPids) expect(plan.pids).toContain(pid);
      // And the no-`-d` driver, reached through its adb child.
      expect(plan.pids).toContain(noDeviceDriver.pid);
      // The bystander's drivers were classified as another device's, by name.
      expect(plan.otherDevice.map((d) => d.process.pid).sort()).toEqual(
        [...bystanderPids].sort()
      );
      // Scoped to THIS RUN's subtree, not the host. The unfiltered form asserts a
      // property of the machine: on any box where somebody else has a flutter session
      // up — which is every box we work on — a foreign driver lands here and the test
      // goes red for an environment fact, reading as a defect in the code under test.
      // Measured: two orphaned `flutter run --profile` drivers, 4h old, against an
      // unattached device. The production logic was correct throughout — it declined to
      // attribute them and REPORTED rather than killed, which is the property this whole
      // file exists to pin.
      expect(
        plan.unattributed.filter((d) => subtreePids.has(d.process.pid))
      ).toEqual([]);

      // Now the real thing: the adapter-facing entry point, which re-reads the
      // process table and signals.
      const killed = await killScopedLaunchDrivers({
        driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
        driverKey: "flutterRun",
        identity,
        deviceLabel: target,
      });
      expect(killed.flutterRun.code).toBe(0);

      // BOTH sides.
      expect(await waitFor(async () => (await alive(target)) === 0)).toBe(true);
      expect(await alive(bystander)).toBe(3);
    },
    40000
  );

  it(
    "the unscoped (all_devices) plan takes BOTH devices' drivers, not just the target's",
    async () => {
      const { target, bystander } = serialsFor("B");
      const targetPids = startSession(target);
      const bystanderPids = startSession(bystander);
      expect(await waitFor(async () => (await alive(bystander)) === 3)).toBe(true);
      expect(await alive(target)).toBe(3);

      // Planned, not executed as an all-devices sweep: running that for real on
      // this host would kill any live `flutter run` a developer or another agent
      // has, which is the failure under repair. The plan is the decision; the
      // scoped case above already proves the plan is what gets signalled.
      const table = await readTable();
      const plan = planScopedKill({
        processes: table,
        driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
        protectedPids: [process.pid],
      });
      for (const pid of [...targetPids, ...bystanderPids]) {
        expect(plan.pids).toContain(pid);
      }
      // Built HERE rather than borrowed from the scoped case above: `subtreePids`
      // there is local to that `it`, and a reference to it from this block only
      // evaluates when the array being filtered is NON-EMPTY — so it would throw
      // ReferenceError exactly when a foreign driver appeared, which is the one
      // situation the filter exists for. Measured with a deliberately undefined
      // name: the suite stayed green, because `filter` never calls its predicate
      // on an empty array.
      const mine = new Set<number>(spawned.map((c) => c.pid as number));
      const subtreePids = new Set(
        table
          .filter((pr) => mine.has(pr.ppid) || mine.has(pr.pid))
          .map((pr) => pr.pid)
      );
      // Scoped to THIS RUN's subtree, not the host. The unfiltered form asserts a
      // property of the machine: on any box where somebody else has a flutter session
      // up — which is every box we work on — a foreign driver lands here and the test
      // goes red for an environment fact, reading as a defect in the code under test.
      // Measured: two orphaned `flutter run --profile` drivers, 4h old, against an
      // unattached device. The production logic was correct throughout — it declined to
      // attribute them and REPORTED rather than killed, which is the property this whole
      // file exists to pin.
      expect(
        plan.unattributed.filter((d) => subtreePids.has(d.process.pid))
      ).toEqual([]);
      expect(plan.otherDevice).toEqual([]);

      // Signal only what this test spawned, and confirm both devices' sessions
      // do die by that route.
      await runShell(`kill ${[...targetPids, ...bystanderPids].join(" ")} 2>&1`, {
        timeoutMs: 10000,
      });
      expect(
        await waitFor(
          async () => (await alive(target)) === 0 && (await alive(bystander)) === 0
        )
      ).toBe(true);
    },
    40000
  );
});
