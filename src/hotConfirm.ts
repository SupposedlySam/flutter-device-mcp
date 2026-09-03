/**
 * Did the flutter tool actually ACT on the control char, or did the bytes just
 * land in the pipe?
 *
 * Writing to the control FIFO succeeds whenever the FIFO exists and has a
 * reader. That is a much weaker fact than "a hot reload happened", and the two
 * come apart in practice: a FIFO on flutter's fd 0 is never read for keys at
 * all (see ptyControl for the measurement), so every `r`/`R` written to it is
 * read by nobody while the write itself reports success.
 *
 * Reporting the write as the effect turns that into a silent lie: the caller is
 * told its Dart was recompiled, edits it believes are live are not, and the
 * mismatch surfaces later as behaviour that contradicts the source. So the
 * effect is confirmed from the one place that only the flutter tool can write —
 * its own acknowledgement in the launch log.
 */
import { readFile, stat } from "node:fs/promises";

import type { HotAction } from "./hotControl.js";

/**
 * What the flutter tool prints once it has performed the action. Both the
 * in-progress and completed lines count: seeing the work START is already proof
 * the key handler received the char, which is the thing in doubt.
 */
export function ackPatternFor(action: HotAction): RegExp {
  return action === "restart"
    ? /Performing hot restart|Restarted application/i
    : /Performing hot reload|Reloaded \d+/i;
}

/** Byte length of the launch log now, or 0 when it cannot be read. */
export async function logSize(logPath: string): Promise<number> {
  try {
    return (await stat(logPath)).size;
  } catch {
    return 0;
  }
}

export interface ConfirmDeps {
  read?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll the launch log for the action's acknowledgement, looking only at output
 * appended after `fromByte` so a previous reload's line cannot be mistaken for
 * this one's.
 *
 * Returns false on timeout rather than throwing: "I could not confirm it" is an
 * outcome the caller has to be able to act on, and it is NOT the same as the
 * write having failed.
 */
export async function confirmHotAction(opts: {
  logPath: string;
  action: HotAction;
  fromByte: number;
  timeoutMs?: number;
  pollMs?: number;
  deps?: ConfirmDeps;
}): Promise<boolean> {
  const { logPath, action, fromByte } = opts;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const pollMs = opts.pollMs ?? 500;
  const read = opts.deps?.read ?? ((p: string) => readFile(p, "utf8"));
  const sleep =
    opts.deps?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.deps?.now ?? (() => Date.now());

  const pattern = ackPatternFor(action);
  const deadline = now() + timeoutMs;
  for (;;) {
    let appended = "";
    try {
      appended = (await read(logPath)).slice(fromByte);
    } catch {
      // An unreadable log cannot confirm anything. Keep waiting rather than
      // reporting a failure the app may not have.
      appended = "";
    }
    if (pattern.test(appended)) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}
