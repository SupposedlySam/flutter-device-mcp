import { jest } from "@jest/globals";

// The scoping/attribution logic is pure over an already-read process table, so
// only the shell reads (`ps`, `ps` again for reconciliation, then `kill`) need
// mocking.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
}));

const {
  FLUTTER_RUN_DRIVER_PATTERNS,
  KILL_STALE_EXIT,
  PROCESS_PAIRS_COMMAND,
  PROCESS_TABLE_COMMAND,
  buildDeviceIdentity,
  classifyDeviceToken,
  describeKillPlan,
  extractDeviceToken,
  killScopedLaunchDrivers,
  parseProcessPairs,
  parseProcessTable,
  planScopedKill,
  reconcileProcessTable,
} = await import("../src/killStaleScope.js");

const PHONE = "988a1b413950494c49";
const EMULATOR = "emulator-5554";
const OTHER_EMULATOR = "emulator-5556";

// Captured verbatim from `ps -Awwo pid=,ppid=,command=` on the host where the
// collision happened: a session this MCP launched on the physical phone (note
// the QUOTED serial in the pty forwarder's argv), its Dart snapshot, its
// compiler, and the `adb -s <serial> … logcat` child a live session keeps.
const PHONE_SESSION = [
  "86630     1 /Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python /Users/dev/flutter-device-mcp/scripts/pty-control-forward.py /var/folders/v_/T/flutter-device-mcp-control-2026-09-04T15-08-46-104Z-86629.fifo fvm flutter run --debug -d '988a1b413950494c49'",
  "86631 86630 fvm flutter run --debug -d 988a1b413950494c49",
  "86633 86631 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dartvm --packages=/Users/dev/fvm/versions/3.44.0/packages/flutter_tools/.dart_tool/package_config.json /Users/dev/fvm/versions/3.44.0/bin/cache/flutter_tools.snapshot run --debug -d 988a1b413950494c49",
  "86699 86633 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dartaotruntime /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/snapshots/frontend_server_aot.dart.snapshot --sdk-root /Users/dev/flutter_patched_sdk/ --incremental --target=flutter",
  "86701 86633 /Users/dev/Library/Android/sdk/platform-tools/adb -s 988a1b413950494c49 shell -x logcat -v time -T '09-04 11:08:53.033'",
];

// The same shape on the emulator — the other target attached to the same host.
const EMULATOR_SESSION = [
  "90010     1 /Applications/Xcode.app/Contents/MacOS/Python /Users/dev/flutter-device-mcp/scripts/pty-control-forward.py /var/folders/v_/T/flutter-device-mcp-control-emu.fifo fvm flutter run --debug -d 'emulator-5554'",
  "90011 90010 fvm flutter run --debug -d emulator-5554",
  "90013 90011 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dartvm /Users/dev/fvm/versions/3.44.0/bin/cache/flutter_tools.snapshot run --debug -d emulator-5554",
  "90080 90013 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dartaotruntime /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/snapshots/frontend_server_aot.dart.snapshot --sdk-root /Users/dev/flutter_patched_sdk/",
  "90081 90013 /Users/dev/Library/Android/sdk/platform-tools/adb -s emulator-5554 shell -x logcat -v time",
];

// The IDE's own Dart processes, which a host-wide match took down as collateral.
const IDE_PROCESSES = [
  "11668 10348 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dartvm --packages=/Users/dev/flutter_tools/.dart_tool/package_config.json /Users/dev/fvm/versions/3.44.0/bin/cache/flutter_tools.snapshot daemon",
  "11669 10348 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dart language-server --protocol=lsp --client-id=VS-Code",
  "11670 10348 /Users/dev/fvm/versions/3.44.0/bin/cache/dart-sdk/bin/dartaotruntime /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /Users/dev/flutter_patched_sdk/ --incremental",
];

function table(...groups: string[][]): string {
  return groups.flat().join("\n") + "\n";
}

