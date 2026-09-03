/**
 * Locate the `pymobiledevice3` CLI for {@link IosAdapter}'s PHYSICAL-device
 * screen capture.
 *
 * WHY THIS EXISTS (verified live on iOS 18.7, iPhone11,8): a physical iOS device
 * has no first-party CLI screenshot path — `idevicescreenshot` fails without the
 * Developer Disk Image's screenshotr service, and `xcrun devicectl` has no
 * screenshot subcommand. But `pymobiledevice3 developer dvt screenshot <out.png>`
 * DOES capture a real PNG: on iOS 17+ it opens a no-root userspace tunnel
 * automatically (it prints a WARNING about that but still succeeds, no sudo), and
 * relies on the DDI already being mounted (Xcode auto-mounts it).
 *
 * As with {@link locateIdb}, the MCP server is often launched by a GUI app whose
 * process PATH omits Homebrew / pipx / venv bins, so a bare PATH lookup can miss
 * an installed `pymobiledevice3`. This module searches robust, well-known install
 * locations IN ADDITION to the inherited PATH, honors an explicit
 * `FLUTTER_DEVICE_PYMOBILEDEVICE3` override, and is called PER-INVOCATION (no cached
 * negative) so a just-installed binary is picked up on the next tool call.
 *
 * THE OVERRIDE IS PROBED, NOT TRUSTED, AND ITS REJECTION IS REPORTED. An operator
 * who sets `FLUTTER_DEVICE_PYMOBILEDEVICE3` has made a claim about which binary to use;
 * falling through to a different one and capturing anyway told them their typo had
 * worked, and made the "set FLUTTER_DEVICE_PYMOBILEDEVICE3 to the absolute path" hint
 * unfalsifiable. So the override is checked with the cheapest real operation
 * (`pymobiledevice3 version`), which catches all three of its failure states —
 * absent, present-but-not-executable, and present-but-not-pymobiledevice3 — and a
 * rejected override comes back as a WARNING alongside whatever was used instead.
 * That mirrors the stale device pin: self-heal so the capture still happens, but
 * say so in the result rather than silently substituting.
 *
 * Discovery candidates are NOT probed, deliberately: the capture command is its
 * own probe there (a broken binary surfaces as a real
 * `pymobiledevice3 screenshot failed: …` reason, which mis-attributes nothing),
 * and a probe costs ~0.3s of Python startup that every capture would pay for a
 * failure mode nobody configured.
 *
 * Pure over its inputs (candidate dirs, an existence probe, a usability probe,
 * the env) so the search order is unit-testable without touching the real
 * filesystem or spawning anything.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

/** The CLI binary name searched for. */
export const PYMOBILEDEVICE3_BIN = "pymobiledevice3";

/**
 * `pymobiledevice3 version` prints a bare version string (e.g. `11.3.0`) and
 * exits 0. Requiring that SHAPE — not just a zero exit — is what separates the
 * real CLI from an unrelated executable that shrugs at its arguments
 * (`/bin/echo version` exits 0 too). `--version` is NOT used: this CLI rejects
 * it with a usage error.
 */
const VERSION_OUTPUT = /^\d+\.\d+/;

/** Result of resolving the CLI: what to run, and what was rejected on the way. */
export interface Pymobiledevice3Resolution {
  /** Absolute path to the CLI to shell, or undefined when none is usable. */
  binary?: string;
  /**
   * Set when `FLUTTER_DEVICE_PYMOBILEDEVICE3` was configured but could not be used —
   * names the configured path, why it was rejected, and what (if anything) was
   * used in its place. Surfaced on the tool result so an override that silently
   * did nothing is impossible.
   */
  overrideWarning?: string;
}

/**
 * Directories `pymobiledevice3` is commonly installed into, searched IN ADDITION
 * to the inherited PATH. `pymobiledevice3` is a Python package, so the usual
 * homes are pipx / pip-user / venv bins plus Homebrew:
 *  - Homebrew on Apple Silicon (`/opt/homebrew/bin`) and Intel (`/usr/local/bin`).
 *  - pipx / `pip install --user` (`~/.local/bin`) — the documented install route.
 *  - the per-minor-version Framework Python bins (`~/Library/Python/3.x/bin`).
 *  - pyenv shims (`~/.pyenv/shims`).
 */
