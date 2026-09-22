/**
 * Android input controller — OS-level input injection over `adb shell input`.
 *
 * Implements the platform-neutral {@link InputController} by shelling adb's
 * input command against the resolved device serial: `input keyevent` for
 * remote/navigation keys, `input tap` for the pointer click, `input swipe` for
 * the pointer scroll, and `input text` for typing into the focused field. Works
 * on physical devices and emulators alike (both are adb targets).
 *
 * This is the OS-LEVEL input plane, and on Android it is the one to reach for
 * FIRST for navigation and position-based input — it is a single adb call with
 * no VM-service round trip, and its coordinates are device pixels, the same
 * space `flutter_screenshot` returns. A driver over the Dart VM service (e.g.
 * Marionette) is the fallback here, for what this plane genuinely cannot
 * serve: adb injects raw system input events, bypassing Flutter's
 * gesture-arena semantics (no widget/element addressing, no synchronization
 * with the frame pipeline), so a VM-service driver is the way to address the
 * app's own widgets by key or text. This plane, in turn, covers what a
 * VM-service driver cannot reach — OS UI outside the Flutter view, non-debug
 * builds, and D-pad-style navigation (Android TV).
 *
 * The device serial is NOT held here directly: it is resolved LAZILY via an
 * injected resolver so the controller always targets the currently-connected
 * device (multi-dev/multi-device safe — no baked-in serial).
 *
 * POINTER MODEL: Android has no visible free cursor, so `pointerMove` stages a
 * position (no adb call) and `pointerClick` taps at the staged position.
 * `pointerScroll` swipes vertically, anchored at the staged position or —
 * when none is staged — at the screen center read from `adb shell wm size`.
 *
 * A swipe has two independent variables, distance and duration, and only the
 * first used to be reachable from a caller — which made the second, speed, an
 * uncontrolled consequence of the first. It also made an ineffective scroll
 * silent: the request is bounded by the screen, so asking for more than fits
 * quietly buys less travel than asked for, and the drag landing is not the same
 * as the app acting on it. Both are now reported (see {@link planAndroidScroll})
 * and the duration is an argument.
 *
 * The stage is DURABLE and keyed by device (see pointerStage.ts), NOT a field on
 * this object. Holding it in memory made the move→click pair work only while one
 * server process happened to live across both calls; a restart or a host reload
 * dropped it, and the click then failed with "No pointer position staged" one
 * call after the caller had staged one. Reading it back from disk makes the
 * precondition the error names actually satisfiable, and keying it by the
 * RESOLVED serial keeps a position staged for one device from being tapped on
 * another.
 */
import { quote, RunOptions, runShell, tail } from "../cli.js";
import {
  filePointerStage,
  PointerStage,
  stageKey,
  StagedPointerPosition,
} from "./pointerStage.js";
import {
  CommandResult,
  InputController,
  InputMode,
  Platform,
  PointerScrollOpts,
  PointerScrollOutcome,
  PointerScrollVerification,
} from "../types.js";

/**
 * Short key names mapped to Android keycodes (`adb shell input keyevent`).
 *
 * The navigation names mirror the Samsung short names the Tizen controller
 * accepts, mapped to their Android equivalents: the arrows are the DPAD codes,
 * ENTER/OK/SELECT are KEYCODE_DPAD_CENTER (23 — activates the focused element,
 * the D-pad semantics of Samsung's KEY_ENTER; pass KEYCODE_ENTER for the
 * text-field newline key, 66), RETURN/BACK are KEYCODE_BACK (4), and HOME is
 * KEYCODE_HOME (3).
 */
export const ANDROID_KEYCODES: Readonly<Record<string, number>> = {
  UP: 19, // KEYCODE_DPAD_UP
  DOWN: 20, // KEYCODE_DPAD_DOWN
  LEFT: 21, // KEYCODE_DPAD_LEFT
  RIGHT: 22, // KEYCODE_DPAD_RIGHT
  ENTER: 23, // KEYCODE_DPAD_CENTER
  OK: 23, // KEYCODE_DPAD_CENTER
  SELECT: 23, // KEYCODE_DPAD_CENTER
  RETURN: 4, // KEYCODE_BACK
  BACK: 4, // KEYCODE_BACK
  HOME: 3, // KEYCODE_HOME
};

