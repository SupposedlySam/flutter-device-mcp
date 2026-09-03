/**
 * macOS platform adapter.
 *
 * Drives an arbitrary prebuilt, SIGNED `.app` bundle behind the neutral
 * {@link PlatformAdapter} seam — the desktop sibling of {@link IosAdapter}/
 * {@link TvosAdapter}. Where those wrap `xcrun devicectl`/`simctl` + flutter,
 * macOS wraps `cliclick` (pointer/key input), `/usr/sbin/screencapture`
 * (window-targeted screenshots), and `osascript` / System Events (window
 * geometry, quit/activate) — there is no device to discover and no build
 * toolchain here.
 *
 * NO DART VM SERVICE: this adapter launches an already-built bundle with
 * `open -n`, NOT under `flutter run`, so there is no daemon holding a VM
 * service open and nothing for a driver like Marionette to connect to. The
 * returned URIs are empty strings and `flutter_hot_reload`/`flutter_hot_restart`
 * do not apply. That makes `flutter_pointer`/`flutter_key`/`flutter_screenshot`
 * the PRIMARY driver on this platform rather than the OS-level fallback they are
 * on mobile.
 *
 * SCRATCH-DIR ONLY: `flutter_deploy` stages the `.app` under a fresh
 * `os.tmpdir()` directory and launches it from there — NEVER `/Applications`.
 * A signed bundle launched directly from a scratch dir is drivable exactly
 * like an installed one (verified on-device: System Events sees its process,
 * and `tell application id "<bundle id>"` controls it) — and the whole deploy
 * is undone by deleting that one directory. See macosBundle.ts's module doc.
 *
 * TCC IS A SILENT-FAILURE GATE: without Accessibility, `cliclick` exits 0 and
 * silently does nothing; without Screen Recording, `screencapture` exits 0
 * and writes a degenerate image. Both are indistinguishable from success by
 * exit code alone, so `info()` probes both BY EFFECT (move+read-back+restore
 * for Accessibility; capture+size-check for Screen Recording) rather than
 * asking a permissions API or assuming. See {@link MacosAdapter.info}.
 *
 * COORDINATES ARE WINDOW-RELATIVE BY DEFAULT: `cliclick` takes absolute
 * screen points, but a caller's script should survive the window moving —
 * so `flutter_pointer`'s default space is translated through the target
 * window's LIVE bounds (re-read every call, never cached) via
 * {@link windowRelativeToAbsolute}. `opts.absolute` (see
 * {@link PointerCoordinateOpts}) is the escape hatch.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import os from "os";
import path from "path";
import { CommandResult, quote, runShell, tail } from "../cli.js";
import {
  BuildMode,
  BuildOptions,
  BuildResult,
  DeviceResolution,
  InputController,
  InputMode,
  LaunchOutcome,
  Platform,
  PointerClickOpts,
  PointerCoordinateOpts,
  UnsupportedInputError,
} from "../types.js";
import {
  AppLifecycle,
  DeviceTargetPreference,
  InstallOptions,
  PlatformAdapter,
} from "./platformAdapter.js";
import { defaultScreenshotPath, ScreenshotResult } from "../screenshot.js";
import { DeviceGeometryReading } from "../deviceGeometry.js";
import { locateCliclick } from "../cliclickLocate.js";
import {
  buildCliclickClickAtCurrentCommand,
  buildCliclickDoubleClickAtCurrentCommand,
  buildCliclickKeyCommand,
  buildCliclickMoveCommand,
  buildCliclickPositionCommand,
  buildCliclickRelativeMoveCommand,
  buildCliclickTextCommand,
  normalizeMacosKey,
  parseCliclickPosition,
} from "../cliclickCommands.js";
import {
  bundleExecutablePath,
  buildCurlDownloadCommand,
  buildDittoCopyCommand,
  buildFindAppBundleCommand,
  buildHdiutilAttachCommand,
  buildHdiutilDetachCommand,
  buildPlutilExtractCommand,
  buildTarExtractCommand,
  classifyMacosAppSource,
  infoPlistPath,
  MacosAppSource,
  MacosArchiveFormat,
  parseFoundAppBundle,
  parsePlutilRawOutput,
} from "../macosBundle.js";
import {
  buildOsascriptActivateCommand,
  buildOsascriptQuitCommand,
  buildScreencaptureProbeCommand,
  buildScreencaptureWindowCommand,
  buildSystemEventsWindowBoundsCommand,
  MacWindowBounds,
  parseSystemEventsWindowBounds,
  windowRelativeToAbsolute,
} from "../macosWindow.js";

/**
 * The floor (bytes) below which a `screencapture` probe image is treated as
 * DEGENERATE (the documented Screen-Recording-denied signature: exit 0, but a
 * near-empty/placeholder PNG). Calibrated against a REAL probe capture on a
 * Retina display: a genuine 40x40pt (80x80px @2x) RGBA capture of an ordinary
 * desktop corner ran ~11 KB. A DENIED capture could not be produced on the host
 * this was measured on (Screen Recording was already granted there), so this is
 * a documented heuristic, NOT a verified boundary — see `flutter_info`'s
 * reported byte count if it ever needs recalibrating on a host where the grant
 * is denied.
 */
export const MACOS_SCREENCAPTURE_DEGENERATE_BYTES = 3000;

/** Configuration a MacosAdapter needs from the runtime (all optional — see field docs). */
export interface MacosAdapterConfig {
  /** Fallback bundle id for lifecycle verbs before any app has been staged. */
  appId?: string;
  /** Default `.app`/archive PATH staged when a deploy call supplies none (FLUTTER_DEVICE_MACOS_APP_PATH). */
  appPath?: string;
  /** Default `.app` archive URL staged when neither a call nor appPath supplies one (FLUTTER_DEVICE_MACOS_APP_URL). */
  appUrl?: string;
  /**
   * Pin a target process name (the app's CFBundleExecutable, e.g.
   * "example-app" — NOT its display name) for an ALREADY-RUNNING app, so
   * geometry/screenshot/pointer/key work without a prior `flutter_deploy` this
   * session (FLUTTER_DEVICE_MACOS_PROCESS_NAME).
   */
  processName?: string;
  /**
   * Locate the `cliclick` CLI, returning its absolute path or undefined when
   * not found. Optional; defaults to {@link locateCliclick}. Injectable so
   * tests pin cliclick's presence deterministically.
   */
  locateCliclick?: () => string | undefined;
}

/** A synthetic failure CommandResult carrying `message` as both stderr and combined. */
function failureResult(message: string): CommandResult {
  return {
    code: null,
    stdout: "",
    stderr: message,
    combined: message,
    success: false,
    timedOut: false,
  };
}

