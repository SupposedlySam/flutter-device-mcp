/**
 * Device screen RECORDING — pure command builders + the platform seam's result
 * shape. Mirrors {@link file://./screenshot.ts}: pure, unit-testable builders
 * that encode the per-platform capture reality learned on-device, so callers
 * never re-derive it. The adapters run these builders (spawn + timed SIGINT +
 * pull/assemble) behind the {@link PlatformAdapter.record} seam.
 *
 * PER-PLATFORM reality (verified on this host):
 *   - Android (physical, the best path): `adb -s <serial> shell screenrecord
 *     <remote.mp4>` records a smooth native mp4. Stop it early by SIGINT'ing the
 *     ON-DEVICE screenrecord (`adb ... shell pkill -INT screenrecord`) — it
 *     flushes the file on SIGINT — then `adb ... pull` it and `adb ... shell rm`
 *     the remote file. No ffmpeg needed for mp4.
 *   - iOS SIMULATOR: `xcrun simctl io <udid> recordVideo --codec=h264 --force
 *     <out.mp4>` records until it receives SIGINT; stop by SIGINT'ing that
 *     process. Native mp4, no ffmpeg needed. (NB: some apps crash on the iOS
 *     simulator — e.g. shader-heavy apps — so this path can be correct yet not
 *     usable for a given app's own screens; that is an app issue, not a bug here.)
 *   - iOS PHYSICAL device: NO native recorder (pymobiledevice3 dvt exposes only
 *     `screenshot`; devicectl has none). The only path is a BURST of screenshots
 *     then an ffmpeg assemble. Screenshot latency is ~0.3–1s, so the realistically
 *     achievable rate is only ~1–3 fps and the result is CHOPPY — documented, not a
 *     bug. Requires ffmpeg to assemble; absent ffmpeg → `{ supported: false }`.
 *   - tvOS / Tizen / webOS: no clean recording path → `{ supported: false }`.
 *
 * GIF output is always an ffmpeg step (native recorders emit mp4 only), so `gif`
 * requires ffmpeg on every platform; absent ffmpeg → `{ supported: false }` with
 * an install hint (native-mp4 paths still work).
 */
import os from "os";
import path from "path";
import { quote } from "./cli.js";

/** Recording output container. `mp4` is native; `gif` always needs an ffmpeg pass. */
export type RecordFormat = "mp4" | "gif";

/** Structured result of a recording attempt, mirroring {@link ScreenshotResult}. */
export interface RecordResult {
  /** True when a clip was written to disk. */
  recorded: boolean;
  /** Absolute path to the saved clip (mp4 or gif), when recorded. */
  savedPath?: string;
  /** The container actually written. */
  format?: RecordFormat;
  /** Wall-clock capture duration in seconds (the requested/effective bound). */
  durationSeconds?: number;
  /**
   * Frames captured, for the iOS-device BURST path only (so the caller sees the
   * real, choppy frame count vs. the requested duration×fps). Omitted for the
   * native-recorder paths.
   */
  frameCount?: number;
  /**
   * False when this platform/target has no clean recording path (iOS physical
   * device without ffmpeg, tvOS, Tizen, webOS). Present only when unsupported; a
   * supported attempt omits it. Paired with `reason`/`hint`.
   */
  supported?: false;
  /** Human-readable reason a recording could not be made (unsupported / error). */
  reason?: string;
  /** Actionable hint (e.g. an install command, or "use a simulator"). */
  hint?: string;
  /** A non-fatal note surfaced alongside a successful capture (e.g. the fps caveat). */
  note?: string;
}

/** Clamp/normalize a requested duration to a sane bound (seconds). */
export const DEFAULT_DURATION_SECONDS = 10;
/** Android `screenrecord` hard-caps a single recording at 180s. */
export const ANDROID_MAX_DURATION_SECONDS = 180;
/** Default frame rate for the iOS-device burst path + gif assembly. */
export const DEFAULT_FPS = 2;

/** A default, predictable output path under the temp dir for one recording. */
export function defaultRecordingPath(platform: string, format: RecordFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    os.tmpdir(),
    `flutter-device-mcp-recording-${platform}-${stamp}.${format}`
  );
}

/**
 * A predictable ON-DEVICE path for Android `screenrecord` to write to before the
 * pull. `/sdcard/` is world-writable and always present.
 */
export function androidRemoteRecordingPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `/sdcard/flutter-device-mcp-recording-${stamp}.mp4`;
}

/**
 * `adb -s <serial> shell screenrecord [--time-limit N] [--size WxH]
 * [--bit-rate B] <remote.mp4>` — Android native recorder.
 *
 * `--time-limit` is passed as a HARD ceiling (screenrecord stops itself at the
 * limit even if the caller's SIGINT is late); the adapter still SIGINTs early at
 * the requested duration. `size`/`bitRate` are optional passthroughs.
 */
export function buildAdbScreenrecordCommand(
  serial: string,
  remotePath: string,
  opts: { timeLimitSeconds?: number; size?: string; bitRate?: number } = {}
): string {
  const flags: string[] = [];
  if (opts.timeLimitSeconds && opts.timeLimitSeconds > 0) {
    flags.push(`--time-limit ${Math.min(opts.timeLimitSeconds, ANDROID_MAX_DURATION_SECONDS)}`);
  }
  if (opts.size) flags.push(`--size ${quote(opts.size)}`);
  if (opts.bitRate && opts.bitRate > 0) flags.push(`--bit-rate ${opts.bitRate}`);
  const flagStr = flags.length ? ` ${flags.join(" ")}` : "";
  return `adb -s ${quote(serial)} shell screenrecord${flagStr} ${quote(remotePath)}`;
}