/**
 * Default duration of the vertical scroll swipe.
 *
 * Inherited from this controller's first version, where it was asserted rather
 * than measured, and kept as the default only because changing it is not free:
 * a slower drag carries less velocity into the app, so a surface that relies on
 * fling momentum travels FURTHER than the finger at this speed and less at a
 * slower one. Raising the default to rescue one surface would quietly shorten
 * every scroll that works today, so the duration is a per-call argument instead
 * (`duration_ms`) and this stays put until a measurement says otherwise.
 */
export const ANDROID_SWIPE_DURATION_MS = 300;

/**
 * Ceiling on a caller-supplied swipe duration.
 *
 * `input swipe` blocks for the whole gesture, so the duration is bounded by the
 * send timeout below — a longer one would be killed mid-drag and reported as a
 * failed send rather than as the too-long argument it is.
 */
export const ANDROID_SWIPE_MAX_DURATION_MS = 10000;

/** Timeout for a single `adb shell input` send. */
const INPUT_TIMEOUT_MS = 15000;

/**
 * How long to let the screen settle before the post-scroll verification hash.
 *
 * `input swipe` returns once the gesture has been INJECTED, which is earlier
 * than the app has drawn its response to it. Long enough for several frames to
 * land; deliberately not long enough to wait out fling momentum, because the
 * question being answered is "did anything move at all", not "where did it stop".
 */
export const ANDROID_SCROLL_SETTLE_MS = 250;

/**
 * Normalize a caller-supplied key name to the token `input keyevent` takes.
 *
 * Accepts the short navigation names ({@link ANDROID_KEYCODES},
 * case-insensitive), full `KEYCODE_*` symbolic names (passed through — adb
 * resolves them itself), and bare numeric keycodes. Anything else throws with
 * the accepted forms — a best-effort passthrough of an unknown name would send
 * a broken keyevent that silently does nothing.
 */
export function normalizeAndroidKey(name: string): string {
  const trimmed = name.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^KEYCODE_[A-Z0-9_]+$/i.test(trimmed)) return trimmed.toUpperCase();
  const mapped = ANDROID_KEYCODES[trimmed.toUpperCase()];
  if (mapped !== undefined) return String(mapped);
  throw new Error(
    `Unknown Android key ${JSON.stringify(name)}. Use a short name ` +
      `(${Object.keys(ANDROID_KEYCODES).join("/")}), a full KEYCODE_* name ` +
      `(e.g. KEYCODE_MEDIA_PLAY_PAUSE), or a numeric keycode.`
  );
}

/**
 * Escape a string for `adb shell input text`.
 *
 * Two layers stack on the way to the device: `input text` itself encodes a
 * space as `%s`, and the DEVICE shell evaluates the argument (adb re-joins its
 * args into one shell string), so its metacharacters must be backslash-escaped.
 * The result is then host-quoted by the command builder — the host shell strips
 * that quoting, leaving exactly the device-side form. Control characters
 * (newlines/tabs) have no `input text` encoding and are rejected.
 */
