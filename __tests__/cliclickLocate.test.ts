import { locateCliclick, defaultCliclickSearchDirs } from "../src/cliclickLocate.js";

/**
 * Build an `exists` probe that returns true only for the given absolute paths.
 * Lets each test drive locateCliclick's search deterministically without a
 * real filesystem.
 */
function existsFor(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("locateCliclick", () => {
  it("honors FLUTTER_DEVICE_CLICLICK_PATH when it points at an existing file", () => {
    const found = locateCliclick({
      env: { FLUTTER_DEVICE_CLICLICK_PATH: "/custom/cliclick", PATH: "/usr/bin" },
      exists: existsFor("/custom/cliclick"),
    });
    expect(found).toBe("/custom/cliclick");
  });

  it("ignores FLUTTER_DEVICE_CLICLICK_PATH when the file does not exist, falling through", () => {
    const found = locateCliclick({
      env: { FLUTTER_DEVICE_CLICLICK_PATH: "/gone/cliclick", PATH: "/opt/homebrew/bin" },
      exists: existsFor("/opt/homebrew/bin/cliclick"),
    });
    expect(found).toBe("/opt/homebrew/bin/cliclick");
  });

  it("finds cliclick on the inherited PATH", () => {
    const found = locateCliclick({
      env: { PATH: "/usr/local/bin:/somewhere/else" },
      exists: existsFor("/usr/local/bin/cliclick"),
    });
    expect(found).toBe("/usr/local/bin/cliclick");
  });

  it("finds cliclick in a well-known Homebrew location even when PATH omits it (the GUI-launch bug)", () => {
    // The GUI-launched server's PATH lacks /opt/homebrew/bin — the exact live bug
    // documented for idb/pymobiledevice3; cliclick shares the same failure mode.
    const found = locateCliclick({
      env: { PATH: "/usr/bin:/bin" },
      exists: existsFor("/opt/homebrew/bin/cliclick"),
    });
    expect(found).toBe("/opt/homebrew/bin/cliclick");
  });

  it("returns undefined when cliclick is nowhere to be found", () => {
    const found = locateCliclick({
      env: { PATH: "/usr/bin:/bin" },
      exists: existsFor("/nothing/here"),
    });
    expect(found).toBeUndefined();
  });

  it("prefers the PATH match over a fallback dir", () => {
    const found = locateCliclick({
      env: { PATH: "/my/tools" },
      exists: existsFor("/my/tools/cliclick", "/opt/homebrew/bin/cliclick"),
    });
    expect(found).toBe("/my/tools/cliclick");
  });

  it("is re-run per call (no cached negative) so a just-installed cliclick is picked up", () => {
    let installed = false;
    const exists = (p: string) => installed && p === "/opt/homebrew/bin/cliclick";
    const opts = { env: { PATH: "/usr/bin" }, exists };
    expect(locateCliclick(opts)).toBeUndefined();
    installed = true;
    expect(locateCliclick(opts)).toBe("/opt/homebrew/bin/cliclick");
  });
});

describe("defaultCliclickSearchDirs", () => {
  it("includes both Homebrew prefixes and /usr/bin", () => {
    const dirs = defaultCliclickSearchDirs();
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/usr/bin");
  });
});
