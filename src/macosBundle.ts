/**
 * macOS `.app` bundle staging: source classification + the shell commands to
 * fetch/unpack/copy a bundle into a REVERSIBLE scratch dir, and to read its
 * Info.plist.
 *
 * WHY A SCRATCH DIR: `flutter_deploy` must never install into `/Applications`
 * — running the app out of a fresh `os.tmpdir()` directory means the whole
 * deploy is undone by deleting that one directory, with nothing to uninstall
 * or Launch-Services-unregister (verified on-device: a signed app launched
 * directly from a scratch dir under `/private/tmp/...` is drivable exactly like
 * an installed one — System Events sees its process, and
 * `tell application id "<bundle id>"` controls it).
 *
 * WHY `ditto` FOR THE COPY: `cp -R` can drop the extended attributes/resource
 * forks a signed bundle's code signature depends on; `ditto` is Apple's own
 * bundle-copy tool and preserves them.
 *
 * Pure command builders + classifiers here; the adapter orchestrates the
 * actual sequence (spawn, fs writes, cleanup) via `runShell`/`fs`.
 */
import path from "path";
import { quote } from "./cli.js";

/** The two archive containers a caller may hand us instead of a bare `.app`. */
export type MacosArchiveFormat = "tar.gz" | "dmg";

/**
 * How a caller's app source resolves — the per-call `app_path`/`app_url` args,
 * or the configured `FLUTTER_DEVICE_MACOS_APP_PATH`/`FLUTTER_DEVICE_MACOS_APP_URL`
 * defaults behind them.
 */
export type MacosAppSource =
  | { kind: "app"; path: string }
  | { kind: "archive"; path: string; format: MacosArchiveFormat }
  | { kind: "url"; url: string; format: MacosArchiveFormat }
  | { kind: "unrecognized"; value: string }
  | { kind: "none" };

/** Sniff the archive format from a path/URL's extension, else undefined. */
export function macosArchiveFormat(value: string): MacosArchiveFormat | undefined {
  const lower = value.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".dmg")) return "dmg";
  return undefined;
}

/**
 * Classify the configured app source. A local path wins over a URL when both
 * are set (no network fetch needed). Anything whose extension is neither
 * `.app` nor a recognized archive is reported as `unrecognized` rather than
 * guessed at — an unpack step run against the wrong format fails opaquely.
 */
export function classifyMacosAppSource(opts: {
  appPath?: string;
  appUrl?: string;
}): MacosAppSource {
  const appPath = opts.appPath?.trim();
  if (appPath) {
    if (appPath.toLowerCase().endsWith(".app")) return { kind: "app", path: appPath };
    const format = macosArchiveFormat(appPath);
    if (format) return { kind: "archive", path: appPath, format };
    return { kind: "unrecognized", value: appPath };
  }
  const appUrl = opts.appUrl?.trim();
  if (appUrl) {
    const format = macosArchiveFormat(appUrl);
    if (format) return { kind: "url", url: appUrl, format };
    return { kind: "unrecognized", value: appUrl };
  }
  return { kind: "none" };
}

/** `curl -fsSL <url> -o <outPath>` — fetch an archive to a scratch path. */
export function buildCurlDownloadCommand(url: string, outPath: string): string {
  return `curl -fsSL ${quote(url)} -o ${quote(outPath)}`;
}

/** `tar -xzf <archivePath> -C <destDir>` — unpack a `.tar.gz`/`.tgz`. */
export function buildTarExtractCommand(archivePath: string, destDir: string): string {
  return `tar -xzf ${quote(archivePath)} -C ${quote(destDir)}`;
}

/**
 * `hdiutil attach <dmgPath> -mountpoint <mountPoint> -nobrowse -readonly
 * -noverify` — mount a `.dmg` without popping a Finder window (`-nobrowse`) or
 * running its (slow) checksum verification (`-noverify`; this is a local
 * artifact we are about to copy out of and discard, not something to trust
 * blindly forever — verification is skipped for speed, not as a security
 * stance).
 */
export function buildHdiutilAttachCommand(
  dmgPath: string,
  mountPoint: string
): string {
  return (
    `hdiutil attach ${quote(dmgPath)} -mountpoint ${quote(mountPoint)} ` +
    "-nobrowse -readonly -noverify"
  );
}

/** `hdiutil detach <mountPoint> -quiet` — unmount after copying the `.app` out. */
export function buildHdiutilDetachCommand(mountPoint: string): string {
  return `hdiutil detach ${quote(mountPoint)} -quiet`;
}

/** `ditto <src> <dest>` — copy a bundle preserving xattrs/code-signature data. */
export function buildDittoCopyCommand(src: string, dest: string): string {
  return `ditto ${quote(src)} ${quote(dest)}`;
}

/**
 * `find <dir> -maxdepth 2 -name '*.app' -type d` — locate the `.app` produced
 * by unpacking an archive (its name is not assumed; the archive's own naming
 * is authoritative).
 */
export function buildFindAppBundleCommand(dir: string): string {
  return `find ${quote(dir)} -maxdepth 2 -name '*.app' -type d`;
}

/** Parse the first result line of {@link buildFindAppBundleCommand}'s output. */
export function parseFoundAppBundle(output: string): string | undefined {
  const first = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first;
}

/**
 * `plutil -extract <key> raw -o - <plistPath>` — read one Info.plist key.
 * `plutil` is a base-OS binary (unlike PlistBuddy, which needs the Xcode CLT),
 * so this has no toolchain dependency beyond macOS itself.
 */
export function buildPlutilExtractCommand(key: string, plistPath: string): string {
  return `plutil -extract ${quote(key)} raw -o - ${quote(plistPath)}`;
}

/** Trim plutil's raw output; empty → undefined (key absent or unreadable). */
export function parsePlutilRawOutput(output: string): string | undefined {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The Info.plist path inside a `.app` bundle. */
export function infoPlistPath(appPath: string): string {
  return path.join(appPath, "Contents", "Info.plist");
}

/** The bundle's main executable path (`Contents/MacOS/<CFBundleExecutable>`). */
export function bundleExecutablePath(appPath: string, executableName: string): string {
  return path.join(appPath, "Contents", "MacOS", executableName);
}

/** The bundle's `Contents/MacOS` directory — where any helper sidecar also lives. */
export function bundleMacOsDir(appPath: string): string {
  return path.join(appPath, "Contents", "MacOS");
}
