/**
 * iOS input controller: hardware volume keys and taps on a PHYSICAL iPhone,
 * through the XCUITest runner in iosUiRunner.ts. Everything else a phone could
 * be asked (D-pad keys, a free cursor, scrolling) is Marionette's job over the
 * VM service and reports {supported:false}.
 *
 * Coordinates are POINTS from the top-left of the app's window, which is what
 * Flutter calls logical pixels and what Marionette reports. They are not
 * screenshot pixels (those are points × the display scale).
 *
 * Like Android, `pointerMove` only stages a position and `pointerClick` taps it.
 */
import { IosUiRunner } from "../iosUiRunner.js";
import { isIosRunnerKey, tapStep, volumeStep } from "../iosUiRunnerSteps.js";
import {
  InputController,
  InputMode,
  KeyOptions,
  Platform,
  UnsupportedInputError,
} from "../types.js";
import {
  filePointerStage,
  PointerStage,
  StagedPointerPosition,
  stageKey,
} from "./pointerStage.js";

export interface IosInputTarget {
  /** The id `xcodebuild -destination id=` takes. */
  udid: string;
  kind: "device" | "simulator";
}

export class IosInputController implements InputController {
  readonly platform: Platform = "ios";
  readonly nativeKeyRepeat = true;
  private _mode: InputMode = "dpad";

  constructor(
    private readonly resolveTarget: () => Promise<IosInputTarget>,
    private readonly runner: Pick<IosUiRunner, "run">,
    private readonly runnerConfig: { appId: string; appDir: string },
    private readonly stage: PointerStage = filePointerStage()
  ) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(mode: InputMode): void {
    this._mode = mode;
  }

  async key(name: string, opts?: KeyOptions): Promise<void> {
    if (!isIosRunnerKey(name)) {
      throw new UnsupportedInputError(
        `iOS has no '${name}' key. flutter_key presses VOLUME_UP and VOLUME_DOWN on a ` +
          "physical iPhone; drive the app itself with Marionette " +
          "(tap/enter_text/scroll) over the Dart VM service."
      );
    }
    const step = volumeStep(name, opts?.repeat);
    const target = await this.physicalTarget("volume keys");
    await this.run(target.udid, step);
  }

  async pointerMove(x: number, y: number): Promise<void> {
    const point = { x: Math.round(x), y: Math.round(y) };
    tapStep(point.x, point.y);
    const target = await this.physicalTarget("taps");
    this.stage.save(stageKey(this.platform, target.udid), point.x, point.y);
  }

  async pointerPosition(): Promise<StagedPointerPosition | undefined> {
    const target = await this.resolveTarget();
    return this.stage.load(stageKey(this.platform, target.udid));
  }

  async pointerClick(): Promise<void> {
    const target = await this.physicalTarget("taps");
    const position = this.stage.load(stageKey(this.platform, target.udid));
    if (!position) {
      throw new Error(
        `No pointer position staged for ${target.udid} — pass x/y (points) on this ` +
          "flutter_pointer 'click' call to tap in ONE call, or send action 'move' first."
      );
    }
    await this.run(target.udid, tapStep(position.x, position.y));
  }

  async pointerScroll(): Promise<void> {
    throw new UnsupportedInputError(
      "Scrolling is unsupported on iOS through flutter_pointer. Use Marionette " +
        "scroll/swipe over the VM service."
    );
  }

  private async physicalTarget(what: string): Promise<IosInputTarget> {
    const target = await this.resolveTarget();
    if (target.kind !== "device") {
      throw new UnsupportedInputError(
        `iOS ${what} need a physical iPhone: the simulator has no hardware buttons ` +
          "and this runner is not built for it. Use Marionette tap over the VM service."
      );
    }
    return target;
  }

  private async run(deviceId: string, steps: string): Promise<void> {
    await this.runner.run({ deviceId, steps, ...this.runnerConfig });
  }
}
