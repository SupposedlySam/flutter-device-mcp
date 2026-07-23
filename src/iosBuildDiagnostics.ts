/**
 * Classify iOS build/deploy failure output into an ORDERED set of known failure
 * classes so the deploy path can react correctly and surface an accurate
 * diagnostic instead of a misleading one.
 *
 * WHY THIS EXISTS (learned on-device, DROP iOS deploy):
 *
 *  - A CocoaPods sandbox that drifted out of sync with `Podfile.lock` (common
 *    right after a branch switch) makes the Xcode/flutter build fail early with
 *    "The sandbox is not in sync with the Podfile.lock. Run 'pod install'". The
 *    build never produces a valid signed bundle — so the DOWNSTREAM install then
 *    fails too, and its generic "Could not install …" text used to trip the
 *    unsigned-bundle signing hint. The signing hint was MISLEADING: the real
 *    cause was pod drift, and running `pod install` (with a UTF-8 locale, see
 *    {@link iosPodInstallEnv}) then rebuilding fixes it.
 *
 *  - A device that was never registered with the Apple Development team (or a
 *    missing/stale provisioning profile) fails with "requires a provisioning
 *    profile" / "No profiles for '…' were found" / "doesn't include the currently
 *    selected device". This is fixable with a one-shot provisioning-updating
 *    `xcodebuild` build (see the adapter), NOT by re-signing an existing bundle.
 *
 *  - Only when NEITHER of the above matched, and the output carries a genuine
 *    code-signature signal, is the unsigned-bundle signing diagnostic the right
 *    one to lead with.
 *
 * The ORDER matters: pod-drift and provisioning are checked BEFORE the signing
 * class, because a pod-drift failure cascades into install/sign-shaped errors
 * that would otherwise mis-classify as "not code-signed". This module encodes
 * that precedence in one pure, unit-testable place.
 */

/** The distinct iOS build/deploy failure classes, most-specific first. */
export type IosFailureClass =
  | "pod-drift"
  | "provisioning"
  | "enospc"
  | "unsigned"
  | "unknown";

/**
 * Sandbox-out-of-sync signature. Xcode/CocoaPods emits this verbatim when the
 * `Pods/` sandbox no longer matches `Podfile.lock` — the canonical post-branch-
 * switch failure. Anchored on the actionable "Run 'pod install'" phrase and the
 * "sandbox is not in sync" phrase (either half is sufficient).
 */
