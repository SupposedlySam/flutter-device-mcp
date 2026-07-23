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
 * Pure over its inputs (candidate dirs, an existence probe, the env) so the
 * search order is unit-testable without touching the real filesystem.
 */
import fs from "fs";
import path from "path";

/** The CLI binary name searched for. */
export const PYMOBILEDEVICE3_BIN = "pymobiledevice3";

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

/**
 * Resolve an absolute path to the `pymobiledevice3` CLI, or `undefined` when none
 * is found.
 *
 * Search order: an explicit `FLUTTER_DEVICE_PYMOBILEDEVICE3` override (used as-is when
 * it exists) first, then each PATH entry, then
 * {@link defaultPymobiledevice3SearchDirs}. The first existing file wins.
 * `exists` is injected so tests drive the search deterministically without a real
 * filesystem.
 */
export function locatePymobiledevice3(
  opts: {
    env?: NodeJS.ProcessEnv;
    exists?: (p: string) => boolean;
  } = {}
): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p) => fs.existsSync(p));

  // 1. Explicit override wins when it points at a real file.
  const override = env.FLUTTER_DEVICE_PYMOBILEDEVICE3?.trim();
  if (override && exists(override)) return override;

  // 2. The inherited PATH (a terminal-launched server has Homebrew/pipx here).
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  // 3. Well-known install locations the GUI-launched server's PATH may omit.
  const searchDirs = [...pathDirs, ...defaultPymobiledevice3SearchDirs(env.HOME ?? "")];

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
