/**
 * Locate the community `flutter-tvos` toolchain for {@link TvosAdapter}.
 *
 * flutter-tvos is a git checkout, not a package, so nothing puts it on PATH but
 * the developer's shell profile. A server spawned by a GUI app inherits the
 * launchd PATH, and a non-login shell has none of the profile either: a
 * `flutter-tvos` invocation then stops at "not found" with the toolchain sitting
 * in `~/flutter-tvos/bin`. The adapter therefore finds the binary itself
 * and puts its directory on the child's PATH.
 *
 * Pure over its inputs (env, home dir, a file probe) so the search order is
 * unit-testable without the host's filesystem.
 */
import fs from "fs";
import path from "path";

export const FLUTTER_TVOS_BINARY = "flutter-tvos";

export type FlutterTvosSource =
  | "FLUTTER_DEVICE_TVOS_FLUTTER_BIN"
  | "FLUTTER_TVOS_HOME"
  | "default"
  | "PATH";

export type FlutterTvosLocation =
  | {
      found: true;
      source: FlutterTvosSource;
      /** The directory holding `flutter-tvos`. */
      binDir: string;
      /**
       * The directory to prepend to the child's PATH, or undefined when the
       * inherited PATH already reaches the binary.
       */
      prependDir: string | undefined;
    }
  | {
      found: false;
      /** Every directory searched, in order, for the error message. */
      checked: string[];
    };

/**
 * Find the directory holding `flutter-tvos`.
 *
 * Order: an explicit `FLUTTER_DEVICE_TVOS_FLUTTER_BIN` bin dir, then
 * `FLUTTER_TVOS_HOME/bin` (the checkout root, as FLUTTER_ROOT names Flutter's),
 * then the documented `~/flutter-tvos/bin`, then the inherited PATH. The named
 * locations come first so a configured toolchain wins over whichever copy PATH
 * happens to reach.
 */
export function locateFlutterTvos(opts: {
  binDirOverride?: string;
  env?: NodeJS.ProcessEnv;
  home: string;
  isFile?: (p: string) => boolean;
}): FlutterTvosLocation {
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? isExistingFile;
  const tvosHome = env.FLUTTER_TVOS_HOME?.trim();

  const named: Array<{ source: FlutterTvosSource; dir: string }> = [];
  const override = opts.binDirOverride?.trim();
  if (override) named.push({ source: "FLUTTER_DEVICE_TVOS_FLUTTER_BIN", dir: override });
  if (tvosHome) named.push({ source: "FLUTTER_TVOS_HOME", dir: path.join(tvosHome, "bin") });
  if (opts.home) {
    named.push({ source: "default", dir: defaultFlutterTvosBinDir(opts.home) });
  }

  const checked: string[] = [];
  for (const { source, dir } of named) {
    checked.push(dir);
    if (isFile(path.join(dir, FLUTTER_TVOS_BINARY))) {
      return { found: true, source, binDir: dir, prependDir: dir };
    }
  }

  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (isFile(path.join(dir, FLUTTER_TVOS_BINARY))) {
      return { found: true, source: "PATH", binDir: dir, prependDir: undefined };
    }
  }
  if (pathDirs.length > 0) checked.push("each directory on PATH");
  return { found: false, checked };
}

/** The documented default flutter-tvos bin dir (`~/flutter-tvos/bin`). */
export function defaultFlutterTvosBinDir(homeDir: string): string {
  return path.join(homeDir, "flutter-tvos", "bin");
}

/** Why a tvOS build or device launch was refused before it was spawned. */
export function flutterTvosMissingMessage(checked: string[]): string {
  return (
    "flutter-tvos not found, so nothing was spawned. Looked in: " +
    `${checked.join(", ")}. Install it with ` +
    "`git clone https://github.com/fluttertv/flutter-tvos.git ~/flutter-tvos`, " +
    "or point FLUTTER_TVOS_HOME at an existing " +
    "checkout (or FLUTTER_DEVICE_TVOS_FLUTTER_BIN at its bin dir) in the MCP server's " +
    "environment and restart the server."
  );
}

function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
