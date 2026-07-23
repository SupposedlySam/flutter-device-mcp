/**
 * Locate the `idb` CLI for {@link IosAdapter}'s system-prompt handling.
 *
 * WHY THIS EXISTS: the MCP server is often launched by
 * a GUI app (Claude Code / Cursor), whose process PATH does NOT include Homebrew's
 * `/opt/homebrew/bin` — so a bare `command -v idb` through the server's env fails
 * even when idb is installed and on a login-shell PATH. Worse, the adapter cached
 * that "not installed" answer for the whole server lifetime, so installing idb
 * afterwards never took effect without a full server restart.
 *
 * This module fixes both: it searches robust, well-known install locations (not
 * just the inherited PATH), honors an explicit `FLUTTER_DEVICE_IDB_PATH` override, and
 * is called PER-INVOCATION (no cached negative) so a just-installed idb is picked
 * up on the next tool call.
 *
 * WHAT WE SHELL: the `idb` CLI (`idb ui describe-all` / `idb ui tap`), NOT
 * `idb_companion` directly. `idb_companion` is the Objective-C daemon that idb
 * talks to; `brew install idb-companion` installs the companion, and the `idb`
 * Python CLI (`pip install fb-idb`, or the brew formula's bundled client) is the
 * command this adapter invokes. Both must be present.
 *
 * Pure over its inputs (candidate dirs, an existence probe, the env) so the search
 * order is unit-testable without touching the real filesystem.
 */
import fs from "fs";
import path from "path";

/**
 * Directories idb is commonly installed into, searched IN ADDITION to the
 * inherited PATH. Ordered most-specific/most-likely first:
 *  - Homebrew on Apple Silicon (`/opt/homebrew/bin`) and Intel (`/usr/local/bin`)
 *    — where `brew install idb-companion` and the bundled `idb` client land, and
 *    the exact dir the GUI-launched server's PATH omits.
 *  - pipx (`~/.local/bin`) and common venv bins — `fb-idb` is a Python package, so
 *    a pip/pipx install (the documented way to get the `idb` CLI) lands here.
 */
export function defaultIdbSearchDirs(
  home: string = process.env.HOME ?? ""
): string[] {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  if (home) {
    dirs.push(
      path.join(home, ".local", "bin"), // pipx / pip --user
      path.join(home, "Library", "Python", "3.11", "bin"),
      path.join(home, "Library", "Python", "3.12", "bin"),
      path.join(home, ".pyenv", "shims")
    );
  }
  return dirs;
}

/**
 * Resolve an absolute path to the `idb` CLI, or `undefined` when none is found.
 *
 * Search order: an explicit `FLUTTER_DEVICE_IDB_PATH` override (used as-is when it
 * exists) first, then each PATH entry, then {@link defaultIdbSearchDirs}. The
 * first existing `idb` file wins. `exists` is injected so tests drive the search
 * deterministically without a real filesystem.
 */
export function locateIdb(opts: {
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
} = {}): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p) => fs.existsSync(p));

  // 1. Explicit override wins when it points at a real file.
  const override = env.FLUTTER_DEVICE_IDB_PATH?.trim();
  if (override && exists(override)) return override;

  // 2. The inherited PATH (a terminal-launched server has Homebrew here).
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  // 3. Well-known install locations the GUI-launched server's PATH may omit.
  const searchDirs = [...pathDirs, ...defaultIdbSearchDirs(env.HOME ?? "")];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, "idb");
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Unreadable dir entry — skip it.
    }
  }
  return undefined;
}