/** Pairs corroborating every row of `psOutput` (what the second ps read returns). */
function pairsFor(psOutput: string): string {
  return parseProcessTable(psOutput)
    .map((p) => `${p.pid} ${p.ppid}`)
    .join("\n");
}

/** Two attached Android devices: the phone and the emulator, distinct models. */
const TWO_ANDROID_DEVICES = [
  { id: PHONE, aliases: ["Pixel_7", "panther"], available: true },
  { id: EMULATOR, aliases: ["sdk_gphone64_arm64", "emu64a"], available: true },
];

function identityFor(target: string, devices = TWO_ANDROID_DEVICES) {
  return buildDeviceIdentity({ target, devices });
}

function planFor(
  psOutput: string,
  identity?: ReturnType<typeof buildDeviceIdentity>,
  extra: Record<string, unknown> = {}
) {
  return planScopedKill({
    processes: parseProcessTable(psOutput),
    driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
    identity,
    ...extra,
  });
}

const ascending = (pids: readonly number[]) => [...pids].sort((a, b) => a - b);

describe("the process-table reads", () => {
  it("asks for UNTRUNCATED argv, because the -d sits at the end of a long one", () => {
    // Without -ww, `ps` truncates the command column to the terminal width when
    // stdout is not a tty (a Linux CI host, or this server's captured pipe), and
    // the `-d <serial>` is at the END of the command line — the match would be
    // missed silently, with no error to notice.
    expect(PROCESS_TABLE_COMMAND).toContain("-Aww");
    expect(PROCESS_TABLE_COMMAND).toContain("command=");
    // The reconciliation read must carry NO argv at all: that is what makes it
    // the authority on which (pid, ppid) pairs exist.
    expect(PROCESS_PAIRS_COMMAND).not.toContain("command");
  });
});

describe("parseProcessTable / reconcileProcessTable", () => {
  it("reads pid, ppid and the FULL argv (the -d argument lives there, not in comm)", () => {
    const [wrapper, shim] = parseProcessTable(table(PHONE_SESSION.slice(0, 2)));
    expect(wrapper).toMatchObject({ pid: 86630, ppid: 1 });
    expect(shim).toMatchObject({
      pid: 86631,
      ppid: 86630,
      command: "fvm flutter run --debug -d 988a1b413950494c49",
    });
  });

  it("drops the PHANTOM rows an argv containing a newline splits into", () => {
    // A newline inside an argv makes `ps` emit what looks like another row; its
    // leading numbers parse as a pid and ppid, and a phantom whose "ppid" is a
    // targeted driver would be signalled with no relationship to it.
    const withNewlineArgv =
      `100     1 fvm flutter run --debug -d ${EMULATOR}\n` +
      "200   100 some-proc --note 'line one\n" +
      "4242   100 innocent-bystander --totally-unrelated\n";
    const rows = parseProcessTable(withNewlineArgv);
    expect(rows.map((r) => r.pid)).toContain(4242);

    // The command-free read is the authority: it has no argv to break on.
    const pairs = parseProcessPairs("  100     1\n  200   100\n");
    const reconciled = reconcileProcessTable(rows, pairs);
    expect(reconciled.map((r) => r.pid)).toEqual([100, 200]);
  });

  it("does not read a degraded ps's stderr line as a process row", () => {
    const rows = parseProcessTable("2026 09 04 ps failed to read kmem");
    // It parses (two leading numbers), which is exactly why reconciliation is
    // what decides: no such (pid, ppid) pair exists.
    expect(reconcileProcessTable(rows, parseProcessPairs(""))).toEqual([]);
  });
});

describe("extractDeviceToken", () => {
  it("reads the QUOTED serial this MCP's own pty launch puts in argv", () => {
    expect(extractDeviceToken(PHONE_SESSION[0])).toBe(PHONE);
  });

  it.each([
    ["fvm flutter run --debug -d emulator-5554", EMULATOR],
    ["flutter run --device-id emulator-5554", EMULATOR],
    ["flutter run --device-id=emulator-5554", EMULATOR],
    ["flutter run -demulator-5554", EMULATOR],
  ])("reads %s", (command, expected) => {
    expect(extractDeviceToken(command)).toBe(expected);
  });

  it("re-joins a QUOTED multi-word device name, as iOS addresses a device", () => {
    expect(
      extractDeviceToken("fvm flutter run --debug -d 'My iPhone' --dart-define=X=1")
    ).toBe("My iPhone");
  });

  it("returns undefined when the command names no device", () => {
    expect(extractDeviceToken("fvm flutter run --debug")).toBeUndefined();
  });
});

