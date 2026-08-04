/**
 * Device screen geometry — the numbers a caller must NOT have to assume.
 *
 * The gap this closes: `flutter_pointer` insists the device pixel ratio is
 * never assumed and must be supplied for logical coordinates, but nothing in
 * this server ever REPORTED one. So a caller eyeballed a screenshot, guessed a
 * ratio, and got it wrong with nothing to catch the error.
 *
 * This is an OS-LEVEL concern: the display size and density belong to the
 * device, not to whatever app happens to be running on it, so they are read
 * from the platform (`adb shell wm size` / `wm density`) and are answerable with
 * no app installed, no debug build, and no Dart VM service.
 *
 * TWO SIZES EXIST AND THEY ARE NOT THE SAME — this is the trap, measured on a
 * physical SM-G892U:
 *   - the DISPLAY is 1440x2960 device px (`adb shell wm size`) at density 640,
 *     so dpr 4.0 and a logical DISPLAY of 360x740;
 *   - the FLUTTER VIEW is 360x725 logical (1440x2900 device px) — the missing
 *     60 device px is the system navigation bar.
 * Flutter/Marionette geometry is view-relative, `adb shell input tap` addresses
 * the display. Dividing the display height by the dpr gives 740 and is WRONG for
 * anything view-derived. Only the DISPLAY half is read here; the view size is
 * knowable only from the running app, so {@link crossCheckView} takes it as a
 * supplied argument and this module never reaches into an app to fetch it.
 *
 * The parsers are pure and platform-agnostic in shape; only the Android
 * `wm size` / `wm density` wordings are encoded here, because Android is the
 * only platform whose geometry has been exercised on-device.
 */

/** A width/height pair. Units are named by the field that holds it. */
export interface ScreenSize {
  width: number;
  height: number;
}

/** Android density buckets as `wm density` reports them. */
export interface DensityReport {
  /** The panel's built-in density. */
  physical?: number;
  /** An active user/OEM override — this is what the system actually renders at. */
  override?: number;
  /** The density in force: the override when set, else the physical one. */
  effective: number;
}

/** Everything known about a device's screen geometry. */
export interface DeviceGeometry {
  /** The whole display in DEVICE pixels — the space `adb shell input tap` uses. */
  displaySize: ScreenSize;
  density: DensityReport;
  /** Device pixels per logical pixel. */
  dpr: number;
  /** How `dpr` was obtained, so a caller can judge it. */
  dprSource: string;
  /**
   * `displaySize / dpr`. The logical size of the DISPLAY — NOT of the Flutter
   * view, which is smaller wherever system bars take space.
   */
  logicalDisplaySize: ScreenSize;
}

/**
 * A {@link DeviceGeometry} together with the device it was read from.
 *
 * The device is part of the answer, not context: a host with several devices
 * attached has several different geometries, and a reading that does not say
 * which one it describes can silently be the wrong device's.
 */
export interface DeviceGeometryReading extends DeviceGeometry {
  /** The resolved target the numbers were read from. */
  device: string;
  /** Set when a pin/argument did not match an online device and resolution fell back. */
  deviceWarning?: string;
}

/** Android's baseline density: 160 dpi is dpr 1.0. */
export const ANDROID_BASELINE_DENSITY_DPI = 160;

/** Round to 2 decimals so derived logical sizes don't carry float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Parse `adb shell wm density`.
 *
 * Both lines can be present:
 *   Physical density: 480
 *   Override density: 640
 * The OVERRIDE is what the system renders at when set, so it is the effective
 * one — reading only "Physical density" on this device would yield dpr 3.0 and
 * mis-scale every tap by a third. Returns undefined when neither line parses.
 */
export function parseWmDensity(output: string): DensityReport | undefined {
  const physicalMatch = output.match(/Physical density:\s*(\d+)/i);
  const overrideMatch = output.match(/Override density:\s*(\d+)/i);
  const physical = physicalMatch ? Number(physicalMatch[1]) : undefined;
  const override = overrideMatch ? Number(overrideMatch[1]) : undefined;
  const effective = override ?? physical;
  if (effective === undefined || !Number.isFinite(effective) || effective <= 0) {
    return undefined;
  }
  return { physical, override, effective };
}