export const IOS_POD_DRIFT_SIGNATURES: RegExp[] = [
  /sandbox is not in sync with the Podfile\.lock/i,
  /The sandbox is not in sync/i,
  /run\s+['"`]?pod install['"`]?/i,
];

/**
 * The Ruby-4.0 (homebrew) CocoaPods crash. `pod install` under a non-UTF-8
 * locale throws `Unicode Normalization not appropriate for ASCII-8BIT
 * (Encoding::CompatibilityError)`. The fix is to run it with a UTF-8 locale
 * ({@link iosPodInstallEnv}); this signature lets the adapter recognize the crash
 * and surface the locale cause if it ever slips through.
 */
export const IOS_POD_ENCODING_CRASH_SIGNATURE =
  /Unicode Normalization not appropriate for ASCII-8BIT|Encoding::CompatibilityError/i;

/**
 * Provisioning / device-registration signatures. A physical device that was
 * never registered with the team, or a missing profile, surfaces one of these.
 * A one-shot provisioning-updating `xcodebuild` build (registering the device +
 * minting the profile) is the fix — distinct from re-signing an existing bundle.
 */
export const IOS_PROVISIONING_SIGNATURES: RegExp[] = [
  /requires a provisioning profile/i,
  /No profiles? for [^\n]* were found/i,
  /doesn'?t include (?:the currently selected|signing certificate|any) /i,
  /no valid (?:ios )?provisioning profile/i,
  /device (?:is )?not (?:registered|in your developer account)/i,
  /Failed to register bundle identifier/i,
];

/** Out-of-space signal — a disk failure, not a signing or pod one. */
export const IOS_ENOSPC_SIGNATURE = /No space left on device/i;

/**
 * Genuine code-signature signals. These are ONLY consulted after pod-drift and
 * provisioning have been ruled out (see {@link classifyIosFailure}), because a
 * pod-drift build cascade emits install/sign-shaped noise that must not be
 * mis-read as an unsigned bundle.
 */
export const IOS_UNSIGNED_SIGNATURES: RegExp[] = [
  /Product\s*>\s*Run/i,
  /0xe8008001/i,
  /bundle[^\n]*not[^\n]*signed/i,
  /application[^\n]*not[^\n]*signed/i,
  /valid code signature/i,
];

/**
 * Classify a captured build/deploy `combined` output into its failure class,
 * applying the precedence pod-drift > enospc > provisioning > unsigned. Returns
 * `"unknown"` when nothing matched (the caller leaves it to the generic path).
 *
 * Precedence rationale:
 *  - pod-drift first: it is the ROOT cause that cascades into install/sign-shaped
 *    errors; catching it first prevents the misleading signing diagnostic.
 *  - enospc before provisioning/unsigned: an out-of-space "Could not install …"
 *    is a disk failure the uninstall-and-retry path owns, never a signing one.
 *  - provisioning before unsigned: "requires a provisioning profile" is a
 *    device-registration fix (a provisioning `xcodebuild` build), not a re-sign.
 */
export function classifyIosFailure(combined: string): IosFailureClass {
  if (IOS_POD_DRIFT_SIGNATURES.some((re) => re.test(combined))) {
    return "pod-drift";
  }
  if (IOS_ENOSPC_SIGNATURE.test(combined)) return "enospc";
  if (IOS_PROVISIONING_SIGNATURES.some((re) => re.test(combined))) {
    return "provisioning";
  }
  if (IOS_UNSIGNED_SIGNATURES.some((re) => re.test(combined))) {
    return "unsigned";
  }
  return "unknown";
}

/** True when the output signals a CocoaPods sandbox-drift failure. */
export function isPodDrift(combined: string): boolean {
  return classifyIosFailure(combined) === "pod-drift";
}

/** True when the output signals a provisioning / device-registration failure. */
export function isProvisioningFailure(combined: string): boolean {
  return classifyIosFailure(combined) === "provisioning";
}

/**
 * The environment overrides needed to run `pod install` without the Ruby-4.0
 * homebrew `Encoding::CompatibilityError` crash: force a UTF-8 locale. Merged
 * over the inherited environment by the caller (never replacing it), so PATH and
 * everything else the developer relies on is preserved.
 */
export const iosPodInstallEnv: Readonly<Record<string, string>> = {
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
};

/** Human-readable diagnostic per failure class (null for unknown). */
export const IOS_POD_DRIFT_MESSAGE =
  "CocoaPods sandbox is out of sync with Podfile.lock (common right after a " +
  "branch switch). The build failed BEFORE producing a signed bundle — this is " +
  "NOT a code-signing problem. Ran `pod install` with a UTF-8 locale " +
  "(LANG/LC_ALL=en_US.UTF-8, to dodge the Ruby-4.0 Encoding::CompatibilityError " +
  "crash) and retried the deploy.";

export const IOS_POD_INSTALL_FAILED_MESSAGE =
  "`pod install` itself failed while recovering from CocoaPods sandbox drift. " +
  "This is the real blocker (NOT code-signing). If the output shows " +
  "`Unicode Normalization not appropriate for ASCII-8BIT " +
  "(Encoding::CompatibilityError)`, it is the Ruby-4.0 homebrew CocoaPods bug — " +
  "re-run `pod install` in your app's ios with LANG=en_US.UTF-8 " +
  "LC_ALL=en_US.UTF-8 set.";

export const IOS_PROVISIONING_MESSAGE =
  "iOS provisioning failed — the device may not be registered with your Apple " +
  "Development team, or the profile is missing/stale. This is NOT a re-sign of an " +
  "existing bundle. A one-shot provisioning build registers the device + mints " +
  "the profile: `xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner " +
  "-configuration Debug -destination \"platform=iOS,id=<hw-udid>\" " +
  "-allowProvisioningUpdates -allowProvisioningDeviceRegistration build` (uses " +
  "the Mac's Xcode Apple ID session), then redeploy.";

export const IOS_UNSIGNED_BUNDLE_MESSAGE =
  "iOS bundle isn't code-signed for this device — deploy via the full " +
  "`flutter run` pipeline (which signs + installs), or open ios/Runner.xcworkspace " +
  "and run Product▸Run once to register/sign, then redeploy.";

/**
 * Map a classified failure to its actionable message. Returns `null` for the
 * `unknown` class so the caller omits the diagnostic rather than guessing.
 */
export function messageForIosFailure(cls: IosFailureClass): string | null {
  switch (cls) {
    case "pod-drift":
      return IOS_POD_DRIFT_MESSAGE;
    case "provisioning":
      return IOS_PROVISIONING_MESSAGE;
    case "unsigned":
      return IOS_UNSIGNED_BUNDLE_MESSAGE;
    case "enospc":
      // ENOSPC is handled by the deploy's uninstall-and-retry path, not a
      // surfaced diagnostic — mirror the prior behavior of returning null here.
      return null;
    case "unknown":
    default:
      return null;
  }
}
