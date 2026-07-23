/**
 * Device screen capture — pure helpers + the platform seam's result shape.
 *
 * Encodes the per-platform capture reality learned on-device so callers never
 * re-derive it:
 *   - iOS SIMULATOR: `xcrun simctl io <udid> screenshot <path>` — reliable, the
 *     primary iOS path.
 *   - iOS PHYSICAL device: `pymobiledevice3 developer dvt screenshot <path>`
 *     (verified live on iOS 18.7): it captures a real PNG over a no-root
 *     userspace tunnel on iOS 17+ (no sudo), relying on the Developer Disk Image
 *     being mounted (Xcode auto-mounts it). This replaces the earlier dead ends —
 *     `idevicescreenshot` needs the DDI's screenshotr service (else "Could not
 *     start screenshotr service") and `xcrun devicectl` has NO screenshot
 *     subcommand. Only when `pymobiledevice3` is not installed does this degrade
 *     to a structured `{ supported: false }` with an install hint.
 *   - Android: `adb -s <serial> exec-out screencap -p > <path>`.
 *   - Tizen / webOS: no clean capture path (sdb shell is DISABLED on Samsung
 *     devices, so a shell screencap can't run) → `{ supported: false }`.
 *
 * The command builders are pure so they are unit-testable; the adapters run them
 * and stat the output. `os.tmpdir()` gives the default output location when the
 * caller doesn't supply one.
 */
import os from "os";
import path from "path";
import { quote } from "./cli.js";

/** Structured result of a screenshot attempt, mirroring the other seams. */
export interface ScreenshotResult {
  /** True when a screenshot was captured to disk. */
  captured: boolean;
  /** Absolute path to the saved PNG, when captured. */
  savedPath?: string;
  /** Base64 of the PNG, only when the caller asked for it AND capture succeeded. */
  base64?: string;
  /**
   * False when this platform/target has no clean capture path (iOS physical
   * device, Tizen, webOS). Present only when unsupported; a supported attempt
   * omits it. Paired with `reason`/`hint`.
   */
  supported?: false;
  /** Human-readable reason a capture could not be taken (unsupported / error). */
  reason?: string;
  /** Actionable hint (e.g. "use a simulator for screenshot walkthroughs"). */
  hint?: string;
}

/** A default, predictable output path under the temp dir for one capture. */
export function defaultScreenshotPath(platform: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    os.tmpdir(),
    `flutter-device-mcp-screenshot-${platform}-${stamp}.png`
  );
}

/** `xcrun simctl io <udid> screenshot <path>` — iOS simulator capture. */
export function buildSimctlScreenshotCommand(udid: string, outPath: string): string {
  return `xcrun simctl io ${quote(udid)} screenshot ${quote(outPath)}`;
}

/**
 * `pymobiledevice3 developer dvt screenshot <path> [--udid <udid>]` — iOS
 * PHYSICAL-device capture (verified live on iOS 18.7).
 *
 * `developer dvt screenshot` writes a real PNG via the DVT (developer tooling)
 * service. On iOS 17+ pymobiledevice3 opens a no-root userspace tunnel
 * automatically (it emits a WARNING but succeeds with no sudo); the Developer
 * Disk Image must be mounted, which Xcode does automatically. `pymobiledevice3`
 * is resolved to an absolute path by the caller (PATH may omit pipx/Homebrew
 * bins under a GUI-launched server), so it is passed in already-quoted-ready and
 * quoted here for safety. `--udid` targets a specific device when more than one
 * is attached; omitted when undefined (single-device assumption).
 */
export function buildPymobiledevice3ScreenshotCommand(
  binary: string,
  outPath: string,
  udid?: string
): string {
  const udidArg = udid ? ` --udid ${quote(udid)}` : "";
  return `${quote(binary)} developer dvt screenshot ${quote(outPath)}${udidArg}`;
}

/**
 * `adb -s <serial> exec-out screencap -p > <path>` — Android capture.
 *
 * `exec-out` (not `shell`) streams the raw PNG bytes with no CRLF translation,
 * so the redirected file is a valid PNG (a plain `adb shell screencap -p`
 * mangles the bytes on some hosts). The redirect target is quoted for the shell.
 */
export function buildAdbScreencapCommand(serial: string, outPath: string): string {
  return `adb -s ${quote(serial)} exec-out screencap -p > ${quote(outPath)}`;
}