describe("buildDeviceIdentity", () => {
  it("keeps an alias only when no OTHER attached device claims it", () => {
    // Two emulators booted from one AVD image report identical model/product.
    const identity = buildDeviceIdentity({
      target: EMULATOR,
      devices: [
        { id: EMULATOR, aliases: ["sdk_gphone64_arm64"], available: true },
        { id: OTHER_EMULATOR, aliases: ["sdk_gphone64_arm64"], available: true },
      ],
    });
    expect(identity.target).toEqual([EMULATOR]);
    // Shared, so it decides nothing either way — not the target's, and not
    // read as the other device's either.
    expect(identity.ambiguous).toEqual(["sdk_gphone64_arm64"]);
    expect(identity.others).not.toContain("sdk_gphone64_arm64");
    expect(identity.soleAttached).toBe(false);
  });

  it("keeps a unique alias, so `-d Pixel_7` still names the phone", () => {
    expect(identityFor(PHONE).target).toEqual([PHONE, "Pixel_7", "panther"]);
  });

  it("claims nothing about other devices when the target is not attached", () => {
    const identity = buildDeviceIdentity({ target: "ghost-serial", devices: [] });
    expect(identity).toEqual({
      target: ["ghost-serial"],
      others: [],
      ambiguous: [],
      soleAttached: false,
    });
  });

  it("reports soleAttached only when the target is the one available device", () => {
    expect(
      buildDeviceIdentity({
        target: EMULATOR,
        devices: [{ id: EMULATOR, available: true }],
      }).soleAttached
    ).toBe(true);
    expect(identityFor(EMULATOR).soleAttached).toBe(false);
  });
});

describe("classifyDeviceToken", () => {
  it("does NOT read a physical iPhone's default name as a simulator's", () => {
    // Live ammunition: a physical iPhone is called "iPhone", `-d` accepts a
    // name, and a prefix rule without a uniqueness test made a deploy to a
    // simulator called "iPhone 16 Pro" kill the phone's healthy session.
    const identity = buildDeviceIdentity({
      target: "SIM-UDID-1",
      devices: [
        { id: "SIM-UDID-1", aliases: ["iPhone 16 Pro"], available: true },
        { id: "00008020-001A2D021AF3002E", aliases: ["iPhone"], available: true },
      ],
    });
    expect(classifyDeviceToken("iPhone", identity)).toBe("other");
    expect(classifyDeviceToken("iPhone 16 Pro", identity)).toBe("target");
  });

  it("honors the `-d emu` prefix when it is unambiguous (the motivating case)", () => {
    const identity = buildDeviceIdentity({
      target: EMULATOR,
      devices: [{ id: EMULATOR, available: true }],
    });
    expect(classifyDeviceToken("emu", identity)).toBe("target");
    expect(classifyDeviceToken("e", identity)).toBe("target");
  });

  it("refuses a prefix that fits TWO attached devices", () => {
    const identity = buildDeviceIdentity({
      target: EMULATOR,
      devices: [
        { id: EMULATOR, available: true },
        { id: OTHER_EMULATOR, available: true },
      ],
    });
    expect(classifyDeviceToken("emulator-55", identity)).toBe("unknown");
    expect(classifyDeviceToken("emulator", identity)).toBe("unknown");
    expect(classifyDeviceToken(EMULATOR, identity)).toBe("target");
    expect(classifyDeviceToken(OTHER_EMULATOR, identity)).toBe("other");
  });

  it("refuses a model name two devices share, with no prefix rule involved", () => {
    // Plain equality, no prefix rule: the alias is simply not an identity. And
    // it is UNKNOWN rather than "another device's" — the session naming it might
    // be this device's, so the honest answer is that nothing can be told.
    const identity = buildDeviceIdentity({
      target: EMULATOR,
      devices: [
        { id: EMULATOR, aliases: ["sdk_gphone64_arm64"], available: true },
        { id: OTHER_EMULATOR, aliases: ["sdk_gphone64_arm64"], available: true },
      ],
    });
    expect(classifyDeviceToken("sdk_gphone64_arm64", identity)).toBe("unknown");
    expect(classifyDeviceToken(EMULATOR, identity)).toBe("target");
    expect(classifyDeviceToken(OTHER_EMULATOR, identity)).toBe("other");
  });
});

