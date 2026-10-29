import {
  detectImpellerShaderLimit,
  impellerShaderLimitMessage,
  isImpellerPipelineFailure,
  messageForIosRuntimeCrash,
  IOS_IMPELLER_SHADER_LIMIT_SIGNATURE,
} from "../src/iosRuntimeDiagnostics.js";
import { IOS_FAILURE_SIGNATURES } from "../src/adapters/ios.js";
import { evaluateLaunchLog } from "../src/launchCapture.js";
import { classifyIosFailure } from "../src/iosBuildDiagnostics.js";

// The crash as Impeller actually prints it, kept verbatim rather than reduced to
// the phrase under test: a signature that only matches a tidied-up version of the
// line is a signature that does not match the device.
const REAL_CRASH =
  "[ERROR:flutter/impeller/renderer/backend/metal/pipeline_library_mtl.mm(103)] " +
  "Could not create render pipeline for RuntimeEffect: Fragment shader " +
  "expected only 14 constant buffers to be available, but 16 were used.";

describe("detectImpellerShaderLimit", () => {
  it("extracts both numbers from the real crash line", () => {
    const finding = detectImpellerShaderLimit(REAL_CRASH);
    expect(finding).not.toBeNull();
    expect(finding!.available).toBe(14);
    expect(finding!.used).toBe(16);
  });

  it("returns the matched text so it can be surfaced verbatim", () => {
    const finding = detectImpellerShaderLimit(REAL_CRASH);
    expect(finding!.line).toContain("14 constant buffers");
    expect(finding!.line).toContain("16 were used");
  });

  it("finds the crash inside a large surrounding log", () => {
    const log = [
      "Launching lib/main.dart on iPhone 15 in debug mode...",
      "Xcode build done.                                   28.4s",
      "Syncing files to device iPhone 15...",
      REAL_CRASH,
      "Lost connection to device.",
    ].join("\n");
    expect(detectImpellerShaderLimit(log)!.used).toBe(16);
  });

  it("reads arbitrary ceilings, not a hardcoded 14/16", () => {
    // The simulator's ceiling is 14 today. A detector that only matched those two
    // numbers would silently stop working on any other device or Metal version,
    // and would look exactly like a log with no crash in it.
    const other =
      "Could not create render pipeline: only 31 constant buffers available, but 40 were used.";
    const finding = detectImpellerShaderLimit(other);
    expect(finding!.available).toBe(31);
    expect(finding!.used).toBe(40);
  });

  it("accepts the singular 'buffer' and 'was used' phrasings", () => {
    const finding = detectImpellerShaderLimit(
      "only 1 constant buffer is available, but 2 was used"
    );
    expect(finding!.available).toBe(1);
    expect(finding!.used).toBe(2);
  });

  it("returns null for an empty or unrelated log", () => {
    expect(detectImpellerShaderLimit("")).toBeNull();
    expect(
      detectImpellerShaderLimit("Syncing files to device iPhone 15...")
    ).toBeNull();
  });

  it("does NOT match a pipeline failure that carries no buffer arithmetic", () => {
    // "Could not create render pipeline" covers every Impeller pipeline failure —
    // a bad blend mode, an unsupported vertex format. Reporting the
    // constant-buffer diagnostic for those would be a confident wrong answer.
    const unrelated =
      "[ERROR:flutter/impeller/renderer/backend/metal/pipeline_library_mtl.mm(103)] " +
      "Could not create render pipeline for Blend: unsupported vertex descriptor.";
    expect(detectImpellerShaderLimit(unrelated)).toBeNull();
    expect(isImpellerPipelineFailure(unrelated)).toBe(true);
  });

  it("isImpellerPipelineFailure is false for the buffer-limit crash (it is classified)", () => {
    // The two are mutually exclusive on purpose: the caller asks the generic
    // question only when the specific one has no answer.
    expect(isImpellerPipelineFailure(REAL_CRASH)).toBe(false);
  });

  it("isImpellerPipelineFailure is false for an empty or clean log", () => {
    expect(isImpellerPipelineFailure("")).toBe(false);
    expect(isImpellerPipelineFailure("Syncing files to device...")).toBe(false);
  });
});

