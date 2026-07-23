import {
  locatePymobiledevice3,
  defaultPymobiledevice3SearchDirs,
} from "../src/pymobiledevice3Locate.js";

/**
 * Build an `exists` probe that returns true only for the given absolute paths,
 * so each test drives the search deterministically without a real filesystem.
 */
function existsFor(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("locatePymobiledevice3", () => {
  it("honors FLUTTER_DEVICE_PYMOBILEDEVICE3 when it points at an existing file", () => {
    const found = locatePymobiledevice3({
      env: { FLUTTER_DEVICE_PYMOBILEDEVICE3: "/custom/pymobiledevice3", PATH: "/usr/bin" },
      exists: existsFor("/custom/pymobiledevice3"),
    });
    expect(found).toBe("/custom/pymobiledevice3");
  });

  it("ignores FLUTTER_DEVICE_PYMOBILEDEVICE3 when the file does not exist, falling through", () => {
    const found = locatePymobiledevice3({
      env: { FLUTTER_DEVICE_PYMOBILEDEVICE3: "/gone/pymobiledevice3", PATH: "/opt/homebrew/bin" },
      exists: existsFor("/opt/homebrew/bin/pymobiledevice3"),
    });
    expect(found).toBe("/opt/homebrew/bin/pymobiledevice3");
  });

  it("finds pymobiledevice3 on the inherited PATH", () => {
    const found = locatePymobiledevice3({
      env: { PATH: "/usr/local/bin:/somewhere/else" },
      exists: existsFor("/usr/local/bin/pymobiledevice3"),
    });
    expect(found).toBe("/usr/local/bin/pymobiledevice3");
  });

  it("finds a pipx-installed binary under ~/.local/bin when PATH omits it (GUI-launch bug)", () => {
    const found = locatePymobiledevice3({
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/dev" },
      exists: existsFor("/Users/dev/.local/bin/pymobiledevice3"),
    });
    expect(found).toBe("/Users/dev/.local/bin/pymobiledevice3");
  });

  it("finds a venv/Framework-Python binary under the home dir", () => {
    const found = locatePymobiledevice3({
      env: { PATH: "/usr/bin", HOME: "/Users/dev" },
      exists: existsFor("/Users/dev/Library/Python/3.12/bin/pymobiledevice3"),
    });
    expect(found).toBe("/Users/dev/Library/Python/3.12/bin/pymobiledevice3");
  });

  it("returns undefined when pymobiledevice3 is nowhere to be found", () => {
    const found = locatePymobiledevice3({
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/dev" },
      exists: existsFor("/nothing/here"),
    });
    expect(found).toBeUndefined();
  });

  it("prefers the PATH match over a fallback dir", () => {
    const found = locatePymobiledevice3({
      env: { PATH: "/my/tools", HOME: "/Users/dev" },
      exists: existsFor("/my/tools/pymobiledevice3", "/opt/homebrew/bin/pymobiledevice3"),
    });
    expect(found).toBe("/my/tools/pymobiledevice3");
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
