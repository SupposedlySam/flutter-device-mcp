import {
  classifyIosFailure,
  isPodDrift,
  isProvisioningFailure,
  iosPodInstallEnv,
  messageForIosFailure,
  IOS_POD_DRIFT_MESSAGE,
  IOS_PROVISIONING_MESSAGE,
  IOS_UNSIGNED_BUNDLE_MESSAGE,
} from "../src/iosBuildDiagnostics.js";

describe("classifyIosFailure precedence", () => {
  it("classifies CocoaPods sandbox drift (the post-branch-switch failure)", () => {
    const real =
      "error: The sandbox is not in sync with the Podfile.lock. " +
      "Run 'pod install' or update your CocoaPods installation.";
    expect(classifyIosFailure(real)).toBe("pod-drift");
    expect(isPodDrift(real)).toBe(true);
  });

  it("classifies a provisioning / device-registration failure", () => {
    expect(
      classifyIosFailure("error: Runner requires a provisioning profile.")
    ).toBe("provisioning");
    expect(
      classifyIosFailure("No profiles for 'com.example.app' were found")
    ).toBe("provisioning");
    expect(isProvisioningFailure("requires a provisioning profile")).toBe(true);
  });

  it("classifies a genuine unsigned-bundle failure", () => {
    expect(
      classifyIosFailure("The bundle Runner.app is not correctly signed.")
    ).toBe("unsigned");
    expect(classifyIosFailure("verification failed (0xe8008001)")).toBe(
      "unsigned"
    );
  });

  it("classifies ENOSPC (owned by the uninstall-and-retry path)", () => {
    expect(
      classifyIosFailure(
        "Could not install com.example.app on iPhone. No space left on device"
      )
    ).toBe("enospc");
  });

  it("returns unknown for an unrelated failure", () => {
    expect(classifyIosFailure("Some other transient error")).toBe("unknown");
  });

  it("PRECEDENCE: pod drift wins over co-occurring signing-shaped noise", () => {
    // A pod-drift build cascade can also print install/sign-shaped errors. The
    // root cause is pod drift — it must NOT be mis-read as an unsigned bundle.
    const cascade =
      "The sandbox is not in sync with the Podfile.lock. Run 'pod install'\n" +
      "Could not install com.example.app on iPhone.\n" +
      "Try launching Xcode and selecting Product > Run to fix the problem:\n" +
      "(This code will be run under an unsigned/invalid signature.)";
    expect(classifyIosFailure(cascade)).toBe("pod-drift");
  });

  it("PRECEDENCE: ENOSPC wins over the signing hint on a shared 'Could not install' preamble", () => {
    const enospc =
      "Could not install com.example.app on iPhone. " +
      "Product > Run. No space left on device";
    expect(classifyIosFailure(enospc)).toBe("enospc");
  });

  it("PRECEDENCE: provisioning wins over the generic unsigned class", () => {
    const both =
      "requires a provisioning profile. The bundle is not correctly signed.";
    expect(classifyIosFailure(both)).toBe("provisioning");
  });
});

describe("messageForIosFailure", () => {
  it("maps each class to its actionable message (enospc/unknown → null)", () => {
    expect(messageForIosFailure("pod-drift")).toBe(IOS_POD_DRIFT_MESSAGE);
    expect(messageForIosFailure("provisioning")).toBe(IOS_PROVISIONING_MESSAGE);
    expect(messageForIosFailure("unsigned")).toBe(IOS_UNSIGNED_BUNDLE_MESSAGE);
    expect(messageForIosFailure("enospc")).toBeNull();
    expect(messageForIosFailure("unknown")).toBeNull();
  });

  it("the pod-drift message names the UTF-8 locale fix, not code-signing", () => {
    expect(IOS_POD_DRIFT_MESSAGE).toMatch(/pod install/i);
    expect(IOS_POD_DRIFT_MESSAGE).toMatch(/en_US\.UTF-8/);
    expect(IOS_POD_DRIFT_MESSAGE).toMatch(/NOT a code-signing/i);
  });

  it("the provisioning message documents the one-shot xcodebuild registration step", () => {
    expect(IOS_PROVISIONING_MESSAGE).toMatch(/-allowProvisioningUpdates/);
    expect(IOS_PROVISIONING_MESSAGE).toMatch(
      /-allowProvisioningDeviceRegistration/
    );
    expect(IOS_PROVISIONING_MESSAGE).toMatch(/Runner\.xcworkspace/);
  });

  it("the unsigned message steers to the full flutter run pipeline", () => {
    expect(IOS_UNSIGNED_BUNDLE_MESSAGE).toMatch(/flutter run/i);
    expect(IOS_UNSIGNED_BUNDLE_MESSAGE).toMatch(/Runner\.xcworkspace/);
  });
});

describe("iosPodInstallEnv", () => {
  it("forces a UTF-8 locale (dodges the Ruby-4.0 Encoding::CompatibilityError)", () => {
    expect(iosPodInstallEnv).toEqual({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    });
  });
});
