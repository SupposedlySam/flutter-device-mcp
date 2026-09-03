/**
 * Locate the `cliclick` CLI for {@link MacosAdapter}'s pointer/key input plane.
 *
 * Same rationale as {@link locateIdb}/{@link resolvePymobiledevice3}: the MCP
 * server is often launched by a GUI app (an IDE, an agent host) whose process
 * PATH omits Homebrew's `/opt/homebrew/bin`, so a bare `command -v cliclick`
 * through the server's env can fail even when cliclick is installed. This
 * searches robust, well-known install locations (not just the inherited PATH),
 * honors an explicit `FLUTTER_DEVICE_CLICLICK_PATH` override, and is called
 * PER-INVOCATION (no cached negative) so a just-installed cliclick is picked up
 * on the next tool call rather than requiring a server restart.
 *
 * Pure over its inputs (candidate dirs, an existence probe, the env) so the
 * search order is unit-testable without touching the real filesystem.
 */
import fs from "fs";
import path from "path";

/**
 * Directories cliclick is commonly installed into, searched IN ADDITION to the
 * inherited PATH. Homebrew is the documented install path (`brew install
 * cliclick`) — Apple Silicon lands it in `/opt/homebrew/bin` (verified on-host,
 * v5.1), Intel in `/usr/local/bin`.
 */
export function defaultCliclickSearchDirs(): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
}

/**
 * Resolve an absolute path to the `cliclick` CLI, or `undefined` when none is
 * found.
 *
 * Search order: an explicit `FLUTTER_DEVICE_CLICLICK_PATH` override (used as-is
 * when it exists) first, then each PATH entry, then
 * {@link defaultCliclickSearchDirs}. The first existing `cliclick` file wins.
 * `exists` is injected so tests drive the search deterministically without a
 * real filesystem.
 */
export function locateCliclick(
  opts: {
    env?: NodeJS.ProcessEnv;
    exists?: (p: string) => boolean;
  } = {}
): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p) => fs.existsSync(p));

  // 1. Explicit override wins when it points at a real file.
  const override = env.FLUTTER_DEVICE_CLICLICK_PATH?.trim();
  if (override && exists(override)) return override;

  // 2. The inherited PATH (a terminal-launched server has Homebrew here).
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  // 3. Well-known install locations the GUI-launched server's PATH may omit.
  const searchDirs = [...pathDirs, ...defaultCliclickSearchDirs()];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, "cliclick");
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Unreadable dir entry — skip it.
    }
  }
  return undefined;
}
