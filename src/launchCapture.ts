/**
 * Platform-neutral launch + Dart VM Service URI capture core.
 *
 * A flutter runner only line-flushes its "A Dart VM Service ... is available
 * at:" message when attached to a tty; run through a plain pipe it buffers and
 * the URI never arrives. Callers therefore supply a launch command that has
 * already been wrapped in a pty allocator (via {@link buildPtyCaptureCommand} —
 * `script` for a plain launch, or the FIFO→pty bridge when the launch wants a
 * control channel for hot reload/restart). The child is detached and left
 * running (it holds the VM service open
 * for Marionette) while its stdout is tee'd to a temp log file that this module
 * polls for the URI.
 *
 * Everything here is platform-neutral: the flutter-runner command string and
 * the set of failure signatures are values the platform adapter supplies IN.
 * Nothing here references sdb, flutter-tizen, or a device profile.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { quote } from "./cli.js";
import { createControlFifoPath, makeControlFifo } from "./ptyControl.js";
import {
  buildPtyForwardCommand,
  ControlChannel,
  resolvePtyForwarder,
} from "./ptyForward.js";
import { parseVmServiceUri, VmServiceUri } from "./vmServiceUri.js";
import { LaunchOutcome } from "./types.js";

export type { LaunchResult, LaunchFailure, LaunchOutcome } from "./types.js";
export type { ControlChannel } from "./ptyForward.js";
export { isLaunchFailure } from "./types.js";

/** Create a unique temp log path for one launch. */
export function createLogPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(os.tmpdir(), `flutter-device-mcp-launch-${stamp}-${process.pid}.log`);
}

/**
 * Wrap a fully-composed inner invocation in `script` so a flutter runner sees a
 * pty and line-flushes its VM-service URI (buffered under a plain pipe).
 *
 * `script`'s command signature differs by host OS, and this is the ONE place
 * that difference lives (four adapters previously each re-encoded it, which
 * shipped three defects):
 *  - macOS/BSD: `script -q <file> <cmd> <args...>` — the command trails and is
 *    exec'd directly (no shell), so a compound inner (`export PATH=…; a && b`)
 *    would hand `export` to `script` as argv[0].
 *  - Linux/util-linux: `script -q -c "<cmd>" <file>` — the command is a single
 *    `-c` string already run through a shell.
 *
 * To make the bare-vs-compound-inner distinction (the actual bug class)
 * disappear, we standardize on `/bin/sh -c ${quote(inner)}` for BOTH platforms:
 * `/bin/sh -c` is a strict superset that runs a simple OR compound inner
 * identically, so callers never have to reason about whether their inner is
 * compound.
 *
 * The leading `exec` is preserved so the detached child in
 * {@link launchAndCaptureUri} is the pty owner that outlives the poll.
 *
 * `platform` defaults to the running host (`process.platform`) and is injectable
 * for tests.
 */
export function buildPtyCaptureCommand(opts: {
  inner: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  /**
   * When set, the runner is launched through the FIFO→pty bridge instead of
   * `script`, so `r`/`R` appended to the FIFO reach flutter's key handler on a
   * REAL terminal (the bridge owns the pty, so `script` is not involved and the
   * host `script` signature no longer applies). Undefined → no control channel:
   * the plain `script` form above, behavior-identical to before. See ptyForward.
   */
  controlChannel?: ControlChannel;
}): string {
  const { inner, cwd, platform = process.platform, controlChannel } = opts;
  const launch = controlChannel
    ? buildPtyForwardCommand({
        forwarder: controlChannel.forwarder,
        fifoPath: controlChannel.fifoPath,
        inner,
      })
    : platform === "darwin"
      ? `exec script -q /dev/null /bin/sh -c ${quote(inner)}`
      : `exec script -q -c ${quote(inner)} /dev/null`;
  return cwd ? `cd ${quote(cwd)} && ${launch}` : launch;
}

/**
 * Allocate a control channel for a launch — the FIFO plus the pty bridge that
 * makes it reach flutter — or undefined when either half is unavailable (no
 * `mkfifo`, or no usable python3 for the bridge).
 *
 * BOTH halves are required, which is why they are allocated together: a FIFO
 * with no bridge accepts every write and delivers none of them, and recording
 * that as a control channel is what made `flutter_hot_restart` report a restart
 * it had not performed. Undefined means the launch proceeds with NO channel —
 * hot reload falls back to the VM service and hot restart says it cannot be
 * driven — which is a worse inner loop but an honest one.
 */
