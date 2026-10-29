/**
 * Whether Xcode has prepared debug symbols for the tvOS release on an Apple TV.
 *
 * A debug launch attaches lldb, which needs the device's shared-cache symbols
 * copied to `~/Library/Developer/Xcode/tvOS DeviceSupport/`. Xcode copies them
 * the first time its Devices window sees a device on a new tvOS release, and
 * until it has, a debug deploy fails late, after the whole build. Xcode marks a
 * finished copy with a `.finalized` file; the lock files stay behind either way.
 */
import fs from "fs";
import os from "os";
import path from "path";

export const TVOS_DEVICE_SUPPORT_ROOT = path.join(
  os.homedir(),
  "Library/Developer/Xcode/tvOS DeviceSupport"
);

const FINALIZED_MARKER = ".finalized";

export interface DeviceSupportProbe {
  name?: string;
  productType?: string;
  osVersion?: string;
  osBuild?: string;
}

export interface DeviceSupportFs {
  listDir(dir: string): string[];
  exists(file: string): boolean;
}

const realFs: DeviceSupportFs = {
  listDir: (dir) => fs.readdirSync(dir),
  exists: (file) => fs.existsSync(file),
};

/**
 * Xcode names the directory `<productType> <version> (<build>)`, and older
 * releases named it `<version> (<build>)`, so a match is on the suffix.
 */
export function deviceSupportDirMatches(
  dirName: string,
  osVersion: string,
  osBuild: string
): boolean {
  const suffix = `${osVersion} (${osBuild})`;
  return dirName === suffix || dirName.endsWith(` ${suffix}`);
}

/**
 * A remedy when the symbols for this Apple TV's tvOS are missing or still being
 * copied, else null. Null too when devicectl did not report the version and
 * build, since a guess would send someone to Xcode for nothing.
 */
export function tvosDeviceSupportDiagnostic(
  device: DeviceSupportProbe,
  root: string = TVOS_DEVICE_SUPPORT_ROOT,
  files: DeviceSupportFs = realFs
): string | null {
  const { osVersion, osBuild } = device;
  if (!osVersion || !osBuild) return null;
  let entries: string[];
  try {
    entries = files.listDir(root);
  } catch {
    entries = [];
  }
  const matching = entries.filter((entry) =>
    deviceSupportDirMatches(entry, osVersion, osBuild)
  );
  if (
    matching.some((entry) => files.exists(path.join(root, entry, FINALIZED_MARKER)))
  ) {
    return null;
  }
  const label = device.name ? `"${device.name}"` : "the Apple TV";
  const release = `tvOS ${osVersion} (${osBuild})`;
  const state =
    matching.length > 0
      ? `Xcode has started copying the debug symbols for ${release} but has not finished`
      : `Xcode has no debug symbols for ${release}, the release on ${label}`;
  return (
    `${state} (looked in ${root}). A debug deploy attaches lldb and fails until they are ` +
    "there. Open Xcode > Window > Devices and Simulators, select " +
    `${label}, and wait for "Preparing" / "Copying shared cache symbols" to finish. ` +
    "A profile or release install does not need them."
  );
}
