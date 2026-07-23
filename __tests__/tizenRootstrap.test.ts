import {
  checkTizenRootstrap,
  defaultTizenSdkPaths,
  installedDeviceRootstraps,
  readManifestApiVersion,
  resolveTizenSdkPath,
  RootstrapFs,
} from "../src/tizenRootstrap.js";

/**
 * Build a fake filesystem over a set of "existing" paths plus file contents.
 * Directory listings are synthesized from the path set: a child of `dir` is any
 * existing path exactly one segment deeper. Good enough for the precheck's
 * `platforms/tizen-<v>/<profile>/rootstraps/<name>` scan.
 */
function fakeFs(paths: Set<string>, files: Record<string, string> = {}): RootstrapFs {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return {
    existsSync: (p) => paths.has(norm(p)) || p in files,
    readFileSync: (p) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT ${p}`);
    },
    readdirSync: (dir) => {
      const base = norm(dir) + "/";
      const names = new Set<string>();
      for (const p of paths) {
        if (p.startsWith(base)) {
          const rest = p.slice(base.length);
          if (rest.length > 0) names.add(rest.split("/")[0]);
        }
      }
      // Every synthesized entry is treated as a directory (sufficient here).
      return [...names].map(
        (name) =>
          ({ name, isDirectory: () => true } as unknown as import("fs").Dirent)
      );
    },
  };
}

const SDK = "/sdk/data";
/** A fake SDK tree with a device rootstrap for tizen-8.0 only. */
function sdkWith80(): Set<string> {
  return new Set([
    SDK,
    `${SDK}/platforms`,
    `${SDK}/platforms/tizen-6.0`,
    `${SDK}/platforms/tizen-6.0/mobile`,
    `${SDK}/platforms/tizen-8.0`,
    `${SDK}/platforms/tizen-8.0/tizen`,
    `${SDK}/platforms/tizen-8.0/tizen/rootstraps`,
    `${SDK}/platforms/tizen-8.0/tizen/rootstraps/tizen-8.0-device.core`,
    `${SDK}/platforms/tizen-8.0/tizen/rootstraps/tizen-8.0-emulator.core`,
  ]);
}

const manifest = (v: string) =>
  `<manifest package="com.example.app" api-version="${v}" ><profile name="common"/></manifest>`;

describe("resolveTizenSdkPath", () => {
  it("prefers a configured path when it exists", () => {
    const fs = fakeFs(new Set(["/custom/sdk"]));
    expect(
      resolveTizenSdkPath({ configured: "/custom/sdk", env: {}, homeDir: "/home", fsImpl: fs })
    ).toBe("/custom/sdk");
  });

  it("falls back to $TIZEN_SDK when no config", () => {
    const fs = fakeFs(new Set(["/env/sdk"]));
    expect(
      resolveTizenSdkPath({ env: { TIZEN_SDK: "/env/sdk" }, homeDir: "/home", fsImpl: fs })
    ).toBe("/env/sdk");
  });

  it("falls back to a known default location", () => {
    const def = defaultTizenSdkPaths("/home")[0];
    const fs = fakeFs(new Set([def]));
    expect(resolveTizenSdkPath({ env: {}, homeDir: "/home", fsImpl: fs })).toBe(def);
  });

  it("returns undefined when nothing exists", () => {
    const fs = fakeFs(new Set());
    expect(resolveTizenSdkPath({ env: {}, homeDir: "/home", fsImpl: fs })).toBeUndefined();
  });
});

describe("readManifestApiVersion", () => {
  it("extracts the api-version", () => {
    const fs = fakeFs(new Set(["/app/tizen/tizen-manifest.xml"]), {
      "/app/tizen/tizen-manifest.xml": manifest("8.0"),
    });
    expect(readManifestApiVersion("/app", fs)).toBe("8.0");
  });
  it("returns undefined when the manifest is absent", () => {
    expect(readManifestApiVersion("/app", fakeFs(new Set()))).toBeUndefined();
  });
});

describe("installedDeviceRootstraps", () => {
  it("lists only -device.core rootstraps with their api-version", () => {
    const found = installedDeviceRootstraps(SDK, fakeFs(sdkWith80()));
    expect(found).toEqual([{ apiVersion: "8.0", name: "tizen-8.0-device.core" }]);
  });
});

describe("checkTizenRootstrap", () => {
  const base = { env: {}, homeDir: "/home" };

  it("ok when the manifest api-version has an installed device rootstrap", () => {
    const fs = fakeFs(
      new Set([...sdkWith80(), "/app/tizen/tizen-manifest.xml"]),
      { "/app/tizen/tizen-manifest.xml": manifest("8.0") }
    );
    const r = checkTizenRootstrap({ ...base, appDir: "/app", configuredSdkPath: SDK, fsImpl: fs });
    expect(r.ok).toBe(true);
    expect(r.requiredApiVersion).toBe("8.0");
    expect(r.installedApiVersions).toEqual(["8.0"]);
  });

  it("fails with guidance when the required version is missing (6.0 vs installed 8.0)", () => {
    const fs = fakeFs(
      new Set([...sdkWith80(), "/app/tizen/tizen-manifest.xml"]),
      { "/app/tizen/tizen-manifest.xml": manifest("6.0") }
    );
    const r = checkTizenRootstrap({ ...base, appDir: "/app", configuredSdkPath: SDK, fsImpl: fs });
    expect(r.ok).toBe(false);
    expect(r.requiredApiVersion).toBe("6.0");
    expect(r.message).toMatch(/Tizen 6\.0 device rootstrap is not installed/);
    expect(r.message).toMatch(/8\.0/); // suggests the installed version
  });

  it("configured apiVersion overrides the manifest", () => {
    const fs = fakeFs(
      new Set([...sdkWith80(), "/app/tizen/tizen-manifest.xml"]),
      { "/app/tizen/tizen-manifest.xml": manifest("6.0") }
    );
    const r = checkTizenRootstrap({
      ...base,
      appDir: "/app",
      configuredSdkPath: SDK,
      configuredApiVersion: "8.0",
      fsImpl: fs,
    });
    expect(r.ok).toBe(true);
    expect(r.requiredApiVersion).toBe("8.0");
  });

  it("fails clearly when no SDK is found", () => {
    const r = checkTizenRootstrap({ ...base, appDir: "/app", fsImpl: fakeFs(new Set()) });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Tizen SDK not found/);
  });
});