export function allocateControlChannel(
  deps: { forwarder?: () => ControlChannel["forwarder"] | undefined } = {}
): ControlChannel | undefined {
  const forwarder = (deps.forwarder ?? resolvePtyForwarder)();
  if (!forwarder) return undefined;
  const fifoPath = createControlFifoPath();
  return makeControlFifo(fifoPath) ? { fifoPath, forwarder } : undefined;
}

/** One evaluation of the launch log so far: URI found, failed, or keep polling. */
export type LogEvaluation =
  | { kind: "uri"; uri: VmServiceUri }
  | { kind: "failure"; signature: RegExp }
  | { kind: "pending" };

/**
 * Evaluate the launch log captured so far against the supplied failure
 * signatures. The URI check runs first so a successful launch wins even when an
 * earlier (non-fatal) line resembles a failure signature.
 */
export function evaluateLaunchLog(
  contents: string,
  failureSignatures: RegExp[]
): LogEvaluation {
  const uri = parseVmServiceUri(contents);
  if (uri) return { kind: "uri", uri };

  for (const signature of failureSignatures) {
    if (signature.test(contents)) return { kind: "failure", signature };
  }
  return { kind: "pending" };
}

/** Poll a growing log file for the VM Service URI or a failure signature. */
export async function pollLogForUri(
  logPath: string,
  timeoutMs: number,
  pid: number | undefined,
  failureSignatures: RegExp[],
  controlFifoPath?: string
): Promise<LaunchOutcome> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let contents = "";
    try {
      contents = fs.readFileSync(logPath, "utf8");
    } catch {
      contents = "";
    }

    const evaluation = evaluateLaunchLog(contents, failureSignatures);
    if (evaluation.kind === "uri") {
      return {
        vmServiceUriWs: evaluation.uri.ws,
        vmServiceUriHttp: evaluation.uri.http,
        logPath,
        pid,
        controlFifoPath,
      };
    }

    if (evaluation.kind === "failure") {
      return {
        failed: true,
        reason: `Launch failed: matched ${evaluation.signature}`,
        logPath,
        pid,
        logTail: tailString(contents, 60),
      };
    }

    if (Date.now() > deadline) {
      return {
        failed: true,
        reason: `Timed out after ${timeoutMs}ms waiting for the Dart VM Service URI`,
        logPath,
        pid,
        logTail: tailString(contents, 60),
      };
    }

    await delay(pollInterval);
  }
}

/** Return the last `maxLines` lines of `text` (for log tails in responses). */
export function tailString(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn the (already pty-wrapped) launch command detached, tee-ing stdout to a
 * temp log, then poll the log for the VM Service URI. On success the process is
 * left running; on failure/timeout the returned outcome carries a log tail (the
 * process is also left running so the caller can inspect or kill it).
 *
 * `command` and `failureSignatures` are platform-supplied — this core has no
 * knowledge of which flutter runner or device is behind them.
 */
export async function launchAndCaptureUri(
  command: string,
  cwd: string,
  timeoutMs: number,
  failureSignatures: RegExp[],
  controlFifoPath?: string
): Promise<LaunchOutcome> {
  const logPath = createLogPath();
  const logStream = fs.openSync(logPath, "a");

  const child = spawn(command, {
    // The dev's login shell if set, else POSIX sh — the launch command is
    // sh-compatible (the platform adapter builds it with quote()-escaped args
    // and no zsh-isms), so this works on macOS and Linux dev hosts alike.
    shell: process.env.SHELL ?? "/bin/sh",
    cwd,
    env: process.env,
    detached: true,
    // stdin stays "ignore": when a control channel is used, the FIFO is read by
    // the pty bridge INSIDE the command (see ptyForward), not through this
    // spawn's stdin — that keeps the durable-across-restarts property (the FIFO
    // is a path on disk, not this handle).
    stdio: ["ignore", logStream, logStream],
  });

  const pid = child.pid;
  // Detach so the launch outlives this poll and this server process.
  child.unref();

  const outcome = await pollLogForUri(
    logPath,
    timeoutMs,
    pid,
    failureSignatures,
    controlFifoPath
  );
  try {
    fs.closeSync(logStream);
  } catch {
    // best-effort
  }
  return outcome;
}
