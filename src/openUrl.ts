/**
 * Opening a URL ON the device — the deep-link / universal-link plane.
 *
 * Deep links are reachable ONLY by following a link, so testing one without
 * this means hand-rolling `adb shell am start` or, on a physical iPhone,
 * tapping a link by hand and abandoning the automated run.
 *
 * The module is pure: command builders plus URL validation over strings. The
 * adapters run what it builds.
 *
 * WHAT THIS IS NOT: an in-app navigator. It hands the URL to the OS, exactly as
 * tapping a link would, so it exercises the real intent-filter / URL-scheme /
 * universal-link plumbing rather than bypassing it. In-app navigation belongs to
 * a VM-service driver (e.g. Marionette), not here.
 */
import { quote } from "./cli.js";

/** Result of an attempt to open a URL on a resolved device. */
export interface OpenUrlResult {
  /** True when the URL was handed to the OS successfully. */
  opened: boolean;
  /**
   * False when the platform has no URL-open path at all. Absent (undefined)
   * means the platform supports the verb — `opened` then carries the outcome.
   */
  supported?: boolean;
  /** The URL as it was handed to the device (post-validation, pre-quoting). */
  url?: string;
  /** The resolved device the URL was sent to. */
  device?: string;
  /** The exact shell command run, so a failure can be reproduced by hand. */
  command?: string;
  /** Why the verb is unsupported, or why an attempt failed. */
  reason?: string;
  /** Actionable next step when unsupported (e.g. the path that does work). */
  hint?: string;
  /** Tail of the command output, for diagnosing a failed open. */
  output?: string;
}

/**
 * The maximum URL length accepted. Deep links carry ids and tokens, not
 * payloads; anything past this is far more likely to be a mistake (a pasted
 * file, an unterminated quote) than a real link, and the whole string ends up
 * in a shell command and a log.
 */
const MAX_URL_LENGTH = 2048;

/**
 * Reject a URL that cannot be safely or meaningfully opened, returning the
 * reason; `null` when it is fine.
 *
 * The scheme requirement is the substantive check: `am start -d` and
 * `simctl openurl` both silently do nothing useful for a bare path, which reads
 * as "the deep link is broken" rather than "the argument was wrong".
 *
 * Control characters are rejected outright. Everything else — quotes, spaces,
 * ampersands, semicolons — is SAFE by construction because the URL is passed
 * through {@link quote} into single quotes at the command boundary and never
 * concatenated raw. This validation catches caller mistakes early; it is not
 * the thing standing between you and shell injection.
 */
export function invalidOpenUrlReason(url: string): string | null {
  if (url.trim().length === 0) {
    return "URL is empty.";
  }
  if (url.length > MAX_URL_LENGTH) {
    return `URL is ${url.length} chars; the limit is ${MAX_URL_LENGTH}.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) {
    return "URL contains control characters (newline/NUL/etc).";
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    return (
      "URL has no scheme. Deep links need one — e.g. " +
      "'myapp://details?id=42' or 'https://example.com/details?id=42'."
    );
  }
  return null;
}

/**
 * Build the Android URL-open command:
 * `adb -s <serial> shell am start -a android.intent.action.VIEW -d <url> [pkg]`.
 *
 * Naming the package is optional but strongly preferred: without it a link
 * claimed by more than one app raises a disambiguation chooser that no
 * automated run can answer, and the call appears to hang rather than fail.
 *
 * NOTE on encoding: the URL is single-quoted for the HOST shell, but `am` also
 * parses it on the device. A literal `&` inside a quoted argument reaches `am`
 * intact, so query strings with multiple parameters survive; percent-encoded
 * octets are passed through untouched and decoded by the receiving app.
 */
export function buildAdbOpenUrlCommand(
  serial: string,
  url: string,
  packageName?: string
): string {
  const pkg = packageName ? ` ${quote(packageName)}` : "";
  return (
    `adb -s ${quote(serial)} shell am start ` +
    `-a android.intent.action.VIEW -d ${quote(url)}${pkg}`
  );
}

/**
 * Build the Apple SIMULATOR URL-open command: `xcrun simctl openurl <udid> <url>`.
 *
 * Covers iOS and tvOS simulators identically — simctl does not distinguish the
 * runtime here.
 */
export function buildSimctlOpenUrlCommand(udid: string, url: string): string {
  return `xcrun simctl openurl ${quote(udid)} ${quote(url)}`;
}

/**
 * Android reports a refused/failed intent on STDOUT with a ZERO exit code, so a
 * successful-looking `CommandResult` is not sufficient to claim the link was
 * delivered. Returns the failure text when the output signals one, else `null`.
 *
 * `Warning: Activity not started, intent has been delivered to currently
 * running top-most instance.` is NOT a failure — it is the normal result of
 * re-delivering a link to an already-foregrounded app, which is the common case
 * when driving several links in a row.
 */
export function androidOpenUrlFailure(combined: string): string | null {
  const error = combined.match(/^Error:.*$/m);
  if (error) return error[0];
  if (/Activity not started, unable to resolve Intent/i.test(combined)) {
    return (
      "No installed app claims that URL on this device. For an https link, " +
      "Android App Links also require the app's intent-filter plus a verified " +
      "assetlinks.json on the domain."
    );
  }
  return null;
}

/**
 * The reason + hint returned for an Apple PHYSICAL device (iPhone/iPad/Apple TV).
 *
 * Verified against the Xcode toolchain rather than assumed: `xcrun devicectl
 * device` exposes copy/info/install/notification/orientation/process/reboot/
 * sysdiagnose/uninstall and NO url-open verb, and `idb`'s ui/open commands are
 * simulator-only (a physical target fails with "Target doesn't conform to
 * FBSimulatorLifecycleCommands protocol"). So there is no supported automation
 * path today — an Apple gap, not an omission here, reported as
 * `{supported:false}` rather than papered over with something that looks like it
 * worked.
 */
export function appleDeviceOpenUrlUnsupported(platform: string): {
  reason: string;
  hint: string;
} {
  return {
    reason:
      `Opening a URL on a physical ${platform} target is not supported by any ` +
      "Apple-provided automation: `xcrun devicectl device` has no url-open " +
      "subcommand, and idb's open/ui commands are simulator-only.",
    hint:
      "Use a simulator for automated deep-link runs (fully supported here), or " +
      "open the link by hand on the device — e.g. from Notes or Messages, so " +
      "the tap goes through the real universal-link path.",
  };
}