describe("planScopedKill — two Android targets attached at once", () => {
  const both = table(PHONE_SESSION, EMULATOR_SESSION, IDE_PROCESSES);

  it("deploying to the EMULATOR kills only the emulator's session (the incident)", () => {
    const plan = planFor(both, identityFor(EMULATOR));
    expect(ascending(plan.pids)).toEqual([90010, 90011, 90013, 90080, 90081]);
    // The phone session someone else is using is untouched — the whole point.
    for (const pid of [86630, 86631, 86633, 86699, 86701]) {
      expect(plan.pids).not.toContain(pid);
    }
    expect(ascending(plan.otherDevice.map((d) => d.process.pid))).toEqual([
      86630, 86631, 86633,
    ]);
  });

  it("deploying to the PHONE kills only the phone's session", () => {
    const plan = planFor(both, identityFor(PHONE));
    expect(ascending(plan.pids)).toEqual([86630, 86631, 86633, 86699, 86701]);
    for (const pid of [90010, 90011, 90013, 90080, 90081]) {
      expect(plan.pids).not.toContain(pid);
    }
  });

  it("never touches the IDE's flutter daemon, analysis server, or compiler", () => {
    for (const target of [PHONE, EMULATOR]) {
      const plan = planFor(both, identityFor(target));
      for (const pid of [11668, 11669, 11670]) {
        expect(plan.pids).not.toContain(pid);
      }
    }
  });

  it("kills the compiler INSIDE the targeted subtree and spares the other session's", () => {
    const plan = planFor(both, identityFor(EMULATOR));
    expect(plan.compilers.map((p) => p.pid)).toEqual([90080]);
    expect(ascending(plan.sparedCompilers.map((p) => p.pid))).toEqual([
      11670, 86699,
    ]);
  });

  it("kills deepest-first, so a subtree comes down from the leaves", () => {
    const plan = planFor(both, identityFor(EMULATOR));
    expect(plan.pids.indexOf(90080)).toBeLessThan(plan.pids.indexOf(90010));
    expect(plan.pids.indexOf(90013)).toBeLessThan(plan.pids.indexOf(90011));
  });

  it("does not signal a bystander that a phantom row parented to a driver", () => {
    const withPhantom =
      table(EMULATOR_SESSION) +
      "4242 90013 innocent-bystander --totally-unrelated\n";
    const rows = reconcileProcessTable(
      parseProcessTable(withPhantom),
      parseProcessPairs(pairsFor(table(EMULATOR_SESSION)))
    );
    const plan = planScopedKill({
      processes: rows,
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      identity: identityFor(EMULATOR),
    });
    expect(plan.pids).not.toContain(4242);
  });
});