export function defaultPymobiledevice3SearchDirs(
  home: string = process.env.HOME ?? ""
): string[] {
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  if (home) {
    dirs.push(
      path.join(home, ".local", "bin"), // pipx / pip --user
      path.join(home, "Library", "Python", "3.11", "bin"),
      path.join(home, "Library", "Python", "3.12", "bin"),
      path.join(home, "Library", "Python", "3.13", "bin"),
      path.join(home, ".pyenv", "shims")
    );
  }
  return dirs;
}

/** Why a candidate cannot be used, phrased for an operator. Undefined = usable. */
export function pymobiledevice3Unusable(
  candidate: string,
  deps: {
    stat?: (p: string) => { isFile: boolean; executable: boolean } | undefined;
    version?: (p: string) => string | undefined;
  } = {}
): string | undefined {
  const stat = deps.stat ?? defaultStat;
  const version = deps.version ?? readPymobiledevice3Version;

  const entry = stat(candidate);
  if (!entry) return "no such file";
  if (!entry.isFile) return "not a file";
  if (!entry.executable) return "not executable (chmod +x it)";
  const reported = version(candidate);
  if (reported === undefined) {
    return "`pymobiledevice3 version` did not run successfully";
  }
  if (!VERSION_OUTPUT.test(reported.trim())) {
    return (
      "it does not look like pymobiledevice3 — `pymobiledevice3 version` printed " +
      `${JSON.stringify(truncate(reported.trim()))} instead of a version number`
    );
  }
  return undefined;
}

/** Filesystem facts a candidate must satisfy before it is worth executing. */
function defaultStat(
  candidate: string
): { isFile: boolean; executable: boolean } | undefined {
  try {
    const stats = fs.statSync(candidate);
    let executable = true;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      executable = false;
    }
    return { isFile: stats.isFile(), executable };
  } catch {
    return undefined;
  }
}

/** `<candidate> version` stdout, or undefined when it could not be run. */
function readPymobiledevice3Version(candidate: string): string | undefined {
  try {
    return execFileSync(candidate, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
  } catch {
    return undefined;
  }
}

/** Keep a rejected tool's own output short enough to sit inside a warning. */
function truncate(text: string, max = 80): string {
  const oneLine = text.split("\n")[0];
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export interface ResolvePymobiledevice3Options {
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  /** Why a candidate is unusable (undefined = usable). Injected by tests. */
  unusable?: (p: string) => string | undefined;
}

/**
 * Resolve the `pymobiledevice3` CLI to shell, plus a warning when an explicit
 * override had to be rejected.
 *
 * Search order: `FLUTTER_DEVICE_PYMOBILEDEVICE3` (used only when it PASSES the
 * usability probe) first, then each PATH entry, then
 * {@link defaultPymobiledevice3SearchDirs}; the first existing file wins among
 * those. `exists`/`unusable` are injected so tests drive the search
 * deterministically without a real filesystem or a spawn.
 */
export function resolvePymobiledevice3(
  opts: ResolvePymobiledevice3Options = {}
): Pymobiledevice3Resolution {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p) => fs.existsSync(p));
  const unusable = opts.unusable ?? ((p) => pymobiledevice3Unusable(p));

  const override = env.FLUTTER_DEVICE_PYMOBILEDEVICE3?.trim();
  let rejection: string | undefined;
  if (override) {
    rejection = unusable(override);
    if (!rejection) return { binary: override };
  }

  const discovered = discover(env, exists);
  if (!override) return { binary: discovered };

  return {
    binary: discovered,
    overrideWarning:
      `FLUTTER_DEVICE_PYMOBILEDEVICE3 is set to ${override}, but that path cannot be ` +
      `used for physical-device capture (${rejection}). ` +
      (discovered
        ? `Using ${discovered} instead — fix or unset the override so the two ` +
          "cannot disagree."
        : "No other pymobiledevice3 was found either, so nothing could be captured."),
  };
}

/** First existing candidate across the inherited PATH, then the known dirs. */
function discover(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean
): string | undefined {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const searchDirs = [
    ...pathDirs,
    ...defaultPymobiledevice3SearchDirs(env.HOME ?? ""),
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, PYMOBILEDEVICE3_BIN);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Unreadable dir entry — skip it.
    }
  }
  return undefined;
}
