/**
 * Device screen capture — pure helpers + the platform seam's result shape.
 *
 * Encodes the per-platform capture reality learned on-device so callers never
 * re-derive it:
 *   - iOS SIMULATOR: `xcrun simctl io <udid> screenshot <path>` — reliable, the
 *     primary simulator path.
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
 * ROUTING IS BY RESOLVED TARGET, never by what else happens to be attached. A
 * pinned physical device is captured by the physical path even while a simulator
 * is booted: serving it from simctl returns a real PNG of the WRONG machine,
 * which reads as success. When the physical path is unavailable the capture
 * fails with a reason — it never degrades to a different device.
 *
 * The command builders are pure so they are unit-testable; the adapters run them
 * and stat the output. `os.tmpdir()` gives the default output location when the
 * caller doesn't supply one.
 */
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import { quote } from "./cli.js";

/** Which capture path produced (or would have produced) a PNG. */
export type ScreenshotVia =
  | "simctl"
  | "pymobiledevice3"
  | "adb"
  | "screencapture";

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
  /**
   * The id of the target this capture was ROUTED to, in the id space the
   * capture command addresses. Reported on success AND on failure: a capture
   * that names no device is indistinguishable from one that silently captured a
   * different device, which is the failure this field exists to make visible.
   */
  device?: string;
  /** Human-readable device name, when the resolver knew one. */
  deviceName?: string;
  /** Which class of target was captured — a simulator or real hardware. */
  deviceKind?: "device" | "simulator";
  /** The capture path actually taken, so the routing decision is auditable. */
  via?: ScreenshotVia;
  /** Width of the saved PNG in pixels, read from its IHDR header. */
  pixelWidth?: number;
  /** Height of the saved PNG in pixels, read from its IHDR header. */
  pixelHeight?: number;
  /**
   * Set when `FLUTTER_DEVICE_PYMOBILEDEVICE3` was configured but could not be used for
   * a physical-device capture — it names the configured path, why it was
   * rejected, and what was used instead. An override that silently did nothing
   * made the "set FLUTTER_DEVICE_PYMOBILEDEVICE3" hint unfalsifiable: a typo'd path
   * looked like it had worked.
   */
  pymobiledevice3Warning?: string;
  /**
   * Carried through from device resolution when a pin did not name an online
   * target and resolution fell back to another one — the caller must be able to
   * tell "your pin was honored" from "your pin was stale, this is a different
   * device".
   */
  deviceWarning?: string;
}

/** PNG magic number: the first 8 bytes of every PNG file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read a PNG's pixel dimensions from its IHDR chunk, or `undefined` when the
 * bytes are not a PNG (truncated file, a capture tool that wrote an error page).
 *
 * Reported alongside every capture so a wrong-device capture is VISIBLE rather
 * than silent: an iPhone XR is 828x1792 and a booted iPhone 15 simulator is
 * 1179x2556, so the dimensions alone identify which machine answered. IHDR is
 * mandatory and always first, at a fixed offset: 8-byte signature, 4-byte
 * length, 4-byte type, then width and height as big-endian uint32s.
 */
export function readPngDimensions(
  bytes: Buffer | Uint8Array
): { width: number; height: number } | undefined {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 24) return undefined;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/**
 * A default output path under the temp dir for one capture.
 *
 * The timestamp is for a human reading the directory; it cannot be the key.
 * Captures land within the same millisecond routinely — back-to-back calls, or
 * several servers on one machine sharing `os.tmpdir()` — and a shared path lets
 * one capture overwrite another and report the other's picture as its own. The
 * pid separates processes and the random suffix separates calls within one.
 */
export function defaultScreenshotPath(platform: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const unique = `${process.pid}-${randomUUID().slice(0, 8)}`;
  return path.join(
    os.tmpdir(),
    `flutter-device-mcp-screenshot-${platform}-${stamp}-${unique}.png`
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