describe("planScopedKill — a session that names no device (`flutter run` with no -d)", () => {
  // Narrowing the pattern to `-d <serial>` alone would leave a genuinely wedged
  // session unkillable, so attribution has three fallbacks after the argument.
  const unscopedOnPhone = [
    "70010     1 fvm flutter run --debug",
    "70011 70010 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --debug",
    "70012 70011 /Users/dev/Library/Android/sdk/platform-tools/adb -s 988a1b413950494c49 shell -x logcat -v time",
    "70013 70011 /Users/dev/frontend_server_aot.dart.snapshot --sdk-root /x/",
  ];

  it("is attributed by the `adb -s <serial>` child a live session keeps", () => {
    const plan = planFor(table(unscopedOnPhone), identityFor(PHONE));
    expect(ascending(plan.targeted.map((d) => d.process.pid))).toEqual([
      70010, 70011,
    ]);
    expect(ascending(plan.pids)).toEqual([70010, 70011, 70012, 70013]);
    expect(plan.unattributed).toEqual([]);
  });

  it("is left alone when its subtree names a DIFFERENT device", () => {
    const plan = planFor(table(unscopedOnPhone), identityFor(EMULATOR));
    expect(plan.pids).toEqual([]);
    expect(ascending(plan.otherDevice.map((d) => d.process.pid))).toEqual([
      70010, 70011,
    ]);
  });

  it("is attributed by a pid this MCP RECORDED for the device at launch", () => {
    // The registry is proof rather than inference, and it is what tears down an
    // iOS session (no adb, so no `-s <udid>` child to read) whose argv names no
    // device — the shape the old blunt pkill cleared and a pattern cannot.
    const iosNoDeviceArg = [
      "80010     1 fvm flutter run --debug",
      "80011 80010 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --debug",
    ];
    const identity = buildDeviceIdentity({
      target: "00008020-001A2D021AF3002E",
      devices: [
        { id: "00008020-001A2D021AF3002E", aliases: ["My iPhone"], available: true },
        { id: "SIM-UDID-1", aliases: ["iPhone 16 Pro"], available: true },
      ],
    });
    expect(planFor(table(iosNoDeviceArg), identity).pids).toEqual([]);
    const withRecord = planFor(table(iosNoDeviceArg), identity, {
      knownTargetPids: [80010],
    });
    expect(ascending(withRecord.pids)).toEqual([80010, 80011]);
    expect(withRecord.targeted[0].reason).toContain("recorded");
  });

  it("is attributed to the ONLY attached device when nothing names a device", () => {
    // The single-device host: `flutter run` with no `-d` is the normal shape
    // there and cannot be running on anything else. Without this the common
    // case is a silent regression — the deploy proceeds into a held lock.
    const iosNoDeviceArg = ["80020     1 fvm flutter run --debug"];
    const sole = buildDeviceIdentity({
      target: "00008020-001A2D021AF3002E",
      devices: [{ id: "00008020-001A2D021AF3002E", available: true }],
    });
    const plan = planFor(table(iosNoDeviceArg), sole);
    expect(plan.pids).toEqual([80020]);
    expect(plan.targeted[0].reason).toContain("only device attached");
  });

  it("is REPORTED, not killed, when two devices are attached and nothing names one", () => {
    const orphan = ["70020     1 fvm flutter run --debug"];
    const plan = planFor(table(orphan), identityFor(EMULATOR));
    expect(plan.pids).toEqual([]);
    expect(plan.unattributed.map((d) => d.process.pid)).toEqual([70020]);
    const note = describeKillPlan(plan, EMULATOR);
    expect(note).toContain("could not be attributed");
    expect(note).toContain("70020");
    // It reports; it does not hand back a blind kill to paste.
    expect(note).not.toMatch(/kill \d/);
  });

  it("reports a driver whose -d names nothing attached as UNATTRIBUTED, not another device's", () => {
    const detached = [`70030     1 fvm flutter run --debug -d ${OTHER_EMULATOR}`];
    const plan = planFor(table(detached), identityFor(EMULATOR));
    expect(plan.pids).toEqual([]);
    expect(plan.unattributed.map((d) => d.process.pid)).toEqual([70030]);
    expect(plan.otherDevice).toEqual([]);
  });
});