/**
 * `adb -s <serial> shell pkill -INT screenrecord` — stop the on-device recorder
 * cleanly so it FLUSHES the mp4 (a plain kill would truncate the file).
 */
export function buildAdbStopScreenrecordCommand(serial: string): string {
  return `adb -s ${quote(serial)} shell pkill -INT screenrecord`;
}

/** `adb -s <serial> pull <remote> <local>` — copy the finished clip off-device. */
export function buildAdbPullCommand(
  serial: string,
  remotePath: string,
  localPath: string
): string {
  return `adb -s ${quote(serial)} pull ${quote(remotePath)} ${quote(localPath)}`;
}

/** `adb -s <serial> shell rm -f <remote>` — clean up the on-device clip. */
export function buildAdbRemoveCommand(serial: string, remotePath: string): string {
  return `adb -s ${quote(serial)} shell rm -f ${quote(remotePath)}`;
}

/**
 * `xcrun simctl io <udid> recordVideo --codec=h264 --force <out.mp4>` — iOS/tvOS
 * SIMULATOR recorder. It records until it receives SIGINT; `--force` overwrites
 * an existing file so a re-record does not error. The adapter spawns this and
 * SIGINTs it at the requested duration.
 */
export function buildSimctlRecordVideoCommand(udid: string, outPath: string): string {
  return `xcrun simctl io ${quote(udid)} recordVideo --codec=h264 --force ${quote(outPath)}`;
}

/**
 * `<bin> developer dvt screenshot <frame.png> [--udid <udid>]` — one BURST frame
 * for the iOS-physical-device path. Identical shape to the screenshot builder;
 * duplicated here so the recording module owns the per-frame invocation and the
 * burst loop reads self-contained.
 */
export function buildPymobiledevice3BurstFrameCommand(
  binary: string,
  framePath: string,
  udid?: string
): string {
  const udidArg = udid ? ` --udid ${quote(udid)}` : "";
  return `${quote(binary)} developer dvt screenshot ${quote(framePath)}${udidArg}`;
}

/** The zero-padded frame-file basename ffmpeg's `%04d` pattern expects. */
export function burstFrameName(index: number): string {
  return `frame_${String(index).padStart(4, "0")}.png`;
}

/**
 * `ffmpeg -y -framerate <fps> -i <dir>/frame_%04d.png -pix_fmt yuv420p <out.mp4>`
 * — assemble burst PNG frames into an mp4. `-pix_fmt yuv420p` makes the mp4 play
 * in QuickTime/browsers. Width is forced even (`scale=...:-2`) since h264 rejects
 * odd dimensions from arbitrary screenshot sizes.
 */
export function buildFfmpegFramesToVideoCommand(
  ffmpeg: string,
  framesDir: string,
  fps: number,
  outPath: string
): string {
  const pattern = path.join(framesDir, "frame_%04d.png");
  return (
    `${quote(ffmpeg)} -y -framerate ${fps} -i ${quote(pattern)} ` +
    `-vf ${quote("scale=trunc(iw/2)*2:trunc(ih/2)*2")} -pix_fmt yuv420p ${quote(outPath)}`
  );
}

/**
 * Two-pass high-quality GIF from burst PNG frames: a palette is generated then
 * applied, which avoids the muddy 256-color default. Returns the two commands to
 * run in order (palettegen → paletteuse). `palettePath` is a caller-owned temp
 * PNG.
 */
export function buildFfmpegFramesToGifCommands(
  ffmpeg: string,
  framesDir: string,
  fps: number,
  outPath: string,
  palettePath: string
): [string, string] {
  const pattern = path.join(framesDir, "frame_%04d.png");
  const gen =
    `${quote(ffmpeg)} -y -framerate ${fps} -i ${quote(pattern)} ` +
    `-vf ${quote("palettegen")} ${quote(palettePath)}`;
  const use =
    `${quote(ffmpeg)} -y -framerate ${fps} -i ${quote(pattern)} -i ${quote(palettePath)} ` +
    `-lavfi ${quote("paletteuse")} ${quote(outPath)}`;
  return [gen, use];
}

/**
 * Two-pass high-quality GIF from an existing mp4 (the native-recorder → gif
 * path). `fps` sets the gif's frame rate (downsampled from the source video).
 * Returns [palettegen, paletteuse] to run in order.
 */
export function buildFfmpegVideoToGifCommands(
  ffmpeg: string,
  videoPath: string,
  fps: number,
  outPath: string,
  palettePath: string
): [string, string] {
  const filter = `fps=${fps}`;
  const gen =
    `${quote(ffmpeg)} -y -i ${quote(videoPath)} ` +
    `-vf ${quote(`${filter},palettegen`)} ${quote(palettePath)}`;
  const use =
    `${quote(ffmpeg)} -y -i ${quote(videoPath)} -i ${quote(palettePath)} ` +
    `-lavfi ${quote(`${filter}[x];[x][1:v]paletteuse`)} ${quote(outPath)}`;
  return [gen, use];
}
