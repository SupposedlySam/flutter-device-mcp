/**
 * Per-developer client-key persistence for the webOS ssap channel.
 *
 * The webOS counterpart of `samsungToken.ts`. On the first (unpaired) ssap
 * connect the TV shows an on-screen Allow prompt and returns a `client-key`;
 * presenting that key on later connects skips the prompt. NOTHING device-specific
 * is committed — the key is read from / written to a per-developer file under
 * `$HOME/.config/flutter-device-mcp/webos-client-key.txt`, alongside the Samsung
 * pairing token.
 *
 * The client-key is a LAN bearer credential (whoever holds it can drive the TV's
 * input over ssap), so the file is written owner-only (0600) and never logged.
 * The path is rooted at `$HOME` (via os.homedir) so it resolves for whichever
 * developer runs the MCP.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** Directory holding the per-developer TV remote credentials (shared with Samsung). */
export function webosTokenDir(): string {
  return path.join(os.homedir(), ".config", "flutter-device-mcp");
}

/** Absolute path to the per-developer webOS ssap client-key file. */
export function webosTokenPath(): string {
  return path.join(webosTokenDir(), "webos-client-key.txt");
}

/**
 * Read the persisted ssap client-key, or undefined when none exists yet.
 *
 * A trailing newline is trimmed and an empty/whitespace file is treated as "no
 * key" so a stray blank file does not send an empty `client-key` on register.
 */
export function loadWebosClientKey(
  file: string = webosTokenPath()
): string | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a newly-issued ssap client-key, creating the containing directory if
 * needed. Called after the first (unpaired) register returns a `client-key`, so
 * subsequent MCP runs skip the on-screen pairing prompt.
 */
export function saveWebosClientKey(
  key: string,
  file: string = webosTokenPath()
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Owner-only (0600): the client-key is a LAN bearer credential and must not be
  // group/world-readable. Mode is set explicitly rather than relying on umask.
  fs.writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode only applies on create; chmod covers the
  // rewrite-existing-file case so perms stay 0600 regardless.
  fs.chmodSync(file, 0o600);
}
