import { jest } from "@jest/globals";
import {
  AndroidInputController,
  ANDROID_KEYCODES,
  ANDROID_SWIPE_DURATION_MS,
  buildAdbKeyeventCommand,
  buildAdbSwipeCommand,
  buildAdbTapCommand,
  buildAdbTextCommand,
  escapeAdbText,
  normalizeAndroidKey,
  parseWmSize,
} from "../src/input/androidInputController.js";
import { CommandResult } from "../src/types.js";

const SERIAL = "988a1b413950494c49";

const okResult: CommandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

/** A controller with an injected runner + a fixed serial resolver. */
function controller(run: jest.Mock) {
  return new AndroidInputController(
    async () => SERIAL,
    run as unknown as (cmd: string, opts?: unknown) => Promise<CommandResult>
  );
}

describe("normalizeAndroidKey", () => {
  it("maps the exposed short names to their Android keycodes", () => {
    expect(normalizeAndroidKey("UP")).toBe("19"); // KEYCODE_DPAD_UP
    expect(normalizeAndroidKey("DOWN")).toBe("20");
    expect(normalizeAndroidKey("LEFT")).toBe("21");
    expect(normalizeAndroidKey("RIGHT")).toBe("22");
    // ENTER activates the FOCUSED element → DPAD_CENTER, not KEYCODE_ENTER.
    expect(normalizeAndroidKey("ENTER")).toBe("23");
    expect(normalizeAndroidKey("OK")).toBe("23");
    expect(normalizeAndroidKey("SELECT")).toBe("23");
    expect(normalizeAndroidKey("RETURN")).toBe("4"); // KEYCODE_BACK
    expect(normalizeAndroidKey("BACK")).toBe("4");
    expect(normalizeAndroidKey("HOME")).toBe("3"); // KEYCODE_HOME
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeAndroidKey(" up ")).toBe("19");
    expect(normalizeAndroidKey("home")).toBe("3");
  });

  it("passes through symbolic KEYCODE_* names (uppercased) and numeric codes", () => {
    expect(normalizeAndroidKey("keycode_media_play_pause")).toBe(
      "KEYCODE_MEDIA_PLAY_PAUSE"
    );
    expect(normalizeAndroidKey("66")).toBe("66");
  });

  it("throws an informative error for an unknown key name", () => {
    expect(() => normalizeAndroidKey("VOLUP")).toThrow(
      /Unknown Android key "VOLUP".*KEYCODE_\*/s
    );
    // No Samsung-style best-effort prefixing — a broken keyevent would
    // silently do nothing.
    expect(() => normalizeAndroidKey("KEY_ENTER")).toThrow(
      /Unknown Android key/
    );
  });
});

describe("escapeAdbText", () => {
  it("encodes spaces as %s (the `input text` space form)", () => {
    expect(escapeAdbText("hello world")).toBe("hello%sworld");
  });

  it("backslash-escapes device-shell metacharacters", () => {
    expect(escapeAdbText("a&b$(c)|d;e")).toBe("a\\&b\\$\\(c\\)\\|d\\;e");
    expect(escapeAdbText(`it's "quoted"`)).toBe(`it\\'s%s\\"quoted\\"`);
    expect(escapeAdbText("100% plain.text-ok")).toBe("100%%splain.text-ok");
  });

  it("rejects newlines/tabs (no `input text` encoding exists for them)", () => {
    expect(() => escapeAdbText("line1\nline2")).toThrow(/KEYCODE_ENTER/);
    expect(() => escapeAdbText("a\tb")).toThrow(/control characters/i);
  });
});

describe("adb input command builders", () => {
  it("keyevent quotes the serial and appends the token", () => {
    expect(buildAdbKeyeventCommand(SERIAL, "23")).toBe(
      `adb -s '${SERIAL}' shell input keyevent 23`
    );
  });

  it("tap rounds coordinates to integer device pixels", () => {
    expect(buildAdbTapCommand(SERIAL, 540.4, 1200.6)).toBe(
      `adb -s '${SERIAL}' shell input tap 540 1201`
    );
  });

  it("swipe carries both endpoints and the duration", () => {
    expect(buildAdbSwipeCommand(SERIAL, 540, 1200, 540, 800, 250)).toBe(
      `adb -s '${SERIAL}' shell input swipe 540 1200 540 800 250`
    );
    expect(buildAdbSwipeCommand(SERIAL, 1, 2, 3, 4)).toContain(
      ` ${ANDROID_SWIPE_DURATION_MS}`
    );
  });

  it("text host-quotes the device-escaped string", () => {
    // Host shell strips the single quotes, leaving the device-side form
    // (`%s` for spaces, backslash-escaped metacharacters) for adb to carry.
    expect(buildAdbTextCommand(SERIAL, "hi there $USER")).toBe(
      `adb -s '${SERIAL}' shell input text 'hi%sthere%s\\$USER'`
    );
  });
});

