import {
  flutterTvosMissingMessage,
  locateFlutterTvos,
} from "../src/flutterTvosLocate.js";

const HOME = "/Users/dev";

function filesAt(...paths: string[]) {
  const present = new Set(paths);
  return (p: string) => present.has(p);
}

describe("locateFlutterTvos", () => {
  it("finds ~/flutter-tvos/bin when PATH does not reach it, and prepends it", () => {
    expect(
      locateFlutterTvos({
        env: { PATH: "/usr/bin:/bin" },
        home: HOME,
        isFile: filesAt("/Users/dev/flutter-tvos/bin/flutter-tvos"),
      })
    ).toEqual({
      found: true,
      source: "default",
      binDir: "/Users/dev/flutter-tvos/bin",
      prependDir: "/Users/dev/flutter-tvos/bin",
    });
  });

  it("takes FLUTTER_TVOS_HOME/bin ahead of the default checkout", () => {
    expect(
      locateFlutterTvos({
        env: { PATH: "/usr/bin", FLUTTER_TVOS_HOME: "/opt/flutter-tvos" },
        home: HOME,
        isFile: filesAt(
          "/opt/flutter-tvos/bin/flutter-tvos",
          "/Users/dev/flutter-tvos/bin/flutter-tvos"
        ),
      })
    ).toMatchObject({ source: "FLUTTER_TVOS_HOME", prependDir: "/opt/flutter-tvos/bin" });
  });

  it("takes the FLUTTER_DEVICE_TVOS_FLUTTER_BIN override ahead of FLUTTER_TVOS_HOME", () => {
    expect(
      locateFlutterTvos({
        binDirOverride: "/custom/bin",
        env: { FLUTTER_TVOS_HOME: "/opt/flutter-tvos" },
        home: HOME,
        isFile: filesAt("/custom/bin/flutter-tvos", "/opt/flutter-tvos/bin/flutter-tvos"),
      })
    ).toMatchObject({ source: "FLUTTER_DEVICE_TVOS_FLUTTER_BIN", binDir: "/custom/bin" });
  });

  it("passes over a named dir that has no flutter-tvos binary in it", () => {
    expect(
      locateFlutterTvos({
        env: { FLUTTER_TVOS_HOME: "/opt/empty" },
        home: HOME,
        isFile: filesAt("/Users/dev/flutter-tvos/bin/flutter-tvos"),
      })
    ).toMatchObject({ source: "default" });
  });

  it("uses a copy on the inherited PATH without prepending anything", () => {
    expect(
      locateFlutterTvos({
        env: { PATH: "/usr/bin:/opt/tools/bin" },
        home: HOME,
        isFile: filesAt("/opt/tools/bin/flutter-tvos"),
      })
    ).toEqual({
      found: true,
      source: "PATH",
      binDir: "/opt/tools/bin",
      prependDir: undefined,
    });
  });

  it("reports every location it searched when flutter-tvos is nowhere", () => {
    expect(
      locateFlutterTvos({
        env: { PATH: "/usr/bin", FLUTTER_TVOS_HOME: "/opt/flutter-tvos" },
        home: HOME,
        isFile: () => false,
      })
    ).toEqual({
      found: false,
      checked: ["/opt/flutter-tvos/bin", "/Users/dev/flutter-tvos/bin", "each directory on PATH"],
    });
  });
});

describe("flutterTvosMissingMessage", () => {
  it("names the searched locations and both ways to point at a checkout", () => {
    const message = flutterTvosMissingMessage(["/Users/dev/flutter-tvos/bin"]);
    expect(message).toContain("Looked in: /Users/dev/flutter-tvos/bin");
    expect(message).toContain("FLUTTER_TVOS_HOME");
    expect(message).toContain("FLUTTER_DEVICE_TVOS_FLUTTER_BIN");
  });
});
