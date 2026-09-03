import {
  buildCurlDownloadCommand,
  buildDittoCopyCommand,
  buildFindAppBundleCommand,
  buildHdiutilAttachCommand,
  buildHdiutilDetachCommand,
  buildPlutilExtractCommand,
  buildTarExtractCommand,
  bundleExecutablePath,
  bundleMacOsDir,
  classifyMacosAppSource,
  infoPlistPath,
  macosArchiveFormat,
  parseFoundAppBundle,
  parsePlutilRawOutput,
} from "../src/macosBundle.js";

describe("macosArchiveFormat", () => {
  it("recognizes .tar.gz and .tgz", () => {
    expect(macosArchiveFormat("/x/App.tar.gz")).toBe("tar.gz");
    expect(macosArchiveFormat("/x/App.tgz")).toBe("tar.gz");
  });

  it("recognizes .dmg", () => {
    expect(macosArchiveFormat("/x/App.dmg")).toBe("dmg");
  });

  it("returns undefined for anything else", () => {
    expect(macosArchiveFormat("/x/App.zip")).toBeUndefined();
    expect(macosArchiveFormat("/x/App.app")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(macosArchiveFormat("/x/App.DMG")).toBe("dmg");
  });
});

describe("classifyMacosAppSource", () => {
  it("classifies a .app path", () => {
    expect(classifyMacosAppSource({ appPath: "/x/Example App.app" })).toEqual({
      kind: "app",
      path: "/x/Example App.app",
    });
  });

  it("classifies a local .tar.gz/.dmg path as an archive", () => {
    expect(classifyMacosAppSource({ appPath: "/x/app.tar.gz" })).toEqual({
      kind: "archive",
      path: "/x/app.tar.gz",
      format: "tar.gz",
    });
    expect(classifyMacosAppSource({ appPath: "/x/app.dmg" })).toEqual({
      kind: "archive",
      path: "/x/app.dmg",
      format: "dmg",
    });
  });

  it("classifies a URL by its extension", () => {
    expect(
      classifyMacosAppSource({ appUrl: "https://example.com/app.tar.gz" })
    ).toEqual({
      kind: "url",
      url: "https://example.com/app.tar.gz",
      format: "tar.gz",
    });
  });

  it("prefers a local path over a URL when both are set", () => {
    const result = classifyMacosAppSource({
      appPath: "/x/App.app",
      appUrl: "https://example.com/app.dmg",
    });
    expect(result).toEqual({ kind: "app", path: "/x/App.app" });
  });

  it("reports an unrecognized extension rather than guessing", () => {
    expect(classifyMacosAppSource({ appPath: "/x/app.zip" })).toEqual({
      kind: "unrecognized",
      value: "/x/app.zip",
    });
    expect(
      classifyMacosAppSource({ appUrl: "https://example.com/app.zip" })
    ).toEqual({ kind: "unrecognized", value: "https://example.com/app.zip" });
  });

  it("reports none when neither is set (or blank)", () => {
    expect(classifyMacosAppSource({})).toEqual({ kind: "none" });
    expect(classifyMacosAppSource({ appPath: "  ", appUrl: "" })).toEqual({
      kind: "none",
    });
  });
});

describe("shell command builders", () => {
  it("buildCurlDownloadCommand fetches to the given path", () => {
    expect(buildCurlDownloadCommand("https://x/app.tar.gz", "/tmp/out.tar.gz")).toBe(
      "curl -fsSL 'https://x/app.tar.gz' -o '/tmp/out.tar.gz'"
    );
  });

  it("buildTarExtractCommand extracts into destDir", () => {
    expect(buildTarExtractCommand("/tmp/a.tar.gz", "/tmp/out")).toBe(
      "tar -xzf '/tmp/a.tar.gz' -C '/tmp/out'"
    );
  });

  it("buildHdiutilAttachCommand mounts read-only and nobrowse", () => {
    const cmd = buildHdiutilAttachCommand("/tmp/a.dmg", "/tmp/mnt");
    expect(cmd).toContain("hdiutil attach '/tmp/a.dmg' -mountpoint '/tmp/mnt'");
    expect(cmd).toContain("-nobrowse");
    expect(cmd).toContain("-readonly");
  });

  it("buildHdiutilDetachCommand detaches quietly", () => {
    expect(buildHdiutilDetachCommand("/tmp/mnt")).toBe("hdiutil detach '/tmp/mnt' -quiet");
  });

  it("buildDittoCopyCommand copies preserving xattrs", () => {
    expect(buildDittoCopyCommand("/a/App.app", "/b/App.app")).toBe(
      "ditto '/a/App.app' '/b/App.app'"
    );
  });

  it("buildFindAppBundleCommand searches maxdepth 2 for a .app dir", () => {
    const cmd = buildFindAppBundleCommand("/tmp/extracted");
    expect(cmd).toBe("find '/tmp/extracted' -maxdepth 2 -name '*.app' -type d");
  });

  it("buildPlutilExtractCommand reads a raw plist key to stdout", () => {
    expect(buildPlutilExtractCommand("CFBundleIdentifier", "/a/Info.plist")).toBe(
      "plutil -extract 'CFBundleIdentifier' raw -o - '/a/Info.plist'"
    );
  });
});

describe("output parsers", () => {
  it("parseFoundAppBundle takes the first non-blank line", () => {
    expect(parseFoundAppBundle("\n/tmp/x/App.app\n")).toBe("/tmp/x/App.app");
    expect(parseFoundAppBundle("/a.app\n/b.app\n")).toBe("/a.app");
    expect(parseFoundAppBundle("\n\n")).toBeUndefined();
  });

  it("parsePlutilRawOutput trims and rejects empty output", () => {
    expect(parsePlutilRawOutput("com.example.exampleapp\n")).toBe(
      "com.example.exampleapp"
    );
    expect(parsePlutilRawOutput("   ")).toBeUndefined();
    expect(parsePlutilRawOutput("")).toBeUndefined();
  });
});

describe("path helpers", () => {
  it("infoPlistPath / bundleExecutablePath / bundleMacOsDir compose Contents paths", () => {
    const app = "/tmp/x/Example App.app";
    expect(infoPlistPath(app)).toBe(`${app}/Contents/Info.plist`);
    expect(bundleMacOsDir(app)).toBe(`${app}/Contents/MacOS`);
    expect(bundleExecutablePath(app, "example-app")).toBe(
      `${app}/Contents/MacOS/example-app`
    );
  });
});
