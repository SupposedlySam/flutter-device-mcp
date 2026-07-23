/**
 * Per-developer token + host sourcing for the Samsung remote channel.
 *
 * NOTHING device-specific is committed. The channel host is derived at runtime
 * from the live sdb target (see {@link hostFromSdbTarget}); the pairing token is
 * read from / written to a per-developer file under
 * `$HOME/.config/flutter-device-mcp/token.txt` (see {@link tokenPath}). Both the
 * token file and any IP are machine-local — never hardcoded, never logged.
 *
 * The token file path is intentionally rooted at `$HOME` (via os.homedir) rather
 * than any specific user, so it resolves correctly for whichever developer runs
 * the MCP.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { parseDeviceTarget } from "../deviceTarget.js";

/** Directory holding the per-developer TV remote pairing token. */
export function tokenDir(): string {
  return path.join(os.homedir(), ".config", "flutter-device-mcp");
}

/** Absolute path to the per-developer TV remote pairing token file. */
export function tokenPath(): string {
  return path.join(tokenDir(), "token.txt");
}

/**
 * Derive the Samsung remote-channel host from a resolved sdb target.
 *
 * The sdb target is `<ip>:26101` (the sdb debug-bridge port), but the remote
 * WSS channel lives on `<ip>:8002` — SAME IP, DIFFERENT port. So we strip the
 * sdb port entirely and return the bare host; the caller supplies :8002. A bare
 * host (no port) passes through unchanged.
 */
export function hostFromSdbTarget(target: string): string {
  return parseDeviceTarget(target).host;
}

/**
 * Read the persisted pairing token, or undefined when none exists yet.
 *
 * The file may contain a trailing newline (the reference writer does not add
 * one, but hand-created files might); it is trimmed. An empty file is treated
 * as "no token" so a stray blank file does not send `token=` on the URL.
 */
export function loadToken(file: string = tokenPath()): string | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a newly-issued pairing token, creating the containing directory if
 * needed. Called after the first (unpaired) connect returns a token in its
 * `ms.channel.connect` reply, so subsequent connects skip the on-screen prompt.
 */
export function saveToken(token: string, file: string = tokenPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Owner-only (0600): the pairing token is a device credential and must not be
  // world/group-readable. Mode is set explicitly rather than relying on the
  // process umask.
  fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode only applies when the file is created; chmod covers the
  // rewrite-existing-file case so perms stay 0600 regardless.
  fs.chmodSync(file, 0o600);
}
