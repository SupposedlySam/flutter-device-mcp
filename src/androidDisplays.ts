/**
 * Which display `screencap` should capture on an Android device with several.
 *
 * A foldable has one display device per panel. `screencap` with no `-d` captures
 * SurfaceFlinger's first id, which on a book-style foldable can be the inner panel even
 * when it is dark and the cover screen is the one in use — a black PNG that reads
 * as a successful capture. `dumpsys display` says which panel is lit.
 */

export interface AndroidDisplay {
  /** The id `screencap -d` takes: the number after `local:` in the unique id. */
  id: string;
  uniqueId: string;
  width: number;
  height: number;
  /** The display state as dumpsys prints it: ON, OFF, DOZE, … */
  state: string;
  /** True for the display backing logical display 0 (the one apps start on). */
  isDefault: boolean;
}

export type DisplayChoice =
  | { ok: true; display: AndroidDisplay | undefined; why: string }
  | { ok: false; reason: string };

const DEVICE_LINE =
  /DisplayDeviceInfo\{[^\n]*?uniqueId="(local:(\d+))",\s*(\d+) x (\d+)[^\n]*?\bstate (\w+)/g;
const LOGICAL_DISPLAY = /^\s*Display (\d+):\s*$/gm;
const UNIQUE_ID = /uniqueId "(local:\d+)"/;

/**
 * The physical displays in `dumpsys display`. Virtual and overlay displays carry
 * no `local:` id, and `screencap -d` cannot address them, so they are left out.
 */
export function parseAndroidDisplays(dumpsys: string): AndroidDisplay[] {
  const defaultUniqueId = defaultDisplayUniqueId(dumpsys);
  const displays: AndroidDisplay[] = [];
  for (const m of dumpsys.matchAll(DEVICE_LINE)) {
    const [, uniqueId, id, width, height, state] = m;
    if (displays.some((d) => d.uniqueId === uniqueId)) continue;
    displays.push({
      id,
      uniqueId,
      width: Number(width),
      height: Number(height),
      state,
      isDefault: uniqueId === defaultUniqueId,
    });
  }
  return displays;
}

function defaultDisplayUniqueId(dumpsys: string): string | undefined {
  const zero = [...dumpsys.matchAll(LOGICAL_DISPLAY)].find((m) => m[1] === "0");
  if (!zero || zero.index === undefined) return undefined;
  const block = dumpsys.slice(zero.index + zero[0].length);
  const next = block.search(/^\s*Display \d+:\s*$/m);
  return UNIQUE_ID.exec(next < 0 ? block : block.slice(0, next))?.[1];
}

/**
 * Choose the display to capture. With none requested: the only display that is
 * ON, otherwise the default display. A device with one display, or whose
 * displays could not be read, takes no `-d`. A requested display is honoured
 * even when it is off, and an unknown one is refused with the list.
 */
export function chooseAndroidDisplay(
  displays: AndroidDisplay[],
  requested?: string
): DisplayChoice {
  const wanted = requested?.trim().replace(/^local:/, "");
  if (wanted) {
    const match = displays.find((d) => d.id === wanted);
    if (match) return { ok: true, display: match, why: "requested" };
    return {
      ok: false,
      reason:
        `Display ${requested} is not one of this device's displays. ` +
        (displays.length ? `Available: ${describeDisplays(displays)}.` : "No display could be read."),
    };
  }
  if (displays.length < 2) {
    return { ok: true, display: undefined, why: "single display" };
  }
  const lit = displays.filter((d) => d.state === "ON");
  if (lit.length === 1) return { ok: true, display: lit[0], why: "only display that is on" };
  const fallback = displays.find((d) => d.isDefault);
  return {
    ok: true,
    display: fallback,
    why: fallback ? "default display" : "no display identified as default",
  };
}

export function describeDisplays(displays: AndroidDisplay[]): string {
  return displays
    .map((d) => `${d.id} (${d.width}x${d.height}, ${d.state}${d.isDefault ? ", default" : ""})`)
    .join("; ");
}