describe("planScopedKill — the cases the old blunt kill got right", () => {
  it("kills BOTH a wedged and a fresh session on the SAME device", () => {
    const wedged = [
      "60010     1 fvm flutter run --profile -d emulator-5554",
      "60011 60010 /Users/dev/flutter_tools.snapshot run --profile -d emulator-5554",
    ];
    const plan = planFor(table(wedged, EMULATOR_SESSION), identityFor(EMULATOR));
    expect(plan.pids).toContain(60010);
    expect(plan.pids).toContain(90010);
  });

  it("kills a session regardless of its launch MODE (debug and profile alike)", () => {
    const profileSession = ["60020     1 fvm flutter run --profile -d emulator-5554"];
    expect(planFor(table(profileSession), identityFor(EMULATOR)).pids).toEqual([
      60020,
    ]);
  });

  it("reports nothing found — not a failure — when no session is running", () => {
    const plan = planFor(table(IDE_PROCESSES), identityFor(EMULATOR));
    expect(plan.pids).toEqual([]);
    expect(describeKillPlan(plan, EMULATOR)).toContain("No launch driver found");
  });
});

describe("planScopedKill — report-only patterns and the unscoped hammer", () => {
  it("names a possibly-related process it cannot identify instead of killing it", () => {
    // tvOS: an orphaned Dart snapshot is indistinguishable from an iPhone's or
    // Android's session, so it can only be named.
    const orphanSnapshot = [
      "50010     1 /Users/dev/dartvm /Users/dev/flutter_tools.snapshot run --profile -d ATV",
    ];
    const plan = planScopedKill({
      processes: parseProcessTable(table(orphanSnapshot)),
      driverPatterns: [/flutter-tvos/],
      reportOnlyPatterns: [/flutter_tools(?:\.snapshot)?\s+run(?:\s|$)/],
    });
    expect(plan.pids).toEqual([]);
    expect(plan.unrelated.map((p) => p.pid)).toEqual([50010]);
    expect(describeKillPlan(plan)).toContain("no longer identifiable");
  });

  it("never signals this MCP's own process, even if it matches a driver pattern", () => {
    // A self-protection claim with no witness is one refactor away from being
    // false: the server would kill itself mid-teardown and the caller would see
    // a dropped connection rather than a result.
    const selfRow = `${process.pid}     1 node dist/index.js flutter run --debug -d ${EMULATOR}`;
    const plan = planScopedKill({
      processes: parseProcessTable(selfRow + "\n"),
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      identity: identityFor(EMULATOR),
      protectedPids: [process.pid],
    });
    expect(plan.pids).toEqual([]);
    expect(plan.targeted).toEqual([]);
  });

  it("targets every session when no identity is given", () => {
    const plan = planFor(table(PHONE_SESSION, EMULATOR_SESSION));
    expect(plan.pids).toContain(86630);
    expect(plan.pids).toContain(90010);
  });

  it("only sweeps orphaned compilers when explicitly asked", () => {
    const processes = parseProcessTable(table(PHONE_SESSION, IDE_PROCESSES));
    const patterns = FLUTTER_RUN_DRIVER_PATTERNS;
    expect(
      planScopedKill({ processes, driverPatterns: patterns }).pids
    ).not.toContain(11670);
    expect(
      planScopedKill({
        processes,
        driverPatterns: patterns,
        sweepOrphanCompilers: true,
      }).pids
    ).toContain(11670);
  });
});