describe("parseWmSize", () => {
  it("parses the physical size", () => {
    expect(parseWmSize("Physical size: 1080x2340")).toEqual({
      width: 1080,
      height: 2340,
    });
  });

  it("prefers an active override size (what input coordinates address)", () => {
    expect(
      parseWmSize("Physical size: 1080x2340\nOverride size: 720x1560")
    ).toEqual({ width: 720, height: 1560 });
  });

  it("returns undefined for unrecognized output", () => {
    expect(parseWmSize("error: no devices/emulators found")).toBeUndefined();
  });
});

describe("AndroidInputController", () => {
  let run: jest.Mock;

  beforeEach(() => {
    run = jest.fn(async () => okResult) as jest.Mock;
  });

  it("key() resolves the serial lazily and sends the mapped keyevent", async () => {
    await controller(run).key("ENTER");
    expect(run).toHaveBeenCalledWith(
      `adb -s '${SERIAL}' shell input keyevent 23`,
      { timeoutMs: 15000 }
    );
  });

  it("key() rejects an unknown key without sending anything", async () => {
    await expect(controller(run).key("NOPE")).rejects.toThrow(
      /Unknown Android key/
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("pointerMove stages the position without sending an adb event (no cursor to move)", async () => {
    await controller(run).pointerMove(100, 200);
    expect(run).not.toHaveBeenCalled();
  });

  it("pointerClick taps at the staged position", async () => {
    const input = controller(run);
    await input.pointerMove(320.4, 640.6);
    await input.pointerClick();
    expect(run).toHaveBeenCalledWith(
      `adb -s '${SERIAL}' shell input tap 320 641`,
      { timeoutMs: 15000 }
    );
  });

  it("pointerClick without a staged position throws guidance instead of tapping blind", async () => {
    await expect(controller(run).pointerClick()).rejects.toThrow(
      /No pointer position staged.*'move'/s
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("pointerScroll swipes UP from the staged anchor for a positive (scroll-down) dy", async () => {
    const input = controller(run);
    await input.pointerMove(540, 1200);
    await input.pointerScroll(400);
    expect(run).toHaveBeenCalledWith(
      `adb -s '${SERIAL}' shell input swipe 540 1200 540 800 ` +
        `${ANDROID_SWIPE_DURATION_MS}`,
      { timeoutMs: 15000 }
    );
  });

  it("pointerScroll with no staged anchor swipes from the wm-size screen center", async () => {
    run.mockImplementation(async (cmd: unknown) => {
      if ((cmd as string).includes("wm size")) {
        return { ...okResult, combined: "Physical size: 1080x2340" };
      }
      return okResult;
    });
    await controller(run).pointerScroll(-300); // scroll up → finger swipes down
    const swipe = run.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("input swipe"))!;
    expect(swipe).toBe(
      `adb -s '${SERIAL}' shell input swipe 540 1170 540 1470 ` +
        `${ANDROID_SWIPE_DURATION_MS}`
    );
  });

  it("pointerScroll clamps the swipe end to the screen", async () => {
    run.mockImplementation(async (cmd: unknown) => {
      if ((cmd as string).includes("wm size")) {
        return { ...okResult, combined: "Physical size: 1080x2340" };
      }
      return okResult;
    });
    const input = controller(run);
    await input.pointerMove(540, 100);
    await input.pointerScroll(5000); // would end far above the screen
    const swipe = run.mock.calls
      .map(([c]) => c as string)
      .find((c) => c.includes("input swipe"))!;
    expect(swipe).toContain("swipe 540 100 540 0 ");
  });

  it("text() sends the escaped string through `input text`", async () => {
    await controller(run).text("hello world");
    expect(run).toHaveBeenCalledWith(
      `adb -s '${SERIAL}' shell input text 'hello%sworld'`,
      { timeoutMs: 15000 }
    );
  });

  it("surfaces a failed adb send as an error (never a silent sent:true)", async () => {
    run.mockResolvedValue({
      ...okResult,
      success: false,
      code: 1,
      combined: "error: device offline",
    });
    await expect(controller(run).key("HOME")).rejects.toThrow(
      /adb input send failed.*device offline/s
    );
  });

  it("tracks the session-sticky input mode", () => {
    const input = controller(run);
    expect(input.mode).toBe("dpad");
    input.setMode("pointer");
    expect(input.mode).toBe("pointer");
  });

  it("exposes the documented keycode table", () => {
    expect(ANDROID_KEYCODES.HOME).toBe(3);
    expect(ANDROID_KEYCODES.BACK).toBe(4);
    expect(ANDROID_KEYCODES.ENTER).toBe(23);
  });
});
