import { jest } from "@jest/globals";
import {
  AndroidInputController,
  ANDROID_KEYCODES,
  ANDROID_SCROLL_SETTLE_MS,
  ANDROID_SWIPE_DURATION_MS,
  ANDROID_SWIPE_MAX_DURATION_MS,
  buildAdbKeyeventCommand,
  buildAdbScreenHashCommand,
  buildAdbSwipeCommand,
  buildAdbTapCommand,
  buildAdbTextCommand,
  escapeAdbText,
  normalizeAndroidKey,
  parseScreenHash,
  parseWmSize,
  planAndroidScroll,
  resolveSwipeDurationMs,
} from "../src/input/androidInputController.js";
import {
  filePointerStage,
  memoryPointerStage,
  PointerStage,
  stageKey,
} from "../src/input/pointerStage.js";
import { CommandResult } from "../src/types.js";
import fs from "fs";
import os from "os";
import path from "path";

const SERIAL = "988a1b413950494c49";

const okResult: CommandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

/**
 * The shell-runner seam AndroidInputController is constructed with. Naming it
 * lets the mocks below carry this signature instead of a bare `jest.Mock`, whose
 * unparameterized return type made `mockResolvedValue` infer `never` — an error
 * `npm test` cannot see (ts-jest transpiles without type diagnostics) and one
 * that also forced the `as unknown as` double-cast this replaces.
 */
type RunShell = (cmd: string, opts?: unknown) => Promise<CommandResult>;

/**
 * A controller with an injected runner + a fixed serial resolver.
 *
 * The pointer stage is injected too, defaulting to a FRESH in-memory stage per
 * controller: the production stage is on disk (so a staged tap survives a server
 * restart), and letting tests share it would leak a staged position from one
 * case into the next. Pass a shared stage to exercise the cross-process path.
 */
function controller(
  run: jest.Mock<RunShell>,
  stage: PointerStage = memoryPointerStage(),
  resolveSerial: () => Promise<string> = async () => SERIAL
) {
  return new AndroidInputController(
    resolveSerial,
    run,
    stage,
    async () => {} // no settle wait in tests
  );
}

/** A runner whose `wm size` answers with a fixed screen, used by scroll cases. */
function runnerOnScreen(width: number, height: number, hashes: string[] = []) {
  const queue = [...hashes];
  return jest.fn<RunShell>(async (cmd) => {
    const command = cmd as string;
    if (command.includes("wm size")) {
      return { ...okResult, combined: `Physical size: ${width}x${height}` };
    }
    if (command.includes("md5sum")) {
      const next = queue.shift();
      if (next === undefined) return { ...okResult, success: false };
      return { ...okResult, combined: `${next}  -` };
    }
    return okResult;
  });
}

/** The `input swipe` command a runner was asked to send. */
function sentSwipe(run: jest.Mock<RunShell>): string {
  return run.mock.calls
    .map(([c]) => c as string)
    .find((c) => c.includes("input swipe"))!;
}

