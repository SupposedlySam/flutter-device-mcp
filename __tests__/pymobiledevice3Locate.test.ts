import fs from "fs";
import os from "os";
import path from "path";
import {
  defaultPymobiledevice3SearchDirs,
  pymobiledevice3Unusable,
  resolvePymobiledevice3,
} from "../src/pymobiledevice3Locate.js";

/**
 * Build an `exists` probe that returns true only for the given absolute paths,
 * so each test drives the search deterministically without a real filesystem.
 */
function existsFor(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

/** An `unusable` probe that accepts only the given paths. */
function usableOnly(...usable: string[]) {
  const set = new Set(usable);
  return (p: string) => (set.has(p) ? undefined : "no such file");
}

describe("resolvePymobiledevice3 discovery", () => {
  it("honors FLUTTER_DEVICE_PYMOBILEDEVICE3 when it passes the usability probe", () => {
    const resolution = resolvePymobiledevice3({
      env: { FLUTTER_DEVICE_PYMOBILEDEVICE3: "/custom/pymobiledevice3", PATH: "/usr/bin" },
      exists: existsFor("/custom/pymobiledevice3"),
      unusable: usableOnly("/custom/pymobiledevice3"),
    });
    expect(resolution.binary).toBe("/custom/pymobiledevice3");
    // A working override is not a warning-worthy event.
    expect(resolution.overrideWarning).toBeUndefined();
  });

  it("finds pymobiledevice3 on the inherited PATH", () => {
    const resolution = resolvePymobiledevice3({
      env: { PATH: "/usr/local/bin:/somewhere/else" },
      exists: existsFor("/usr/local/bin/pymobiledevice3"),
    });
    expect(resolution.binary).toBe("/usr/local/bin/pymobiledevice3");
    expect(resolution.overrideWarning).toBeUndefined();
  });

  it("finds a pipx-installed binary under ~/.local/bin when PATH omits it (GUI-launch bug)", () => {
    const resolution = resolvePymobiledevice3({
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/dev" },
      exists: existsFor("/Users/dev/.local/bin/pymobiledevice3"),
    });
    expect(resolution.binary).toBe("/Users/dev/.local/bin/pymobiledevice3");
  });

  it("finds a venv/Framework-Python binary under the home dir", () => {
    const resolution = resolvePymobiledevice3({
      env: { PATH: "/usr/bin", HOME: "/Users/dev" },
      exists: existsFor("/Users/dev/Library/Python/3.12/bin/pymobiledevice3"),
    });
    expect(resolution.binary).toBe(
      "/Users/dev/Library/Python/3.12/bin/pymobiledevice3"
    );
  });

  it("returns no binary when pymobiledevice3 is nowhere to be found", () => {
    const resolution = resolvePymobiledevice3({
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/dev" },
      exists: existsFor("/nothing/here"),
    });
    expect(resolution.binary).toBeUndefined();
    expect(resolution.overrideWarning).toBeUndefined();
  });

  it("prefers the PATH match over a fallback dir", () => {
    const resolution = resolvePymobiledevice3({
      env: { PATH: "/my/tools", HOME: "/Users/dev" },
      exists: existsFor("/my/tools/pymobiledevice3", "/opt/homebrew/bin/pymobiledevice3"),
    });
    expect(resolution.binary).toBe("/my/tools/pymobiledevice3");
  });

  it("does NOT probe discovery candidates (the capture command is their probe)", () => {
    // Probing every candidate would add ~0.3s of Python startup to every
    // capture for a failure nobody configured; a broken discovered binary
    // surfaces as a real `pymobiledevice3 screenshot failed: …` reason instead.
    const probed: string[] = [];
    resolvePymobiledevice3({
      env: { PATH: "/my/tools" },
      exists: existsFor("/my/tools/pymobiledevice3"),
      unusable: (p) => {
        probed.push(p);
        return undefined;
      },
    });
    expect(probed).toEqual([]);
  });
});

describe("resolvePymobiledevice3 with an UNUSABLE override", () => {
  it("self-heals to a working binary but WARNS, naming the configured path and the reason", () => {
    const resolution = resolvePymobiledevice3({
      env: {
        FLUTTER_DEVICE_PYMOBILEDEVICE3: "/nonexistent/pymobiledevice3",
        PATH: "/opt/homebrew/bin",
      },
      exists: existsFor("/opt/homebrew/bin/pymobiledevice3"),
      unusable: () => "no such file",
    });
    // The capture still happens (the stale-device-pin convention: self-heal)…
    expect(resolution.binary).toBe("/opt/homebrew/bin/pymobiledevice3");
    // …but the operator is told their override did nothing, which binary ran
    // instead, and why theirs was rejected. Without this, a typo'd path looked
    // like it had worked.
    expect(resolution.overrideWarning).toContain("FLUTTER_DEVICE_PYMOBILEDEVICE3");
    expect(resolution.overrideWarning).toContain("/nonexistent/pymobiledevice3");
    expect(resolution.overrideWarning).toContain("no such file");
    expect(resolution.overrideWarning).toContain("/opt/homebrew/bin/pymobiledevice3");
  });

  it("says nothing could be captured when the override is unusable AND no fallback exists", () => {
    const resolution = resolvePymobiledevice3({
      env: { FLUTTER_DEVICE_PYMOBILEDEVICE3: "/nonexistent/pymobiledevice3", PATH: "/usr/bin" },
      exists: () => false,
      unusable: () => "not executable (chmod +x it)",
    });
    expect(resolution.binary).toBeUndefined();
    expect(resolution.overrideWarning).toContain("/nonexistent/pymobiledevice3");
    expect(resolution.overrideWarning).toContain("not executable");
    expect(resolution.overrideWarning).toMatch(/No other pymobiledevice3 was found/i);
  });

  it("probes the override itself rather than trusting that it exists", () => {
    const probed: string[] = [];
    const resolution = resolvePymobiledevice3({
      env: { FLUTTER_DEVICE_PYMOBILEDEVICE3: "/custom/pymobiledevice3", PATH: "/usr/bin" },
      // The override EXISTS — existence alone must not be enough.
      exists: existsFor("/custom/pymobiledevice3", "/usr/bin/pymobiledevice3"),
      unusable: (p) => {
        probed.push(p);
        return "`pymobiledevice3 version` did not run successfully";
      },
    });
    expect(probed).toEqual(["/custom/pymobiledevice3"]);
    expect(resolution.binary).toBe("/usr/bin/pymobiledevice3");
    expect(resolution.overrideWarning).toBeDefined();
  });
});

describe("pymobiledevice3Unusable (the three states of an optional dependency)", () => {
  it("accepts a binary whose `version` prints a version number", () => {
    expect(
      pymobiledevice3Unusable("/opt/homebrew/bin/pymobiledevice3", {
        stat: () => ({ isFile: true, executable: true }),
        version: () => "11.3.0\n",
      })
    ).toBeUndefined();
  });

  it("rejects an ABSENT path", () => {
    expect(
      pymobiledevice3Unusable("/gone/pymobiledevice3", {
        stat: () => undefined,
        version: () => "11.3.0",
      })
    ).toMatch(/no such file/i);
  });

  it("rejects a path that is a DIRECTORY", () => {
    expect(
      pymobiledevice3Unusable("/opt/homebrew/bin", {
        stat: () => ({ isFile: false, executable: true }),
        version: () => "11.3.0",
      })
    ).toMatch(/not a file/i);
  });

  it("rejects a PRESENT-BUT-NOT-EXECUTABLE file", () => {
    expect(
      pymobiledevice3Unusable("/custom/pymobiledevice3", {
        stat: () => ({ isFile: true, executable: false }),
        version: () => "11.3.0",
      })
    ).toMatch(/not executable/i);
  });

  it("rejects an executable that cannot run `version` at all", () => {
    expect(
      pymobiledevice3Unusable("/custom/pymobiledevice3", {
        stat: () => ({ isFile: true, executable: true }),
        version: () => undefined,
      })
    ).toMatch(/did not run successfully/i);
  });

  it("rejects an executable that is NOT pymobiledevice3 (exit 0 is not enough)", () => {
    // `/bin/echo version` exits 0 and prints "version": a zero exit code alone
    // would have accepted it as the CLI.
    const reason = pymobiledevice3Unusable("/bin/echo", {
      stat: () => ({ isFile: true, executable: true }),
      version: () => "version\n",
    });
    expect(reason).toMatch(/does not look like pymobiledevice3/i);
    expect(reason).toContain('"version"');
  });

  it("truncates a chatty rejected tool's output so the warning stays readable", () => {
    const reason = pymobiledevice3Unusable("/custom/thing", {
      stat: () => ({ isFile: true, executable: true }),
      version: () => `${"x".repeat(300)}\nsecond line`,
    });
    expect(reason).toContain("…");
    expect(reason).not.toContain("second line");
    expect(reason!.length).toBeLessThan(220);
  });
});

describe("pymobiledevice3Unusable against the real filesystem", () => {
  it("rejects a path that does not exist", () => {
    expect(
      pymobiledevice3Unusable("/nonexistent/pymobiledevice3")
    ).toMatch(/no such file/i);
  });

  it("rejects a real, existing, NON-EXECUTABLE file", () => {
    const file = path.join(
      os.tmpdir(),
      `flutter-device-mcp-pmd3-probe-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    fs.writeFileSync(file, "#!/bin/sh\necho 11.3.0\n", { mode: 0o600 });
    try {
      expect(pymobiledevice3Unusable(file)).toMatch(/not executable/i);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("rejects a real executable that is not pymobiledevice3", () => {
    // /bin/echo is executable and exits 0 for any argument — the exact shape a
    // presence-only or exit-code-only check would wave through.
    expect(pymobiledevice3Unusable("/bin/echo")).toMatch(
      /does not look like pymobiledevice3/i
    );
  });

  it("accepts a real executable that answers `version` like the CLI does", () => {
    const file = path.join(
      os.tmpdir(),
      `flutter-device-mcp-pmd3-stub-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    fs.writeFileSync(file, '#!/bin/sh\n[ "$1" = version ] && echo 11.3.0\n', {
      mode: 0o700,
    });
    try {
      expect(pymobiledevice3Unusable(file)).toBeUndefined();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("defaultPymobiledevice3SearchDirs", () => {
  it("includes both Homebrew prefixes", () => {
    const dirs = defaultPymobiledevice3SearchDirs("/Users/dev");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
  });

  it("includes home-relative pipx/venv dirs when HOME is set", () => {
    const dirs = defaultPymobiledevice3SearchDirs("/Users/dev");
    expect(dirs).toContain("/Users/dev/.local/bin");
  });

  it("omits home-relative dirs when HOME is empty", () => {
    const dirs = defaultPymobiledevice3SearchDirs("");
    expect(dirs.some((d) => d.includes(".local"))).toBe(false);
  });
});
