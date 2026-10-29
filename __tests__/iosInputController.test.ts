import { IosInputController, IosInputTarget } from "../src/input/iosInputController.js";
import { IosUiRunnerError } from "../src/iosUiRunner.js";
import { PointerStage, StagedPointerPosition } from "../src/input/pointerStage.js";
import { UnsupportedInputError } from "../src/types.js";

function setup(target: IosInputTarget = { udid: "UDID1", kind: "device" }) {
  const runs: { deviceId: string; steps: string; appId: string }[] = [];
  const staged = new Map<string, StagedPointerPosition>();
  const stage: PointerStage = {
    load: (key) => staged.get(key),
    save: (key, x, y) => {
      const position = { x, y, stagedAt: "t" };
      staged.set(key, position);
      return position;
    },
  };
  const controller = new IosInputController(
    async () => target,
    {
      run: async (request) => {
        runs.push(request);
        return { output: "" };
      },
    },
    { appId: "com.example.app", appDir: "/app" },
    stage
  );
  return { controller, runs };
}

describe("IosInputController keys", () => {
  it("sends a volume key with its repeat as one runner step on a device", async () => {
    const { controller, runs } = setup();
    await controller.key("VOLUME_DOWN", { repeat: 16 });
    expect(runs).toEqual([
      { deviceId: "UDID1", steps: "down16", appId: "com.example.app", appDir: "/app" },
    ]);
  });

  it("refuses other keys without touching the device", async () => {
    const { controller, runs } = setup();
    await expect(controller.key("ENTER")).rejects.toThrow(UnsupportedInputError);
    expect(runs).toEqual([]);
  });

  it("reports the simulator as unsupported, with the reason", async () => {
    const { controller, runs } = setup({ udid: "SIM", kind: "simulator" });
    await expect(controller.key("VOLUME_UP")).rejects.toThrow(/simulator has no hardware buttons/);
    expect(runs).toEqual([]);
  });

  it("lets a runner failure through unchanged", async () => {
    const failing = new IosInputController(
      async () => ({ udid: "U", kind: "device" }),
      {
        run: async () => {
          throw new IosUiRunnerError("turn on UI Automation", "ui-automation-disabled");
        },
      },
      { appId: "a", appDir: "/" }
    );
    await expect(failing.key("VOLUME_UP")).rejects.toThrow("turn on UI Automation");
  });
});

describe("IosInputController taps", () => {
  it("taps the staged position in points", async () => {
    const { controller, runs } = setup();
    await controller.pointerMove(195.4, 420.6);
    await controller.pointerClick();
    expect(runs.map((r) => r.steps)).toEqual(["tap@195:421"]);
    expect(await controller.pointerPosition()).toMatchObject({ x: 195, y: 421 });
  });

  it("rejects an off-screen negative position when staging, before it is stored", async () => {
    const { controller, runs } = setup();
    await expect(controller.pointerMove(-5, -5)).rejects.toThrow(RangeError);
    expect(await controller.pointerPosition()).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it("refuses to tap with nothing staged", async () => {
    const { controller, runs } = setup();
    await expect(controller.pointerClick()).rejects.toThrow(/No pointer position staged/);
    expect(runs).toEqual([]);
  });

  it("does not support scrolling", async () => {
    await expect(setup().controller.pointerScroll()).rejects.toThrow(UnsupportedInputError);
  });
});
