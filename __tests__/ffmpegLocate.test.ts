import { locateFfmpeg, defaultFfmpegSearchDirs } from "../src/ffmpegLocate.js";

/** Build an `exists` probe that returns true only for the given absolute paths. */
function existsFor(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("locateFfmpeg", () => {
  it("honors FLUTTER_DEVICE_FFMPEG when it points at an existing file", () => {
    const found = locateFfmpeg({
      env: { FLUTTER_DEVICE_FFMPEG: "/custom/ffmpeg", PATH: "/usr/bin" },
      exists: existsFor("/custom/ffmpeg"),
    });
    expect(found).toBe("/custom/ffmpeg");
  });

  it("ignores FLUTTER_DEVICE_FFMPEG when the file does not exist, falling through", () => {
    const found = locateFfmpeg({
      env: { FLUTTER_DEVICE_FFMPEG: "/gone/ffmpeg", PATH: "/opt/homebrew/bin" },
      exists: existsFor("/opt/homebrew/bin/ffmpeg"),
    });
    expect(found).toBe("/opt/homebrew/bin/ffmpeg");
  });

  it("finds ffmpeg on the inherited PATH", () => {
    const found = locateFfmpeg({
      env: { PATH: "/usr/local/bin:/somewhere/else" },
      exists: existsFor("/usr/local/bin/ffmpeg"),
    });
    expect(found).toBe("/usr/local/bin/ffmpeg");
  });

  it("finds a Homebrew binary when PATH omits it (GUI-launch bug)", () => {
    const found = locateFfmpeg({
      env: { PATH: "/usr/bin:/bin" },
      exists: existsFor("/opt/homebrew/bin/ffmpeg"),
    });
    expect(found).toBe("/opt/homebrew/bin/ffmpeg");
  });

  it("returns undefined when ffmpeg is nowhere to be found", () => {
    const found = locateFfmpeg({
      env: { PATH: "/usr/bin:/bin" },
      exists: existsFor("/nothing/here"),
    });
    expect(found).toBeUndefined();
  });

  it("prefers the PATH match over a fallback dir", () => {
    const found = locateFfmpeg({
      env: { PATH: "/my/tools" },
      exists: existsFor("/my/tools/ffmpeg", "/opt/homebrew/bin/ffmpeg"),
    });
    expect(found).toBe("/my/tools/ffmpeg");
  });
});

describe("defaultFfmpegSearchDirs", () => {
  it("includes both Homebrew prefixes and the system bins", () => {
    const dirs = defaultFfmpegSearchDirs();
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/usr/bin");
  });
});
