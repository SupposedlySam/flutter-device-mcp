import { jest } from "@jest/globals";
import {
  AndroidInputController,
  buildAdbDragCommand,
  parseDragDeviceMs,
} from "../src/input/androidInputController.js";
import { memoryPointerStage } from "../src/input/pointerStage.js";
import { dragOverrunNote, effectiveDragHz, planDrag } from "../src/input/drag.js";
import { buildCliclickDragCommand } from "../src/cliclickCommands.js";
import { dragUnsupportedReason, resolveDragGesture } from "../src/handlerLogic.js";
import { buildToolList } from "../src/toolRegistry.js";
import { CommandResult } from "../src/types.js";

const SERIAL = "emulator-5554";

const okResult: CommandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

/** A runner on a 1080x2400 screen whose drag send answers with `dragOutput`. */
function runner(dragOutput: Partial<CommandResult> = {}) {
  return jest.fn(async (cmd: unknown) => {
    const command = cmd as string;
    if (command.includes("wm size")) {
      return { ...okResult, combined: "Physical size: 1080x2400" };
    }
    if (command.includes("motionevent DOWN")) return { ...okResult, ...dragOutput };
    return okResult;
  }) as jest.Mock;
}

function controller(run: jest.Mock) {
  return new AndroidInputController(
    async () => SERIAL,
    run as unknown as (cmd: string, opts?: unknown) => Promise<CommandResult>,
    memoryPointerStage(),
    async () => {}
  );
}

/** The device-side script inside the one `adb shell` drag send. */
function sentDragScripts(run: jest.Mock): string[] {
  return run.mock.calls
    .map(([c]) => c as string)
    .filter((c) => c.includes("motionevent DOWN"));
}

/** Timing line the drag script prints, for a gesture that took `ms` on the device. */
function timingLine(ms: number, rc = 0): string {
  const t0 = BigInt("1760371200123456789");
  const t1 = t0 + BigInt(ms) * BigInt(1000000);
  return `FLUTTER_DEVICE_DRAG t0=${t0} t1=${t1} rc=${rc}\n`;
}

describe("planDrag", () => {
  it("spaces the default ~60Hz moves evenly along the line and ends on the target", () => {
    const plan = planDrag({ from: { x: 100, y: 100 }, to: { x: 400, y: 700 }, durationMs: 500 });
    expect(plan.steps).toBe(30);
    expect(plan.intervalMs).toBe(17);
    expect(plan.durationMs).toBe(510);
    expect(plan.moves).toHaveLength(30);
    expect(plan.moves[0]).toEqual({ x: 110, y: 120 });
    expect(plan.moves[14]).toEqual({ x: 250, y: 400 });
    expect(plan.moves[29]).toEqual({ x: 400, y: 700 });
    expect(plan.distancePx).toBe(671);
  });

  it("sends exactly the steps asked for when the interval allows them", () => {
    const plan = planDrag({
      from: { x: 0, y: 0 },
      to: { x: 90, y: 0 },
      durationMs: 900,
      steps: 3,
      holdMs: 250,
    });
    expect(plan.moves).toEqual([
      { x: 30, y: 0 },
      { x: 60, y: 0 },
      { x: 90, y: 0 },
    ]);
    expect(plan.intervalMs).toBe(300);
    expect(plan.holdMs).toBe(250);
    expect(plan.notes).toEqual([]);
  });

  it("reduces a step count the platform's minimum interval cannot fit, and says so", () => {
    const plan = planDrag(
      { from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, durationMs: 200, steps: 60 },
      { minIntervalMs: 20 }
    );
    expect(plan.steps).toBe(10);
    expect(plan.intervalMs).toBe(20);
    expect(plan.notes.join(" ")).toMatch(/Requested 60 steps but sent 10/);
  });

  it("names a zero-length drag as a press-hold-release in place", () => {
    const plan = planDrag({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, durationMs: 100 });
    expect(plan.distancePx).toBe(0);
    expect(plan.notes.join(" ")).toMatch(/no travel was sent/);
  });
});

describe("drag timing", () => {
  const plan = planDrag({
    from: { x: 0, y: 0 },
    to: { x: 0, y: 600 },
    durationMs: 600,
    steps: 30,
    holdMs: 100,
  });

  it("reports the per-event cost when the measured drag overruns its plan", () => {
    expect(dragOverrunNote(plan, 700 + 32 * 25, "input start-up")).toMatch(
      /took 1500ms against 700ms planned — about 25ms extra per event/
    );
  });

  it("says nothing when the drag ran close to plan", () => {
    expect(dragOverrunNote(plan, 760, "input start-up")).toBeUndefined();
  });

  it("computes the achieved move rate without the hold", () => {
    expect(effectiveDragHz(plan, 1100)).toBe(30);
  });

  it("reads nanosecond device timestamps past a double's exact range", () => {
    expect(parseDragDeviceMs(timingLine(1234))).toBe(1234);
  });

  it("gives up on a device whose date has no %N", () => {
    expect(parseDragDeviceMs("FLUTTER_DEVICE_DRAG t0=1760371200N t1=1760371201N rc=0")).toBeUndefined();
  });
});