const HASH_A = "0123456789abcdef0123456789abcdef";
const HASH_B = "fedcba9876543210fedcba9876543210";

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
  let run: jest.Mock<RunShell>;

  beforeEach(() => {
    run = jest.fn<RunShell>(async () => okResult);
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

  describe("the staged position survives the process that staged it", () => {
    /**
     * THE REGRESSION. `move` used to record the tap position in a field on the
     * controller, so `click` only saw it while ONE server process happened to
     * live across both tool calls. Every other case — a restarted server, a
     * reloaded MCP host, any call that rebuilds the adapter registry — silently
     * dropped it, and the click failed with "No pointer position staged": an
     * error naming a precondition the caller HAD satisfied one call earlier,
     * which is what made coordinate tapping unusable.
     *
     * These assert the POSITIVE: a tap actually goes out, at the staged
     * coordinates, from a controller that never shared memory with the mover.
     * A test that only asserted "click did not throw" would pass on a no-op.
     */
    function tmpStageFile(): string {
      return path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "android-input-stage-")),
        "pointer-stage.json"
      );
    }

    it("taps at the moved-to coordinates from a SEPARATE controller sharing only the on-disk stage", async () => {
      const file = tmpStageFile();
      // Two controllers over two stage instances = two server processes. No
      // shared object graph: the position can only travel through the file.
      await controller(
        jest.fn<RunShell>(async () => okResult),
        filePointerStage(file)
      ).pointerMove(756, 2268);

      const clickRun = jest.fn<RunShell>(async () => okResult);
      await controller(clickRun, filePointerStage(file)).pointerClick();

      expect(clickRun).toHaveBeenCalledWith(
        `adb -s '${SERIAL}' shell input tap 756 2268`,
        { timeoutMs: 15000 }
      );
    });

    it("anchors a scroll at the staged position from a SEPARATE controller too", async () => {
      const file = tmpStageFile();
      await controller(
        jest.fn<RunShell>(async () => okResult),
        filePointerStage(file)
      ).pointerMove(540, 1200);

      const scrollRun = jest.fn<RunShell>(async () => okResult);
      await controller(scrollRun, filePointerStage(file)).pointerScroll(400);

      // The anchor is the staged (540,1200), not the wm-size screen center the
      // no-position fallback would have used.
      expect(scrollRun).toHaveBeenCalledWith(
        `adb -s '${SERIAL}' shell input swipe 540 1200 540 800 ` +
          `${ANDROID_SWIPE_DURATION_MS}`,
        { timeoutMs: 15000 }
      );
    });

    it("keys the stage by device, so a position staged for one serial is NOT tapped on another", async () => {
      const file = tmpStageFile();
      await controller(
        jest.fn<RunShell>(async () => okResult),
        filePointerStage(file),
        async () => "emulator-5554"
      ).pointerMove(756, 2268);

      const otherRun = jest.fn<RunShell>(async () => okResult);
      await expect(
        controller(
          otherRun,
          filePointerStage(file),
          async () => "R5CT10ABCDE"
        ).pointerClick()
      ).rejects.toThrow(/No pointer position staged for R5CT10ABCDE/);
      expect(otherRun).not.toHaveBeenCalled();
    });

    it("reports the position a click would use, for the tool response", async () => {
      const file = tmpStageFile();
      const input = controller(
        jest.fn<RunShell>(async () => okResult),
        filePointerStage(file)
      );
      expect(await input.pointerPosition()).toBeUndefined();
      await input.pointerMove(120, 340);
      expect(
        await controller(run, filePointerStage(file)).pointerPosition()
      ).toMatchObject({ x: 120, y: 340 });
    });

    it("names the one-call tap and the D-pad alternative when nothing is staged", async () => {
      await expect(controller(run).pointerClick()).rejects.toThrow(
        /pass x\/y directly on this flutter_pointer 'click' call/
      );
      await expect(controller(run).pointerClick()).rejects.toThrow(
        /flutter_key ENTER/
      );
    });

    it("stages under the platform-qualified key (no cross-platform collision)", async () => {
      const file = tmpStageFile();
      await controller(run, filePointerStage(file)).pointerMove(11, 22);
      expect(
        filePointerStage(file).load(stageKey("android", SERIAL))
      ).toMatchObject({ x: 11, y: 22 });
    });
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

  it("pointerScroll reports the gesture it sent, not a bare success", async () => {
    const scrollRun = runnerOnScreen(1080, 2340);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    const outcome = await input.pointerScroll(400);

    expect(outcome).toMatchObject({
      requestedDy: 400,
      appliedDy: 400,
      clamped: false,
      from: { x: 540, y: 1200 },
      to: { x: 540, y: 800 },
      durationMs: ANDROID_SWIPE_DURATION_MS,
    });
  });

  it("pointerScroll sends a caller-supplied duration instead of the default", async () => {
    const scrollRun = runnerOnScreen(1080, 2340);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    const outcome = await input.pointerScroll(400, { durationMs: 600 });

    expect(sentSwipe(scrollRun)).toBe(
      `adb -s '${SERIAL}' shell input swipe 540 1200 540 800 600`
    );
    expect(outcome).toMatchObject({ durationMs: 600, speedPxPerMs: 0.667 });
  });

  it("pointerScroll bounds a duration above the max rather than timing the send out", async () => {
    const scrollRun = runnerOnScreen(1080, 2340);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    await input.pointerScroll(400, { durationMs: 999999 });

    expect(sentSwipe(scrollRun)).toContain(
      `540 800 ${ANDROID_SWIPE_MAX_DURATION_MS}`
    );
  });
});