describe("killScopedLaunchDrivers", () => {
  const okResult = {
    code: 0,
    stdout: "",
    stderr: "",
    combined: "",
    success: true,
    timedOut: false,
  };

  beforeEach(() => {
    runShell.mockReset();
  });

  function mockReads(psOutput: string, pairsOutput = pairsFor(psOutput)) {
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd === PROCESS_TABLE_COMMAND) {
        return { ...okResult, stdout: psOutput, combined: psOutput };
      }
      if (cmd === PROCESS_PAIRS_COMMAND) {
        return { ...okResult, stdout: pairsOutput, combined: pairsOutput };
      }
      return okResult;
    });
  }

  /** The pids the `kill` invocation actually named, exactly. */
  function killedPids(): number[] {
    const kill = runShell.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.startsWith("kill "));
    if (!kill) return [];
    return ascending(
      kill
        .replace(/^kill\s+/, "")
        .replace(/2>&1$/, "")
        .trim()
        .split(/\s+/)
        .map(Number)
    );
  }

  it("signals ONLY the resolved device's pids, and never issues a pkill", async () => {
    mockReads(table(PHONE_SESSION, EMULATOR_SESSION, IDE_PROCESSES));
    const killed = await killScopedLaunchDrivers({
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      driverKey: "flutterRun",
      identity: identityFor(EMULATOR),
      deviceLabel: EMULATOR,
    });
    expect(killedPids()).toEqual([90010, 90011, 90013, 90080, 90081]);
    const commands = runShell.mock.calls.map((c) => c[0] as string);
    expect(commands).toContain(PROCESS_TABLE_COMMAND);
    expect(commands).toContain(PROCESS_PAIRS_COMMAND);
    // A command-line pattern cannot tell two Android sessions apart, so no
    // pattern-matching kill may be issued at all.
    expect(commands.some((c) => c.includes("pkill"))).toBe(false);
    expect(killed.flutterRun.code).toBe(KILL_STALE_EXIT.killed);
    expect(killed.flutterRun.combined).toContain("Left running, on another device");
    expect(killed.frontendServer.code).toBe(KILL_STALE_EXIT.killed);
  });

  it("does not SIGNAL a phantom row that a newline in an argv invented", async () => {
    // The one path in this module that could signal something with no
    // relationship to Flutter at all: an argv containing a newline splits into
    // rows whose leading numbers parse as a pid and a ppid, and a phantom whose
    // "ppid" is a targeted driver would be killed as its child.
    const withPhantom =
      table(EMULATOR_SESSION) +
      "200 90013 some-proc --note 'line one\n" +
      "4242 90013 innocent-bystander --totally-unrelated\n";
    mockReads(withPhantom, pairsFor(table(EMULATOR_SESSION)) + "\n200 90013\n");
    await killScopedLaunchDrivers({
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      driverKey: "flutterRun",
      identity: identityFor(EMULATOR),
      deviceLabel: EMULATOR,
    });
    expect(killedPids()).toEqual([90010, 90011, 90013, 90080, 90081, 200].sort((a, b) => a - b));
    expect(killedPids()).not.toContain(4242);
  });

  it("reports a no-match as exit 1 with a note, and signals nothing", async () => {
    mockReads(table(IDE_PROCESSES));
    const killed = await killScopedLaunchDrivers({
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      driverKey: "flutterRun",
      identity: identityFor(EMULATOR),
      deviceLabel: EMULATOR,
    });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterRun.code).toBe(KILL_STALE_EXIT.noMatch);
    expect(killed.flutterRun.combined).toContain("No launch driver found");
  });

  it("reports a FAILED scan distinctly from an empty one, and kills nothing", async () => {
    // A scan that could not run must never be reported as a host with nothing
    // running on it — that turns an outage into a clean bill of health.
    runShell.mockImplementation(async (cmd: string) =>
      cmd.startsWith("ps ")
        ? {
            ...okResult,
            code: 1,
            success: false,
            stdout: "",
            stderr: "ps: failed to read kmem",
            combined: "ps: failed to read kmem",
          }
        : okResult
    );
    const killed = await killScopedLaunchDrivers({
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      driverKey: "flutterRun",
      identity: identityFor(EMULATOR),
    });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterRun.code).toBe(KILL_STALE_EXIT.unavailable);
    expect(killed.flutterRun.code).not.toBe(KILL_STALE_EXIT.noMatch);
    expect(killed.flutterRun.combined).toContain("not 'no stale processes'");
  });

  it("kills nothing when the reconciliation read comes back empty", async () => {
    mockReads(table(EMULATOR_SESSION), "");
    const killed = await killScopedLaunchDrivers({
      driverPatterns: FLUTTER_RUN_DRIVER_PATTERNS,
      driverKey: "flutterRun",
      identity: identityFor(EMULATOR),
    });
    expect(killedPids()).toEqual([]);
    expect(killed.flutterRun.code).toBe(KILL_STALE_EXIT.unavailable);
  });
});
