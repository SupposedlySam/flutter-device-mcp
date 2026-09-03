/**
 * Android input controller — OS-level input injection over `adb shell input`.
 *
 * Implements the platform-neutral {@link InputController} by shelling adb's
 * input command against the resolved device serial: `input keyevent` for
 * remote/navigation keys, `input tap` for the pointer click, `input swipe` for
 * the pointer scroll, and `input text` for typing into the focused field. Works
 * on physical devices and emulators alike (both are adb targets).
 *
 * This is the OS-LEVEL FALLBACK input plane, not the primary in-app driver:
 * adb injects raw system input events, bypassing Flutter's gesture-arena
 * semantics (no widget/element addressing, no synchronization with the frame
 * pipeline). Marionette over the Dart VM service remains the primary way to
 * drive the app's own widgets; this plane covers what Marionette cannot reach —
 * OS UI outside the Flutter view, non-debug builds, and D-pad-style navigation
 * (Android TV).
 *
 * The device serial is NOT held here directly: it is resolved LAZILY via an
 * injected resolver so the controller always targets the currently-connected
 * device (multi-dev/multi-device safe — no baked-in serial).
 *
 * POINTER MODEL: Android has no visible free cursor, so `pointerMove` stages a
 * position (no adb call) and `pointerClick` taps at the staged position.
 * `pointerScroll` swipes vertically, anchored at the staged position or —
 * when none is staged — at the screen center read from `adb shell wm size`.
 */
import { quote, RunOptions, runShell, tail } from "../cli.js";
import {
  CommandResult,
  InputController,
  InputMode,
  Platform,
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

/** Duration of the vertical scroll swipe — long enough to register as a drag. */
export const ANDROID_SWIPE_DURATION_MS = 300;

/** Timeout for a single `adb shell input` send. */
const INPUT_TIMEOUT_MS = 15000;

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

  /** The staged pointer position (device pixels) — see the class doc. */
  private position: { x: number; y: number } | undefined;

  /** Screen size per serial, read once from `wm size` and cached. */
  private readonly screenSizeBySerial = new Map<
    string,
    { width: number; height: number }
  >();

  constructor(
    private readonly resolveSerial: SerialResolver,
    private readonly run: ShellRunner = runShell
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
   * Stage the pointer position. Android has no visible free cursor, so no adb
   * INPUT event is sent here — the staged position anchors the next
   * click/scroll. The resolver still runs (and its result is discarded) so a
   * stale device pin is reported on `move` too, not only on the verbs that
   * happen to need the resolved serial.
   */
  async pointerMove(x: number, y: number): Promise<void> {
    await this.resolveSerial();
    this.position = { x: Math.round(x), y: Math.round(y) };
  }

  /** Tap at the staged position via `input tap`. */
  async pointerClick(): Promise<void> {
    if (!this.position) {
      throw new Error(
        "No pointer position staged — send flutter_pointer action 'move' " +
          "with the target coordinates first (Android taps at the staged " +
          "position), or use flutter_key ENTER to activate the focused " +
          "element (D-pad semantics)."
      );
    }
    const serial = await this.resolveSerial();
    await this.send(
      buildAdbTapCommand(serial, this.position.x, this.position.y)
    );
  }

  /**
   * Scroll by a device-pixel vertical delta via `input swipe` (positive = down,
   * so the finger swipes UP). Anchored at the staged position, else at the
   * screen center from `wm size`. The end point is clamped to the screen.
   */
  async pointerScroll(dy: number): Promise<void> {
    const serial = await this.resolveSerial();
    const size = await this.screenSize(serial);
    const anchor =
      this.position ??
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
    const maxY = size ? size.height - 1 : Number.MAX_SAFE_INTEGER;
    const toY = Math.min(Math.max(0, anchor.y - Math.round(dy)), maxY);
    await this.send(
      buildAdbSwipeCommand(serial, anchor.x, anchor.y, anchor.x, toY)
    );
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
