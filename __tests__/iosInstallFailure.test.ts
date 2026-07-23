import {
  diagnoseIosInstallFailure,
  IOS_UNSIGNED_BUNDLE_MESSAGE,
} from "../src/iosInstallFailure.js";

describe("diagnoseIosInstallFailure", () => {
  it("matches the real 'Could not install … Product > Run' failure text", () => {
    const real =
      "Installing and launching...\n" +
      "Could not install com.example.app on iPhone.\n" +
      "Try launching Xcode and selecting Product > Run to fix the problem:\n" +
      "(This code will be run under an unsigned/invalid signature.)";
    expect(diagnoseIosInstallFailure(real)).toBe(IOS_UNSIGNED_BUNDLE_MESSAGE);
  });

  it("matches the 0xe8008001 bad-signature code", () => {
    const real =
      "ERROR: Failed to install the requested application\n" +
      "The application could not be verified. (0xe8008001)";
    expect(diagnoseIosInstallFailure(real)).toBe(IOS_UNSIGNED_BUNDLE_MESSAGE);
  });

  it("matches an explicit 'bundle is not signed' phrasing", () => {
    expect(
      diagnoseIosInstallFailure("The bundle Runner.app is not correctly signed.")
    ).toBe(IOS_UNSIGNED_BUNDLE_MESSAGE);
  });

  it("surfaces the actionable next step (flutter run pipeline / Product Run)", () => {
    expect(IOS_UNSIGNED_BUNDLE_MESSAGE).toMatch(/Runner\.xcworkspace/);
    expect(IOS_UNSIGNED_BUNDLE_MESSAGE).toMatch(/Product/);
    expect(IOS_UNSIGNED_BUNDLE_MESSAGE).toMatch(/redeploy/i);
  });

  it("returns null for an unrelated failure (leaves it to the generic path)", () => {
    expect(
      diagnoseIosInstallFailure("No space left on device")
    ).toBeNull();
    expect(diagnoseIosInstallFailure("Some other transient error")).toBeNull();
  });

  it("does NOT surface the signing hint for an ENOSPC 'Could not install' failure", () => {
    // Out-of-space shares the generic "Could not install …" preamble but is a
    // disk-space failure — ENOSPC precedence must return null (uninstall-and-retry
    // owns it), not the code-sign hint.
    const enospc =
      "Could not install com.example.app on iPhone. " +
      "No space left on device";
    expect(diagnoseIosInstallFailure(enospc)).toBeNull();
  });

  it("still surfaces the signing hint for a genuine unsigned-bundle failure", () => {
    expect(
      diagnoseIosInstallFailure("The application Runner.app is not signed.")
    ).toBe(IOS_UNSIGNED_BUNDLE_MESSAGE);
    expect(
      diagnoseIosInstallFailure(
        "Verification failed: no valid code signature found."
      )
    ).toBe(IOS_UNSIGNED_BUNDLE_MESSAGE);
  });
});