export function escapeAdbText(text: string): string {
  if (/[\r\n\t\0]/.test(text)) {
    throw new Error(
      "input text cannot carry newlines/tabs/control characters. Send them as " +
        "separate key events (e.g. KEYCODE_ENTER, KEYCODE_TAB) instead."
    );
  }
  return text
    .replace(/[\\'"`$&|;<>()*?~#![\]{}^]/g, (ch) => `\\${ch}`)
    .replace(/ /g, "%s");
}

/** Build `adb -s <serial> shell input <args>` with a host-quoted serial. */
export function buildAdbInputCommand(serial: string, args: string): string {
  return `adb -s ${quote(serial)} shell input ${args}`;
}

/** Build the `input keyevent` send for an already-normalized key token. */
export function buildAdbKeyeventCommand(
  serial: string,
  keyToken: string
): string {
  return buildAdbInputCommand(serial, `keyevent ${keyToken}`);
}

/** Build the `input tap` send at a device-pixel position. */
export function buildAdbTapCommand(
  serial: string,
  x: number,
  y: number
): string {
  return buildAdbInputCommand(serial, `tap ${Math.round(x)} ${Math.round(y)}`);
}

/** Build the `input swipe` send between two device-pixel positions. */
export function buildAdbSwipeCommand(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number = ANDROID_SWIPE_DURATION_MS
): string {
  return buildAdbInputCommand(
    serial,
    `swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ` +
      `${Math.round(y2)} ${Math.round(durationMs)}`
  );
}

/** Build the `input text` send, escaped for the device shell + host-quoted. */
export function buildAdbTextCommand(serial: string, text: string): string {
  return buildAdbInputCommand(serial, `text ${quote(escapeAdbText(text))}`);
}

/**
 * Build the ON-DEVICE screen fingerprint used to tell a no-op scroll from a
 * real one: `screencap | md5sum`, both sides of the pipe running on the device.
 *
 * The raw framebuffer is hashed rather than `screencap -p`, for two reasons:
 * raw bytes are a deterministic function of what is on screen (a PNG re-encode
 * is an extra chance for two identical screens to hash differently, which would
 * read as "it scrolled"), and nothing pays to compress ~17MB that is discarded.
 *
 * `shell` is correct here even though the screenshot path insists on `exec-out`:
 * that rule is about the shell protocol's CRLF translation corrupting binary on
 * the WIRE, and here the framebuffer never leaves the device — only the hex
 * digest crosses, which is text.
 */
export function buildAdbScreenHashCommand(serial: string): string {
  return `adb -s ${quote(serial)} shell ${quote("screencap | md5sum")}`;
}

/** Pull the digest out of `md5sum` output (`<hex>  -`), if it produced one. */
export function parseScreenHash(output: string): string | undefined {
  return output.match(/\b([0-9a-f]{32})\b/i)?.[1].toLowerCase();
}

/**
 * Normalize a caller-supplied swipe duration, falling back to the default.
 *
 * Tolerant rather than throwing: an out-of-range value from a caller is rejected
 * up at the tool boundary (before any device round-trip), so anything reaching
 * here is either absent or already checked, and refusing to scroll over a stray
 * NaN would be worse than scrolling at the default.
 */
export function resolveSwipeDurationMs(durationMs?: number): number {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return ANDROID_SWIPE_DURATION_MS;
  }
  return Math.min(
    Math.max(1, Math.round(durationMs)),
    ANDROID_SWIPE_MAX_DURATION_MS
  );
}

/** The gesture a scroll request resolves to, before anything is sent. */
export interface AndroidScrollPlan {
  from: { x: number; y: number };
  to: { x: number; y: number };
  requestedDy: number;
  appliedDy: number;
  clamped: boolean;
  durationMs: number;
  speedPxPerMs: number;
  notes: string[];
}

/**
 * Work out the swipe a scroll request becomes — pure, so the relationship
 * between the request and the gesture is inspectable without a device.
 *
 * The relationship is not the obvious one, and getting it wrong costs hours.
 * Travel is bounded by the distance between the anchor and the screen edge,
 * while duration is fixed, so past the point where the request is clamped a
 * LARGER `dy` does not scroll further — it covers the same distance in the same
 * time, which is to say the identical gesture. The intuition it violates is that
 * "it didn't scroll, ask for more" is a fix; it produces a byte-identical
 * command. Only `durationMs` and the anchor can change what is sent.
 */
export function planAndroidScroll(args: {
  anchor: { x: number; y: number };
  dy: number;
  screenHeight?: number;
  durationMs: number;
}): AndroidScrollPlan {
  const { anchor, durationMs } = args;
  const requestedDy = Math.round(args.dy);
  const maxY =
    args.screenHeight !== undefined
      ? args.screenHeight - 1
      : Number.MAX_SAFE_INTEGER;
  const toY = Math.min(Math.max(0, anchor.y - requestedDy), maxY);
  const appliedDy = anchor.y - toY;
  const clamped = appliedDy !== requestedDy;
  const speedPxPerMs = Math.abs(appliedDy) / durationMs;

  const notes: string[] = [];
  if (clamped) {
    const edge = requestedDy > 0 ? "top" : "bottom";
    notes.push(
      `Requested dy ${requestedDy} but the drag was bounded to ${appliedDy}px: ` +
        `it starts at y=${anchor.y} and the ${edge} of the screen is ${Math.abs(
          appliedDy
        )}px away. Raising dy CANNOT scroll further — travel is already at the ` +
        `edge while the duration is fixed, so a larger dy emits the identical ` +
        `command. To scroll further, call scroll again; to scroll SLOWER (a drag ` +
        `rather than a flick, which some surfaces treat very differently), pass ` +
        `duration_ms; to lengthen one gesture, stage a lower anchor with action ` +
        `'move' first.`
    );
  }
  if (appliedDy === 0) {
    notes.push(
      `The swipe starts and ends at y=${anchor.y}, so no gesture travel was ` +
        `sent at all. Check the anchor and the sign of dy (positive = scroll ` +
        `down, which drags the finger UP).`
    );
  }

  return {
    from: { x: anchor.x, y: anchor.y },
    to: { x: anchor.x, y: toY },
    requestedDy,
    appliedDy,
    clamped,
    durationMs,
    speedPxPerMs: Number(speedPxPerMs.toFixed(3)),
    notes,
  };
}

/**
 * Parse `adb shell wm size` output into the device-pixel screen size.
 *
 * Prefers the "Override size" line (present when a size override is active —
 * it is the size input coordinates actually address) over "Physical size".
 * Returns undefined when neither is present.
 */
export function parseWmSize(
  output: string
): { width: number; height: number } | undefined {
  const override = output.match(/Override size:\s*(\d+)x(\d+)/i);
  const physical = output.match(/Physical size:\s*(\d+)x(\d+)/i);
  const match = override ?? physical;
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Resolves the current device serial on demand. */
export type SerialResolver = () => Promise<string>;

/** The shell runner to send commands through. Injected for testability. */
export type ShellRunner = (
  command: string,
  options?: RunOptions
) => Promise<CommandResult>;

export class AndroidInputController implements InputController {
  readonly platform: Platform = "android";
  private _mode: InputMode = "dpad";

  /** Screen size per serial, read once from `wm size` and cached. */
  private readonly screenSizeBySerial = new Map<
    string,
    { width: number; height: number }
  >();

  constructor(
    private readonly resolveSerial: SerialResolver,
    private readonly run: ShellRunner = runShell,
    /**
     * Where the staged pointer position lives. Defaults to the per-developer
     * on-disk stage so it survives this process; injected in tests (and usable
     * as an in-memory fallback) via {@link PointerStage}.
     */
    private readonly stage: PointerStage = filePointerStage(),
    /** Settle wait between the two verification hashes. Injected in tests. */
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(mode: InputMode): void {
    this._mode = mode;
  }

  async key(name: string): Promise<void> {
    const token = normalizeAndroidKey(name);
    const serial = await this.resolveSerial();
    await this.send(buildAdbKeyeventCommand(serial, token));
  }

  /**
   * Stage the pointer position for the RESOLVED device. Android has no visible
   * free cursor, so no adb INPUT event is sent here — the staged position
   * anchors the next click/scroll. The serial is resolved (not discarded) both
   * to report a stale device pin on `move` too and because it is the stage key:
   * a position staged for one device is never tapped on another.
   */
  async pointerMove(x: number, y: number): Promise<void> {
    const serial = await this.resolveSerial();
    this.stage.save(
      stageKey(this.platform, serial),
      Math.round(x),
      Math.round(y)
    );
  }

  /**
   * The position a `pointerClick`/`pointerScroll` would use right now, for the
   * currently-resolved device — so a caller can be TOLD where a tap landed
   * instead of inferring it from a bare `sent: true`.
   */
  async pointerPosition(): Promise<StagedPointerPosition | undefined> {
    return this.stage.load(stageKey(this.platform, await this.resolveSerial()));
  }

  /** Tap at the staged position via `input tap`. */
  async pointerClick(): Promise<void> {
    const serial = await this.resolveSerial();
    const position = this.stage.load(stageKey(this.platform, serial));
    if (!position) {
      throw new Error(
        `No pointer position staged for ${serial} — pass x/y directly on this ` +
          "flutter_pointer 'click' call to tap in ONE call (preferred), send " +
          "action 'move' with the target coordinates first (the staged position " +
          "persists across calls and server restarts, per device), or use " +
          "flutter_key ENTER to activate the focused element (D-pad semantics)."
      );
    }
    await this.send(buildAdbTapCommand(serial, position.x, position.y));
  }

  /**
   * Scroll by a device-pixel vertical delta via `input swipe` (positive = down,
   * so the finger swipes UP). Anchored at the staged position, else at the
   * screen center from `wm size`. The end point is bounded by the screen.
   *
   * Returns the gesture it actually sent rather than nothing. A scroll has two
   * ways to succeed at doing nothing — the request gets bounded down to a
   * shorter drag than asked for, or the drag lands but the app ignores it — and
   * a bare resolve made both indistinguishable from a scroll that worked. The
   * plan is reported always; `opts.verify` additionally checks the screen.
   */
  async pointerScroll(
    dy: number,
    opts?: PointerScrollOpts
  ): Promise<PointerScrollOutcome> {
    const serial = await this.resolveSerial();
    const size = await this.screenSize(serial);
    const anchor =
      this.stage.load(stageKey(this.platform, serial)) ??
      (size
        ? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
        : undefined);
    if (!anchor) {
      throw new Error(
        "Could not resolve a scroll anchor: no pointer position is staged and " +
          "`adb shell wm size` did not report a screen size. Send " +
          "flutter_pointer action 'move' first to stage the anchor."
      );
    }
    const plan = planAndroidScroll({
      anchor,
      dy,
      screenHeight: size?.height,
      durationMs: resolveSwipeDurationMs(opts?.durationMs),
    });

    const before = opts?.verify ? await this.screenHash(serial) : undefined;
    await this.send(
      buildAdbSwipeCommand(
        serial,
        plan.from.x,
        plan.from.y,
        plan.to.x,
        plan.to.y,
        plan.durationMs
      )
    );

    const { notes, ...gesture } = plan;
    return {
      ...gesture,
      ...(opts?.verify ? await this.verifyScrolled(serial, before) : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  /**
   * Compare the screen before and after the gesture.
   *
   * Reports three states, never a boolean, because they carry very different
   * weight: `unchanged` is strong evidence the gesture did nothing, `changed`
   * only says SOME pixel differs (a clock or an animation elsewhere counts), and
   * a hash that could not be taken is neither — reporting an unusable check as
   * "unchanged" would invent a failure, and as "changed" would hide one.
   */
  private async verifyScrolled(
    serial: string,
    before: string | undefined
  ): Promise<{
    verification: PointerScrollVerification;
    verificationDetail: string;
  }> {
    if (!before) {
      return {
        verification: "unavailable",
        verificationDetail:
          "Could not fingerprint the screen before the gesture " +
          "(`screencap | md5sum` produced no digest — some devices lack " +
          "md5sum, and a secure surface refuses capture). The gesture was " +
          "still sent; its effect is unverified.",
      };
    }
    await this.delay(ANDROID_SCROLL_SETTLE_MS);
    const after = await this.screenHash(serial);
    if (!after) {
      return {
        verification: "unavailable",
        verificationDetail:
          "The screen was fingerprinted before the gesture but not after, so " +
          "the two cannot be compared. The gesture was still sent.",
      };
    }
    if (after === before) {
      return {
        verification: "unchanged",
        verificationDetail:
          `The screen was byte-identical ${ANDROID_SCROLL_SETTLE_MS}ms after ` +
          "the swipe, so nothing on it moved — the gesture reached the device " +
          "but the app did not act on it. The input plane is working; look at " +
          "what is under the anchor and at the gesture's speed (pass a longer " +
          "duration_ms to send a slow drag instead of a flick) before " +
          "suspecting the app or the Dart VM service.",
      };
    }
    return {
      verification: "changed",
      verificationDetail:
        "The screen differs after the swipe. This is weaker evidence than it " +
        "looks: it means some pixel changed, not necessarily that the intended " +
        "surface scrolled — a clock, animation or video would also register.",
    };
  }

  /** Fingerprint the current screen on-device; undefined when it cannot run. */
  private async screenHash(serial: string): Promise<string | undefined> {
    const result = await this.run(buildAdbScreenHashCommand(serial), {
      timeoutMs: INPUT_TIMEOUT_MS,
    });
    return result.success ? parseScreenHash(result.combined) : undefined;
  }

  /** Type into the focused field via `input text` (escaped — see helpers). */
  async text(value: string): Promise<void> {
    const serial = await this.resolveSerial();
    await this.send(buildAdbTextCommand(serial, value));
  }

  /** Read (and cache) the device's screen size in device pixels. */
  private async screenSize(
    serial: string
  ): Promise<{ width: number; height: number } | undefined> {
    const cached = this.screenSizeBySerial.get(serial);
    if (cached) return cached;
    const result = await this.run(`adb -s ${quote(serial)} shell wm size`, {
      timeoutMs: INPUT_TIMEOUT_MS,
    });
    const size = parseWmSize(result.combined);
    if (size) this.screenSizeBySerial.set(serial, size);
    return size;
  }

  /** Send one adb input command, surfacing a failed send as an error. */
  private async send(command: string): Promise<void> {
    const result = await this.run(command, { timeoutMs: INPUT_TIMEOUT_MS });
    if (!result.success) {
      throw new Error(
        `adb input send failed (is the device online/authorized?): ` +
          `${tail(result.combined, 10)}`
      );
    }
  }
}
