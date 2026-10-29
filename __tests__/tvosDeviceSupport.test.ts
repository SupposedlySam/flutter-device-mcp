import {
  deviceSupportDirMatches,
  tvosDeviceSupportDiagnostic,
} from "../src/tvosDeviceSupport.js";

const ROOT = "/Xcode/tvOS DeviceSupport";
const APPLE_TV = {
  name: "Den",
  productType: "AppleTV14,1",
  osVersion: "27.0",
  osBuild: "24J361",
};

function fakeFs(dirs: Record<string, boolean>) {
  return {
    listDir: () => Object.keys(dirs),
    exists: (file: string) =>
      Object.entries(dirs).some(
        ([dir, finalized]) => finalized && file === `${ROOT}/${dir}/.finalized`
      ),
  };
}

describe("deviceSupportDirMatches", () => {
  it("matches the current and the older directory naming on version and build", () => {
    expect(deviceSupportDirMatches("AppleTV14,1 27.0 (24J361)", "27.0", "24J361")).toBe(true);
    expect(deviceSupportDirMatches("27.0 (24J361)", "27.0", "24J361")).toBe(true);
  });

  it("does not match another build or a version that only ends the same way", () => {
    expect(deviceSupportDirMatches("AppleTV14,1 27.0 (24J360)", "27.0", "24J361")).toBe(false);
    expect(deviceSupportDirMatches("AppleTV14,1 17.0 (24J361)", "7.0", "24J361")).toBe(false);
  });
});

describe("tvosDeviceSupportDiagnostic", () => {
  it("names the release, the device and the Xcode step when no symbols exist", () => {
    const diagnostic = tvosDeviceSupportDiagnostic(
      APPLE_TV,
      ROOT,
      fakeFs({ "AppleTV14,1 26.5 (23L471)": true })
    );
    expect(diagnostic).toMatch(
      /^Xcode has no debug symbols for tvOS 27\.0 \(24J361\), the release on "Den"/
    );
    expect(diagnostic).toMatch(/Window > Devices and Simulators, select "Den"/);
  });

  it("reports a copy that has not finalized", () => {
    expect(
      tvosDeviceSupportDiagnostic(APPLE_TV, ROOT, fakeFs({ "AppleTV14,1 27.0 (24J361)": false }))
    ).toMatch(/^Xcode has started copying the debug symbols for tvOS 27\.0 \(24J361\)/);
  });

  it("is null once the symbols are finalized", () => {
    expect(
      tvosDeviceSupportDiagnostic(APPLE_TV, ROOT, fakeFs({ "AppleTV14,1 27.0 (24J361)": true }))
    ).toBeNull();
  });

  it("treats a missing DeviceSupport directory as no symbols", () => {
    const missingRoot = {
      listDir: () => {
        throw new Error("ENOENT");
      },
      exists: () => false,
    };
    expect(tvosDeviceSupportDiagnostic(APPLE_TV, ROOT, missingRoot)).toMatch(
      /no debug symbols for tvOS 27\.0/
    );
  });

  it("is null when devicectl did not report the version and build", () => {
    expect(
      tvosDeviceSupportDiagnostic({ name: "Den" }, ROOT, fakeFs({}))
    ).toBeNull();
  });
});
