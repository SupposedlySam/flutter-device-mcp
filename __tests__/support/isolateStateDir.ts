/**
 * Point FLUTTER_DEVICE_STATE_DIR at a throwaway directory for every suite.
 *
 * The pointer stage (src/input/pointerStage.ts) persists to the developer's real
 * `$HOME/.config/flutter-device-mcp` by default. A unit test must never write
 * there — it would leave a staged tap coordinate behind on the machine and make
 * suites order-dependent — so the env override is set before any module loads.
 */
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-mcp-state-"));
process.env.FLUTTER_DEVICE_STATE_DIR = dir;
