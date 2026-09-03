/**
 * Shared, platform-neutral types used across the frontend MCP.
 *
 * These describe the shapes exchanged between the neutral server, the platform
 * adapters, and the neutral shell/launch cores. Nothing here is Tizen- or
 * webOS-specific; per-platform behavior lives behind the {@link PlatformAdapter}
 * seam in `adapters/`.
 */

// =========== PLATFORM ==========
/**
 * The frontend platforms this MCP can drive.
 *
 * Appliances: `tizen` (Samsung Smart Monitor/TV, fully implemented) and `webos`
 * (LG TV, Stage-1 stub). TV (Apple family): `tvos` (Apple TV via `flutter-tvos` +
 * xcrun devicectl/simctl). Mobile: `ios` (iPhone/iPad via xcrun devicectl/simctl
 * + flutter) and `android` (adb + flutter). Desktop: `macos` (a prebuilt, signed
 * `.app` driven via cliclick/screencapture/osascript — this MCP does not build
 * it). The set is a SUPERSET — each new target is added alongside the existing
 * platforms, not in place of them.
 */
export type Platform = "tizen" | "webos" | "ios" | "android" | "tvos" | "macos";

// =========== SHELL RESULT ==========
export interface CommandResult {
  /** Process exit code, or null when the process was signalled. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved by arrival, for signature scanning. */
  combined: string;
  /** True when the process exited 0. */
  success: boolean;
  /** True when the command was killed by the timeout. */
  timedOut: boolean;
}

// =========== BUILD ==========
/**
 * The three Flutter compilation modes, as a platform-neutral type.
 *
 * The distinction that matters for driving an app is NOT speed, it is whether
 * the Dart VM service is open:
 *   - `debug`   — JIT, VM service OPEN. The classic Marionette path.
 *   - `profile` — AOT, so timing is REALISTIC, and the VM service is still
 *                 OPEN. This is the mode for measuring anything: a debug build's
 *                 JIT slowdown makes its numbers meaningless, and a release
 *                 build cannot be connected to at all.
 *   - `release` — AOT, NO VM service. Not drivable, not measurable.
 *
 * Every platform here compiles with these same three modes, so the type is
 * neutral even though the CLI flag that carries it differs per adapter.
 */
export type BuildMode = "release" | "profile" | "debug";

/**
 * Resolve the effective {@link BuildMode} from the 3-way `mode` option and the
 * legacy 2-way `debug` boolean.
 *
 * An explicit `mode` always wins — it is strictly more expressive, and a caller
 * that names a mode means it. Otherwise `debug` maps to its historical meaning
 * (`true` → debug, absent/false → release), so every pre-`mode` caller keeps the
 * behavior it had.
 */
export function resolveBuildMode(opts: {
  mode?: BuildMode;
  debug?: boolean;
}): BuildMode {
  if (opts.mode) return opts.mode;
  return opts.debug ? "debug" : "release";
}

/** Options for a build (mirrors the `flutter-tizen build` flags). */
export interface BuildOptions {
  profile?: string;
  /**
   * The 3-way build mode. Wins over the legacy `debug` boolean — see
   * {@link resolveBuildMode}. Prefer this: `debug` cannot express `profile`,
   * the only mode that is both realistically-timed AND drivable.
   */
  mode?: BuildMode;
  debug?: boolean;
  /**
   * `--dart-define` compile-time constants to pass to the build (e.g. pointing
   * the app at a local backend). See {@link ../dartDefine}.
   */
  dartDefine?: Record<string, string>;
  skip_rust?: boolean;
  skip_flutter?: boolean;
  install?: boolean;
  run?: boolean;
}

/** The outcome of a build: the raw command result plus parsed signals. */
export interface BuildResult {
  result: CommandResult;
  /** Path to the built package artifact (TPK / IPK), when detected. */
  artifactPath?: string;
  /** True when the output contained a "No space left on device" signature. */
  enospc: boolean;
  /** True when the output contained an "Install failed" signature. */
  installFailed: boolean;
  /** True when this build also launched (seizes the physical display). */
  launchedDisplay: boolean;
  /**
   * False when this platform has no build path in this MCP (macOS: bring your
   * own signed `.app` and point flutter_deploy at it — there is no toolchain
   * here to build/sign one). Present only when unsupported, mirroring
   * {@link ScreenshotResult}/{@link RecordResult}'s `supported?: false`.
   */
  supported?: false;
}

// =========== DEVICE DISCOVERY ==========
/** The chosen device target plus how it was chosen. */
export interface DeviceResolution {
  target: string;
  /**
   * `pin` — the explicit device pin (env var), confirmed online.
   * `discovered` — the first online device from platform device discovery.
   * `discovered-offline` — a listed-but-offline device (best effort, no pin set).
   * `stale-pin` — the pin was kept despite not being seen online (no online
   * device existed to fall back to).
   *
   * These names are platform-neutral by design; how a platform discovers
   * devices (sdb, ssap, etc.) is an adapter detail and is not leaked here.
   */
  source: "pin" | "discovered" | "discovered-offline" | "stale-pin";
  /**
   * The bare network host (no port) the resolved device is reachable at, when
   * the target name is NOT itself dial-able. On a name-addressed platform
   * (webOS/ares), this carries the parsed connection host so the input plane can
   * dial it directly. Undefined when the target is itself the host (Tizen sdb).
   */
  host?: string;
  /** Human-readable note when the pin was stale, for surfacing to callers. */
  warning?: string;
}

