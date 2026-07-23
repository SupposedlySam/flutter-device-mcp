import { locateIdb, defaultIdbSearchDirs } from "../src/idbLocate.js";

/**
 * Build an `exists` probe that returns true only for the given absolute paths.
 * Lets each test drive locateIdb's search deterministically without a real
 * filesystem.
 */
function existsFor(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("locateIdb", () => {
  it("honors FLUTTER_DEVICE_IDB_PATH when it points at an existing file", () => {
    const found = locateIdb({
      env: { FLUTTER_DEVICE_IDB_PATH: "/custom/idb", PATH: "/usr/bin" },
      exists: existsFor("/custom/idb"),
    });
    expect(found).toBe("/custom/idb");
  });

  it("ignores FLUTTER_DEVICE_IDB_PATH when the file does not exist, falling through", () => {
    const found = locateIdb({
      env: { FLUTTER_DEVICE_IDB_PATH: "/gone/idb", PATH: "/opt/homebrew/bin" },
      exists: existsFor("/opt/homebrew/bin/idb"),
    });
    expect(found).toBe("/opt/homebrew/bin/idb");
  });

  it("finds idb on the inherited PATH", () => {
    const found = locateIdb({
      env: { PATH: "/usr/local/bin:/somewhere/else" },
      exists: existsFor("/usr/local/bin/idb"),
    });
    expect(found).toBe("/usr/local/bin/idb");
  });

  it("finds idb in a well-known Homebrew location even when PATH omits it (the GUI-launch bug)", () => {
    // The GUI-launched server's PATH lacks /opt/homebrew/bin — the exact live bug.
    const found = locateIdb({
      env: { PATH: "/usr/bin:/bin" },
      exists: existsFor("/opt/homebrew/bin/idb"),
    });
    expect(found).toBe("/opt/homebrew/bin/idb");
  });

  it("finds a pipx/venv idb under the home dir when nothing else has it", () => {
    const found = locateIdb({
      env: { PATH: "/usr/bin", HOME: "/Users/dev" },
      exists: existsFor("/Users/dev/.local/bin/idb"),
    });
    expect(found).toBe("/Users/dev/.local/bin/idb");
  });

  it("returns undefined when idb is nowhere to be found", () => {
    const found = locateIdb({
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/dev" },
      exists: existsFor("/nothing/here"),
    });
    expect(found).toBeUndefined();
  });

  it("prefers the PATH match over a fallback dir", () => {
    // Both a PATH entry and a fallback dir have idb; the PATH entry wins.
    const found = locateIdb({
      env: { PATH: "/my/tools", HOME: "/Users/dev" },
      exists: existsFor("/my/tools/idb", "/opt/homebrew/bin/idb"),
    });
    expect(found).toBe("/my/tools/idb");
  });
});

describe("defaultIdbSearchDirs", () => {
  it("includes both Homebrew prefixes", () => {
    const dirs = defaultIdbSearchDirs("/Users/dev");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
  });

  it("includes home-relative pipx/venv dirs when HOME is set", () => {
    const dirs = defaultIdbSearchDirs("/Users/dev");
    expect(dirs).toContain("/Users/dev/.local/bin");
  });

  it("omits home-relative dirs when HOME is empty", () => {
    const dirs = defaultIdbSearchDirs("");
    expect(dirs.some((d) => d.includes(".local"))).toBe(false);
  });
});
