/**
 * Pure `cliclick` command builders + key/position parsing for the macOS input
 * plane and the `flutter_info` TCC probes.
 *
 * cliclick (v5.1, verified on-host) has no scroll-wheel verb — its full command
 * set is `rc/m/kd/kp/tc/ku/dm/c/dd/w/p/du/cp/dc/t` (see {@link CLICLICK_VALID_KP_KEYS}
 * for the `kp:` key list) — so free-cursor scroll is NOT wired here; the input
 * controller throws {@link UnsupportedInputError} for it instead of faking a
 * no-op. Commands are built as pure strings so they are unit-testable without
 * spawning a real process; the adapter/controller shells them via `runShell`.
 */
import { quote } from "./cli.js";

/** Build `<cliclick> p:` — print the current mouse position ("x, y"). */
export function buildCliclickPositionCommand(binary: string): string {
  return `${quote(binary)} p:`;
}

/** Parse cliclick's `p:` output ("123, 456") into a position. */
export function parseCliclickPosition(
  output: string
): { x: number; y: number } | undefined {
  const match = output.trim().match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!match) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

/** Build `<cliclick> m:x,y` — move the cursor to an ABSOLUTE screen position. */
export function buildCliclickMoveCommand(
  binary: string,
  x: number,
  y: number
): string {
  return `${quote(binary)} m:${Math.round(x)},${Math.round(y)}`;
}

/**
 * Build `<cliclick> m:+dx,+dy` (or `-dx,-dy`) — move the cursor by a RELATIVE
 * offset from wherever it currently is. Used by the Accessibility probe (nudge
 * a small, direction-agnostic amount rather than needing to know an absolute
 * target first).
 */
export function buildCliclickRelativeMoveCommand(
  binary: string,
  dx: number,
  dy: number
): string {
  const fmt = (n: number): string => {
    const rounded = Math.round(n);
    return rounded >= 0 ? `+${rounded}` : `${rounded}`;
  };
  return `${quote(binary)} m:${fmt(dx)},${fmt(dy)}`;
}

/**
 * Build `<cliclick> c:.` — click at the CURRENT cursor position ("." is
 * cliclick's own token for "don't move, click here"). The macOS input
 * controller always moves first (a real OS cursor, unlike Android's staged
 * tap-position model), so a click never needs its own coordinates.
 */
export function buildCliclickClickAtCurrentCommand(binary: string): string {
  return `${quote(binary)} c:.`;
}

/**
 * Build `<cliclick> dc:.` — double-click at the CURRENT cursor position. Same
 * "don't move, act here" rationale as {@link buildCliclickClickAtCurrentCommand}.
 */
export function buildCliclickDoubleClickAtCurrentCommand(binary: string): string {
  return `${quote(binary)} dc:.`;
}

/**
 * Build `<cliclick> t:'<text>'` — type text into the frontmost application.
 * `t:` and the text are ONE argv token (per cliclick's own syntax: a space
 * inside the text must be enclosed in shell quotes), so the whole `t:<text>`
 * string is quoted together — not the text alone — otherwise a space would
 * split it into two cliclick commands.
 */
export function buildCliclickTextCommand(binary: string, text: string): string {
  return `${quote(binary)} ${quote(`t:${text}`)}`;
}

/**
 * Short key names mapped to their `cliclick kp:` token, mirroring the Samsung/
 * Android short names the other input controllers accept
 * ({@link ANDROID_KEYCODES}) so a caller can use the same UP/DOWN/ENTER/RETURN
 * vocabulary across platforms.
 */
export const MACOS_KEY_MAP: Readonly<Record<string, string>> = {
  UP: "arrow-up",
  DOWN: "arrow-down",
  LEFT: "arrow-left",
  RIGHT: "arrow-right",
  ENTER: "enter",
  RETURN: "return",
  ESC: "esc",
  ESCAPE: "esc",
  TAB: "tab",
  SPACE: "space",
  HOME: "home",
  END: "end",
  DELETE: "delete",
  BACKSPACE: "delete",
  FORWARD_DELETE: "fwd-delete",
  PAGE_UP: "page-up",
  PAGE_DOWN: "page-down",
};

/**
 * The exhaustive `kp:` key vocabulary cliclick 5.1 accepts (from `cliclick -h`,
 * verified on-host). Used to validate a caller-supplied token PASSED THROUGH
 * as-is (already a valid cliclick name, e.g. "f1" or "volume-up") — anything
 * outside this set is rejected rather than sent, since a broken `kp:` token
 * would silently do nothing (cliclick still exits 0 for an argument-parse
 * issue in some cases, which is exactly the class of silent failure this
 * adapter must not add to).
 */
export const CLICLICK_VALID_KP_KEYS: ReadonlySet<string> = new Set([
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "brightness-down",
  "brightness-up",
  "delete",
  "end",
  "enter",
  "esc",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "f13",
  "f14",
  "f15",
  "f16",
  "fwd-delete",
  "home",
  "keys-light-down",
  "keys-light-toggle",
  "keys-light-up",
  "mute",
  "num-0",
  "num-1",
  "num-2",
  "num-3",
  "num-4",
  "num-5",
  "num-6",
  "num-7",
  "num-8",
  "num-9",
  "num-clear",
  "num-divide",
  "num-enter",
  "num-equals",
  "num-minus",
  "num-multiply",
  "num-plus",
  "page-down",
  "page-up",
  "play-next",
  "play-pause",
  "play-previous",
  "return",
  "space",
  "tab",
  "volume-down",
  "volume-up",
]);

/**
 * Normalize a caller-supplied key name to the token `cliclick kp:` takes.
 *
 * Accepts the short navigation names ({@link MACOS_KEY_MAP}, case-insensitive)
 * and a cliclick-native token passed straight through ({@link
 * CLICLICK_VALID_KP_KEYS}, also case-insensitive). Anything else throws with
 * the accepted forms — a best-effort passthrough of an unknown name would send
 * a broken `kp:` argument that silently does nothing.
 */
export function normalizeMacosKey(name: string): string {
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  if (MACOS_KEY_MAP[upper]) return MACOS_KEY_MAP[upper];
  const lower = trimmed.toLowerCase();
  if (CLICLICK_VALID_KP_KEYS.has(lower)) return lower;
  throw new Error(
    `Unknown macOS key ${JSON.stringify(name)}. Use a short name ` +
      `(${Object.keys(MACOS_KEY_MAP).join("/")}) or a cliclick kp: token ` +
      `(${[...CLICLICK_VALID_KP_KEYS].join("/")}).`
  );
}

/** Build `<cliclick> kp:<token>` for an already-normalized key token. */
export function buildCliclickKeyCommand(binary: string, token: string): string {
  return `${quote(binary)} kp:${token}`;
}
