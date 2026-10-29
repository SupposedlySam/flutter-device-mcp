/**
 * A short host-wide mutex shared by the state files several flutter-device-mcp
 * processes read and write (the launch registry, simulator claims).
 */
import fs from "fs";

/** How long to wait for another writer's lock before giving up on it. */
const LOCK_TIMEOUT_MS = 2000;

/**
 * Take an exclusive lock for a read-modify-write of the store, run `mutate`,
 * and release it.
 *
 * `mkdir` is the primitive: it is atomic on POSIX and fails if the directory
 * exists, so exactly one holder wins. A lock older than {@link LOCK_TIMEOUT_MS}
 * is treated as abandoned (a crashed writer) and broken, and if the lock cannot
 * be taken at all the mutation still runs unlocked: the state guarded here is
 * best-effort, and a tool call that throws because a stale directory was left
 * behind is worse than a rare lost update.
 */
export function withStoreLock<T>(storePath: string, mutate: () => T): T {
  const lockPath = `${storePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_TIMEOUT_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The holder released it between the failed mkdir and the stat; retry.
        continue;
      }
    }
  }
  try {
    return mutate();
  } finally {
    if (held) fs.rmSync(lockPath, { recursive: true, force: true });
  }
}