/** Convert an Android density (dpi) to a device pixel ratio. */
export function dprFromDensity(density: number): number {
  return density / ANDROID_BASELINE_DENSITY_DPI;
}

/**
 * Build the geometry from raw `wm size` + `wm density` output. Returns undefined
 * when either could not be parsed — a partial guess is worse than none here.
 */
export function deriveAndroidGeometry(
  size: ScreenSize | undefined,
  density: DensityReport | undefined
): DeviceGeometry | undefined {
  if (!size || !density) return undefined;
  const dpr = dprFromDensity(density.effective);
  if (!Number.isFinite(dpr) || dpr <= 0) return undefined;
  return {
    displaySize: size,
    density,
    dpr,
    dprSource:
      density.override !== undefined
        ? "adb shell wm density (Override density — the density in force)"
        : "adb shell wm density (Physical density)",
    logicalDisplaySize: {
      width: round2(size.width / dpr),
      height: round2(size.height / dpr),
    },
  };
}

/** What a view-vs-display comparison concluded. */
export interface ViewCrossCheck {
  /** Human-readable observations that are EXPECTED (system bars, etc.). */
  notes: string[];
  /** Observations that indicate the reported dpr may be wrong. */
  warnings: string[];
}

/**
 * Cross-check the platform-derived geometry against a SUPPLIED Flutter view
 * size, so a wrong dpr is CAUGHT instead of silently mis-scaling taps.
 *
 * The view size is an input, never something read here: it belongs to a running
 * app and is knowable only over the VM service (Marionette reports it), while
 * everything else in this module is an OS-level fact. Both view arguments are
 * optional and an absent one simply produces no observation about it.
 *
 * WIDTH is the reliable axis: no system chrome takes horizontal space in
 * portrait, so `viewLogicalWidth * dpr` must equal the display width — a
 * mismatch means the dpr is wrong and is reported as a warning. HEIGHT
 * legitimately differs (navigation/status bars), so a shortfall is reported as
 * a note, not a warning.
 */
export function crossCheckView(
  geometry: DeviceGeometry,
  viewLogicalSize: ScreenSize | undefined,
  viewDevicePixelRatio: number | undefined
): ViewCrossCheck {
  const notes: string[] = [];
  const warnings: string[] = [];

  if (
    viewDevicePixelRatio !== undefined &&
    Math.abs(viewDevicePixelRatio - geometry.dpr) > 0.01
  ) {
    warnings.push(
      `The app reports MediaQuery.devicePixelRatio ${viewDevicePixelRatio} but the ` +
        `platform density implies ${geometry.dpr}. Taps are scaled with the ` +
        "platform value; investigate before trusting either."
    );
  }

  if (!viewLogicalSize) return { notes, warnings };

  const impliedWidth = viewLogicalSize.width * geometry.dpr;
  if (Math.abs(impliedWidth - geometry.displaySize.width) > 1) {
    warnings.push(
      `The Flutter view is ${viewLogicalSize.width} logical px wide, which at dpr ` +
        `${geometry.dpr} is ${round2(impliedWidth)} device px — but the display is ` +
        `${geometry.displaySize.width}. The dpr is probably wrong, so tap ` +
        "coordinates derived from it will land in the wrong place."
    );
  }

  const impliedHeight = viewLogicalSize.height * geometry.dpr;
  const missing = round2(geometry.displaySize.height - impliedHeight);
  if (Math.abs(missing) > 1) {
    notes.push(
      `The Flutter view is ${viewLogicalSize.height} logical px tall (${round2(
        impliedHeight
      )} device px) against a ${geometry.displaySize.height} px display — ` +
        `${missing} device px are system chrome (navigation/status bar). Use the ` +
        "VIEW size for anything derived from Flutter geometry; dividing the " +
        "DISPLAY height by the dpr would give " +
        `${geometry.logicalDisplaySize.height}, which is not the view.`
    );
  }

  return { notes, warnings };
}
