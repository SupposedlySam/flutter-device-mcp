/**
 * macOS window geometry + AppleScript/System Events command builders.
 *
 * WHY THIS EXISTS: `flutter_pointer`'s coordinates and `flutter_screenshot`'s
 * capture region both depend on knowing where the target window ACTUALLY is on
 * screen, in the SAME point-based coordinate space `cliclick` and
 * `screencapture -R` both address (verified on-device: System Events' window
 * `position`/`size`, `cliclick m:`/`p:`, and `screencapture -R` all use a
 * top-left-origin point space — a window at System Events position (100,100)
 * size (1400,900) captures correctly with `screencapture -R100,100,1400,900`
 * and a `cliclick m:` to a point inside that rect lands inside the window).
 *
 * cliclick takes ABSOLUTE screen coordinates, but a caller's coordinates move
 * with the window (the whole point of `flutter_pointer` being WINDOW-RELATIVE
 * by default — see {@link windowRelativeToAbsolute}): resolve bounds FRESH each
 * time rather than trusting a cached position, or a moved/resized window turns
 * a "correct" script into one that clicks the wrong thing with no error at all.
 *
 * Pure command builders + parsers here; the adapter shells them via `runShell`.
 */
import { quote } from "./cli.js";

/** A window's bounds in POINTS — the space cliclick/screencapture -R address. */
export interface MacWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Quote a string for embedding inside an AppleScript source string passed to
 * `osascript -e`. This is AppleScript-level quoting (escape `\` and `"`), NOT
 * shell quoting — the whole script is then shell-quoted as ONE argument via
 * {@link quote} so the two escaping layers don't collide.
 */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the AppleScript that reads the FRONT window's position + size of a
 * process by NAME (the `System Events` process name — the app's
 * `CFBundleExecutable`, e.g. "example-app", NOT its display name "Example
 * App"; verified on-device: `System Events` lists the process by executable
 * name). Prints "x, y, width, height" — parsed by
 * {@link parseSystemEventsWindowBounds}.
 */
export function buildSystemEventsWindowBoundsCommand(processName: string): string {
  const script =
    `tell application "System Events" to tell process ${appleScriptString(processName)} ` +
    "to get {position, size} of front window";
  return `osascript -e ${quote(script)}`;
}

/**
 * Parse `{position, size} of front window` output ("100, 100, 1400, 900") into
 * bounds. Returns undefined for anything that doesn't parse as four integers —
 * a HALF-read bounds would be a worse silent failure than none (see the
 * module doc: acting on a wrong/partial rect is how a click lands on the wrong
 * thing without any error).
 */
export function parseSystemEventsWindowBounds(
  output: string
): MacWindowBounds | undefined {
  const match = output
    .trim()
    .match(/^(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)$/);
  if (!match) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

/**
 * Translate a WINDOW-RELATIVE point (0,0 = the window's own top-left corner)
 * into the ABSOLUTE screen point cliclick needs. This is the one place the
 * "coordinates must be window-relative" contract is actually enforced —
 * everything upstream of this (the input controller, the MCP tool) works in
 * window-relative terms so a caller's script survives the window moving.
 */
export function windowRelativeToAbsolute(
  bounds: MacWindowBounds,
  x: number,
  y: number
): { x: number; y: number } {
  return { x: bounds.x + x, y: bounds.y + y };
}

/**
 * Build a WINDOW-TARGETED `screencapture -R<x,y,w,h>` command — deliberately
 * NOT a full-desktop capture (see {@link PlatformAdapter.screenshot}'s doc: a
 * full-screen grab leaks whatever else the machine's owner has open, a privacy
 * problem and not just a framing one). `-x` suppresses the camera-shutter
 * sound, appropriate for unattended automation.
 */
export function buildScreencaptureWindowCommand(
  bounds: MacWindowBounds,
  outPath: string
): string {
  return (
    `/usr/sbin/screencapture -x -R${Math.round(bounds.x)},${Math.round(bounds.y)},` +
    `${Math.round(bounds.width)},${Math.round(bounds.height)} ${quote(outPath)}`
  );
}

/**
 * Build a small-region `screencapture -R` command for the internal Screen
 * Recording TCC probe ({@link MacosAdapter.info}) — a tiny corner, never the
 * target window, and never returned to the caller (captured, inspected, and
 * deleted). Kept separate from {@link buildScreencaptureWindowCommand} so the
 * probe's intent (a disposable internal check) is not confused with the
 * user-facing screenshot path.
 */
export function buildScreencaptureProbeCommand(
  x: number,
  y: number,
  size: number,
  outPath: string,
  captureCursor: boolean
): string {
  const cursorFlag = captureCursor ? " -C" : "";
  return `/usr/sbin/screencapture -x${cursorFlag} -R${x},${y},${size},${size} ${quote(outPath)}`;
}

/**
 * Build `osascript -e 'tell application id "<bundleId>" to activate'`.
 *
 * Targeting by BUNDLE ID (not display name) is deliberate and verified
 * on-device: an app launched directly from a scratch dir (not `/Applications`,
 * not registered by Finder under its display name) still resolves correctly via
 * `tell application id "…"` as long as it is the currently-running process —
 * `tell application "<Display Name>"` has no such guarantee for an app Launch
 * Services has never indexed.
 */
export function buildOsascriptActivateCommand(bundleId: string): string {
  const script = `tell application id ${appleScriptString(bundleId)} to activate`;
  return `osascript -e ${quote(script)}`;
}

/** Build `osascript -e 'tell application id "<bundleId>" to quit'`. */
export function buildOsascriptQuitCommand(bundleId: string): string {
  const script = `tell application id ${appleScriptString(bundleId)} to quit`;
  return `osascript -e ${quote(script)}`;
}
