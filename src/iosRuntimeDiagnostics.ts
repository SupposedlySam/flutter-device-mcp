/**
 * Classify iOS RUNTIME crashes read out of a launch log.
 *
 * WHY THIS IS NOT IN {@link ./iosBuildDiagnostics}: that module classifies
 * build/deploy output, and its precedence chain is built on the rule that
 * pod-drift is the ROOT cause that cascades into install-shaped errors. The
 * failures here are of a different kind — the app BUILT, INSTALLED and STARTED,
 * then died while rendering. Folding a runtime class into that chain would let a
 * stale crash from an earlier run outrank the pod-install failure that is the
 * actual reason the current deploy produced no bundle. Two kinds of event, two
 * classifiers, and a log that spans a retry cannot make one impersonate the other.
 *
 * WHY THIS EXISTS (learned on-device, iOS Simulator):
 *
 *  - Flutter 3.44 is IMPELLER-ONLY on iOS — the Skia backend is gone. The
 *    simulator's Metal implementation caps constant-buffer bindings at 14, so a
 *    runtime-effect shader needing 16 fails pipeline creation and takes the app
 *    down with it. The crash names both numbers, which is the useful part: it
 *    says how far over the ceiling the shader is, not merely that it failed.
 *
 *  - The two flags a reader will reach for FIRST are both no-ops on iOS in this
 *    version: `--no-enable-impeller` and `FLTEnableImpeller=false` in
 *    Info.plist. Surfacing the crash without saying so sends people to spend an
 *    hour on switches that cannot work, so the message says it.
 *
 * The fix is APP-SIDE — select Skia-compatible shader variants when running on a
 * simulator — so this module's whole job is to name the class accurately and get
 * out of the way. It never pretends the tool can repair it.
 */

/** What a matched constant-buffer overflow tells us. */
export interface ImpellerShaderLimitFinding {
  /** The Metal constant-buffer ceiling reported (14 on the simulator), or null. */
  available: number | null;
  /** How many buffers the shader asked for (e.g. 16), or null. */
  used: number | null;
  /** The matched crash text, trimmed — surfaced verbatim rather than paraphrased. */
  line: string;
}

/**
 * The constant-buffer overflow signature.
 *
 * Anchored on the BUFFER ARITHMETIC ("only N constant buffers … but M were
 * used") rather than on "Could not create render pipeline", because that phrase
 * covers every Impeller pipeline failure — a bad blend mode, an unsupported
 * vertex format — and matching it alone would report a buffer-limit diagnostic
 * for crashes that have nothing to do with the limit. The arithmetic appears
 * only in the overflow case.
 */
export const IOS_IMPELLER_SHADER_LIMIT_SIGNATURE =
  /only\s+(\d+)\s+constant\s+buffers?\b[^\n]*?\bbut\s+(\d+)\s+(?:were|was)\s+used/i;

/**
 * A pipeline-creation failure with no buffer arithmetic in it. Kept SEPARATE and
 * deliberately not merged into the signature above: it is the same subsystem
 * failing for a reason this module cannot name, and reporting it as a
 * buffer-limit crash would be a confident wrong answer.
 */
export const IOS_IMPELLER_PIPELINE_SIGNATURE =
  /Could not create (?:render )?pipeline/i;

/**
 * Extract the constant-buffer overflow from a launch log, or null when it is not
 * there.
 *
 * Returns the two numbers when the crash carries them. They are `number | null`
 * rather than defaulted, because a shape this module has not seen must not be
 * reported as "0 available" — that reads as a measurement and it would be an
 * invention.
 */
export function detectImpellerShaderLimit(
  log: string
): ImpellerShaderLimitFinding | null {
  if (!log) return null;
  const match = log.match(IOS_IMPELLER_SHADER_LIMIT_SIGNATURE);
  if (!match) return null;

  const available = Number.parseInt(match[1], 10);
  const used = Number.parseInt(match[2], 10);

  return {
    available: Number.isNaN(available) ? null : available,
    used: Number.isNaN(used) ? null : used,
    line: match[0].trim(),
  };
}

/**
 * True when the log shows Impeller failing to build a pipeline for a reason that
 * is NOT the constant-buffer ceiling. Callers use this to say "Impeller pipeline
 * creation failed" without attaching the buffer-limit explanation to it.
 */
export function isImpellerPipelineFailure(log: string): boolean {
  if (!log) return false;
  if (detectImpellerShaderLimit(log)) return false;
  return IOS_IMPELLER_PIPELINE_SIGNATURE.test(log);
}

/**
 * The actionable diagnostic for a constant-buffer overflow.
 *
 * States the two dead ends by name. Both are the first thing a reader reaches
 * for and both are no-ops on iOS in this Flutter version, so omitting them does
 * not leave the reader neutral — it leaves them about to spend an hour on a
 * switch that cannot work.
 */
export function impellerShaderLimitMessage(
  finding: ImpellerShaderLimitFinding
): string {
  const arithmetic =
    finding.available !== null && finding.used !== null
      ? `The shader binds ${finding.used} constant buffers; this device allows ${finding.available}.`
      : "The shader binds more constant buffers than this device allows.";

  return (
    `Impeller could not create a Metal render pipeline. ${arithmetic} ` +
    "The app built, installed and started — it died while RENDERING, so this is " +
    "not a build, signing or install failure. " +
    "On the iOS Simulator the Metal constant-buffer ceiling is 14. " +
    "Flutter 3.44+ is Impeller-ONLY on iOS (the Skia backend was removed), and " +
    "BOTH of the obvious escapes are no-ops there: `--no-enable-impeller` and " +
    "`FLTEnableImpeller=false` in Info.plist do nothing on iOS in this version. " +
    "The fix is APP-SIDE: select a shader variant that fits the ceiling when " +
    "running on a simulator (e.g. a Skia-compatible variant behind a " +
    "rendering-engine abstraction). This tool cannot repair it. If your app " +
    "keys that choice off a compile-time constant, pass it through with " +
    "`--dart-define` on build/deploy, which is already supported. " +
    "Verifying on a PHYSICAL iOS device is the fastest way to confirm the " +
    "ceiling is the cause: real Metal hardware allows more bindings."
  );
}

/**
 * The one-call form for a caller holding a launch log: the message when this is
 * a constant-buffer overflow, else null.
 */
export function messageForIosRuntimeCrash(log: string): string | null {
  const finding = detectImpellerShaderLimit(log);
  return finding ? impellerShaderLimitMessage(finding) : null;
}