describe("Android pointerDrag", () => {
  it("sends the whole gesture as one adb shell: DOWN, paced MOVEs, the hold, then UP", async () => {
    const run = runner({ combined: timingLine(400) });
    await controller(run).pointerDrag({
      from: { x: 300, y: 900 },
      to: { x: 600, y: 1200 },
      durationMs: 300,
      steps: 3,
      holdMs: 200,
    });

    const scripts = sentDragScripts(run);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toBe(
      `adb -s '${SERIAL}' shell '` +
        "s=$(date +%s%N); " +
        "input motionevent DOWN 300 900 && " +
        "sleep 0.100 && input motionevent MOVE 400 1000 && " +
        "sleep 0.100 && input motionevent MOVE 500 1100 && " +
        "sleep 0.100 && input motionevent MOVE 600 1200 && " +
        "sleep 0.200 && input motionevent UP 600 1200; " +
        "rc=$?; e=$(date +%s%N); " +
        'echo "FLUTTER_DEVICE_DRAG t0=$s t1=$e rc=$rc"; ' +
        "[ $rc -eq 0 ] || input motionevent CANCEL 600 1200 >/dev/null 2>&1; " +
        "exit $rc'"
    );
  });

  it("reports the gesture it sent with the device-measured wall time", async () => {
    const run = runner({ combined: timingLine(1450) });
    const outcome = await controller(run).pointerDrag({
      from: { x: 100, y: 200 },
      to: { x: 700, y: 1000 },
      durationMs: 1000,
      steps: 50,
    });
    expect(outcome).toMatchObject({
      from: { x: 100, y: 200 },
      to: { x: 700, y: 1000 },
      steps: 50,
      durationMs: 1000,
      intervalMs: 20,
      holdMs: 0,
      distancePx: 1000,
      wallMs: 1450,
      wallClock: "device",
      effectiveHz: 34.5,
    });
    expect(outcome.notes?.join(" ")).toMatch(/took 1450ms against 1000ms planned/);
  });

  it("falls back to the host clock when the device cannot time itself", async () => {
    const outcome = await controller(runner()).pointerDrag({
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      durationMs: 10,
    });
    expect(outcome.wallClock).toBe("host");
    expect(outcome.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("notes an end point off the screen and still sends it as given", async () => {
    const run = runner({ combined: timingLine(40) });
    const outcome = await controller(run).pointerDrag({
      from: { x: 500, y: 500 },
      to: { x: 1200, y: 500 },
      durationMs: 30,
      steps: 1,
    });
    expect(sentDragScripts(run)[0]).toContain("input motionevent UP 1200 500");
    expect(outcome.notes?.join(" ")).toMatch(/\(1200, 500\) lies outside the 1080x2400 screen/);
  });

  it("releases the finger with CANCEL when input reports an error yet exits 0", async () => {
    const run = runner({ combined: "Error: Unknown command: motionevent\n" + timingLine(5) });
    await expect(
      controller(run).pointerDrag({ from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, durationMs: 50 })
    ).rejects.toThrow(/Android 10 or later/);
    expect(run).toHaveBeenLastCalledWith(
      `adb -s '${SERIAL}' shell input motionevent CANCEL 9 9`,
      { timeoutMs: 15000 }
    );
  });

  it("releases the finger with CANCEL when the host times the send out mid-chain", async () => {
    const run = runner({ success: false, timedOut: true });
    await expect(
      controller(run).pointerDrag({ from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, durationMs: 50 })
    ).rejects.toThrow(/timed out/);
    expect(run).toHaveBeenLastCalledWith(
      `adb -s '${SERIAL}' shell input motionevent CANCEL 9 9`,
      { timeoutMs: 15000 }
    );
  });

  it("reports the timeout, not the CANCEL, when the CANCEL fails too", async () => {
    const run = runner();
    run.mockImplementation(async (cmd: unknown) => {
      const command = cmd as string;
      if (command.includes("motionevent DOWN")) return { ...okResult, success: false, timedOut: true };
      if (command.includes("motionevent CANCEL")) throw new Error("adb vanished");
      return okResult;
    });
    await expect(
      controller(run).pointerDrag({ from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, durationMs: 50 })
    ).rejects.toThrow(/timed out/);
  });

  it("fails loudly when the send itself fails", async () => {
    const run = runner({ success: false, code: 1, combined: "device offline" });
    await expect(
      controller(run).pointerDrag({ from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, durationMs: 50 })
    ).rejects.toThrow(/device offline/);
    // The script cancels its own failed events, so the host does not send another.
    expect(run.mock.calls.some(([c]) => /shell input motionevent CANCEL/.test(c as string))).toBe(
      false
    );
  });

  it("gives the send a timeout that covers the whole gesture", async () => {
    const run = runner({ combined: timingLine(100) });
    await controller(run).pointerDrag({
      from: { x: 0, y: 0 },
      to: { x: 0, y: 100 },
      durationMs: 6000,
      steps: 100,
      holdMs: 2000,
    });
    const dragCall = run.mock.calls.find(([c]) => (c as string).includes("motionevent DOWN"))!;
    expect(dragCall[1]).toEqual({ timeoutMs: 15000 + 6000 + 2000 + 100 * 250 });
  });

  it("builds the command from the plan alone", () => {
    const plan = planDrag({ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, durationMs: 20, steps: 1 });
    expect(buildAdbDragCommand("abc", plan)).toContain(
      "input motionevent DOWN 0 0 && sleep 0.020 && input motionevent MOVE 10 0 && input motionevent UP 10 0;"
    );
  });
});

describe("buildCliclickDragCommand", () => {
  it("presses, moves with the button held at the -w interval, holds, and releases in one call", () => {
    const plan = planDrag(
      { from: { x: 10, y: 20 }, to: { x: 70, y: 80 }, durationMs: 90, steps: 3, holdMs: 150 },
      { minIntervalMs: 20 }
    );
    expect(buildCliclickDragCommand("/opt/homebrew/bin/cliclick", plan)).toBe(
      "'/opt/homebrew/bin/cliclick' -w 30 dd:10,20 dm:30,40 dm:50,60 dm:70,80 w:150 du:70,80"
    );
  });
});

describe("resolveDragGesture", () => {
  it("converts both ends from logical to device pixels with the given dpr", () => {
    expect(
      resolveDragGesture({ x: 100, y: 50, x2: 300, y2: 250, coordinateSpace: "logical", dpr: 2.5 })
    ).toEqual({
      request: { from: { x: 250, y: 125 }, to: { x: 750, y: 625 }, durationMs: 500 },
      coordinateSpace: "logical",
    });
  });

  it("carries steps and hold_ms through and defaults the duration", () => {
    expect(
      resolveDragGesture({ x: 1, y: 2, x2: 3, y2: 4, duration_ms: 2000, steps: 40, hold_ms: 0 })
        .request
    ).toEqual({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 2000, steps: 40, holdMs: 0 });
  });

  it("requires both ends", () => {
    expect(() => resolveDragGesture({ x: 1, y: 2, x2: 3 })).toThrow(/x2, y2/);
  });

  it("requires dpr for logical coordinates", () => {
    expect(() =>
      resolveDragGesture({ x: 1, y: 2, x2: 3, y2: 4, coordinateSpace: "logical" })
    ).toThrow(/dpr/);
  });

  it.each([
    ["steps", { steps: 2.5 }, /steps must be a whole number from 1 to 600/],
    ["steps", { steps: 601 }, /steps must be a whole number from 1 to 600/],
    ["duration_ms", { duration_ms: 0 }, /duration_ms must be a number from 1 to 10000/],
    ["hold_ms", { hold_ms: -1 }, /hold_ms must be a number from 0 to 10000/],
  ])("rejects an out-of-range %s before any device is touched", (_name, extra, message) => {
    expect(() => resolveDragGesture({ x: 1, y: 2, x2: 3, y2: 4, ...extra })).toThrow(message);
  });
});

describe("drag on platforms without a drag path", () => {
  it("tells a Tizen caller the app is D-pad driven and where gestures go instead", () => {
    expect(dragUnsupportedReason("tizen")).toMatch(/focus\/D-pad-driven.*Marionette/s);
  });

  it("points iOS at Marionette swipe", () => {
    expect(dragUnsupportedReason("ios")).toMatch(/iOS.*Marionette swipe/s);
  });
});

describe("flutter_pointer advertises drag", () => {
  const pointer = buildToolList().flutter.find((t) => t.name === "flutter_pointer")!;
  const props = pointer.inputSchema.properties as Record<
    string,
    { enum?: string[]; description?: string }
  >;

  it("lists drag with its end point, steps and hold arguments", () => {
    expect(props.action.enum).toContain("drag");
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["x2", "y2", "steps", "hold_ms"]));
  });

  it("describes it as a point-to-point drag sent in one adb shell", () => {
    expect(pointer.description).toMatch(/ARBITRARY POINT-TO-POINT drag/);
    expect(pointer.description).toMatch(/ONE `adb shell`/);
  });
});
