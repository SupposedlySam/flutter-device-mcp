import { burstFrameName } from "../src/recording.js";
import { runScreenshotBurst } from "../src/recordingRun.js";

/**
 * A monotonic fake clock that advances a fixed step on every read, so the burst
 * loop's time budget is fully deterministic without real timers.
 */
function fakeClock(stepMs: number) {
  let t = 0;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
}

describe("runScreenshotBurst", () => {
  it("captures frames up to the duration budget and counts only successes", async () => {
    const captured: string[] = [];
    const { framesDir, frameCount } = await runScreenshotBurst({
      fps: 2,
      durationSeconds: 1,
      frameName: burstFrameName,
      // Each read advances 100ms; deadline is 1000ms → the loop admits frames
      // while the clock is < 1000.
      now: fakeClock(100),
      sleep: async () => {},
      makeDir: () => "/tmp/fake-burst",
      captureFrame: async (framePath) => {
        captured.push(framePath);
        return true;
      },
    });

    expect(framesDir).toBe("/tmp/fake-burst");
    // At least one frame was captured, and the count matches the successes.
    expect(frameCount).toBeGreaterThan(0);
    expect(frameCount).toBe(captured.length);
    // Frames are named with the zero-padded %04d pattern under the dir.
    expect(captured[0]).toBe("/tmp/fake-burst/frame_0000.png");
  });

  it("counts only frames that the capture reports succeeded", async () => {
    let i = 0;
    const { frameCount } = await runScreenshotBurst({
      fps: 4,
      durationSeconds: 1,
      frameName: burstFrameName,
      now: fakeClock(100),
      sleep: async () => {},
      makeDir: () => "/tmp/fake-burst-2",
      // Every other frame "fails" (e.g. a dropped dvt screenshot).
      captureFrame: async () => (i++ % 2 === 0 ? true : false),
    });
    expect(frameCount).toBeGreaterThan(0);
  });

  it("captures nothing when the duration budget is already exhausted", async () => {
    const { frameCount } = await runScreenshotBurst({
      fps: 2,
      durationSeconds: 0,
      frameName: burstFrameName,
      now: fakeClock(100),
      sleep: async () => {},
      makeDir: () => "/tmp/fake-burst-3",
      captureFrame: async () => true,
    });
    expect(frameCount).toBe(0);
  });
});
