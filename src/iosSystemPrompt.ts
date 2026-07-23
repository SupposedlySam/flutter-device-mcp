/**
 * Detection and button-selection for iOS SYSTEM-LEVEL UI prompts — the alerts,
 * permission sheets, and "Open in <app>?" confirmations that live OUTSIDE the
 * Flutter app's view tree.
 *
 * WHY THIS EXISTS: Marionette drives the app over the Dart VM service, so it can
 * only see and tap widgets INSIDE the Flutter view. A SpringBoard alert (e.g.
 * Safari's "Open in <app>?" after `simctl openurl https://…`, or a notifications
 * permission dialog) is rendered by the OS, never reaches the Dart isolate, and
 * so is invisible+untappable to Marionette. A human tap was the only unblock —
 * which defeats autonomous on-device testing. This module + its adapter method
 * close that gap.
 *
 * MECHANISM (see the adapter): we read the accessibility tree with
 * `idb ui describe-all` (idb_companion surfaces the SpringBoard alert's elements
 * with labels + frames as JSON) and tap a chosen button with `idb ui tap <x> <y>`
 * at the element's frame center. idb is preferred over pixel-tapping because it
 * is DATA-driven (match a button by its label, not a guessed coordinate) and
 * needs no macOS Accessibility (TCC) grant — unlike AppleScript UI-scripting of
 * Simulator.app, which requires an un-grantable-headlessly assistive-access
 * permission and depends on the fragile Simulator window AX layout.
 *
 * SIMULATOR-ONLY (verified live): idb's `ui` commands require the
 * FBSimulatorLifecycle protocol, so they work on a SIMULATOR only — a physical
 * device returns "Target doesn't conform to FBSimulatorLifecycleCommands
 * protocol". The adapter resolves a booted simulator for this reason.
 *
 * This module is PURE parsing/selection over the JSON the adapter captures — it
 * never spawns anything, so the matching rules are unit-testable in isolation.
 */

/** A single element parsed from `idb ui describe-all`. */
export interface AxElement {
  /** The accessibility label (the visible text of a button/alert), if any. */
  label?: string;
  /** The accessibility value, if any (some controls carry text here). */
  value?: string;
  /** The accessibility type/role, e.g. "Button", "StaticText", "Alert". */
  type?: string;
  /** Element frame in device points: {x, y, width, height}. */
  frame?: { x: number; y: number; width: number; height: number };
}

/** A tappable button surfaced on a detected system prompt. */
export interface PromptButton {
  /** The button's visible label (from AXLabel), e.g. "Open", "Allow". */
  label: string;
  /** The frame-center point (device points) to tap to activate it. */
  center: { x: number; y: number };
}

/** The result of scanning the accessibility tree for a system prompt. */
export interface DetectedPrompt {
  /** True when the tree contains an alert/prompt element. */
  present: boolean;
  /** The alert's title/message text lines, best-effort (for the caller's log). */
  messages: string[];
  /** The tappable buttons on the prompt, in tree order. */
  buttons: PromptButton[];
}

/**
 * The `idb ui describe-all` payload is a JSON array of element objects. idb has
 * emitted the label under a few key spellings across versions (`AXLabel`,
 * `label`) and likewise for type/frame — so we read defensively and accept any
 * of them. A shape we don't recognize degrades to "no elements" (a safe
 * "no prompt detected"), never a throw.
 */
interface RawAxElement {
  AXLabel?: unknown;
  label?: unknown;
  AXValue?: unknown;
  value?: unknown;
  AXType?: unknown;
  type?: unknown;
  role?: unknown;
  AXFrame?: unknown;
  frame?: unknown;
  [key: string]: unknown;
}

/** Coerce a value to a trimmed string, or undefined when not a usable string. */
function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse an idb frame, which idb has emitted either as an object
 * ({x,y,width,height}) or as a "{{x, y}, {w, h}}" CGRect-style string. Returns
 * undefined when neither shape is present/valid (the element is then treated as
 * un-tappable — it contributes to detection but not to a tap target).
 */
export function parseFrame(
  raw: unknown
): { x: number; y: number; width: number; height: number } | undefined {
  if (raw && typeof raw === "object") {
    const f = raw as Record<string, unknown>;
    const x = Number(f.x);
    const y = Number(f.y);
    const width = Number(f.width);
    const height = Number(f.height);
    if ([x, y, width, height].every((n) => Number.isFinite(n))) {
      return { x, y, width, height };
    }
    return undefined;
  }
  if (typeof raw === "string") {
    // CGRect string form: "{{x, y}, {w, h}}".
    const nums = raw.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 4) {
      const [x, y, width, height] = nums.slice(0, 4).map(Number);
      if ([x, y, width, height].every((n) => Number.isFinite(n))) {
        return { x, y, width, height };
      }
    }
  }
  return undefined;
}

