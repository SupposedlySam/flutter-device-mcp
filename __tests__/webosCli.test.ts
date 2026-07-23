import {
  buildAresDeviceInfoCommand,
  buildAresDeviceListCommand,
  buildAresInstallCommand,
  buildAresLaunchCommand,
  buildAresUninstallCommand,
  defaultWebosSdkBin,
  resolveWebosSdkBin,
  WEBOS_SDK_BIN_ENV,
  withWebosPathGuard,
} from "../src/webos/webosCli.js";

describe("ares command builders", () => {
  it("install targets the device and ipk", () => {
    expect(buildAresInstallCommand("tv-26", "/out/app.ipk")).toBe(
      "ares-install -d 'tv-26' '/out/app.ipk'"
    );
  });

  it("launch runs in inspect mode on the primary display", () => {
    expect(buildAresLaunchCommand("tv-26", "com.example.app")).toBe(
      "ares-launch -d 'tv-26' --inspect --display 0 'com.example.app'"
    );
  });

  it("uninstall uses --remove", () => {
    expect(buildAresUninstallCommand("tv-26", "com.example.app")).toBe(
      "ares-install -d 'tv-26' --remove 'com.example.app'"
    );
  });

  it("device info uses ares-device -i", () => {
    expect(buildAresDeviceInfoCommand("tv-26")).toBe(
      "ares-device -d 'tv-26' -i"
    );
  });

  it("device list uses ares-setup-device --list --full", () => {
    expect(buildAresDeviceListCommand()).toBe("ares-setup-device --list --full");
  });

  it("escapes single quotes in an ipk path", () => {
    expect(buildAresInstallCommand("tv-26", "/o'ut/app.ipk")).toBe(
      "ares-install -d 'tv-26' '/o'\\''ut/app.ipk'"
    );
  });
});

describe("resolveWebosSdkBin", () => {
  it("uses the env override when set", () => {
    expect(
      resolveWebosSdkBin({ [WEBOS_SDK_BIN_ENV]: "/opt/webos/bin" })
    ).toBe("/opt/webos/bin");
  });

  it("falls back to the default location when the env var is unset", () => {
    expect(resolveWebosSdkBin({})).toBe(defaultWebosSdkBin());
  });

  it("treats an explicitly-empty env var as an opt-out (undefined)", () => {
    expect(resolveWebosSdkBin({ [WEBOS_SDK_BIN_ENV]: "  " })).toBeUndefined();
  });
});

describe("withWebosPathGuard", () => {
  const cmd = "ares-setup-device --list --full";

  it("prepends the SDK bin dir to PATH via export when the dir exists", () => {
    const guarded = withWebosPathGuard(cmd, "/opt/webos/bin", () => true);
    expect(guarded).toBe(
      `export PATH='/opt/webos/bin:'"$PATH"; ${cmd}`
    );
  });

  it("is a no-op when the dir does not exist", () => {
    expect(withWebosPathGuard(cmd, "/opt/webos/bin", () => false)).toBe(cmd);
  });

  it("is a no-op for an opted-out (empty) SDK bin dir", () => {
    // An explicitly-empty FLUTTER_DEVICE_WEBOS_SDK_BIN opts out of the guard.
    expect(resolveWebosSdkBin({ [WEBOS_SDK_BIN_ENV]: "" })).toBeUndefined();
    // The guard treats a falsy/empty dir as a no-op even if a dir would 'exist'.
    expect(withWebosPathGuard(cmd, "", () => true)).toBe(cmd);
  });

  it("quotes a bin dir containing spaces", () => {
    const guarded = withWebosPathGuard(cmd, "/opt/web os/bin", () => true);
    expect(guarded).toContain("export PATH='/opt/web os/bin:'\"$PATH\";");
  });
});
