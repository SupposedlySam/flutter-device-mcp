/**
 * Recording ORCHESTRATION: spawn a native recorder for a bounded duration, stop
 * it cleanly (so the file flushes), and — for the iOS-device path — drive a
 * screenshot burst then hand off to the ffmpeg builders. The pure command
 * strings live in {@link file://./recording.ts}; this module runs them.
 *
 * DURATION-BOUNDED is the primary model (simplest robust shape that covers a
 * before/after clip): start the recorder, wait `durationSeconds`, then stop. Two
 * stop mechanics, because the recorders differ:
 *   - simctl `recordVideo` stops on SIGINT to the SPAWNED process (it owns the
 *     capture), so we SIGINT the child.
 *   - Android `screenrecord` runs ON-DEVICE behind adb, so SIGINT'ing the adb
 *     host process would NOT flush the mp4 — instead we run a separate
 *     `adb shell pkill -INT screenrecord`, which flushes it, then pull + rm.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runShell } from "./cli.js";

/** Sleep helper (bounded recorder duration). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn a recorder command, let it run `durationSeconds`, then invoke `stop`.
 * Resolves once the child has fully exited (so its output file is flushed).
 * Never rejects — a spawn error resolves with `ok: false` + the captured stderr
 * so the adapter can surface a structured result.
 *
 * `stop` receives the child so callers can either SIGINT it (simctl) or run an
 * out-of-band device stop (Android) and let the child exit on its own.
 */
export async function runTimedRecorder(opts: {
  command: string;
  durationSeconds: number;
  stop: (child: import("child_process").ChildProcess) => void | Promise<void>;
  /** Hard ceiling after `stop` for the child to exit before we SIGKILL it. */
  exitGraceMs?: number;
}): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(opts.command, {
      shell: process.env.SHELL ?? "/bin/sh",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, output });
    };

    child.on("error", (err) => {
      output += err instanceof Error ? err.message : String(err);
      finish(false);
    });
    child.on("close", () => finish(true));

    // After the bounded duration, stop the recorder and enforce an exit grace.
    void (async () => {
      await delay(Math.max(0, opts.durationSeconds * 1000));
      try {
        await opts.stop(child);
      } catch {
        // best-effort; the grace-kill below still bounds us.
      }
      const grace = opts.exitGraceMs ?? 8000;
      await delay(grace);
      if (!settled) {
        // The recorder did not exit after stop — force it so we never hang.
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish(true);
      }
    })();
  });
}

/**
 * Drive a screenshot BURST (iOS physical device) at `fps` for `durationSeconds`
 * into a fresh temp dir, one PNG per frame (`frame_%04d.png`). Returns the temp
 * dir and how many frames actually landed on disk (the real, choppy count — the
 * device's ~0.3–1s screenshot latency means the effective rate is well under a
 * high requested fps). Never throws; a failed frame is simply skipped.
 *
 * `captureFrame(framePath)` runs one screenshot to that path and resolves whether
 * it succeeded; it is injected so this loop is testable without a device.
 */
export async function runScreenshotBurst(opts: {
  fps: number;
  durationSeconds: number;
  captureFrame: (framePath: string) => Promise<boolean>;
  frameName: (index: number) => string;
  /** Injected clock (ms since epoch) so tests can drive the time budget. */
  now?: () => number;
  /** Injected sleep so tests skip the real pacing wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected temp-dir factory so tests avoid the real filesystem. */
  makeDir?: () => string;
}): Promise<{ framesDir: string; frameCount: number }> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? delay;
  const framesDir =
    opts.makeDir?.() ??
    fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-mcp-burst-"));

  const intervalMs = opts.fps > 0 ? 1000 / opts.fps : 1000;
  const deadline = now() + opts.durationSeconds * 1000;
  let index = 0;
  let captured = 0;

  while (now() < deadline) {
    const framePath = path.join(framesDir, opts.frameName(index));
    const frameStart = now();
    const ok = await opts.captureFrame(framePath);
    if (ok) captured += 1;
    index += 1;
    // Pace to the target fps, but never sleep past the deadline. If a capture
    // already overran the interval (the common case on-device), loop immediately.
    const elapsed = now() - frameStart;
    const wait = Math.min(
      Math.max(0, intervalMs - elapsed),
      Math.max(0, deadline - now())
    );
    if (wait > 0) await sleep(wait);
  }

  return { framesDir, frameCount: captured };
}

/**
 * Convert an already-recorded mp4 to a gif via the two-pass palette builders,
 * writing to `outPath` and cleaning up the mp4 + palette. Returns whether the
 * gif landed. Shared by the native-recorder adapters (Android, iOS/tvOS sim) so
 * the mp4→gif branch is not duplicated per adapter.
 */
export async function convertVideoToGif(opts: {
  ffmpeg: string;
  videoPath: string;
  fps: number;
  outPath: string;
  buildCommands: (
    ffmpeg: string,
    videoPath: string,
    fps: number,
    outPath: string,
    palettePath: string
  ) => [string, string];
}): Promise<boolean> {
  const palettePath = path.join(
    os.tmpdir(),
    `flutter-device-mcp-palette-${Date.now()}.png`
  );
  const [gen, use] = opts.buildCommands(
    opts.ffmpeg,
    opts.videoPath,
    opts.fps,
    opts.outPath,
    palettePath
  );
  const result = await runSequential([gen, use]);
  // Clean up intermediates regardless of outcome.
  for (const p of [palettePath, opts.videoPath]) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p);
    } catch {
      // best-effort
    }
  }
  return result.ok && fs.existsSync(opts.outPath);
}

/** Recursively remove a burst frames dir; never throws. */
export function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Run an ordered list of shell commands, stopping at the first failure. */
export async function runSequential(
  commands: string[],
  timeoutMs = 120000
): Promise<{ ok: boolean; output: string }> {
  let output = "";
  for (const command of commands) {
    const result = await runShell(command, { timeoutMs });
    output += result.combined;
    if (!result.success) return { ok: false, output };
  }
  return { ok: true, output };
}
