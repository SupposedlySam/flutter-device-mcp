import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { quote } from "../src/cli.js";
import {
  createControlFifoPath,
  makeControlFifo,
  removeControlFifo,
  sendControlChar,
} from "../src/ptyControl.js";
import {
  buildPtyForwardCommand,
  defaultPython3Candidates,
  locatePython3,
  ptyForwardScriptPath,
  python3CanFork,
  resolvePtyForwarder,
} from "../src/ptyForward.js";

const BRIDGE = {
  python: "/usr/bin/python3",
  script: "/pkg/scripts/pty-control-forward.py",
};

describe("defaultPython3Candidates", () => {
  it("tries the command-line-tools python3 FIRST, then PATH, then Homebrew", () => {
    const candidates = defaultPython3Candidates({
      PATH: ["/opt/bin", "/usr/bin"].join(path.delimiter),
    } as NodeJS.ProcessEnv);
    expect(candidates[0]).toBe("/usr/bin/python3");
    expect(candidates).toContain("/opt/bin/python3");
    expect(candidates).toContain("/opt/homebrew/bin/python3");
    expect(candidates).toContain("/usr/local/bin/python3");
  });

  it("survives an unset PATH", () => {
    expect(defaultPython3Candidates({} as NodeJS.ProcessEnv)).toContain(
      "/usr/bin/python3"
    );
  });
});