/** Normalize one raw idb element into an {@link AxElement}. */
export function normalizeElement(raw: RawAxElement): AxElement {
  return {
    label: asString(raw.AXLabel) ?? asString(raw.label),
    value: asString(raw.AXValue) ?? asString(raw.value),
    type: asString(raw.AXType) ?? asString(raw.type) ?? asString(raw.role),
    frame: parseFrame(raw.AXFrame ?? raw.frame),
  };
}

/** Parse the raw `idb ui describe-all` stdout into normalized elements. */
export function parseAxElements(jsonOutput: string): AxElement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => normalizeElement(entry as RawAxElement));
}

/**
 * Types idb reports for a tappable button on an alert. iOS alert actions are
 * `Button`; some idb versions prefix the AX role (`AXButton`). We match either.
 */
function isButton(el: AxElement): boolean {
  const t = (el.type ?? "").toLowerCase();
  return t === "button" || t === "axbutton";
}

/**
 * Types that signal a system prompt/alert is on screen. iOS renders alerts and
 * permission sheets with an `Alert`/`SheetSheet`-style container; idb reports
 * the container role plus button children. We treat the PRESENCE of an alert
 * container OR of the well-known permission/confirmation button labels as
 * "a prompt is present", so detection still works if idb omits the container
 * role on a given OS version.
 */
function isAlertContainer(el: AxElement): boolean {
  const t = (el.type ?? "").toLowerCase();
  return t.includes("alert") || t.includes("sheet");
}

/**
 * Button labels that, on their own, indicate a system prompt (permission dialog
 * or "Open in app" confirmation) even when idb did not tag an alert container.
 * Lowercased for case-insensitive matching. Kept deliberately conservative — a
 * plain "OK"/"Cancel" pair inside the app is NOT enough; we require one of the
 * distinctly-system affirmatives.
 */
const SYSTEM_AFFIRMATIVE_LABELS = [
  "open", // Safari "Open in <app>?"
  "allow", // notifications / location / camera
  "allow once",
  "allow while using app",
  "ok", // generic permission accept (paired with a system container check below)
  "continue",
  "always allow",
];

/** The frame-center tap point for an element with a frame. */
function centerOf(frame: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  return {
    x: Math.round(frame.x + frame.width / 2),
    y: Math.round(frame.y + frame.height / 2),
  };
}

/**
 * Scan normalized elements for a system prompt and its buttons.
 *
 * A prompt is considered present when EITHER an alert/sheet container element is
 * found OR a button carrying a distinctly-system affirmative label
 * ({@link SYSTEM_AFFIRMATIVE_LABELS}) is found — this two-signal approach keeps
 * detection working across idb/OS versions that vary in whether they expose the
 * container role. Buttons are every button element that has a frame (so it can
 * be tapped); their labels + frame-center tap points are returned in tree order.
 */
export function detectSystemPrompt(elements: AxElement[]): DetectedPrompt {
  const buttons: PromptButton[] = [];
  const messages: string[] = [];
  let hasAlertContainer = false;

  for (const el of elements) {
    if (isAlertContainer(el)) hasAlertContainer = true;
    if (isButton(el) && el.label && el.frame) {
      buttons.push({ label: el.label, center: centerOf(el.frame) });
    } else if (!isButton(el) && el.label) {
      // Static text on the alert (title/message) — useful context for the caller.
      messages.push(el.label);
    }
  }

  const hasSystemButton = buttons.some((b) =>
    SYSTEM_AFFIRMATIVE_LABELS.includes(b.label.trim().toLowerCase())
  );
  const present = hasAlertContainer || hasSystemButton;

  return {
    present,
    // Only surface messages when we actually detected a prompt, so a normal app
    // screen's static text is not reported as a phantom prompt's message.
    messages: present ? messages : [],
    buttons: present ? buttons : [],
  };
}

/**
 * Choose the button to tap from a detected prompt.
 *
 * When `label` is given, matches case-insensitively — first an EXACT label
 * match, then a substring match (so "Open" selects "Open in <app>"). When
 * `label` is omitted the caller wants a best-effort DISMISS: prefer a
 * negative/cancel action ("Cancel"/"Don't Allow"/"Not Now"), else fall back to
 * the last button (iOS conventionally puts the dismissive action last on a
 * two-button alert). Returns undefined when nothing matches, so the caller can
 * report a clean "no such button" rather than tapping blindly.
 */
export function chooseButton(
  prompt: DetectedPrompt,
  label?: string
): PromptButton | undefined {
  if (prompt.buttons.length === 0) return undefined;

  if (label && label.trim().length > 0) {
    const want = label.trim().toLowerCase();
    return (
      prompt.buttons.find((b) => b.label.trim().toLowerCase() === want) ??
      prompt.buttons.find((b) => b.label.trim().toLowerCase().includes(want))
    );
  }

  // Dismiss: prefer an explicit negative action.
  const negatives = ["cancel", "don't allow", "dont allow", "not now", "no"];
  const negative = prompt.buttons.find((b) =>
    negatives.includes(b.label.trim().toLowerCase())
  );
  if (negative) return negative;
  // Otherwise the last button (iOS puts the dismissive action last).
  return prompt.buttons[prompt.buttons.length - 1];
}
