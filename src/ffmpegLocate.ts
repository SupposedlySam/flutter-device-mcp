/**
 * Locate the `ffmpeg` CLI for {@link file://./recording.ts}'s gif output and the
 * iOS-physical-device burst→video assembly.
 *
 * WHY THIS EXISTS: ffmpeg is only NEEDED for two recording paths — producing a
 * `gif` (native recorders emit mp4 only, so a gif is always an ffmpeg pass) and
 * assembling the iOS-device screenshot BURST into a clip. The native-mp4 paths
 * (Android `screenrecord`, simulator `recordVideo`) do NOT need it. So absence of
 * ffmpeg is not fatal — the recorder degrades those two paths to a structured
 * `{ supported: false }` with an install hint rather than failing.
 *
 * As with {@link locatePymobiledevice3}, the MCP server is often launched by a
 * GUI app whose process PATH omits Homebrew bins, so a bare PATH lookup can miss
 * an installed `ffmpeg`. This searches well-known install dirs IN ADDITION to the
 * inherited PATH, honors a `FLUTTER_DEVICE_FFMPEG` override, and is called
 * PER-INVOCATION (no cached negative) so a just-installed binary is picked up on
 * the next call.
 *
 * Pure over its inputs (candidate dirs, an existence probe, the env) so the
 * search order is unit-testable without touching the real filesystem.
 */
import fs from "fs";
import path from "path";

/** The CLI binary name searched for. */
export const FFMPEG_BIN = "ffmpeg";

/**
 * Directories `ffmpeg` is commonly installed into, searched IN ADDITION to the
 * inherited PATH: Homebrew on Apple Silicon (`/opt/homebrew/bin`) and Intel
 * (`/usr/local/bin`), and the standard system bins.
 */
export function defaultFfmpegSearchDirs(): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
}

/**
 * Resolve an absolute path to the `ffmpeg` CLI, or `undefined` when none is
 * found.
 *
 * Search order: an explicit `FLUTTER_DEVICE_FFMPEG` override (used as-is when it
 * exists) first, then each PATH entry, then {@link defaultFfmpegSearchDirs}. The
 * first existing file wins. `exists` is injected so tests drive the search
 * deterministically without a real filesystem.
 */
export function locateFfmpeg(
  opts: {
    env?: NodeJS.ProcessEnv;
    exists?: (p: string) => boolean;
  } = {}
): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p) => fs.existsSync(p));

  // 1. Explicit override wins when it points at a real file.
  const override = env.FLUTTER_DEVICE_FFMPEG?.trim();
  if (override && exists(override)) return override;

  // 2. The inherited PATH (a terminal-launched server has Homebrew here).
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  // 3. Well-known install locations the GUI-launched server's PATH may omit.
  const searchDirs = [...pathDirs, ...defaultFfmpegSearchDirs()];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, FFMPEG_BIN);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Unreadable dir entry — skip it.
    }
  }
  return undefined;
}