// =========== LAUNCH / URI CAPTURE ==========
export interface LaunchResult {
  vmServiceUriWs: string;
  vmServiceUriHttp: string;
  logPath: string;
  pid: number | undefined;
  /**
   * Path to the control FIFO wired to the launched flutter runner's stdin, when
   * a control channel was allocated for this launch. Appending `r\n`/`R\n` to it
   * drives a real hot reload/restart on the running daemon (see ptyControl). A
   * launch spawned without a control channel (allocation failed, or the platform
   * opted out) leaves this undefined and reload/restart fall back to the
   * VM-service path.
   */
  controlFifoPath?: string;
}

export interface LaunchFailure {
  failed: true;
  reason: string;
  logPath: string;
  pid: number | undefined;
  logTail: string;
}

export type LaunchOutcome = LaunchResult | LaunchFailure;

export function isLaunchFailure(outcome: LaunchOutcome): outcome is LaunchFailure {
  return (outcome as LaunchFailure).failed === true;
}

// =========== INPUT (Stage 2) ==========
/** The two physical-input driving modes an appliance exposes. */
export type InputMode = "dpad" | "pointer";

/**
 * Controller for driving physical input on an appliance.
 *
 * Platform-neutral by design: Tizen drives it over the Samsung remote channel
 * today, and webOS will implement the same surface over ssap in a future stage.
 * `key` accepts a navigation/remote key; the pointer methods position and click
 * a virtual cursor in DEVICE pixels (callers convert logical → device first).
 *
 * `mode` is session-sticky state the controller tracks so callers can reason
 * about which input plane is active; the send methods themselves are always
 * available regardless of mode.
 */
export interface InputController {
  readonly platform: Platform;
  /** The currently-selected input mode (session-sticky). */
  readonly mode: InputMode;
  /** Select the active input mode. */
  setMode(mode: InputMode): void;
  /** Send a navigation/remote key (short name UP/DOWN/… or full KEY_ name). */
  key(name: string): Promise<void>;
  /**
   * Move the virtual pointer to a DEVICE-pixel position. May throw
   * {@link UnsupportedInputError} on focus-based platforms (e.g. Tizen) that
   * have no free cursor — use {@link key} for navigation there instead.
   *
   * `opts.absolute` is an ESCAPE HATCH a controller may honor: when true, `x`/`y`
   * are ABSOLUTE screen coordinates rather than the platform's own default space
   * (macOS defaults to WINDOW-RELATIVE points, translated via the target
   * window's live bounds, precisely so a script survives the window moving).
   * Controllers with no such distinction ignore it.
   */
  pointerMove(x: number, y: number, opts?: PointerCoordinateOpts): Promise<void>;
  /**
   * Click at the current pointer position (activates the focused element).
   * `opts.double` is an escape hatch a controller may honor (macOS: `cliclick
   * dc:` instead of `c:`); controllers with no double-click concept ignore it.
   */
  pointerClick(opts?: PointerClickOpts): Promise<void>;
  /**
   * Scroll by a DEVICE-pixel vertical delta (positive = down). May throw
   * {@link UnsupportedInputError} on focus-based platforms (e.g. Tizen) that
   * have no free cursor — use {@link key} for navigation there instead.
   */
  pointerScroll(dy: number, opts?: PointerCoordinateOpts): Promise<void>;
  /**
   * Type a text string into the currently-focused field. OPTIONAL — implemented
   * where the platform has an OS-level text-injection channel (Android:
   * `adb shell input text`); absence means text input is not wired on the
   * platform and is surfaced as `{ supported: false }`.
   */
  text?(value: string): Promise<void>;
  /**
   * The DEVICE-pixel position a positional {@link pointerClick} /
   * {@link pointerScroll} would use right now. OPTIONAL — implemented where a
   * click IS positional (Android, whose click is a tap at a staged position), so
   * the tool response can report WHERE it tapped instead of a bare `sent: true`.
   * Absent on platforms whose click activates the focused element (Tizen) or
   * clicks wherever the real OS cursor happens to be (macOS), where there is no
   * such position to report. Advisory: callers must treat a throw as "unknown".
   */
  pointerPosition?(): Promise<
    { x: number; y: number; stagedAt?: string } | undefined
  >;
}

/**
 * Escape hatch for a controller whose default coordinate space is not plain
 * absolute screen pixels (today: macOS, whose default is WINDOW-RELATIVE).
 * Ignored by controllers with no such distinction.
 */
export interface PointerCoordinateOpts {
  /** When true, coordinates are ABSOLUTE screen points/pixels. */
  absolute?: boolean;
}

/** Escape hatch for a controller with a double-click concept (macOS). */
export interface PointerClickOpts {
  /** When true, perform a double-click instead of a single click. */
  double?: boolean;
}

// =========== ERRORS ==========
/** Thrown by stubbed adapter/input capabilities not yet implemented. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/**
 * Thrown when an input capability exists in the neutral interface but is not an
 * effective input path on the current platform (non-functional-by-design, not a
 * bug). Live device testing established that free-cursor pointer move/scroll has
 * no effect on the focus/D-pad-driven Tizen appliance; those methods throw this.
 */
export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}
