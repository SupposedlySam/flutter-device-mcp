/**
 * Durable control channel for the running launch daemon's flutter stdin.
 *
 * WHY THIS EXISTS: a genuine Flutter hot reload/restart is driven by the flutter
 * TOOL over its interactive stdin — `r\n` recompiles Dart + reassembles (real hot
 * reload), `R\n` re-runs `main()` (hot restart). Neither is reachable over just
 * the captured `ws://…/ws` VM-service URI: `reloadSources` reloads sources in
 * place but never re-runs `main()`, and `ext.flutter.reassemble` only rebuilds
 * widget trees WITHOUT recompiling. The authoritative reload/restart path is the
 * launch pty's stdin, so we keep a writable channel to it.
 *
 * WHY A FIFO (not an in-memory `child.stdin` handle): the launch child is spawned
 * detached + unref'd so it deliberately OUTLIVES this MCP process (it holds the VM
 * service open across MCP restarts — see launchCapture). An in-memory write handle
 * would be lost on restart. A named pipe (FIFO) on disk is a durable channel — its
 * path is recorded in the launch registry, so any later MCP process can append a
 * control char to reach the same running daemon, mirroring how the registry makes
 * the VM-service URI durable.
 *
 * THE EOF TRAP + FIX: a FIFO reader sees EOF the instant the last writer closes
 * (so a one-shot `printf > fifo` would end the stream after the first control
 * char). The reader therefore opens the FIFO READ-WRITE, making itself a writer
 * too, so the pipe never sees zero writers and EOF never fires between appends.
 * Verified on macOS: sequential `printf > fifo` appends were all received and the
 * reader stayed alive.
 *
 * WHY A PTY BRIDGE SITS BETWEEN THE FIFO AND FLUTTER, MEASURED. Putting the FIFO
 * on flutter's fd 0 directly does NOT let it read keys: `Terminal.singleCharMode`
 * returns early unless `stdinHasTerminal`, and the keystroke stream is only
 * meaningful in single-char mode — so with a FIFO on fd 0 flutter never enters
 * the mode and never processes `r`/`R`, while `printHelp` still prints the key
 * legend unconditionally. The legend is what made this look like it worked.
 * Feeding the FIFO to `script` instead (so flutter would inherit script's pty)
 * fails too: macOS `script` ioctls its OWN stdin at startup and dies with
 * `tcgetattr/ioctl: Operation not supported on socket` — reproduced directly.
 *
 * So the launch runs through `scripts/pty-control-forward.py` (see ptyForward),
 * which opens the FIFO read-write, forks flutter on a real pty, and copies
 * FIFO→pty and pty→stdout. Flutter gets a terminal on stdin (single-char mode
 * engages, `r`/`R` are read) AND its stdout still line-flushes through a pty for
 * the URI capture, while the durable half stays a path on disk that any later
 * MCP process can write to. A host with no usable python3 gets NO control
 * channel at all rather than one that swallows writes.
 *
 * The write landing is still kept as what it is — a write landing — and the
 * caller confirms the EFFECT in the launch log before reporting one.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/** The two flutter interactive control chars this channel drives. */
export type FlutterControlChar = "r" | "R";

/** Create a unique FIFO path (not yet created on disk) for one launch. */
export function createControlFifoPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    os.tmpdir(),
    `flutter-device-mcp-control-${stamp}-${process.pid}.fifo`
  );
}

/**
 * Create the FIFO on disk via `mkfifo`. Best-effort: returns true when the FIFO
 * exists afterward, false otherwise (the caller then launches WITHOUT a control
 * channel and hot reload/restart degrade to the VM-service fallback). Never
 * throws — a host without `mkfifo` (unusual on macOS/Linux dev hosts) must not
 * fail a launch.
 */
export function makeControlFifo(fifoPath: string): boolean {
  try {
    // 0600: the control channel is per-developer, like the remote token.
    // Node's fs API has no mkfifo, so shell out to the POSIX `mkfifo`.
    execFileSync("mkfifo", ["-m", "600", fifoPath], { stdio: "ignore" });
    return fs.existsSync(fifoPath);
  } catch {
    return false;
  }
}

/**
 * Append one flutter control char (+newline) to the FIFO to drive a reload
 * (`r`) or restart (`R`) on the running daemon.
 *
 * Opens the FIFO for append and writes `"<char>\n"`. A line-buffered
 * (non-tty-stdin) `flutter run` reads these as its interactive commands. Resolves
 * true on a successful write, false on any failure (FIFO gone because the daemon
 * exited, or a write error) — the caller then reports "no live daemon; redeploy"
 * or falls back to the VM-service path. Never throws.
 *
 * A short write timeout guards against a FIFO with no reader (a dead daemon that
 * left the pipe file behind): opening a FIFO for write blocks until a reader is
 * present, so without the timeout this could hang. On timeout it resolves false.
 */
export function sendControlChar(
  fifoPath: string,
  char: FlutterControlChar,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(fifoPath)) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // Open for append; the write blocks until flutter (the reader) is attached,
    // so a dead-daemon FIFO with no reader would hang — bound it with a timer.
    const timer = setTimeout(() => done(false), timeoutMs);
    fs.open(fifoPath, "a", (openErr, fd) => {
      if (openErr) {
        clearTimeout(timer);
        done(false);
        return;
      }
      fs.write(fd, `${char}\n`, (writeErr) => {
        clearTimeout(timer);
        fs.close(fd, () => done(!writeErr));
      });
    });
  });
}

/** Best-effort removal of the FIFO (on kill/redeploy). Never throws. */
export function removeControlFifo(fifoPath: string | undefined): void {
  if (!fifoPath) return;
  try {
    fs.rmSync(fifoPath, { force: true });
  } catch {
    // best-effort
  }
}