describe("planAndroidScroll", () => {
  const anchor = { x: 720, y: 1600 };
  const screenHeight = 2960;

  it("reports a request the screen truncated as clamped, with the real travel", () => {
    const plan = planAndroidScroll({
      anchor,
      dy: 9000,
      screenHeight,
      durationMs: 300,
    });

    expect(plan.requestedDy).toBe(9000);
    expect(plan.appliedDy).toBe(1600); // anchor to the top edge, nothing more
    expect(plan.clamped).toBe(true);
    expect(plan.to).toEqual({ x: 720, y: 0 });
  });

  it("emits the IDENTICAL gesture for any dy past the bound — raising it is never the fix", () => {
    const plans = [2000, 9000, 100000].map((dy) =>
      planAndroidScroll({ anchor, dy, screenHeight, durationMs: 300 })
    );

    // The distinguishing claim: the requests differ by 50x and the gestures do
    // not differ at all, which is why seven retries at a bigger dy changed
    // nothing. Asserting only that each is "clamped" would pass even if travel
    // still grew with dy.
    for (const plan of plans) {
      expect(plan.to).toEqual(plans[0].to);
      expect(plan.appliedDy).toBe(plans[0].appliedDy);
      expect(plan.durationMs).toBe(plans[0].durationMs);
      expect(plan.speedPxPerMs).toBe(plans[0].speedPxPerMs);
    }
    expect(plans.map((p) => p.requestedDy)).toEqual([2000, 9000, 100000]);
  });

  it("turns a larger dy into SPEED, not distance, once travel is at the bound", () => {
    const modest = planAndroidScroll({
      anchor,
      dy: 400,
      screenHeight,
      durationMs: 300,
    });
    const excessive = planAndroidScroll({
      anchor,
      dy: 9000,
      screenHeight,
      durationMs: 300,
    });

    expect(modest.speedPxPerMs).toBeCloseTo(1.333, 3);
    expect(excessive.speedPxPerMs).toBeCloseTo(5.333, 3);
    // Same duration for both: the ONLY thing the bigger dy bought was velocity.
    expect(excessive.durationMs).toBe(modest.durationMs);
  });

  it("lets duration reach a speed dy cannot, at identical travel", () => {
    const flick = planAndroidScroll({
      anchor,
      dy: 9000,
      screenHeight,
      durationMs: 300,
    });
    const drag = planAndroidScroll({
      anchor,
      dy: 9000,
      screenHeight,
      durationMs: 600,
    });

    expect(drag.appliedDy).toBe(flick.appliedDy);
    expect(drag.speedPxPerMs).toBeCloseTo(flick.speedPxPerMs / 2, 3);
  });

  it("says raising dy cannot help, in the note attached to a clamped plan", () => {
    const plan = planAndroidScroll({
      anchor,
      dy: 9000,
      screenHeight,
      durationMs: 300,
    });

    expect(plan.notes.join(" ")).toMatch(/Raising dy CANNOT scroll further/);
    expect(plan.notes.join(" ")).toMatch(/duration_ms/);
  });

  it("leaves an in-bounds request alone and unremarked", () => {
    const plan = planAndroidScroll({
      anchor,
      dy: 400,
      screenHeight,
      durationMs: 300,
    });

    expect(plan.clamped).toBe(false);
    expect(plan.appliedDy).toBe(400);
    expect(plan.notes).toEqual([]);
  });

  it("flags a plan whose swipe never leaves its starting point", () => {
    const plan = planAndroidScroll({
      anchor,
      dy: 0,
      screenHeight,
      durationMs: 300,
    });

    expect(plan.appliedDy).toBe(0);
    expect(plan.notes.join(" ")).toMatch(/no gesture travel was sent at all/);
  });

  it("bounds a downward scroll at the bottom edge too", () => {
    const plan = planAndroidScroll({
      anchor: { x: 720, y: 2900 },
      dy: -9000,
      screenHeight,
      durationMs: 300,
    });

    expect(plan.to).toEqual({ x: 720, y: 2959 }); // height - 1
    expect(plan.clamped).toBe(true);
    expect(plan.notes.join(" ")).toMatch(/bottom of the screen/);
  });
});

describe("resolveSwipeDurationMs", () => {
  it("defaults when the caller supplied nothing", () => {
    expect(resolveSwipeDurationMs()).toBe(ANDROID_SWIPE_DURATION_MS);
  });

  it("honors a supplied duration", () => {
    expect(resolveSwipeDurationMs(600)).toBe(600);
  });

  it("caps at the max the send timeout allows", () => {
    expect(resolveSwipeDurationMs(60000)).toBe(ANDROID_SWIPE_MAX_DURATION_MS);
  });

  it("falls back to the default rather than refusing to scroll on a NaN", () => {
    expect(resolveSwipeDurationMs(Number.NaN)).toBe(ANDROID_SWIPE_DURATION_MS);
  });
});