describe("impellerShaderLimitMessage", () => {
  const message = impellerShaderLimitMessage(
    detectImpellerShaderLimit(REAL_CRASH)!
  );

  it("states the arithmetic that was actually read", () => {
    expect(message).toContain("binds 16 constant buffers");
    expect(message).toContain("allows 14");
  });

  it("names BOTH no-op escapes, because they are what a reader reaches for first", () => {
    expect(message).toContain("--no-enable-impeller");
    expect(message).toContain("FLTEnableImpeller");
  });

  it("says the fix is app-side rather than implying the tool can repair it", () => {
    expect(message).toMatch(/APP-SIDE/);
    expect(message).toContain("cannot repair");
  });

  it("says the app built and installed, so this is not read as a build failure", () => {
    expect(message).toMatch(/not a build, signing or install failure/i);
  });

  it("degrades honestly when the numbers are absent", () => {
    // A shape the regex matched but whose numbers did not parse must not be
    // reported as "0 allowed" — that reads as a measurement and would be invented.
    const vague = impellerShaderLimitMessage({
      available: null,
      used: null,
      line: "only N constant buffers ... but M were used",
    });
    expect(vague).toContain("more constant buffers than this device allows");
    expect(vague).not.toMatch(/binds null/);
    expect(vague).not.toMatch(/allows 0\b/);
  });
});

describe("messageForIosRuntimeCrash", () => {
  it("returns the diagnostic for the buffer-limit crash", () => {
    expect(messageForIosRuntimeCrash(REAL_CRASH)).toContain("Impeller");
  });

  it("returns null when there is no known runtime crash", () => {
    expect(messageForIosRuntimeCrash("Syncing files to device...")).toBeNull();
    expect(messageForIosRuntimeCrash("")).toBeNull();
  });
});

describe("the runtime classifier is kept OUT of the build classifier", () => {
  it("classifyIosFailure does not claim the Impeller crash", () => {
    // The two must never share a precedence chain. A log spanning a retry can
    // hold both a stale runtime crash and the live build failure, and the build
    // failure is the one that explains why this deploy produced no bundle.
    expect(classifyIosFailure(REAL_CRASH)).toBe("unknown");
  });

  it("a pod-drift build failure still classifies as pod-drift beside a stale crash", () => {
    const mixed = [
      REAL_CRASH,
      "error: The sandbox is not in sync with the Podfile.lock. Run 'pod install'",
    ].join("\n");
    expect(classifyIosFailure(mixed)).toBe("pod-drift");
  });
});

describe("launch-poll wiring", () => {
  it("the signature is in the iOS failure set, so an EARLY crash fails fast", () => {
    expect(IOS_FAILURE_SIGNATURES).toContain(
      IOS_IMPELLER_SHADER_LIMIT_SIGNATURE
    );
  });

  it("stops the poll when the crash beats the URI to the log", () => {
    const evaluation = evaluateLaunchLog(REAL_CRASH, IOS_FAILURE_SIGNATURES);
    expect(evaluation.kind).toBe("failure");
  });

  it("a found URI still WINS over the crash — the launch did succeed", () => {
    // This pins the documented limitation rather than a bug. The crash normally
    // fires after the URI is printed; the launch genuinely succeeded and must be
    // reported that way. flutter_diagnose is the surface for the post-launch case,
    // and if this ever flips to "failure" the deploy would start reporting a
    // successful launch as a failure.
    const log = [
      "A Dart VM Service on iPhone 15 is available at: http://127.0.0.1:51182/tys47XX1iAw=/",
      REAL_CRASH,
    ].join("\n");
    const evaluation = evaluateLaunchLog(log, IOS_FAILURE_SIGNATURES);
    expect(evaluation.kind).toBe("uri");
  });
});