describe("locatePython3", () => {
  it("skips a PRESENT-BUT-UNUSABLE interpreter and keeps looking", () => {
    // The macOS /usr/bin/python3 shim with no command-line tools installed is
    // exactly this: on PATH, exits non-zero. Treating presence as capability
    // would hand the launch a bridge that cannot run, and the launch would then
    // record a control channel that swallows every keystroke.
    const probed: string[] = [];
    const found = locatePython3({
      env: { PATH: "/opt/homebrew/bin" } as NodeJS.ProcessEnv,
      exists: () => true,
      usable: (candidate) => {
        probed.push(candidate);
        return candidate === "/opt/homebrew/bin/python3";
      },
    });
    expect(found).toBe("/opt/homebrew/bin/python3");
    expect(probed[0]).toBe("/usr/bin/python3");
  });

  it("returns undefined when every candidate exists but none can run the bridge", () => {
    expect(
      locatePython3({
        env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
        exists: () => true,
        usable: () => false,
      })
    ).toBeUndefined();
  });

  it("prefers FLUTTER_DEVICE_PYTHON3 — but still PROBES it rather than trusting the name", () => {
    const env = {
      FLUTTER_DEVICE_PYTHON3: "/opt/venv/bin/python3",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    expect(
      locatePython3({ env, exists: () => true, usable: () => true })
    ).toBe("/opt/venv/bin/python3");
    // The override names an interpreter that cannot import pty: it must lose to
    // one that can, not win because it was configured.
    expect(
      locatePython3({
        env,
        exists: () => true,
        usable: (candidate) => candidate !== "/opt/venv/bin/python3",
      })
    ).toBe("/usr/bin/python3");
  });

  it("never probes a candidate that does not exist", () => {
    const probed: string[] = [];
    locatePython3({
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      exists: (candidate) => candidate === "/usr/bin/python3",
      usable: (candidate) => {
        probed.push(candidate);
        return false;
      },
    });
    expect(probed).toEqual(["/usr/bin/python3"]);
  });
});

describe("resolvePtyForwarder", () => {
  it("returns undefined when the bridge script is missing from the package", () => {
    expect(
      resolvePtyForwarder({
        scriptPath: "/pkg/scripts/pty-control-forward.py",
        exists: (p) => p !== "/pkg/scripts/pty-control-forward.py",
        usable: () => true,
      })
    ).toBeUndefined();
  });

  it("returns undefined when no python3 can run the bridge (no half-built channel)", () => {
    expect(
      resolvePtyForwarder({
        scriptPath: "/pkg/scripts/pty-control-forward.py",
        exists: () => true,
        usable: () => false,
      })
    ).toBeUndefined();
  });

  it("pairs the usable interpreter with the script when both are available", () => {
    expect(
      resolvePtyForwarder({
        scriptPath: "/pkg/scripts/pty-control-forward.py",
        env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
        exists: () => true,
        usable: () => true,
      })
    ).toEqual(BRIDGE);
  });
});

describe("ptyForwardScriptPath", () => {
  it("resolves the checked-in bridge script, which must exist in the package", () => {
    const resolved = ptyForwardScriptPath();
    expect(resolved.endsWith(path.join("scripts", "pty-control-forward.py"))).toBe(
      true
    );
    expect(fs.existsSync(resolved)).toBe(true);
  });
});

describe("python3CanFork (real probe)", () => {
  it("reports false for an interpreter that does not exist, without throwing", () => {
    expect(python3CanFork("/nonexistent/python3")).toBe(false);
  });

  it("reports false for an executable that is not python (present ≠ usable)", () => {
    expect(python3CanFork("/bin/echo")).toBe(false);
  });
});

describe("buildPtyForwardCommand", () => {
  it("execs the bridge with the FIFO and the inner command as separate arguments", () => {
    expect(
      buildPtyForwardCommand({
        forwarder: BRIDGE,
        fifoPath: "/tmp/ctl.fifo",
        inner: "fvm flutter run --debug -d 'ECID'",
      })
    ).toBe(
      "exec '/usr/bin/python3' '/pkg/scripts/pty-control-forward.py' " +
        "'/tmp/ctl.fifo' 'fvm flutter run --debug -d '\\''ECID'\\'''"
    );
  });

  it("keeps a COMPOUND inner as one argument (the bridge runs it with /bin/sh -c)", () => {
    const cmd = buildPtyForwardCommand({
      forwarder: BRIDGE,
      fifoPath: "/tmp/ctl.fifo",
      inner: "export PATH='/opt/bin:'\"$PATH\"; flutter run && echo ok",
    });
    // Exactly four shell words after `exec`: python, script, fifo, and ONE
    // quoted payload — so `export` can never become the bridge's argv[0].
    expect(cmd.startsWith("exec '/usr/bin/python3' ")).toBe(true);
    expect(cmd).toContain("'/tmp/ctl.fifo' 'export PATH=");
    expect(cmd.endsWith("'")).toBe(true);
  });

  it("quotes a FIFO path with spaces or quotes so an odd path cannot break out", () => {
    const cmd = buildPtyForwardCommand({
      forwarder: BRIDGE,
      fifoPath: "/tmp/a b/c'.fifo",
      inner: "flutter run",
    });
    expect(cmd).toContain("'/tmp/a b/c'\\''.fifo'");
  });

  it("keeps the leading `exec` so the detached child IS the pty owner", () => {
    expect(
      buildPtyForwardCommand({
        forwarder: BRIDGE,
        fifoPath: "/tmp/ctl.fifo",
        inner: "flutter run",
      }).startsWith("exec ")
    ).toBe(true);
  });
});

/**
 * The mechanism this whole module exists for, exercised end to end on the real
 * host: a control char appended to the durable FIFO must arrive at a child whose
 * stdin is a TERMINAL, one raw byte at a time and with no newline needed. That is
 * exactly what the flutter tool requires (`Terminal.singleCharMode` returns early
 * unless stdin `hasTerminal`), and it is what a plain `flutter … <&3` redirect
 * cannot do — the write lands and nothing reads it.
 *
 * A stand-in child is used rather than `flutter run`, because the property under
 * test belongs to the channel, not to flutter: does a FIFO append reach a
 * tty stdin in raw mode?
 */
describe("the FIFO→pty bridge delivers raw keystrokes to a TERMINAL stdin", () => {
  const python = locatePython3();
  let fifoPath: string | undefined;
  let logPath: string | undefined;

  afterEach(() => {
    removeControlFifo(fifoPath);
    if (logPath) fs.rmSync(logPath, { force: true });
    fifoPath = undefined;
    logPath = undefined;
  });

  // Skip LOUDLY and name what the skip costs: this is the only test that proves
  // the channel works at all, so silently passing without it would be worse than
  // the gap.
  (python ? it : it.skip)(
    "reports a tty on the child's stdin and hands it a lone `r` (no newline)",
    async () => {
      const probe = [
        "import sys, tty",
        "tty.setraw(0)",
        'sys.stdout.write("ISATTY=%s\\r\\n" % sys.stdin.isatty())',
        "sys.stdout.flush()",
        'sys.stdout.write("CHAR=%s\\r\\n" % sys.stdin.read(1))',
        "sys.stdout.flush()",
      ].join("; ");
      const inner = `${quote(python as string)} -c ${quote(probe)}`;

      fifoPath = createControlFifoPath();
      expect(makeControlFifo(fifoPath)).toBe(true);
      logPath = path.join(os.tmpdir(), `flutter-device-mcp-bridge-test-${process.pid}.log`);
      const logFd = fs.openSync(logPath, "a");

      const command = buildPtyForwardCommand({
        forwarder: { python: python as string, script: ptyForwardScriptPath() },
        fifoPath,
        inner,
      });
      const child = spawn(command, {
        shell: "/bin/sh",
        stdio: ["ignore", logFd, logFd],
        detached: true,
      });
      child.unref();

      const read = () => {
        try {
          return fs.readFileSync(logPath as string, "utf8");
        } catch {
          return "";
        }
      };
      const waitFor = async (pattern: RegExp) => {
        for (let i = 0; i < 100; i++) {
          if (pattern.test(read())) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      };

      // The child sees a real terminal — the precondition flutter checks.
      expect(await waitFor(/ISATTY=True/)).toBe(true);
      // A single char, appended to the FIFO from a separate call, arrives with no
      // newline and no line-buffering in the way.
      expect(await sendControlChar(fifoPath, "r")).toBe(true);
      expect(await waitFor(/CHAR=r/)).toBe(true);

      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      fs.closeSync(logFd);
    },
    30000
  );
});