describe("scroll verification", () => {
  it("hashes the raw framebuffer on-device so only a digest crosses the wire", () => {
    expect(buildAdbScreenHashCommand(SERIAL)).toBe(
      `adb -s '${SERIAL}' shell 'screencap | md5sum'`
    );
    // NOT `screencap -p`: a PNG re-encode is a second chance for two identical
    // screens to hash differently, which would read as "it scrolled".
    expect(buildAdbScreenHashCommand(SERIAL)).not.toContain("-p");
  });

  it("parses a digest out of md5sum output", () => {
    expect(parseScreenHash(`${HASH_A}  -\n`)).toBe(HASH_A);
    expect(parseScreenHash("md5sum: not found")).toBeUndefined();
  });

  it("reports 'unchanged' when the screen is byte-identical after the swipe", async () => {
    const scrollRun = runnerOnScreen(1080, 2340, [HASH_A, HASH_A]);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    const outcome = await input.pointerScroll(400, { verify: true });

    expect(outcome.verification).toBe("unchanged");
    // The point of the state: it names the input plane as WORKING, so nobody
    // goes hunting a dead Dart VM service over a gesture the app simply ignored.
    expect(outcome.verificationDetail).toMatch(/gesture reached the device/);
  });

  it("reports 'changed' when the screen differs, and says why that is weak", async () => {
    const scrollRun = runnerOnScreen(1080, 2340, [HASH_A, HASH_B]);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    const outcome = await input.pointerScroll(400, { verify: true });

    expect(outcome.verification).toBe("changed");
    expect(outcome.verificationDetail).toMatch(/weaker evidence/);
  });

  it("reports 'unavailable' — never 'unchanged' — when the check cannot run", async () => {
    // A device without md5sum, or a secure surface refusing capture. Calling
    // that "unchanged" would invent a no-op the tool never observed.
    const scrollRun = runnerOnScreen(1080, 2340, []);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    const outcome = await input.pointerScroll(400, { verify: true });

    expect(outcome.verification).toBe("unavailable");
    expect(sentSwipe(scrollRun)).toBeDefined(); // the gesture still went out
  });

  it("reports 'unavailable' when only the post-gesture hash fails", async () => {
    const scrollRun = runnerOnScreen(1080, 2340, [HASH_A]);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    expect((await input.pointerScroll(400, { verify: true })).verification).toBe(
      "unavailable"
    );
  });

  it("lets the screen settle BETWEEN the swipe and the second hash", async () => {
    // `input swipe` returns once the gesture is injected, which is before the
    // app has drawn its response. Hashing straight afterwards would call a
    // scroll that worked "unchanged".
    const order: string[] = [];
    const scrollRun = jest.fn<RunShell>(async (cmd) => {
      const command = cmd as string;
      if (command.includes("wm size")) {
        return { ...okResult, combined: "Physical size: 1080x2340" };
      }
      if (command.includes("md5sum")) {
        order.push("hash");
        return { ...okResult, combined: `${HASH_A}  -` };
      }
      if (command.includes("input swipe")) order.push("swipe");
      return okResult;
    });
    const waits: number[] = [];
    const input = new AndroidInputController(
      async () => SERIAL,
      scrollRun as unknown as (c: string, o?: unknown) => Promise<CommandResult>,
      memoryPointerStage(),
      async (ms) => {
        order.push(`wait:${ms}`);
        waits.push(ms);
      }
    );
    await input.pointerMove(540, 1200);

    await input.pointerScroll(400, { verify: true });

    expect(order).toEqual([
      "hash",
      "swipe",
      `wait:${ANDROID_SCROLL_SETTLE_MS}`,
      "hash",
    ]);
    expect(waits).toEqual([ANDROID_SCROLL_SETTLE_MS]);
  });

  it("takes no screen hashes at all unless verification was asked for", async () => {
    const scrollRun = runnerOnScreen(1080, 2340, [HASH_A, HASH_B]);
    const input = controller(scrollRun);
    await input.pointerMove(540, 1200);

    const outcome = await input.pointerScroll(400);

    expect(
      scrollRun.mock.calls.filter(([c]) => (c as string).includes("md5sum"))
    ).toHaveLength(0);
    expect(outcome.verification).toBeUndefined();
  });
});

describe("AndroidInputController (text, sends, mode)", () => {
  let run: jest.Mock<RunShell>;
  beforeEach(() => {
    run = jest.fn<RunShell>(async () => okResult);
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
