/**
 * Resolve the pty bridge that makes the launch control channel actually drive
 * the flutter tool.
 *
 * THE PROBLEM IT SOLVES (measured, not inferred). The control FIFO alone cannot
 * work: the flutter tool reads `r`/`R` only in single-char mode, and
 * `Terminal.singleCharMode` returns early unless stdin `hasTerminal`. With a FIFO
 * on fd 0 flutter never enters the mode, so every control char lands in a pipe
 * nobody reads — the write succeeds and no reload happens, which is exactly the
 * failure `flutter_hot_restart` was reporting. Handing the FIFO to `script`
 * instead (so flutter would inherit script's pty) dies on macOS with
 * `tcgetattr/ioctl: Operation not supported on socket`, because `script` ioctls
 * its own stdin at startup — reproduced on this host, so that route is closed.
 *
 * The bridge (`scripts/pty-control-forward.py`) keeps both properties: the FIFO
 * stays the DURABLE half (a path on disk, reachable from any later MCP process,
 * which an in-memory pty master handle could never be), and the pty is the half
 * flutter needs to read keys at all.
 *
 * python3 is used for it because it is the only pty-capable interpreter present
 * by default on the hosts this server runs on (macOS ships `/usr/bin/python3`
 * with the Xcode command-line tools, which every iOS/Tizen dev here already
 * has), and Node has no pty in core. It is treated as an OPTIONAL dependency
 * with THREE states, not two: absent, present-and-working, and
 * present-but-unusable (the macOS `/usr/bin/python3` shim with no command-line
 * tools installed is exactly the third). So the candidate is not merely located
 * — it is PROBED by importing `pty`, and only a probe that passes counts.
 *
 * Everything here is pure over injected dependencies (candidate list, existence
 * probe, usability probe) so the search order is unit-testable without touching
 * the real filesystem or spawning anything.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { quote } from "./cli.js";

/** The interpreter + bridge script that give a launch a usable control channel. */
export interface PtyForwarder {
  /** Absolute path to a python3 that can `import pty`. */
  python: string;
  /** Absolute path to `scripts/pty-control-forward.py`. */
  script: string;
}

/**
 * A launch's control channel: the durable FIFO plus the bridge that carries what
 * is written to it into flutter's terminal. Both halves are required — a FIFO
 * with no bridge accepts writes and delivers nothing.
 */
export interface ControlChannel {
  fifoPath: string;
  forwarder: PtyForwarder;
}

/**
 * Absolute path to the checked-in bridge script, resolved from this module's own
 * location so it works identically from `src/` (jest) and `dist/` (the built
 * server) — both sit one level under the package root.
 */
export function ptyForwardScriptPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "pty-control-forward.py"
  );
}

/**
 * python3 interpreters to try, in order. `/usr/bin/python3` (the macOS
 * command-line-tools one) comes FIRST deliberately: it is the copy that is
 * present on a dev host regardless of whether Homebrew/pyenv are installed, and
 * a pyenv shim earlier in PATH can be a version that was uninstalled from under
 * it. The inherited PATH follows, then the usual Homebrew locations a
 * GUI-launched server's PATH omits.
 */
export function defaultPython3Candidates(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const pathDirs = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "python3"));
  return [
    "/usr/bin/python3",
    ...pathDirs,
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
  ];
}

export interface LocatePython3Options {
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  /** True when this interpreter can actually run the bridge (imports `pty`). */
  usable?: (candidate: string) => boolean;
}

/** What the probe program prints, and the only output that counts as a pass. */
const PROBE_MARKER = "pty-ok";

/**
 * True when `candidate` is a python3 that can import `pty` — the cheapest real
 * operation the bridge needs. Presence is not capability here: the bare
 * `/usr/bin/python3` on a macOS host without the command-line tools exits
 * non-zero with a prompt to install them, and a stale pyenv shim exits non-zero
 * too. Never throws; a failure of any kind means "not usable".
 *
 * The probe checks the printed MARKER, not just the exit code, because an exit
 * code alone cannot tell python from something else that happens to be at the
 * candidate path and shrug at its arguments (`/bin/echo -c …` exits 0).
 */
export function python3CanFork(candidate: string): boolean {
  try {
    const output = execFileSync(
      candidate,
      ["-c", `import pty; print("${PROBE_MARKER}")`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }
    );
    return output.trim() === PROBE_MARKER;
  } catch {
    return false;
  }
}

/**
 * Resolve a usable python3, or `undefined` when none of the candidates can run
 * the bridge. An explicit `FLUTTER_DEVICE_PYTHON3` override is tried first and is
 * still PROBED — an override that names an unusable interpreter must not be
 * trusted just because someone set it.
 */
export function locatePython3(opts: LocatePython3Options = {}): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const usable = opts.usable ?? python3CanFork;

  const override = env.FLUTTER_DEVICE_PYTHON3?.trim();
  const candidates = [
    ...(override ? [override] : []),
    ...defaultPython3Candidates(env),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (!exists(candidate)) continue;
      if (usable(candidate)) return candidate;
    } catch {
      // Unreadable candidate — try the next.
    }
  }
  return undefined;
}

export interface ResolvePtyForwarderOptions extends LocatePython3Options {
  scriptPath?: string;
}

/**
 * The bridge for a new launch, or `undefined` when this host cannot provide one
 * (no usable python3, or the script is missing from the package). Undefined is a
 * real answer, not an error: the launch proceeds WITHOUT a control channel, so
 * hot reload degrades to the VM-service path and hot restart says plainly that
 * it cannot be driven — rather than a channel that accepts writes nobody reads.
 */
export function resolvePtyForwarder(
  opts: ResolvePtyForwarderOptions = {}
): PtyForwarder | undefined {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const script = opts.scriptPath ?? ptyForwardScriptPath();
  if (!exists(script)) return undefined;
  const python = locatePython3(opts);
  return python ? { python, script } : undefined;
}

/**
 * Compose the launch command that runs `inner` on a pty fed by the control FIFO.
 *
 * `inner` is passed as ONE argument and run by the bridge with `/bin/sh -c`, so
 * a compound inner (`export PATH=…; a && b`) behaves exactly as it did under the
 * previous `/bin/sh -c` wrapping. The leading `exec` is preserved so the
 * detached child is the bridge itself — the pty owner that outlives the launch
 * poll and holds the VM service open.
 */
export function buildPtyForwardCommand(opts: {
  forwarder: PtyForwarder;
  fifoPath: string;
  inner: string;
}): string {
  const { forwarder, fifoPath, inner } = opts;
  return [
    "exec",
    quote(forwarder.python),
    quote(forwarder.script),
    quote(fifoPath),
    quote(inner),
  ].join(" ");
}

/** Why a control channel could not be established, for the launch log. */
export const NO_PTY_FORWARDER_REASON =
  "No usable python3 was found for the launch control channel (it bridges the " +
  "durable FIFO to a pty, which the flutter tool requires to read `r`/`R` at " +
  "all). Hot reload will fall back to the VM-service reload and hot restart " +
  "will report that it cannot be driven. Install the Xcode command-line tools " +
  "(`xcode-select --install`) or set FLUTTER_DEVICE_PYTHON3 to a python3 that can " +
  "`import pty`.";