/** A synthetic successful CommandResult carrying `message` as stdout/combined. */
function okResult(message: string): CommandResult {
  return {
    code: 0,
    stdout: message,
    stderr: "",
    combined: message,
    success: true,
    timedOut: false,
  };
}

/**
 * Parse one `ps -axo pid=,comm=` line into its pid and comm fields. `comm` is
 * everything after the numeric pid, kept as a single value even when the
 * command path itself contains spaces (e.g. an app whose bundle lives under
 * "/Applications/Some App.app/...").
 */
function parsePidCommLine(
  line: string
): { pid: number; comm: string } | undefined {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? { pid, comm: match[2] } : undefined;
}

/**
 * Whether a `ps` `comm=` value matches `marker`, ANCHORED so this can never
 * fire on a bare substring appearing anywhere inside an unrelated process's
 * path — see {@link MacosAdapter.findMatchingPids}'s doc for why that
 * distinction matters for a destructive caller.
 *
 * - A fully-qualified marker (contains "/" — the `Contents/MacOS/<exe>` path
 *   built from a session-staged app) must match `comm` EXACTLY. Both sides
 *   must already be symlink-resolved by the caller ({@link findMatchingPids})
 *   before reaching here — this function does no filesystem I/O itself, so it
 *   stays a pure, synchronously-testable string comparison.
 * - A bare marker (just the executable name, all that survives an MCP server
 *   restart via the `FLUTTER_DEVICE_MACOS_PROCESS_NAME` pin) must match comm's
 *   TRAILING PATH SEGMENT: `comm === marker`, or `comm` ends with
 *   `/${marker}`. A short/generic bare marker (e.g. "Electron") therefore
 *   cannot match a longer, different executable name that merely contains it
 *   (e.g. "ElectronHelper"). There is no filesystem path to resolve for a bare
 *   marker (it is a name, not a path), so no symlink normalization applies on
 *   this branch.
 */
function commMatchesMarker(comm: string, marker: string): boolean {
  if (marker.includes("/")) return comm === marker;
  return comm === marker || comm.endsWith(`/${marker}`);
}

