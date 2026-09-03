import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// Mock the shell layer so we can assert exactly which commands the
// MacosAdapter issues (and control their output) without spawning real
// processes or touching a real Mac's TCC state — mirrors adapters.test.ts's
// pattern for the other adapters.
const runShell = jest.fn<(cmd: string, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../src/cli.js", () => ({
  runShell,
  quote: (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`,
  tail: (t: string) => t,
}));

const okResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

function ok(stdout: string) {
  return { ...okResult, stdout, combined: stdout };
}

function fail(combined: string) {
  return { ...okResult, code: 1, success: false, stdout: "", stderr: combined, combined };
}

const { MacosAdapter, MACOS_SCREENCAPTURE_DEGENERATE_BYTES } = await import(
  "../src/adapters/macos.js"
);
const { AdapterRegistry } = await import("../src/adapters/registry.js");
const { UnsupportedInputError } = await import("../src/types.js");

const CLICLICK = "/opt/homebrew/bin/cliclick";

type Overrides = {
  appId?: string;
  appPath?: string;
  appUrl?: string;
  processName?: string;
};

/**
 * A MacosAdapter with cliclick's location PINNED, so no test depends on whether
 * the host running the suite happens to have cliclick installed.
 */
function adapter(overrides: Overrides = {}) {
  return new MacosAdapter({ ...overrides, locateCliclick: () => CLICLICK });
}

beforeEach(() => {
  runShell.mockReset();
  runShell.mockResolvedValue(okResult);
});

describe("AdapterRegistry accepts macos", () => {
  it("resolves an explicit 'macos' platform", () => {
    const registry = new AdapterRegistry([adapter()], "macos");
    expect(registry.resolve("macos").platform).toBe("macos");
  });
});

describe("MacosAdapter.build", () => {
  it("returns {supported:false} with a reason — no build toolchain here", async () => {
    const build = await adapter().build({});
    expect(build.supported).toBe(false);
    expect(build.result.success).toBe(false);
    expect(build.result.combined).toMatch(/no build path/i);
    // Never shells anything for a build attempt.
    expect(runShell).not.toHaveBeenCalled();
  });
});

describe("MacosAdapter.setup", () => {
  it("reports there is no pairing/target-file step", async () => {
    const { result, wrote } = await adapter().setup({});
    expect(result.success).toBe(true);
    expect(wrote).toBeUndefined();
    expect(result.combined).toMatch(/no pairing/i);
  });
});

describe("MacosAdapter.discoverDevice", () => {
  it("throws a clear error when nothing is staged and no pin is configured", async () => {
    await expect(adapter().discoverDevice()).rejects.toThrow(
      /No macOS app resolved/
    );
  });

  it("resolves the pinned process name as source 'pin' when it is running", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      if ((cmd as string).startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      return okResult;
    });
    const resolution = await adapter({ processName: "example-app" }).discoverDevice();
    expect(resolution.target).toBe("example-app");
    expect(resolution.source).toBe("pin");
    expect(resolution.warning).toBeUndefined();
    expect(runShell).toHaveBeenCalledWith("ps -axo pid=,comm=", { timeoutMs: 5000 });
  });

  it("self-heals a stale pin: still returns the target, with a warning, when ps finds nothing matching", async () => {
    runShell.mockResolvedValue(ok(""));
    const resolution = await adapter({ processName: "ghost-app" }).discoverDevice();
    expect(resolution.target).toBe("ghost-app");
    expect(resolution.source).toBe("stale-pin");
    expect(resolution.warning).toMatch(/does not appear to be running/);
  });

  it("reports 'discovered-offline' (not 'stale-pin') for a dead SESSION-STAGED app — it isn't a pin at all", async () => {
    const scratchParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "flutter-device-mcp-macos-test-")
    );
    try {
      const srcApp = path.join(scratchParent, "Example App.app");
      fs.mkdirSync(srcApp, { recursive: true });
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) return okResult;
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("ps -axo")) return ok(""); // dead — nothing matches
        return okResult;
      });
      const a = adapter({ appPath: srcApp });
      await a.install("local", {});
      const resolution = await a.discoverDevice();
      expect(resolution.source).toBe("discovered-offline");
    } finally {
      fs.rmSync(scratchParent, { recursive: true, force: true });
    }
  });
});

describe("MacosAdapter.install (staging)", () => {
  let scratchParent: string;

  beforeEach(() => {
    scratchParent = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-mcp-macos-test-"));
  });

  afterEach(() => {
    fs.rmSync(scratchParent, { recursive: true, force: true });
  });

  it("fails clearly when no app source is configured", async () => {
    const result = await adapter().install("local", {});
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/No macOS \.app to stage/);
  });

  it("fails clearly on an unrecognized source extension", async () => {
    const result = await adapter().install("local", { appPath: "/tmp/app.zip" });
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/Could not classify/);
  });

  it("stages a .app via ditto, reads its Info.plist, and remembers the target", async () => {
    const srcApp = path.join(scratchParent, "Example App.app");
    fs.mkdirSync(srcApp, { recursive: true });

    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ditto")) return okResult;
      if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
      if (c.includes("CFBundleExecutable")) return ok("example-app");
      return okResult;
    });

    const a = adapter({ appPath: srcApp });
    const result = await a.install("local", {});
    expect(result.success).toBe(true);
    expect(result.combined).toMatch(/Staged/);
    expect(result.combined).toMatch(/never \/Applications/);
    expect(a.appId).toBe("com.example.exampleapp");

    const dittoCall = runShell.mock.calls.find(([c]) => (c as string).startsWith("ditto"));
    expect(dittoCall![0]).toContain(`'${srcApp}'`);
  });

  it("fails clearly when the staged bundle's Info.plist can't be read", async () => {
    const srcApp = path.join(scratchParent, "Broken.app");
    fs.mkdirSync(srcApp, { recursive: true });
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ditto")) return okResult;
      return fail("no such key");
    });
    const result = await adapter({ appPath: srcApp }).install("local", {});
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/could not read CFBundleIdentifier/);
  });

  it("propagates a ditto failure (e.g. a real disk-full error) as the failure reason", async () => {
    const srcApp = path.join(scratchParent, "Example App.app");
    fs.mkdirSync(srcApp, { recursive: true });
    runShell.mockImplementation(async (cmd: unknown) => {
      if ((cmd as string).startsWith("ditto")) {
        return fail("ditto: No space left on device");
      }
      return okResult;
    });
    const result = await adapter({ appPath: srcApp }).install("local", {});
    expect(result.success).toBe(false);
    expect(result.combined).toMatch(/No space left on device/);
  });

  it("removes the scratch dir when stageApp throws (e.g. a real ditto failure)", async () => {
    const srcApp = path.join(scratchParent, "Example App.app");
    fs.mkdirSync(srcApp, { recursive: true });
    const original = fs.mkdtempSync;
    const createdDirs: string[] = [];
    const mkdtempSpy = jest
      .spyOn(fs, "mkdtempSync")
      .mockImplementation((...args: Parameters<typeof fs.mkdtempSync>) => {
        const dir = original(...args) as string;
        createdDirs.push(dir);
        return dir;
      });
    try {
      runShell.mockImplementation(async (cmd: unknown) => {
        if ((cmd as string).startsWith("ditto")) {
          return fail("ditto: No space left on device");
        }
        return okResult;
      });
      const result = await adapter({ appPath: srcApp }).install("local", {});
      expect(result.success).toBe(false);
      expect(createdDirs).toHaveLength(1);
      expect(fs.existsSync(createdDirs[0])).toBe(false);
    } finally {
      mkdtempSpy.mockRestore();
      createdDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("removes the scratch dir when the staged bundle's Info.plist is missing required keys", async () => {
    const srcApp = path.join(scratchParent, "Broken.app");
    fs.mkdirSync(srcApp, { recursive: true });
    const original = fs.mkdtempSync;
    const createdDirs: string[] = [];
    const mkdtempSpy = jest
      .spyOn(fs, "mkdtempSync")
      .mockImplementation((...args: Parameters<typeof fs.mkdtempSync>) => {
        const dir = original(...args) as string;
        createdDirs.push(dir);
        return dir;
      });
    try {
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) return okResult;
        return fail("no such key");
      });
      const result = await adapter({ appPath: srcApp }).install("local", {});
      expect(result.success).toBe(false);
      expect(createdDirs).toHaveLength(1);
      expect(fs.existsSync(createdDirs[0])).toBe(false);
    } finally {
      mkdtempSpy.mockRestore();
      createdDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("a per-call app_path (via InstallOptions.appPath) wins over the configured default", async () => {
    const configuredApp = path.join(scratchParent, "Configured.app");
    const perCallApp = path.join(scratchParent, "PerCall.app");
    fs.mkdirSync(configuredApp, { recursive: true });
    fs.mkdirSync(perCallApp, { recursive: true });
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ditto")) return okResult;
      if (c.includes("CFBundleIdentifier")) return ok("com.example.app");
      if (c.includes("CFBundleExecutable")) return ok("app-bin");
      return okResult;
    });
    await adapter({ appPath: configuredApp }).install("local", { appPath: perCallApp });
    const dittoCall = runShell.mock.calls.find(([c]) => (c as string).startsWith("ditto"));
    expect(dittoCall![0]).toContain(`'${perCallApp}'`);
    expect(dittoCall![0]).not.toContain(`'${configuredApp}'`);
  });
});

describe("MacosAdapter.launchAndCaptureUri", () => {
  it("fails clearly when nothing has been staged", async () => {
    const outcome = await adapter().launchAndCaptureUri("local", 5000);
    expect("failed" in outcome && outcome.failed).toBe(true);
    if ("reason" in outcome) expect(outcome.reason).toMatch(/No app staged/);
  });

  it("launches via `open -n`, resolves the pid, and returns EMPTY VM-service URIs (no Dart VM service exists)", async () => {
    const scratchParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "flutter-device-mcp-macos-test-")
    );
    try {
      const srcApp = path.join(scratchParent, "Example App.app");
      fs.mkdirSync(srcApp, { recursive: true });
      // install() ditto-copies srcApp into a FRESH scratch dir of its own — the
      // staged (launched) path is the ditto DESTINATION, not srcApp. Capture it
      // from the ditto command itself so the ps mock matches the real path.
      let stagedApp = "";
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) {
          const match = c.match(/^ditto '.*?' '(.*)'$/);
          stagedApp = match![1];
          return okResult;
        }
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("open -n")) return okResult;
        if (c.startsWith("ps -axo")) {
          return ok(`42668 ${stagedApp}/Contents/MacOS/example-app\n`);
        }
        return okResult;
      });
      const a = adapter({ appPath: srcApp });
      await a.install("local", {});
      const outcome = await a.launchAndCaptureUri("local", 5000);
      expect("failed" in outcome).toBe(false);
      if (!("failed" in outcome)) {
        expect(outcome.pid).toBe(42668);
        expect(outcome.vmServiceUriWs).toBe("");
        expect(outcome.vmServiceUriHttp).toBe("");
      }
    } finally {
      fs.rmSync(scratchParent, { recursive: true, force: true });
    }
  });

  it("reports a failure when `open -n` itself fails", async () => {
    const scratchParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "flutter-device-mcp-macos-test-")
    );
    try {
      const srcApp = path.join(scratchParent, "Example App.app");
      fs.mkdirSync(srcApp, { recursive: true });
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) return okResult;
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("open -n")) return fail("LSOpenURLsWithRole() failed");
        return okResult;
      });
      const a = adapter({ appPath: srcApp });
      await a.install("local", {});
      const outcome = await a.launchAndCaptureUri("local", 5000);
      expect("failed" in outcome && outcome.failed).toBe(true);
      if ("reason" in outcome) expect(outcome.reason).toMatch(/open -n. failed/);
    } finally {
      fs.rmSync(scratchParent, { recursive: true, force: true });
    }
  });
});

describe("MacosAdapter.uninstall / killStale", () => {
  it("killStale no-ops (with a clear note) when nothing was launched this session and no pin is set", async () => {
    const killed = await adapter().killStale();
    expect(killed.previousLaunch.success).toBe(true);
    expect(killed.previousLaunch.combined).toMatch(/No macOS process name known/);
  });

  it("killStale kills by the FULLY-QUALIFIED executable path (ps + kill -9, matching waitForPid) when this session launched something", async () => {
    const scratchParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "flutter-device-mcp-macos-test-")
    );
    try {
      const srcApp = path.join(scratchParent, "Example App.app");
      fs.mkdirSync(srcApp, { recursive: true });
      let stagedApp = "";
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) {
          const match = c.match(/^ditto '.*?' '(.*)'$/);
          stagedApp = match![1];
          return okResult;
        }
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("open -n")) return okResult;
        if (c.startsWith("ps -axo")) {
          return ok(`42668 ${stagedApp}/Contents/MacOS/example-app\n`);
        }
        if (c.startsWith("kill -9")) return okResult;
        return okResult;
      });
      const a = adapter({ appPath: srcApp });
      await a.install("local", {});
      await a.launchAndCaptureUri("local", 5000);
      const killed = await a.killStale();
      expect(runShell).toHaveBeenCalledWith("ps -axo pid=,comm=", { timeoutMs: 5000 });
      expect(runShell).toHaveBeenCalledWith("kill -9 42668 2>&1", { timeoutMs: 5000 });
      expect(runShell.mock.calls.some(([c]) => (c as string).startsWith("pkill"))).toBe(
        false
      );
      expect(killed.previousLaunch.success).toBe(true);
    } finally {
      fs.rmSync(scratchParent, { recursive: true, force: true });
    }
  });

  it("killStale kills by the FLUTTER_DEVICE_MACOS_PROCESS_NAME pin (bare-name ps match), surviving an MCP server restart", async () => {
    // No install()/launchAndCaptureUri() this session — simulates a fresh adapter
    // instance after a host restart, with only the pin available (in-memory
    // `processName`/`lastPid` are gone). Restart-safety requires this to still work,
    // and there is no known bundle path to qualify the match with, so this falls
    // back to a bare-name ps match (still not pgrep/pkill's kernel-name match).
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) {
        return ok("55123 /Applications/Example.app/Contents/MacOS/example-app\n");
      }
      if (c.startsWith("kill -9")) return okResult;
      return okResult;
    });
    const killed = await adapter({ processName: "example-app" }).killStale();
    expect(runShell).toHaveBeenCalledWith("ps -axo pid=,comm=", { timeoutMs: 5000 });
    expect(runShell).toHaveBeenCalledWith("kill -9 55123 2>&1", { timeoutMs: 5000 });
    expect(killed.previousLaunch.success).toBe(true);
  });

  it("killStale reports no match (not a false success) when ps finds nothing for the pin", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("");
      return okResult;
    });
    const killed = await adapter({ processName: "ghost-app" }).killStale();
    expect(killed.previousLaunch.success).toBe(true);
    expect(killed.previousLaunch.combined).toMatch(/No process matching "ghost-app" found/);
  });

  it("killStale does NOT kill an unrelated process whose path merely CONTAINS a generic bare-name pin (the substring-match defect)", async () => {
    // The unfixed code did `line.includes(marker)` — a bare pin of "Example" would
    // match ANY comm path containing that substring anywhere, including a
    // completely different, unrelated app whose executable happens to be
    // named "ExampleSomethingElse". The match must be ANCHORED to comm's
    // trailing path segment, not merely present somewhere inside it, so this
    // unrelated process must survive.
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) {
        return ok(
          "77777 /Applications/ExampleSomethingElse.app/Contents/MacOS/ExampleSomethingElse\n"
        );
      }
      if (c.startsWith("kill -9")) return okResult;
      return okResult;
    });
    const killed = await adapter({ processName: "Example" }).killStale();
    expect(
      runShell.mock.calls.some(([c]) => (c as string).startsWith("kill -9"))
    ).toBe(false);
    expect(killed.previousLaunch.combined).toMatch(/No process matching "Example" found/);
  });

  it("matches a staged app across a SYMLINKED scratch-dir path (the os.tmpdir() /var -> /private/var case) via realpath normalization", async () => {
    // os.tmpdir() returns a "/var/folders/..." path that macOS itself
    // symlinks to "/private/var/folders/...", and `open -n` + `ps` report the
    // RESOLVED form — verified live against a real signed test bundle staged
    // under a real os.tmpdir() and launched exactly as production code does
    // (see the PR thread / journal for the live proof). Reproduced here
    // deterministically (independent of the test host's own tmpdir layout) by
    // faking realpathSync to rewrite one fabricated root to another, so this
    // is not just re-testing "two identical strings compare equal".
    const symlinkRoot = "/fake-tmpdir-symlink-root";
    const realRoot = "/fake-tmpdir-real-root";
    const mkdtempSpy = jest.spyOn(fs, "mkdtempSync").mockReturnValue(symlinkRoot);
    const realpathSpy = jest
      .spyOn(fs, "realpathSync")
      .mockImplementation(((p: fs.PathLike) =>
        typeof p === "string" && p.startsWith(symlinkRoot)
          ? p.replace(symlinkRoot, realRoot)
          : p) as typeof fs.realpathSync);
    try {
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) return okResult;
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("open -n")) return okResult;
        if (c.startsWith("ps -axo")) {
          // The REAL, already-resolved path — what a live `ps` reports, never
          // the symlinked form the marker is built from.
          return ok(`42668 ${realRoot}/Example App.app/Contents/MacOS/example-app\n`);
        }
        if (c.startsWith("kill -9")) return okResult;
        return okResult;
      });
      const a = adapter({ appPath: "/somewhere/Example App.app" });
      await a.install("local", {});
      const outcome = await a.launchAndCaptureUri("local", 5000);
      expect("failed" in outcome).toBe(false);
      if (!("failed" in outcome)) expect(outcome.pid).toBe(42668);

      const killed = await a.killStale();
      expect(runShell).toHaveBeenCalledWith("kill -9 42668 2>&1", { timeoutMs: 5000 });
      expect(killed.previousLaunch.success).toBe(true);
    } finally {
      mkdtempSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it("does NOT falsely match when realpath cannot resolve either side (degrades to the pre-fix exact-string comparison, never a permissive default)", async () => {
    // If the scratch dir is already gone (or the path is otherwise
    // unresolvable), realOrSelf falls back to the raw string rather than
    // throwing or treating "unresolvable" as "equal" — so two DIFFERENT
    // unresolvable paths must still correctly NOT match.
    const symlinkRoot = "/fake-tmpdir-symlink-root-2";
    const mkdtempSpy = jest.spyOn(fs, "mkdtempSync").mockReturnValue(symlinkRoot);
    const realpathSpy = jest.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    });
    try {
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) return okResult;
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("ps -axo")) {
          // A DIFFERENT real path that just happens to share the same
          // basename — must not match via basename alone.
          return ok("42668 /Applications/SomethingElse.app/Contents/MacOS/example-app\n");
        }
        return okResult;
      });
      // killStale (single-shot, no polling) rather than launchAndCaptureUri
      // (which polls waitForPid for up to 10s on a miss) — this test is about
      // findMatchingPids's non-match behavior, not the launch wait budget.
      const a = adapter({ appPath: "/somewhere/Example App.app" });
      await a.install("local", {});
      const killed = await a.killStale();
      expect(
        runShell.mock.calls.some(([c]) => (c as string).startsWith("kill -9"))
      ).toBe(false);
      expect(killed.previousLaunch.combined).toMatch(/No process matching "example-app" found/);
    } finally {
      mkdtempSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it("killStale REFUSES to kill -9 (rather than mass-killing) when a bare restart-recovered marker matches MORE THAN ONE distinct process", async () => {
    // The asymmetry: several genuinely distinct, unrelated apps can share one
    // generic literal CFBundleExecutable (many Electron-based apps are
    // literally named "Electron"). isProcessRunning tolerates that ambiguity
    // (cosmetic — it only feeds a warning), but killStale's kill -9 must not:
    // mass-killing every match would take down apps nobody asked about.
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) {
        return ok(
          "111 /Applications/Slack.app/Contents/MacOS/Electron\n" +
            "222 /Applications/Discord.app/Contents/MacOS/Electron\n"
        );
      }
      if (c.startsWith("kill -9")) return okResult;
      return okResult;
    });
    const killed = await adapter({ processName: "Electron" }).killStale();
    expect(
      runShell.mock.calls.some(([c]) => (c as string).startsWith("kill -9"))
    ).toBe(false);
    expect(killed.previousLaunch.success).toBe(false);
    expect(killed.previousLaunch.combined).toMatch(/Refusing to kill/);
    expect(killed.previousLaunch.combined).toMatch(/111, 222/);
  });

  it("isProcessRunning (cosmetic) still reports true for the SAME ambiguous bare marker killStale refuses to act on", async () => {
    // Confirms the asymmetry is deliberate, not an accidental inconsistency:
    // discoverDevice/isProcessRunning see the same two matches killStale
    // refused above, and correctly still report the pin as running (a false
    // positive here is cosmetic, not destructive).
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) {
        return ok(
          "111 /Applications/Slack.app/Contents/MacOS/Electron\n" +
            "222 /Applications/Discord.app/Contents/MacOS/Electron\n"
        );
      }
      return okResult;
    });
    const resolution = await adapter({ processName: "Electron" }).discoverDevice();
    expect(resolution.target).toBe("Electron");
    expect(resolution.source).toBe("pin");
    expect(resolution.warning).toBeUndefined();
  });

  it("uninstall reports 'nothing to uninstall' when nothing is staged", async () => {
    const result = await adapter().uninstall("local", "com.example.app");
    expect(result.success).toBe(true);
    expect(result.combined).toMatch(/Nothing staged/);
  });

  it("uninstall kills the tracked pid and removes the scratch dir when something was launched", async () => {
    const scratchParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "flutter-device-mcp-macos-test-")
    );
    try {
      const srcApp = path.join(scratchParent, "Example App.app");
      fs.mkdirSync(srcApp, { recursive: true });
      let stagedApp = "";
      runShell.mockImplementation(async (cmd: unknown) => {
        const c = cmd as string;
        if (c.startsWith("ditto")) {
          const match = c.match(/^ditto '.*?' '(.*)'$/);
          stagedApp = match![1];
          return okResult;
        }
        if (c.includes("CFBundleIdentifier")) return ok("com.example.exampleapp");
        if (c.includes("CFBundleExecutable")) return ok("example-app");
        if (c.startsWith("open -n")) return okResult;
        if (c.startsWith("ps -axo")) {
          return ok(`42668 ${stagedApp}/Contents/MacOS/example-app\n`);
        }
        if (c.startsWith("kill -9")) return okResult;
        return okResult;
      });
      const a = adapter({ appPath: srcApp });
      await a.install("local", {});
      await a.launchAndCaptureUri("local", 5000);
      const result = await a.uninstall("local", "com.example.exampleapp");
      expect(runShell).toHaveBeenCalledWith("kill -9 42668 2>&1", { timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.combined).toMatch(/Killed pid 42668/);
      expect(result.combined).toMatch(/Removed scratch dir/);
      // Round-trips to "nothing staged" — bundleId/scratchDir/processName all cleared.
      await expect(a.discoverDevice()).rejects.toThrow(/No macOS app resolved/);
    } finally {
      fs.rmSync(scratchParent, { recursive: true, force: true });
    }
  });
});

describe("MacosAdapter lifecycle", () => {
  it("terminate quits by bundle id via osascript", async () => {
    await adapter().lifecycle.terminate("local", "com.example.exampleapp");
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining('tell application id "com.example.exampleapp" to quit'),
      expect.anything()
    );
  });

  it("foreground activates by bundle id via osascript", async () => {
    await adapter().lifecycle.foreground("local", "com.example.exampleapp");
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining('tell application id "com.example.exampleapp" to activate'),
      expect.anything()
    );
  });

  it("background activates Finder (macOS has no OS-level 'send to background' verb)", async () => {
    await adapter().lifecycle.background("local", "com.example.exampleapp");
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining('tell application "Finder" to activate'),
      expect.anything()
    );
  });

  it("terminate skips the quit Apple Event (which would otherwise LAUNCH the app) when it's already not running", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok(""); // not running
      return okResult;
    });
    const a = adapter({ processName: "example-app" });
    const result = await a.lifecycle.terminate("local", "com.example.exampleapp");
    expect(result.success).toBe(true);
    expect(result.combined).toMatch(/is not running — nothing to terminate/);
    expect(runShell).not.toHaveBeenCalledWith(
      expect.stringContaining("to quit"),
      expect.anything()
    );
  });

  it("terminate still sends the quit Apple Event when the process IS running", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      return okResult;
    });
    const a = adapter({ processName: "example-app" });
    await a.lifecycle.terminate("local", "com.example.exampleapp");
    expect(runShell).toHaveBeenCalledWith(
      expect.stringContaining('tell application id "com.example.exampleapp" to quit'),
      expect.anything()
    );
  });
});

describe("MacosAdapter.screenshot", () => {
  it("fails with a clear reason when no window can be resolved", async () => {
    const result = await adapter().screenshot({});
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/No macOS app resolved/);
  });

  it("captures WINDOW-TARGETED via screencapture -R against the live bounds", async () => {
    let outPath = "";
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      if (c.includes("System Events")) return ok("100, 100, 1400, 900");
      if (c.startsWith("/usr/sbin/screencapture")) {
        const match = c.match(/'([^']+\.png)'$/);
        outPath = match![1];
        fs.writeFileSync(outPath, Buffer.alloc(MACOS_SCREENCAPTURE_DEGENERATE_BYTES + 500, 1));
        return okResult;
      }
      return okResult;
    });
    const result = await adapter({ processName: "example-app" }).screenshot({});
    expect(result.captured).toBe(true);
    expect(result.savedPath).toBe(outPath);
    const shotCall = runShell.mock.calls.find(([c]) =>
      (c as string).startsWith("/usr/sbin/screencapture")
    );
    expect(shotCall![0]).toBe(`/usr/sbin/screencapture -x -R100,100,1400,900 '${outPath}'`);
    fs.rmSync(outPath, { force: true });
  });

  it("reports captured:false when Screen Recording is denied (degenerate image, exit 0)", async () => {
    let outPath = "";
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      if (c.includes("System Events")) return ok("100, 100, 1400, 900");
      if (c.startsWith("/usr/sbin/screencapture")) {
        const match = c.match(/'([^']+\.png)'$/);
        outPath = match![1];
        // Denied Screen Recording: screencapture exits 0 but writes a near-empty placeholder.
        fs.writeFileSync(outPath, Buffer.alloc(200, 1));
        return okResult;
      }
      return okResult;
    });
    const result = await adapter({ processName: "example-app" }).screenshot({});
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/200 bytes/);
    expect(result.reason).toMatch(new RegExp(`${MACOS_SCREENCAPTURE_DEGENERATE_BYTES}-byte floor`));
    expect(result.hint).toMatch(/Screen Recording/);
    fs.rmSync(outPath, { force: true });
  });
});

describe("MacosAdapter.geometry", () => {
  it("reports the target window's bounds in points plus the backingScaleFactor", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      if (c.includes("System Events")) return ok("100, 100, 1400, 900");
      if (c.includes("backingScaleFactor")) return ok("2");
      return okResult;
    });
    const geometry = await adapter({ processName: "example-app" }).geometry!();
    expect(geometry).toEqual({
      device: "example-app",
      displaySize: { width: 1400, height: 900 },
      density: { effective: 2 },
      dpr: 2,
      dprSource: expect.stringContaining("backingScaleFactor"),
      logicalDisplaySize: { width: 1400, height: 900 },
    });
  });

  it("defaults dpr to 1 when backingScaleFactor can't be parsed", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      if (c.includes("System Events")) return ok("0, 0, 800, 600");
      if (c.includes("backingScaleFactor")) return ok("not-a-number");
      return okResult;
    });
    const geometry = await adapter({ processName: "app" }).geometry!();
    expect(geometry!.dpr).toBe(1);
  });

  it("throws when System Events can't read the window bounds", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      if (c.includes("System Events")) return fail("Application isn't running.");
      return okResult;
    });
    await expect(adapter({ processName: "app" }).geometry!()).rejects.toThrow(
      /Could not read app.s front window bounds/
    );
  });
});

describe("MacosAdapter.info (TCC probes)", () => {
  it("Accessibility: GRANTED when the cursor read-back reflects the nudge (and it is restored)", async () => {
    let pos = { x: 20, y: 20 };
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("ProductVersion: 26.5.1");
      if (c === "uname -m") return ok("arm64");
      if (c.endsWith(" p:")) return ok(`${pos.x}, ${pos.y}`);
      if (c.includes(" m:+")) {
        pos = { x: pos.x + 3, y: pos.y + 3 };
        return okResult;
      }
      if (c.includes(" m:")) {
        // restore move: m:<x>,<y>
        const m = c.match(/m:(-?\d+),(-?\d+)/)!;
        pos = { x: Number(m[1]), y: Number(m[2]) };
        return okResult;
      }
      if (c.startsWith("/usr/sbin/screencapture")) return okResult; // handled below per-test
      return okResult;
    });
    const info = await adapter().info();
    expect(info.combined).toMatch(/GRANTED — cliclick moved the cursor/);
    expect(pos).toEqual({ x: 20, y: 20 }); // restored
  });

  it("Accessibility: DENIED when the cursor never actually moves (silent no-op)", async () => {
    const pos = { x: 20, y: 20 };
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("ProductVersion: 26.5.1");
      if (c === "uname -m") return ok("arm64");
      if (c.endsWith(" p:")) return ok(`${pos.x}, ${pos.y}`); // never changes
      if (c.includes(" m:")) return okResult; // exits 0 but does nothing
      if (c.startsWith("ps -o comm=")) return ok("Terminal");
      return okResult;
    });
    const info = await adapter().info();
    expect(info.combined).toMatch(/DENIED — cliclick exited 0 but the cursor never moved/);
    expect(info.combined).toMatch(/Terminal \(pid \d+\)/);
    expect(info.combined).not.toMatch(/grant it to cliclick/i);
  });

  it("Accessibility: UNKNOWN when cliclick is not found", async () => {
    const a = new MacosAdapter({
      locateCliclick: () => undefined,
    });
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("ProductVersion: 26.5.1");
      if (c === "uname -m") return ok("arm64");
      return okResult;
    });
    const info = await a.info();
    expect(info.combined).toMatch(/UNKNOWN — cliclick was not found/);
  });

  it("Screen Recording: GRANTED for a real-sized probe image", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("ProductVersion: 26.5.1");
      if (c === "uname -m") return ok("arm64");
      if (c.endsWith(" p:")) return ok("20, 20");
      if (c.includes(" m:")) return okResult;
      if (c.startsWith("/usr/sbin/screencapture")) {
        const match = c.match(/'([^']+\.png)'$/);
        fs.writeFileSync(
          match![1],
          Buffer.alloc(MACOS_SCREENCAPTURE_DEGENERATE_BYTES + 500, 1)
        );
        return okResult;
      }
      return okResult;
    });
    const info = await adapter().info();
    expect(info.combined).toMatch(/GRANTED — captured a real \d+-byte probe image/);
  });

  it("Screen Recording: DENIED (degenerate image) when the probe is suspiciously small", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("ProductVersion: 26.5.1");
      if (c === "uname -m") return ok("arm64");
      if (c.endsWith(" p:")) return ok("20, 20");
      if (c.includes(" m:")) return okResult;
      if (c.startsWith("ps -o comm=")) return ok("Terminal");
      if (c.startsWith("/usr/sbin/screencapture")) {
        const match = c.match(/'([^']+\.png)'$/);
        fs.writeFileSync(match![1], Buffer.alloc(200, 1));
        return okResult;
      }
      return okResult;
    });
    const info = await adapter().info();
    expect(info.combined).toMatch(/DENIED \(degenerate image\)/);
    expect(info.combined).toMatch(/Screen Recording/);
  });

  it("Screen Recording: UNKNOWN when screencapture fails to run", async () => {
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("ProductVersion: 26.5.1");
      if (c === "uname -m") return ok("arm64");
      if (c.endsWith(" p:")) return ok("20, 20");
      if (c.includes(" m:")) return okResult;
      if (c.startsWith("/usr/sbin/screencapture")) return fail("permission denied");
      return okResult;
    });
    const info = await adapter().info();
    expect(info.combined).toMatch(/UNKNOWN — screencapture failed to run/);
  });

  it("always cleans up its probe image", async () => {
    let probePath = "";
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c === "sw_vers") return ok("");
      if (c === "uname -m") return ok("arm64");
      if (c.endsWith(" p:")) return ok("20, 20");
      if (c.includes(" m:")) return okResult;
      if (c.startsWith("/usr/sbin/screencapture")) {
        const match = c.match(/'([^']+\.png)'$/);
        probePath = match![1];
        fs.writeFileSync(probePath, Buffer.alloc(4000, 1));
        return okResult;
      }
      return okResult;
    });
    await adapter().info();
    expect(fs.existsSync(probePath)).toBe(false);
  });
});

describe("MacosInputController", () => {
  function bounds() {
    return { x: 100, y: 100, width: 1400, height: 900 };
  }

  it("key() normalizes a short name and shells kp:<token>", async () => {
    const input = adapter().input();
    runShell.mockResolvedValue(okResult);
    await input.key("ENTER");
    expect(runShell).toHaveBeenCalledWith(`'${CLICLICK}' kp:enter`, { timeoutMs: 5000 });
  });

  it("key() throws on an unknown key without shelling anything", async () => {
    const input = adapter().input();
    await expect(input.key("not-a-key")).rejects.toThrow(/Unknown macOS key/);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("key() throws when cliclick is not found", async () => {
    const a = new MacosAdapter({
      locateCliclick: () => undefined,
    });
    await expect(a.input().key("ENTER")).rejects.toThrow(/cliclick was not found/);
  });

  it("text() shells t:<value> as one quoted token", async () => {
    const input = adapter().input();
    runShell.mockResolvedValue(okResult);
    await input.text!("hello world");
    expect(runShell).toHaveBeenCalledWith(`'${CLICLICK}' 't:hello world'`, {
      timeoutMs: 10000,
    });
  });

  it("pointerMove translates WINDOW-RELATIVE coordinates to absolute by default", async () => {
    const b = bounds();
    const input = adapter({ processName: "example-app" }).input();
    // Make the position readback match the predicted absolute target so the
    // effect-verification passes.
    const target = { x: b.x + 50, y: b.y + 60 };
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.startsWith("ps -axo")) return ok("42668 /Applications/Example.app/Contents/MacOS/example-app\n");
      if (c.includes("System Events")) return ok("100, 100, 1400, 900");
      if (c.endsWith(" p:")) return ok(`${target.x}, ${target.y}`);
      return okResult;
    });
    await input.pointerMove(50, 60);
    const moveCall = runShell.mock.calls.find(([c]) => (c as string).includes(" m:"));
    expect(moveCall![0]).toBe(`'${CLICLICK}' m:${target.x},${target.y}`);
  });

  it("pointerMove sends RAW absolute coordinates when opts.absolute is set (bypasses window translation)", async () => {
    const input = adapter().input();
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.endsWith(" p:")) return ok("500, 600");
      return okResult;
    });
    await input.pointerMove(500, 600, { absolute: true });
    const moveCall = runShell.mock.calls.find(([c]) => (c as string).includes(" m:"));
    expect(moveCall![0]).toBe(`'${CLICLICK}' m:500,600`);
    // Absolute mode must not need to resolve a window at all.
    expect(runShell.mock.calls.some(([c]) => (c as string).startsWith("ps -axo"))).toBe(
      false
    );
  });

  it("pointerMove throws (fails LOUDLY) when the read-back position does not match — the denied-Accessibility signature", async () => {
    const input = adapter().input();
    runShell.mockImplementation(async (cmd: unknown) => {
      const c = cmd as string;
      if (c.endsWith(" p:")) return ok("20, 20"); // never moves
      return okResult; // move command "succeeds" (exit 0) but is a no-op
    });
    await expect(input.pointerMove(500, 600, { absolute: true })).rejects.toThrow(
      /DENIED Accessibility grant/
    );
  });

  it("pointerClick sends a single click by default, double-click when opts.double is set", async () => {
    const input = adapter().input();
    runShell.mockResolvedValue(okResult);
    await input.pointerClick();
    expect(runShell).toHaveBeenLastCalledWith(`'${CLICLICK}' c:.`, { timeoutMs: 5000 });
    await input.pointerClick({ double: true });
    expect(runShell).toHaveBeenLastCalledWith(`'${CLICLICK}' dc:.`, { timeoutMs: 5000 });
  });

  it("pointerScroll ALWAYS throws UnsupportedInputError — cliclick 5 has no scroll verb", async () => {
    const input = adapter().input();
    await expect(input.pointerScroll(100)).rejects.toBeInstanceOf(UnsupportedInputError);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("input() returns the SAME cached controller across calls", () => {
    const a = adapter();
    expect(a.input()).toBe(a.input());
  });
});
