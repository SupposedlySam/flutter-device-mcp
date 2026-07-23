/**
 * Classify an iOS install failure into an actionable message.
 *
 * WHY: `flutter build ios --no-codesign` produces an UNSIGNED bundle. Installing
 * that on a physical device fails with a generic, non-actionable error — some
 * mix of "Could not install …", the hint "Try launching Xcode and selecting
 * Product > Run to fix", the code `0xe8008001`, and "bundle … is not … signed".
 * The failure is real but the surfaced text doesn't tell you WHAT to do, so the
 * deploy previously looked like an opaque install crash. We match that class and
 * return a clear next step. We do NOT attempt to auto-fix signing.
 *
 * This is now a THIN wrapper over {@link classifyIosFailure} so the ordered
 * precedence (pod-drift / enospc / provisioning BEFORE unsigned) lives in ONE
 * place. Leading with the signing hint was misleading when the true root cause
 * was pod-sandbox drift or an unregistered device; classifying first fixes that.
 *
 * Pure over the captured `combined` output so it is fully unit-testable.
 */
import { classifyIosFailure, messageForIosFailure } from "./iosBuildDiagnostics.js";

export {
  IOS_UNSIGNED_BUNDLE_MESSAGE,
  IOS_UNSIGNED_SIGNATURES as IOS_UNSIGNED_BUNDLE_SIGNATURES,
} from "./iosBuildDiagnostics.js";

/**
 * Return an actionable message for the install output's failure class, else
 * `null`. Delegates to {@link classifyIosFailure} so pod-drift / provisioning /
 * enospc are recognized and take precedence over the unsigned-bundle hint — the
 * signing message is no longer surfaced for a failure whose real cause is pod
 * drift or device registration.
 */
export function diagnoseIosInstallFailure(combined: string): string | null {
  return messageForIosFailure(classifyIosFailure(combined));
}
