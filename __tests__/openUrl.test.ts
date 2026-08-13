import { execFileSync } from "child_process";
import {
  androidOpenUrlFailure,
  appleDeviceOpenUrlUnsupported,
  buildAdbOpenUrlCommand,
  buildSimctlOpenUrlCommand,
  invalidOpenUrlReason,
} from "../src/openUrl.js";

describe("invalidOpenUrlReason", () => {
  it("accepts both deep-link forms", () => {
    expect(invalidOpenUrlReason("myapp://details?id=42")).toBeNull();
    expect(
      invalidOpenUrlReason("https://example.com/details?id=42%3A7")
    ).toBeNull();
  });

  it("rejects a URL with no scheme, naming what a scheme looks like", () => {
    const reason = invalidOpenUrlReason("example.com/details?id=42");
    expect(reason).toContain("no scheme");
    // The message has to be actionable — a bare "invalid URL" sends the caller
    // looking at the app instead of at their argument.
    expect(reason).toContain("myapp://");
  });

  it("rejects empty and control-character URLs", () => {
    expect(invalidOpenUrlReason("")).toContain("empty");
    expect(invalidOpenUrlReason("   ")).toContain("empty");
    expect(invalidOpenUrlReason("myapp://x\nrm -rf /")).toContain(
      "control characters"
    );
  });

  it("rejects a URL past the length limit", () => {
    expect(invalidOpenUrlReason(`myapp://x?p=${"a".repeat(2048)}`)).toContain(
      "limit"
    );
  });
});

describe("buildAdbOpenUrlCommand", () => {
  it("builds a VIEW intent scoped to the package", () => {
    expect(
      buildAdbOpenUrlCommand("ABC123", "myapp://details?id=42", "com.example.app")
    ).toBe(
      "adb -s 'ABC123' shell am start -a android.intent.action.VIEW " +
        "-d 'myapp://details?id=42' 'com.example.app'"
    );
  });

  it("omits the package when none is given, leaving the OS to disambiguate", () => {
    const command = buildAdbOpenUrlCommand("ABC123", "https://example.com/x");
    expect(command).toContain("-d 'https://example.com/x'");
    expect(command.trimEnd().endsWith("'https://example.com/x'")).toBe(true);
  });

  // The safety claim is about SHELL TOKENIZATION, so these ask a real shell to
  // split the built command and check the URL survives as ONE argument.
  // Asserting on the substring instead would pass even if the quoting broke,
  // since the dangerous text legitimately appears inside the quoted argument.
  function shellWords(command: string): string[] {
    const args = command.replace(/^adb /, "");
    const out = execFileSync("/bin/sh", [
      "-c",
      `printf '%s\\n' ${args}`,
    ]).toString();
    return out.split("\n").filter((line) => line.length > 0);
  }

  it("passes a URL with shell metacharacters through as a single argument", () => {
    const url = "https://example.com/x?a=1&b=2;echo pwned";
    const words = shellWords(buildAdbOpenUrlCommand("serial", url));
    expect(words).toContain(url);
    expect(words).not.toContain("echo");
    expect(words).not.toContain("pwned");
  });

  it("survives an embedded single quote without terminating the argument", () => {
    const url = "myapp://x?q='; id #";
    const words = shellWords(buildAdbOpenUrlCommand("serial", url));
    expect(words).toContain(url);
    expect(words).not.toContain("id");
  });

  it("keeps percent-encoding untouched so the app decodes it, not the shell", () => {
    const url = "myapp://details?id=90%3A0%3A42";
    expect(shellWords(buildAdbOpenUrlCommand("serial", url))).toContain(url);
  });
});

describe("buildSimctlOpenUrlCommand", () => {
  it("builds a quoted simctl openurl invocation", () => {
    expect(buildSimctlOpenUrlCommand("ABC-123", "myapp://details?id=42")).toBe(
      "xcrun simctl openurl 'ABC-123' 'myapp://details?id=42'"
    );
  });
});

describe("androidOpenUrlFailure", () => {
  it("treats re-delivery to the running instance as SUCCESS, not failure", () => {
    // This is the normal output when firing several links in a row at an
    // already-foregrounded app. Calling it a failure would make every
    // back-to-back deep-link run look broken.
    const combined =
      "Starting: Intent { act=android.intent.action.VIEW dat=myapp://details }\n" +
      "Warning: Activity not started, intent has been delivered to currently running top-most instance.";
    expect(androidOpenUrlFailure(combined)).toBeNull();
  });

  it("reports a plain successful start as no failure", () => {
    expect(
      androidOpenUrlFailure(
        "Starting: Intent { act=android.intent.action.VIEW dat=myapp://details }"
      )
    ).toBeNull();
  });

  it("detects an unresolvable intent", () => {
    const failure = androidOpenUrlFailure(
      "Starting: Intent { ... }\nError: Activity not started, unable to resolve Intent"
    );
    expect(failure).not.toBeNull();
    expect(failure).toContain("Error:");
  });

  it("detects the unresolvable-intent wording even without an Error: line", () => {
    expect(
      androidOpenUrlFailure("Activity not started, unable to resolve Intent { }")
    ).toContain("assetlinks.json");
  });

  it("surfaces a generic am Error line", () => {
    expect(
      androidOpenUrlFailure("Error: Activity class {x/y} does not exist.")
    ).toBe("Error: Activity class {x/y} does not exist.");
  });
});

describe("appleDeviceOpenUrlUnsupported", () => {
  it("names the platform and points at the path that does work", () => {
    const { reason, hint } = appleDeviceOpenUrlUnsupported("iOS");
    expect(reason).toContain("iOS");
    expect(reason).toContain("devicectl");
    expect(hint).toContain("simulator");
  });
});