/**
 * Resolve `p` to its real, symlink-free form, or return `p` UNCHANGED if it
 * can no longer be resolved (e.g. the scratch dir was already removed, or the
 * process that owned it has exited and cleanup ran). This can only make a
 * fully-qualified comparison in {@link commMatchesMarker} MISS — never
 * falsely match — which is the safe direction for a destructive caller: a
 * resolution failure degrades to the pre-fix exact-string comparison rather
 * than silently treating "unresolvable" as "equal".
 *
 * EXISTS BECAUSE: `os.tmpdir()` returns a `/var/folders/...` path that macOS
 * itself symlinks to `/private/var/folders/...`. Verified on-device: staging a
 * real signed test bundle under `os.tmpdir()` and launching it with `open -n`
 * (the exact production path), `ps -axo comm=` reported the `/private/var/...`
 * form even though the launch command was given the unresolved `/var/...`
 * path — so a fully-qualified marker built from `this.stagedAppPath` and a
 * `ps` `comm=` value name the same running process while spelled differently,
 * and a naive `===` never matches the common case.
 */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export class MacosAdapter implements PlatformAdapter {
  readonly platform: Platform = "macos";

  private inputController: MacosInputController | undefined;

  /** Set once install() has staged an app this session. */
  private scratchDir: string | undefined;
  private stagedAppPath: string | undefined;
  private bundleId: string | undefined;
  private processName: string | undefined;
  private lastPid: number | undefined;
  private accessibilityVerifiedThisSession = false;

  constructor(private readonly config: MacosAdapterConfig) {}

  get appId(): string {
    return this.bundleId ?? this.config.appId ?? "";
  }

  /** Resolve the cliclick binary fresh (never cached). Used by the input controller too. */
  cliclickBinary(): string | undefined {
    return (this.config.locateCliclick ?? locateCliclick)();
  }

  /**
   * Name (+ pid) of THIS process's parent — the "responsible" process TCC
   * attributes an Accessibility/Screen-Recording grant to when a short-lived
   * CLI (cliclick, screencapture) is spawned underneath it. Used so
   * `flutter_info` names WHICH app to grant permission to, rather than the
   * unhelpful (and wrong) "grant it to cliclick".
   */
  private async responsibleProcessName(): Promise<string> {
    try {
      const ppid = process.ppid;
      const result = await runShell(`ps -o comm= -p ${ppid}`, {
        timeoutMs: 3000,
      });
      const name = result.stdout.trim();
      return name ? `${name} (pid ${ppid})` : `pid ${ppid}`;
    } catch {
      return "the process that launched this MCP server";
    }
  }

  // =========== flutter_info ==========
  /**
   * Device + environment status: macOS version/arch, whether cliclick is
   * installed, and the two TCC gates probed BY EFFECT (never by asking a
   * permissions API, never assumed) — see the module doc's TCC section. This
   * is the most important tool on this platform: every other capability
   * (pointer/key/screenshot) fails SILENTLY (exit 0, no effect) when a grant
   * is missing, so this is the one place that turns that silence into a clear
   * granted/denied/unknown verdict with the exact remediation path.
   */
  async info(): Promise<CommandResult> {
    const sw = await runShell("sw_vers", { timeoutMs: 10000 });
    const arch = await runShell("uname -m", { timeoutMs: 5000 });
    const cliclickPath = this.cliclickBinary();
    const accessibility = await this.probeAccessibility(cliclickPath);
    const screenRecording = await this.probeScreenRecording();

    const staged = this.stagedAppPath
      ? `Staged app: ${this.stagedAppPath} (bundle id ${this.bundleId}, process ${this.processName}).`
      : "No app staged this session yet — flutter_deploy stages one, or set " +
        "FLUTTER_DEVICE_MACOS_PROCESS_NAME to target an already-running app by its " +
        'CFBundleExecutable (e.g. "example-app", not its display name).';

    const lines = [
      "=== macOS ===",
      sw.combined.trim() || "(sw_vers produced no output)",
      `Architecture: ${arch.stdout.trim() || "unknown"}`,
      "",
      "=== cliclick (pointer/key input) ===",
      cliclickPath
        ? `Found: ${cliclickPath}`
        : "NOT FOUND. Install with `brew install cliclick`, or set " +
          "FLUTTER_DEVICE_CLICLICK_PATH to its absolute path.",
      "",
      "=== TCC: Accessibility (gates cliclick synthetic input) ===",
      accessibility.summary,
      "",
      "=== TCC: Screen Recording (gates screencapture) ===",
      screenRecording.summary,
      "",
      staged,
    ];
    const combined = lines.join("\n");
    return {
      code: 0,
      stdout: combined,
      stderr: "",
      combined,
      success: true,
      timedOut: false,
    };
  }

  /**
   * Probe Accessibility BY EFFECT: nudge the real cursor a small, harmless
   * amount with `cliclick m:`, read it back with `cliclick p:`, and compare —
   * a denied grant means cliclick exits 0 but the cursor never moves (the
   * exact silent-failure signature this whole adapter is built around). The
   * original position is ALWAYS restored, whether or not the nudge landed —
   * this runs on somebody's own machine, possibly while they are away, and
   * nothing here should leave their cursor somewhere they didn't put it.
   */
  private async probeAccessibility(
    cliclickPath: string | undefined
  ): Promise<{ granted: boolean | "unknown"; summary: string }> {
    if (!cliclickPath) {
      return {
        granted: "unknown",
        summary:
          "UNKNOWN — cliclick was not found, so Accessibility cannot be probed by effect. " +
          "Install it (`brew install cliclick`) and re-run flutter_info.",
      };
    }
    const before = await runShell(buildCliclickPositionCommand(cliclickPath), {
      timeoutMs: 5000,
    });
    const beforePos = parseCliclickPosition(before.stdout);
    if (!beforePos) {
      return {
        granted: "unknown",
        summary:
          `UNKNOWN — cliclick p: did not report a parseable cursor position ` +
          `(${tail(before.combined, 5)}).`,
      };
    }
    await runShell(buildCliclickRelativeMoveCommand(cliclickPath, 3, 3), {
      timeoutMs: 5000,
    });
    const after = await runShell(buildCliclickPositionCommand(cliclickPath), {
      timeoutMs: 5000,
    });
    const afterPos = parseCliclickPosition(after.stdout);
    // ALWAYS restore, whether or not the nudge actually landed.
    await runShell(
      buildCliclickMoveCommand(cliclickPath, beforePos.x, beforePos.y),
      { timeoutMs: 5000 }
    );

    if (!afterPos) {
      return {
        granted: "unknown",
        summary:
          "UNKNOWN — the nudge was issued but the read-back position could not be " +
          "parsed afterward.",
      };
    }
    if (afterPos.x !== beforePos.x || afterPos.y !== beforePos.y) {
      return {
        granted: true,
        summary:
          `GRANTED — cliclick moved the cursor (${beforePos.x},${beforePos.y} → ` +
          `${afterPos.x},${afterPos.y}) and it was restored to ${beforePos.x},${beforePos.y}.`,
      };
    }
    const who = await this.responsibleProcessName();
    return {
      granted: false,
      summary:
        "DENIED — cliclick exited 0 but the cursor never moved (a silent no-op; the " +
        `classic TCC-gated signature). Grant Accessibility to ${who} in System Settings ` +
        "→ Privacy & Security → Accessibility — NOT to cliclick itself: macOS attributes " +
        "synthetic-input permission to the responsible PARENT process (your terminal / IDE / " +
        "agent host), not the short-lived cliclick binary it spawns.",
    };
  }

  /**
   * `pointerMove` can verify Accessibility by reading the cursor back after
   * every call, but `key`/`text`/`pointerClick` have no analogous readback —
   * there is nothing to read after a keystroke or a click. So those three
   * borrow the same move+read-back+restore probe, once per session (cached),
   * before their first action: without it, the FIRST input action of a
   * session — if it happens to be a click or a keystroke rather than a move —
   * would report success on a TCC-denied host even though nothing happened.
   */
  async ensureAccessibilityGranted(cliclickPath: string): Promise<void> {
    if (this.accessibilityVerifiedThisSession) {
      return;
    }
    const probe = await this.probeAccessibility(cliclickPath);
    if (probe.granted === true) {
      this.accessibilityVerifiedThisSession = true;
      return;
    }
    if (probe.granted === false) {
      throw new Error(
        `Accessibility is not granted, so this input action would silently no-op. ${probe.summary}`
      );
    }
    // "unknown" (e.g. the position readback didn't parse) isn't a denial signature —
    // there's nothing more to check by effect, so let the action attempt proceed.
  }

  /** Lets a verified pointerMove skip re-probing on the next key/text/click call this session. */
  markAccessibilityGranted(): void {
    this.accessibilityVerifiedThisSession = true;
  }

  /**
   * Probe Screen Recording BY EFFECT: capture a tiny corner of the screen (a
   * disposable internal probe, never the target window, never returned to the
   * caller) and check it is not a degenerate placeholder image — a denied
   * grant means `screencapture` exits 0 but produces one anyway. Always
   * cleaned up.
   */
  private async probeScreenRecording(): Promise<{
    granted: boolean | "unknown";
    summary: string;
  }> {
    const probePath = path.join(
      os.tmpdir(),
      `flutter-device-mcp-macos-screencap-probe-${process.pid}-${Date.now()}.png`
    );
    try {
      const size = 40;
      const result = await runShell(
        buildScreencaptureProbeCommand(0, 0, size, probePath, false),
        { timeoutMs: 10000 }
      );
      if (!result.success || !fs.existsSync(probePath)) {
        return {
          granted: "unknown",
          summary: `UNKNOWN — screencapture failed to run (${tail(result.combined, 5)}).`,
        };
      }
      const stat = fs.statSync(probePath);
      if (stat.size < MACOS_SCREENCAPTURE_DEGENERATE_BYTES) {
        const who = await this.responsibleProcessName();
        return {
          granted: false,
          summary:
            `DENIED (degenerate image) — screencapture exited 0 but wrote only a ` +
            `${stat.size}-byte probe image (below the ${MACOS_SCREENCAPTURE_DEGENERATE_BYTES}-byte ` +
            `floor for a real ${size}x${size} capture). Grant Screen Recording to ${who} in ` +
            "System Settings → Privacy & Security → Screen Recording.",
        };
      }
      return {
        granted: true,
        summary: `GRANTED — captured a real ${stat.size}-byte probe image.`,
      };
    } finally {
      try {
        fs.unlinkSync(probePath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  // =========== flutter_setup ==========
  /**
   * macOS has no pairing/target-file step — there is only "this Mac". Reports
   * how to point the adapter at an app (deploy, or the process-name pin).
   */
  async setup(_opts: { deviceAddr?: string }): Promise<{
    result: CommandResult;
    wrote?: string;
  }> {
    const message =
      'macOS has no pairing/target-file step (there is only "this Mac"). Use ' +
      "flutter_deploy to stage + launch a .app, or set " +
      "FLUTTER_DEVICE_MACOS_PROCESS_NAME to target an already-running one by its " +
      "CFBundleExecutable.";
    return { result: okResult(message) };
  }

  // =========== flutter_build ==========
  /**
   * Explicit {supported:false}: this MCP has no build/sign toolchain for
   * macOS. Bring your own signed `.app` (Xcode, `flutter build macos` +
   * signing, or whatever produced it) and point flutter_deploy at it.
   */
  async build(_opts: BuildOptions): Promise<BuildResult> {
    const message =
      "macOS has no build path in this MCP: flutter_build expects a prebuilt, SIGNED " +
      ".app. Build/sign it yourself and point flutter_deploy at it via app_path/app_url " +
      "(or FLUTTER_DEVICE_MACOS_APP_PATH/FLUTTER_DEVICE_MACOS_APP_URL).";
    return {
      result: failureResult(message),
      enospc: false,
      installFailed: false,
      launchedDisplay: false,
      supported: false,
    };
  }

  // =========== device / target resolution ==========
  /**
   * Resolve the target: the process name (CFBundleExecutable) of the app
   * every other verb acts on. Precedence: the app staged by install() THIS
   * SESSION, else the FLUTTER_DEVICE_MACOS_PROCESS_NAME pin (for an
   * already-running app never deployed by this session).
   * Mirrors the other adapters' pin/discover/self-heal shape: a candidate that
   * isn't found running (see {@link isProcessRunning}) is still returned (not
   * fatal), carrying a warning, so the caller sees exactly why a subsequent
   * call fails rather than a silent substitution.
   */
  async discoverDevice(
    _preference?: DeviceTargetPreference
  ): Promise<DeviceResolution> {
    const pinned = this.config.processName?.trim();
    const candidate = this.processName ?? (pinned || undefined);
    if (!candidate) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No macOS app resolved. Run flutter_deploy first (it stages + launches a .app " +
          "and remembers its process name), or set FLUTTER_DEVICE_MACOS_PROCESS_NAME to " +
          "the CFBundleExecutable of an already-running app (the name System Events " +
          'lists it under — e.g. "example-app", not its display name "Example App").'
      );
    }
    const running = await this.isProcessRunning(candidate);
    if (!running) {
      return {
        target: candidate,
        // A session-staged app that's gone quiet was previously DISCOVERED
        // (this.processName), now offline; a config pin that's never been
        // confirmed alive is the STALE PIN — see DeviceResolution.source's doc.
        source: this.processName ? "discovered-offline" : "stale-pin",
        warning:
          `Process "${candidate}" does not appear to be running (checked via ps, not ` +
          "pgrep — see findMatchingPids's doc). Using it anyway; geometry/screenshot/" +
          "pointer/key calls against it will fail clearly.",
      };
    }
    return { target: candidate, source: this.processName ? "discovered" : "pin" };
  }

  /**
   * The marker `ps`'s `comm=` column is checked against for `processName` —
   * the fully-qualified `Contents/MacOS/<exe>` path when this session knows
   * where the app is staged (mirrors {@link waitForPid} exactly), else the
   * bare executable name (all that survives an MCP server restart, via the
   * FLUTTER_DEVICE_MACOS_PROCESS_NAME pin — there is no known bundle path to
   * qualify it with).
   */
  private processMatchMarker(processName: string): string {
    return this.stagedAppPath && this.processName === processName
      ? bundleExecutablePath(this.stagedAppPath, processName)
      : processName;
  }

  /**
   * PIDs of running processes matching `processName` — via `ps -axo comm=`,
   * the SAME mechanism {@link waitForPid} uses to confirm a just-launched
   * process. Deliberately NOT `pgrep`/`pkill -x`: verified on-device (compiled
   * test binaries inside real `.app` bundles, launched via `open -n`,
   * `CFBundleExecutable`-style names up to 100 chars) that `pgrep -x`/`pkill
   * -x` match against the bare executable BASENAME, never the fully-qualified
   * `Contents/MacOS/<exe>` path `ps`'s `comm=` column reports (`ps -o ucomm=`
   * DOES truncate to 16 chars, but that is not the field pgrep/pkill compare
   * against — no truncation-driven miss reproduced there). That basename-vs-
   * full-path split is still a real inconsistency: two staged copies of the
   * same app (same `CFBundleExecutable`, different scratch-dir paths — see
   * the module doc's re-deploy cleanup) are indistinguishable to `pgrep -x`'s
   * basename match but not to a full-path check, and `pgrep`/`pkill -x` treat
   * the name as a regex, so a name containing a regex metacharacter parses
   * differently than the literal comparison `ps` gets here. Using one field
   * (the full path) everywhere removes both failure modes: a process found
   * at launch is never later invisible to isProcessRunning/killStale for a
   * reason having nothing to do with whether it's running.
   *
   * ANCHORED via {@link commMatchesMarker} — never a bare substring check.
   * This feeds `killStale`'s `kill -9`, a DESTRUCTIVE and irreversible action
   * on the developer's own machine, so a match here must be as narrow as the
   * thing it names: a plain `.includes()` would let a short/generic bare-name
   * pin (e.g. "Electron"/"Chrome"/"Helper" — all that
   * `FLUTTER_DEVICE_MACOS_PROCESS_NAME` has to go on after an MCP server
   * restart) match ANY unrelated process whose full `comm` path merely happens
   * to contain that string somewhere — something `pgrep -x`'s kernel basename
   * comparison could never do. Anchoring closes that gap (a bare marker must
   * match comm's TRAILING PATH SEGMENT; a fully-qualified marker must match
   * comm exactly) without reopening the basename/full-path split above.
   *
   * A fully-qualified marker is additionally SYMLINK-NORMALIZED (via
   * {@link realOrSelf}) on both sides before the exact-match check — `comm`
   * is only realpath-resolved for candidates whose trailing path segment
   * already equals the marker's basename, a cheap string check that keeps
   * this from calling `fs.realpathSync` on every unrelated process on the
   * machine. See {@link realOrSelf}'s doc for why this exists (the
   * `os.tmpdir()` vs `/private/...` split) and why a resolution failure is
   * safe (it can only produce a miss, never a false match).
   */
  private async findMatchingPids(marker: string): Promise<number[]> {
    const ps = await runShell("ps -axo pid=,comm=", { timeoutMs: 5000 });
    const fullyQualified = marker.includes("/");
    const normalizedMarker = fullyQualified ? realOrSelf(marker) : marker;
    const markerBasename = fullyQualified ? path.basename(normalizedMarker) : undefined;
    return ps.stdout
      .split("\n")
      .map((line) => parsePidCommLine(line))
      .filter((parsed): parsed is { pid: number; comm: string } => parsed !== undefined)
      .filter((parsed) => {
        if (!fullyQualified) return commMatchesMarker(parsed.comm, marker);
        if (path.basename(parsed.comm) !== markerBasename) return false;
        return commMatchesMarker(realOrSelf(parsed.comm), normalizedMarker);
      })
      .map((parsed) => parsed.pid);
  }

  private async isProcessRunning(processName: string): Promise<boolean> {
    const pids = await this.findMatchingPids(this.processMatchMarker(processName));
    return pids.length > 0;
  }

  /**
   * Resolve BOTH the target process name and its live front-window bounds in
   * one call — shared by screenshot/geometry/the input controller so every
   * caller reads FRESH bounds (never cached), the point made in macosWindow.ts:
   * a moved/resized window turns a "correct" script into one that silently
   * clicks the wrong thing.
   */
  async resolveTarget(): Promise<{ processName: string; bounds: MacWindowBounds }> {
    const resolution = await this.discoverDevice();
    const processName = resolution.target;
    const result = await runShell(
      buildSystemEventsWindowBoundsCommand(processName),
      { timeoutMs: 15000 }
    );
    const bounds = result.success
      ? parseSystemEventsWindowBounds(result.stdout)
      : undefined;
    if (!bounds) {
      throw new Error(
        `Could not read ${processName}'s front window bounds via System Events ` +
          `(${tail(result.combined, 10)}). Is the app running with a visible window? If ` +
          "System Events itself is being blocked, grant this process Automation access to " +
          "System Events in System Settings → Privacy & Security → Automation."
      );
    }
    return { processName, bounds };
  }

  // =========== flutter_deploy: install (stage) ==========
  /**
   * Resolve the configured `.app` source (a bundle, a `.tar.gz`/`.tgz`, or a
   * `.dmg` — local path or URL) and stage it into a FRESH scratch directory —
   * never `/Applications`. Reads the staged bundle's Info.plist for its bundle
   * id + executable name and remembers both for launch/lifecycle/geometry/
   * screenshot/pointer/key. A prior session's scratch dir is cleaned up on a
   * re-deploy so repeated calls don't accumulate disk usage.
   */
  async install(_device: string, opts: InstallOptions): Promise<CommandResult> {
    const source = classifyMacosAppSource({
      appPath: opts.appPath ?? this.config.appPath,
      appUrl: opts.appUrl ?? this.config.appUrl,
    });

    if (source.kind === "none") {
      return failureResult(
        "No macOS .app to stage. Pass app_path/app_url on flutter_deploy, or set " +
          "FLUTTER_DEVICE_MACOS_APP_PATH/FLUTTER_DEVICE_MACOS_APP_URL. Accepted forms: " +
          "a .app bundle, a .tar.gz/.tgz, or a .dmg."
      );
    }
    if (source.kind === "unrecognized") {
      return failureResult(
        `Could not classify "${source.value}" as a macOS app source — expected a path/URL ` +
          "ending in .app, .tar.gz, .tgz, or .dmg."
      );
    }

    const scratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flutter-device-mcp-macos-")
    );

    // Every failure past this point must remove scratchRoot before returning —
    // it was never assigned to this.scratchDir, so no later call can clean it
    // up; an un-rmSync'd failure here leaks the whole staged/extracted tree.
    let appPath: string;
    try {
      appPath = await this.stageApp(source, scratchRoot);
    } catch (error) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
      return failureResult(error instanceof Error ? error.message : String(error));
    }

    const bundleId = await this.readPlistValue(appPath, "CFBundleIdentifier");
    const executableName = await this.readPlistValue(appPath, "CFBundleExecutable");
    if (!bundleId || !executableName) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
      return failureResult(
        `Staged ${appPath} but could not read CFBundleIdentifier/CFBundleExecutable from ` +
          "its Info.plist — is this a valid, signed app bundle?"
      );
    }

    // Replacing a prior staged app: clean up its scratch dir.
    if (this.scratchDir && this.scratchDir !== scratchRoot) {
      try {
        fs.rmSync(this.scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    this.scratchDir = scratchRoot;
    this.stagedAppPath = appPath;
    this.bundleId = bundleId;
    this.processName = executableName;

    return okResult(
      `Staged ${appPath} (bundle id ${bundleId}, executable ${executableName}) under ` +
        `${scratchRoot} (never /Applications).`
    );
  }

  /** Fetch/unpack/copy the resolved source into `scratchRoot`, returning the staged `.app` path. */
  private async stageApp(
    source: Extract<MacosAppSource, { kind: "app" | "archive" | "url" }>,
    scratchRoot: string
  ): Promise<string> {
    if (source.kind === "app") {
      const dest = path.join(scratchRoot, path.basename(source.path));
      const copy = await runShell(buildDittoCopyCommand(source.path, dest), {
        timeoutMs: 300000,
      });
      if (!copy.success) {
        throw new Error(
          `ditto failed to stage ${source.path}: ${tail(copy.combined, 20)}`
        );
      }
      return dest;
    }

    let archivePath: string;
    const format: MacosArchiveFormat = source.format;
    if (source.kind === "url") {
      archivePath = path.join(
        scratchRoot,
        format === "dmg" ? "download.dmg" : "download.tar.gz"
      );
      const download = await runShell(
        buildCurlDownloadCommand(source.url, archivePath),
        { timeoutMs: 600000 }
      );
      if (!download.success) {
        throw new Error(
          `curl failed to fetch ${source.url}: ${tail(download.combined, 20)}`
        );
      }
    } else {
      archivePath = source.path;
    }

    if (format === "tar.gz") {
      const extractDir = path.join(scratchRoot, "extracted");
      fs.mkdirSync(extractDir, { recursive: true });
      const extract = await runShell(
        buildTarExtractCommand(archivePath, extractDir),
        { timeoutMs: 300000 }
      );
      if (!extract.success) {
        throw new Error(
          `tar failed to extract ${archivePath}: ${tail(extract.combined, 20)}`
        );
      }
      const found = await runShell(buildFindAppBundleCommand(extractDir), {
        timeoutMs: 15000,
      });
      const appInArchive = parseFoundAppBundle(found.stdout);
      if (!appInArchive) {
        throw new Error(
          `No .app bundle found inside ${archivePath} (searched ${extractDir}).`
        );
      }
      return appInArchive;
    }

    // dmg: mount read-only, copy the .app OUT (never run off the mount — it
    // disappears the moment the volume is detached), then detach.
    const mountPoint = path.join(scratchRoot, "mount");
    fs.mkdirSync(mountPoint, { recursive: true });
    const attach = await runShell(
      buildHdiutilAttachCommand(archivePath, mountPoint),
      { timeoutMs: 120000 }
    );
    if (!attach.success) {
      throw new Error(
        `hdiutil attach failed for ${archivePath}: ${tail(attach.combined, 20)}`
      );
    }
    try {
      const found = await runShell(buildFindAppBundleCommand(mountPoint), {
        timeoutMs: 15000,
      });
      const appOnVolume = parseFoundAppBundle(found.stdout);
      if (!appOnVolume) {
        throw new Error(`No .app bundle found on the mounted volume ${mountPoint}.`);
      }
      const dest = path.join(scratchRoot, path.basename(appOnVolume));
      const copy = await runShell(buildDittoCopyCommand(appOnVolume, dest), {
        timeoutMs: 300000,
      });
      if (!copy.success) {
        throw new Error(
          `ditto failed to copy ${appOnVolume} off the mounted dmg: ${tail(copy.combined, 20)}`
        );
      }
      return dest;
    } finally {
      await runShell(buildHdiutilDetachCommand(mountPoint), { timeoutMs: 60000 });
    }
  }

  private async readPlistValue(
    appPath: string,
    key: string
  ): Promise<string | undefined> {
    const result = await runShell(
      buildPlutilExtractCommand(key, infoPlistPath(appPath)),
      { timeoutMs: 10000 }
    );
    if (!result.success) return undefined;
    return parsePlutilRawOutput(result.stdout);
  }

  // =========== flutter_deploy: launch ==========
  /**
   * Launch the staged `.app` with `open -n` (launches by PATH, works for a
   * scratch-dir bundle exactly as for an installed one, and registers it with
   * Launch Services so `tell application id "…"` resolves it) and resolve its
   * pid by matching `Contents/MacOS/<executable>` in the process list.
   *
   * The returned VM-service URIs are EMPTY STRINGS: this launches a prebuilt
   * bundle directly, not under `flutter run`, so no Dart VM service is opened
   * and there is nothing for a driver to connect to (see the module doc). Drive
   * the app with flutter_pointer/flutter_key/flutter_screenshot instead.
   *
   * `mode`/`dartDefine` are inert here — both belong to a build this adapter
   * does not perform.
   */
  async launchAndCaptureUri(
    _device: string,
    _timeoutMs: number,
    _mode?: BuildMode,
    _dartDefine?: Record<string, string>
  ): Promise<LaunchOutcome> {
    if (!this.stagedAppPath || !this.processName) {
      return {
        failed: true,
        reason:
          "No app staged. flutter_deploy's install step must stage a .app before launching.",
        logPath: "",
        pid: undefined,
        logTail: "",
      };
    }
    const open = await runShell(`open -n ${quote(this.stagedAppPath)}`, {
      timeoutMs: 30000,
    });
    if (!open.success) {
      return {
        failed: true,
        reason: `\`open -n\` failed to launch ${this.stagedAppPath}: ${tail(open.combined, 30)}`,
        logPath: "",
        pid: undefined,
        logTail: tail(open.combined, 30),
      };
    }

    const pid = await this.waitForPid(this.stagedAppPath, this.processName);
    if (pid === undefined) {
      return {
        failed: true,
        reason:
          `Launched ${this.stagedAppPath} via \`open -n\` but no matching process appeared ` +
          "within the wait budget.",
        logPath: "",
        pid: undefined,
        logTail: "",
      };
    }
    this.lastPid = pid;
    return { vmServiceUriWs: "", vmServiceUriHttp: "", logPath: "", pid };
  }

  /**
   * Poll for the launched app's pid by matching its executable path in `ps`
   * — by CALLING {@link findMatchingPids} directly (not a parallel re-
   * implementation of its match) so this can never drift from
   * isProcessRunning/killStale's notion of "running": a process found here is
   * never later invisible to them, or vice versa, for a reason having nothing
   * to do with whether it's actually running. (A prior version of this file
   * duplicated the match loop here instead of sharing it, and the copies
   * drifted — this is deliberately not that shape anymore.)
   */
  private async waitForPid(
    appPath: string,
    executableName: string
  ): Promise<number | undefined> {
    const marker = bundleExecutablePath(appPath, executableName);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const pids = await this.findMatchingPids(marker);
      if (pids.length > 0) return pids[0];
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return undefined;
  }

  // =========== flutter_uninstall ==========
  /**
   * "Uninstall" on macOS means undoing the deploy: kill the launched process
   * (if tracked) and remove the scratch directory — there is nothing under
   * /Applications to ever clean up.
   */
  async uninstall(_device: string, _appId: string): Promise<CommandResult> {
    const notes: string[] = [];
    if (this.lastPid !== undefined) {
      await runShell(`kill -9 ${this.lastPid} 2>&1`, { timeoutMs: 5000 });
      notes.push(`Killed pid ${this.lastPid}.`);
      this.lastPid = undefined;
    }
    if (this.scratchDir) {
      try {
        fs.rmSync(this.scratchDir, { recursive: true, force: true });
        notes.push(`Removed scratch dir ${this.scratchDir}.`);
      } catch (error) {
        notes.push(
          `Could not remove scratch dir ${this.scratchDir}: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
      this.scratchDir = undefined;
    }
    this.stagedAppPath = undefined;
    this.bundleId = undefined;
    this.processName = undefined;
    return okResult(notes.length > 0 ? notes.join(" ") : "Nothing staged to uninstall.");
  }

  // =========== flutter_kill_stale ==========
  /**
   * There is no persistent build/run DRIVER process on macOS (unlike a
   * `flutter run` daemon — the launch here is the app itself), so the only
   * thing that could wedge a redeploy is a PRIOR instance still running.
   * Kills by PROCESS NAME (via {@link findMatchingPids}, the same `ps`-based,
   * ANCHORED match {@link isProcessRunning}/{@link waitForPid} use — NOT
   * `pkill -x`, whose bare-basename/regex match is a different field than the
   * one `ps`'s `comm=` reports, see {@link findMatchingPids}'s doc) rather
   * than a remembered pid: a remembered pid resets to `undefined`
   * across an MCP server restart while the previously-launched app is still
   * very much alive, so a pid-only kill silently stops working right when it
   * matters (a stale process surviving a host reload). The process name
   * survives a restart via the FLUTTER_DEVICE_MACOS_PROCESS_NAME pin,
   * mirroring the same pin {@link discoverDevice} falls back to.
   *
   * `kill -9` is DESTRUCTIVE and irreversible, so the anchoring in
   * {@link findMatchingPids}/{@link commMatchesMarker} is load-bearing here in
   * particular: a bare FLUTTER_DEVICE_MACOS_PROCESS_NAME pin only ever matches
   * comm's trailing path segment, never a substring anywhere in the path, so
   * a short/generic pin can't take down an unrelated process whose path
   * merely contains it.
   *
   * killStale is ADDITIONALLY STRICTER than isProcessRunning/waitForPid on top
   * of that shared anchoring — deliberately: the same residual imprecision is
   * merely cosmetic for isProcessRunning (a false positive there only feeds a
   * "such-and-such is/isn't running" warning) but would be destructive here.
   * A bare marker with no known bundle path (the post-MCP-restart case) can
   * still collide with several otherwise-unrelated apps that happen to share
   * one generic literal `CFBundleExecutable` — e.g. many distinct
   * Electron-based apps are named "Electron", not "ElectronHelper" or
   * anything more specific, so anchoring alone can't tell them apart. Rather
   * than `kill -9`-ing every match, a bare marker matching MORE THAN ONE pid
   * is treated as too ambiguous to act on and killStale refuses, reporting the
   * ambiguity instead. A fully-qualified marker (this session's own staged
   * bundle path) can't have this problem — two different apps cannot share
   * the same literal path — so only the bare-marker branch gets this extra
   * bar; see {@link findMatchingPids}'s doc for the shared matching this
   * builds on.
   */
  async killStale(): Promise<Record<string, CommandResult>> {
    const processName = this.processName ?? this.config.processName?.trim();
    if (!processName) {
      return {
        previousLaunch: okResult(
          "No macOS process name known this session, and no " +
            "FLUTTER_DEVICE_MACOS_PROCESS_NAME pin set, so there's nothing to identify " +
            "a stale process by."
        ),
      };
    }
    const marker = this.processMatchMarker(processName);
    const pids = await this.findMatchingPids(marker);
    this.lastPid = undefined;
    if (pids.length === 0) {
      return {
        previousLaunch: okResult(
          `No process matching "${processName}" found running (checked via ps — see ` +
            "findMatchingPids's doc)."
        ),
      };
    }
    if (!marker.includes("/") && pids.length > 1) {
      return {
        previousLaunch: failureResult(
          `Refusing to kill: ${pids.length} distinct processes match the bare name ` +
            `"${processName}" (pids ${pids.join(", ")}). This pin is too generic to act on ` +
            "safely with kill -9 — set FLUTTER_DEVICE_MACOS_PROCESS_NAME to something more " +
            "specific, or run flutter_deploy this session so killStale can match this " +
            "session's exact staged bundle path instead."
        ),
      };
    }
    const kills = await Promise.all(
      pids.map((pid) => runShell(`kill -9 ${pid} 2>&1`, { timeoutMs: 5000 }))
    );
    const success = kills.every((k) => k.success);
    const combined =
      kills.map((k) => k.combined).filter(Boolean).join("\n") ||
      `Killed pid(s) ${pids.join(", ")}.`;
    return {
      previousLaunch: {
        code: success ? 0 : null,
        stdout: success ? combined : "",
        stderr: success ? "" : combined,
        combined,
        success,
        timedOut: false,
      },
    };
  }

  // =========== lifecycle ==========
  /**
   * OS-level lifecycle via `osascript`/System Events, targeting the bundle id
   * (see macosWindow.ts's doc on why bundle-id targeting works for a
   * scratch-dir launch). There is no OS-level "send to background" verb on
   * macOS (unlike iOS's neutral-app trick) — losing key/focus IS backgrounding
   * here, so `background` activates Finder instead, which is the closest
   * analog: the app keeps running, un-killed, just no longer frontmost.
   */
  readonly lifecycle: AppLifecycle = {
    terminate: (_device, appId) => this.terminateApp(appId),
    background: () => this.backgroundApp(),
    foreground: (_device, appId) => this.foregroundApp(appId),
  };

  /**
   * `tell application id "<bundle id>" to quit` is a normal Apple Event send —
   * and macOS LAUNCHES the target first if it isn't already running before
   * delivering any Apple Event to it. So terminating an app that already
   * exited would otherwise spawn it fresh just to quit it again. Skip the
   * send when we can confirm (by process name) it isn't running.
   */
  private async terminateApp(appId: string): Promise<CommandResult> {
    const bundleId = this.bundleId ?? appId;
    const processName = this.processName ?? this.config.processName?.trim();
    if (processName && !(await this.isProcessRunning(processName))) {
      return okResult(
        `Process "${processName}" is not running — nothing to terminate (skipped sending ` +
          "a quit Apple Event, which would otherwise launch it fresh)."
      );
    }
    return runShell(buildOsascriptQuitCommand(bundleId), { timeoutMs: 30000 });
  }

  private foregroundApp(appId: string): Promise<CommandResult> {
    const bundleId = this.bundleId ?? appId;
    return runShell(buildOsascriptActivateCommand(bundleId), { timeoutMs: 30000 });
  }

  private backgroundApp(): Promise<CommandResult> {
    return runShell('osascript -e \'tell application "Finder" to activate\'', {
      timeoutMs: 30000,
    });
  }

  // =========== flutter_screenshot ==========
  /**
   * WINDOW-TARGETED capture via `screencapture -R<x,y,w,h>` against the
   * target's LIVE front-window bounds — deliberately never a full-desktop
   * grab (see the module doc: that would leak whatever else the machine's
   * owner has open, a privacy defect, not a framing one).
   */
  async screenshot(opts: {
    outPath?: string;
    includeBase64?: boolean;
  }): Promise<ScreenshotResult> {
    let bounds: MacWindowBounds;
    try {
      ({ bounds } = await this.resolveTarget());
    } catch (error) {
      return {
        captured: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const outPath = opts.outPath ?? defaultScreenshotPath("macos");
    const result = await runShell(
      buildScreencaptureWindowCommand(bounds, outPath),
      { timeoutMs: 30000 }
    );
    if (!result.success || !fs.existsSync(outPath)) {
      return {
        captured: false,
        reason: `screencapture failed: ${tail(result.combined, 20)}`,
        hint: "Run flutter_info to confirm Screen Recording is granted to the responsible process.",
      };
    }
    // A denied Screen Recording grant is the same silent-failure shape as a missing
    // dependency here: screencapture still exits 0 and writes a file, just a degenerate
    // one — reuse flutter_info's probe floor rather than reporting captured:true on a
    // placeholder image (see the module doc + probeScreenRecording above).
    const stat = fs.statSync(outPath);
    if (stat.size < MACOS_SCREENCAPTURE_DEGENERATE_BYTES) {
      return {
        captured: false,
        reason:
          `screencapture exited 0 and wrote a file, but only ${stat.size} bytes — below the ` +
          `${MACOS_SCREENCAPTURE_DEGENERATE_BYTES}-byte floor for a real capture (the same ` +
          "silent-failure signature flutter_info's Screen Recording probe checks for).",
        hint: "Run flutter_info to confirm Screen Recording is granted to the responsible process.",
      };
    }
    return {
      captured: true,
      savedPath: outPath,
      base64: opts.includeBase64
        ? fs.readFileSync(outPath).toString("base64")
        : undefined,
    };
  }

  // =========== flutter_geometry ==========
  /**
   * The target window's bounds in POINTS — the SAME space `flutter_pointer`
   * (window-relative default) and `flutter_screenshot` (`-R`) address —
   * plus the display's backingScaleFactor (read via a one-line JXA snippet;
   * verified on-device: `osascript -l JavaScript -e
   * 'ObjC.import("Cocoa"); $.NSScreen.mainScreen.backingScaleFactor'` → `2`
   * on a Retina display).
   *
   * UNLIKE Android's model, macOS point-space has no further "logical"
   * reduction beneath it — points already ARE the addressable input space —
   * so `logicalDisplaySize` here equals `displaySize`; `dpr` matters ONLY for
   * interpreting a flutter_screenshot PNG's pixel dimensions (pixels =
   * points × dpr), never for scaling flutter_pointer/flutter_key
   * coordinates. See commandCore's macOS-specific geometry note.
   */
  async geometry(
    _preference?: DeviceTargetPreference
  ): Promise<DeviceGeometryReading | undefined> {
    const { processName, bounds } = await this.resolveTarget();
    const dpr = await this.backingScaleFactor();
    const size = { width: bounds.width, height: bounds.height };
    return {
      device: processName,
      displaySize: size,
      density: { effective: dpr },
      dpr,
      dprSource:
        "NSScreen.mainScreen.backingScaleFactor via JXA (osascript -l JavaScript)",
      logicalDisplaySize: size,
    };
  }

  private async backingScaleFactor(): Promise<number> {
    const result = await runShell(
      "osascript -l JavaScript -e " +
        quote('ObjC.import("Cocoa"); $.NSScreen.mainScreen.backingScaleFactor'),
      { timeoutMs: 10000 }
    );
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  // =========== input ==========
  input(): InputController {
    if (!this.inputController) {
      this.inputController = new MacosInputController(this);
    }
    return this.inputController;
  }
}

/**
 * macOS input controller: `cliclick` for pointer/key/text.
 *
 * Coordinates are WINDOW-RELATIVE by default (translated through the target's
 * LIVE bounds, re-read every call — see {@link MacosAdapter.resolveTarget});
 * `opts.absolute` bypasses translation and sends the raw screen point.
 *
 * pointerMove VERIFIES BY EFFECT: cliclick exiting 0 is not evidence a
 * denied-Accessibility no-op didn't just happen (see the module doc), so
 * after issuing the move this reads the cursor back and throws — loudly,
 * distinguishably from "unsupported" — when it did not land. `key`/`text`/
 * `pointerClick` have no analogous readback of their own (nothing to read
 * after a keystroke or a click), so they borrow the same probe once per
 * session via {@link MacosAdapter.ensureAccessibilityGranted} before their
 * first action, and a successful move marks it verified for the rest of the
 * session. This is the "fail closed, never report a failed dependency as one
 * that returned nothing" standard applied everywhere it's cheaply possible.
 */
class MacosInputController implements InputController {
  readonly platform: Platform = "macos";
  private _mode: InputMode = "pointer";

  constructor(private readonly adapter: MacosAdapter) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(mode: InputMode): void {
    this._mode = mode;
  }

  private requireCliclick(): string {
    const bin = this.adapter.cliclickBinary();
    if (!bin) {
      throw new Error(
        "cliclick was not found, so macOS input cannot be sent. Install it: " +
          "`brew install cliclick`. If it IS installed but not on the server's PATH, set " +
          "FLUTTER_DEVICE_CLICLICK_PATH to its absolute path (e.g. /opt/homebrew/bin/cliclick)."
      );
    }
    return bin;
  }

  async key(name: string): Promise<void> {
    const bin = this.requireCliclick();
    const token = normalizeMacosKey(name);
    await this.adapter.ensureAccessibilityGranted(bin);
    const result = await runShell(buildCliclickKeyCommand(bin, token), {
      timeoutMs: 5000,
    });
    if (!result.success) {
      throw new Error(`cliclick kp:${token} failed: ${tail(result.combined, 10)}`);
    }
  }

  async text(value: string): Promise<void> {
    const bin = this.requireCliclick();
    await this.adapter.ensureAccessibilityGranted(bin);
    const result = await runShell(buildCliclickTextCommand(bin, value), {
      timeoutMs: 10000,
    });
    if (!result.success) {
      throw new Error(`cliclick t: failed: ${tail(result.combined, 10)}`);
    }
  }

  async pointerMove(
    x: number,
    y: number,
    opts?: PointerCoordinateOpts
  ): Promise<void> {
    const bin = this.requireCliclick();
    const abs = await this.toAbsolute(x, y, opts);
    const moveResult = await runShell(buildCliclickMoveCommand(bin, abs.x, abs.y), {
      timeoutMs: 5000,
    });
    if (!moveResult.success) {
      throw new Error(`cliclick move failed: ${tail(moveResult.combined, 10)}`);
    }
    const readback = await runShell(buildCliclickPositionCommand(bin), {
      timeoutMs: 5000,
    });
    const pos = parseCliclickPosition(readback.stdout);
    if (!pos || Math.abs(pos.x - abs.x) > 1 || Math.abs(pos.y - abs.y) > 1) {
      throw new Error(
        `cliclick reported success but the cursor did not move to (${abs.x}, ${abs.y}) — ` +
          `read back ${pos ? `${pos.x},${pos.y}` : "nothing"}. This is the signature of a ` +
          "DENIED Accessibility grant (cliclick exits 0 and silently no-ops) — though a " +
          "stale window position (e.g. the target moved to a display that's since " +
          "disconnected, landing the target point off-screen) can produce the same symptom. " +
          "Run flutter_info to check Accessibility, and flutter_geometry to confirm the " +
          "window is still fully on-screen; grant Accessibility to the process that launched " +
          "this MCP server in System Settings → Privacy & Security → Accessibility if needed."
      );
    }
    this.adapter.markAccessibilityGranted();
  }

  async pointerClick(opts?: PointerClickOpts): Promise<void> {
    const bin = this.requireCliclick();
    await this.adapter.ensureAccessibilityGranted(bin);
    const command = opts?.double
      ? buildCliclickDoubleClickAtCurrentCommand(bin)
      : buildCliclickClickAtCurrentCommand(bin);
    const result = await runShell(command, { timeoutMs: 5000 });
    if (!result.success) {
      throw new Error(`cliclick click failed: ${tail(result.combined, 10)}`);
    }
  }

  async pointerScroll(_dy: number, _opts?: PointerCoordinateOpts): Promise<void> {
    throw new UnsupportedInputError(
      "Free-cursor scroll is unsupported on macOS: cliclick 5.1 has no scroll verb (its " +
        "full command set is rc/m/kd/kp/tc/ku/dm/c/dd/w/p/du/cp/dc/t). Drive scrolling via " +
        "flutter_key (e.g. page-up/page-down/arrow keys reach a focused scroll view) instead."
    );
  }

  private async toAbsolute(
    x: number,
    y: number,
    opts?: PointerCoordinateOpts
  ): Promise<{ x: number; y: number }> {
    if (opts?.absolute) return { x, y };
    const { bounds } = await this.adapter.resolveTarget();
    return windowRelativeToAbsolute(bounds, x, y);
  }
}
