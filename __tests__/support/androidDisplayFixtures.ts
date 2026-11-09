/**
 * `dumpsys display` for a book-style foldable, reduced to the lines the parser reads.
 * The display ids are made up; the sizes are a typical cover and inner panel. The
 * surrounding layout follows AOSP's DisplayManagerService dump, and this is not
 * a byte-for-byte capture.
 */
function foldableDump(cover: "ON" | "OFF", inner: "ON" | "OFF", logicalZero: string): string {
  return `DISPLAY MANAGER (dumpsys display)
  mSafeMode=false
Display Devices: size=2
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:1234567890123456701", 832 x 2268, modeId 1, defaultModeId 1, supportedModes [{id=1, width=832, height=2268, fps=60.0}], density 420, touch INTERNAL, rotation 0, type INTERNAL, state ${cover}, FLAG_DEFAULT_DISPLAY, FLAG_ROTATES_WITH_CONTENT, FLAG_SECURE}
    mAdapter=LocalDisplayAdapter
    mUniqueId=local:1234567890123456701
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:1234567890123456700", 1768 x 2208, modeId 2, defaultModeId 2, supportedModes [{id=2, width=1768, height=2208, fps=60.0}], density 420, touch INTERNAL, rotation 0, type INTERNAL, state ${inner}, FLAG_ROTATES_WITH_CONTENT, FLAG_SECURE}
    mAdapter=LocalDisplayAdapter
    mUniqueId=local:1234567890123456700
Logical Displays: size=1
  Display 0:
    mDisplayId=0
    mPrimaryDisplayDevice=Built-in Screen
    mBaseDisplayInfo=DisplayInfo{"Built-in Screen, displayId 0", displayGroupId 0, uniqueId "${logicalZero}", app 832 x 2268, state ON}
`;
}

export const FOLDABLE_DUMPSYS_DISPLAY = foldableDump("ON", "OFF", "local:1234567890123456701");

/** The foldable opened: the inner panel lit and now backing logical display 0. */
export const FOLDABLE_INNER_ON_DUMPSYS_DISPLAY = foldableDump("OFF", "ON", "local:1234567890123456700");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // The CRC is never read by the code under test.
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

/** A PNG header-and-trailer skeleton of the given size, enough for dimensions and IEND checks. */
export function pngOfSize(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IEND", Buffer.alloc(0))]);
}

/** What screencap prints ahead of the PNG on a device with several displays. */
export const MULTI_DISPLAY_WARNING =
  "[Warning] Multiple displays were found, but no display id was specified.\n";
