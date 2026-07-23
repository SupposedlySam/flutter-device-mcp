import {
  chooseButton,
  detectSystemPrompt,
  normalizeElement,
  parseAxElements,
  parseFrame,
} from "../src/iosSystemPrompt.js";

/**
 * A realistic `idb ui describe-all --json` payload for Safari's "Open in Example?"
 * confirmation shown after opening an https universal link on the simulator: an
 * Alert container, its title StaticText, and Cancel/Open buttons with frames.
 */
const OPEN_IN_APP_JSON = JSON.stringify([
  { AXType: "Alert", AXLabel: "Open in “Example”?", AXFrame: { x: 40, y: 300, width: 295, height: 160 } },
  { AXType: "StaticText", AXLabel: '"verify-dev.example.com" wants to open "Example".' },
  { AXType: "Button", AXLabel: "Cancel", AXFrame: { x: 50, y: 410, width: 130, height: 44 } },
  { AXType: "Button", AXLabel: "Open", AXFrame: { x: 190, y: 410, width: 130, height: 44 } },
]);

/** A notifications permission dialog (no explicit Alert container role). */
const NOTIF_PERMISSION_JSON = JSON.stringify([
  { type: "StaticText", label: '"Example" Would Like to Send You Notifications' },
  { type: "Button", label: "Don't Allow", frame: { x: 50, y: 420, width: 130, height: 44 } },
  { type: "Button", label: "Allow", frame: { x: 190, y: 420, width: 130, height: 44 } },
]);

/** An ordinary app screen (no prompt): buttons, but none system-affirmative. */
const APP_SCREEN_JSON = JSON.stringify([
  { type: "Button", label: "Play", frame: { x: 10, y: 10, width: 40, height: 40 } },
  { type: "StaticText", label: "Now Playing" },
]);

describe("parseFrame", () => {
  it("parses an object frame", () => {
    expect(parseFrame({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("parses a CGRect string frame", () => {
    expect(parseFrame("{{40, 300}, {295, 160}}")).toEqual({
      x: 40,
      y: 300,
      width: 295,
      height: 160,
    });
  });

  it("returns undefined for an unusable frame", () => {
    expect(parseFrame(undefined)).toBeUndefined();
    expect(parseFrame({ x: 1 })).toBeUndefined();
    expect(parseFrame("garbage")).toBeUndefined();
  });
});

describe("normalizeElement", () => {
  it("reads either key spelling for label/type/frame", () => {
    expect(
      normalizeElement({ AXLabel: "Open", AXType: "Button", AXFrame: { x: 0, y: 0, width: 10, height: 10 } })
    ).toEqual({ label: "Open", value: undefined, type: "Button", frame: { x: 0, y: 0, width: 10, height: 10 } });
    expect(
      normalizeElement({ label: "Allow", type: "Button", frame: { x: 1, y: 2, width: 3, height: 4 } })
    ).toEqual({ label: "Allow", value: undefined, type: "Button", frame: { x: 1, y: 2, width: 3, height: 4 } });
  });
});

describe("parseAxElements", () => {
  it("returns [] for unparseable or non-array output", () => {
    expect(parseAxElements("not json")).toEqual([]);
    expect(parseAxElements("{}")).toEqual([]);
    expect(parseAxElements("")).toEqual([]);
  });

  it("normalizes an array payload", () => {
    const els = parseAxElements(OPEN_IN_APP_JSON);
    expect(els).toHaveLength(4);
    expect(els[3]).toEqual({
      label: "Open",
      value: undefined,
      type: "Button",
      frame: { x: 190, y: 410, width: 130, height: 44 },
    });
  });
});

describe("detectSystemPrompt", () => {
  it("detects an alert container + its buttons with frame-center tap points", () => {
    const prompt = detectSystemPrompt(parseAxElements(OPEN_IN_APP_JSON));
    expect(prompt.present).toBe(true);
    expect(prompt.buttons.map((b) => b.label)).toEqual(["Cancel", "Open"]);
    // Open button center: (190 + 130/2, 410 + 44/2) = (255, 432)
    expect(prompt.buttons[1].center).toEqual({ x: 255, y: 432 });
    expect(prompt.messages).toContain(
      '"verify-dev.example.com" wants to open "Example".'
    );
  });

  it("detects a permission dialog via a system button label even with no alert container", () => {
    const prompt = detectSystemPrompt(parseAxElements(NOTIF_PERMISSION_JSON));
    expect(prompt.present).toBe(true);
    expect(prompt.buttons.map((b) => b.label)).toEqual(["Don't Allow", "Allow"]);
  });

  it("does NOT flag an ordinary app screen as a prompt", () => {
    const prompt = detectSystemPrompt(parseAxElements(APP_SCREEN_JSON));
    expect(prompt.present).toBe(false);
    expect(prompt.buttons).toEqual([]);
    expect(prompt.messages).toEqual([]);
  });
});

describe("chooseButton", () => {
  const openPrompt = detectSystemPrompt(parseAxElements(OPEN_IN_APP_JSON));
  const notifPrompt = detectSystemPrompt(parseAxElements(NOTIF_PERMISSION_JSON));

  it("matches a label case-insensitively (exact)", () => {
    expect(chooseButton(openPrompt, "open")?.label).toBe("Open");
    expect(chooseButton(notifPrompt, "ALLOW")?.label).toBe("Allow");
  });

  it("falls back to a substring match ('Open' → 'Open in Example')", () => {
    const substr = detectSystemPrompt([
      { type: "Alert", label: "x" },
      { type: "Button", label: "Open in Example", frame: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(chooseButton(substr, "open")?.label).toBe("Open in Example");
  });

  it("dismiss prefers a negative action", () => {
    expect(chooseButton(openPrompt)?.label).toBe("Cancel");
    expect(chooseButton(notifPrompt)?.label).toBe("Don't Allow");
  });

  it("dismiss falls back to the last button when there is no negative", () => {
    const prompt = detectSystemPrompt([
      { type: "Alert", label: "x" },
      { type: "Button", label: "Later", frame: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "Button", label: "Continue", frame: { x: 20, y: 0, width: 10, height: 10 } },
    ]);
    expect(chooseButton(prompt)?.label).toBe("Continue");
  });

  it("returns undefined when no button matches the requested label", () => {
    expect(chooseButton(openPrompt, "Nope")).toBeUndefined();
  });
});
