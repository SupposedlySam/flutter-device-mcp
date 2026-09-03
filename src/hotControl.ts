/**
 * Hot reload / hot restart over the launch pty's control channel.
 *
 * The flutter TOOL — not the VM service — owns genuine hot reload (`r`:
 * recompile Dart + reassemble) and hot restart (`R`: re-run `main()`), so when
 * the tool can be driven it is the better path: the VM-service
 * `reloadSources`/`reassemble` can only approximate a reload and cannot restart
 * at all.
 *
 * It is NOT unconditionally authoritative, though, and it was written as if it
 * were. Whether the control char reaches flutter's key handler depends on the
 * launch giving flutter a terminal stdin, which the FIFO does not (see
 * ptyControl for the measurement). Presence of a FIFO is therefore not
 * capability: the char is sent, the effect is CONFIRMED, and only a confirmed
 * effect may be reported as a reload.
 *
 * Pure orchestration over an injected `send` so the reload-vs-restart branching
 * and the "no live FIFO" degradation are unit-testable without a real pipe.
 */
import { FlutterControlChar } from "./ptyControl.js";

/** Which flutter interactive command to drive. */
export type HotAction = "reload" | "restart";

/** The control char flutter's interactive runner reads for each action. */
export function controlCharFor(action: HotAction): FlutterControlChar {
  return action === "restart" ? "R" : "r";
}

/** Outcome of a pty-driven hot reload/restart. */
export interface HotControlOutcome {
  kind: "reload" | "restart";
  /** How the action reached the app: the pty control channel. */
  via: "pty";
  /** True when the control char was written to the FIFO. */
  triggered: boolean;
  /**
   * Whether the flutter tool was observed to ACT on the char — a different fact
   * from `triggered`, which only says the bytes landed. `undefined` means nobody
   * looked, and must not be read as either answer: a launch with no log to watch
   * can still be reloading fine.
   */
  confirmed?: boolean;
  /** The control char sent (`r`/`R`). */
  char: FlutterControlChar;
}

/**
 * Drive a hot reload/restart by appending the action's control char to the
 * launch control FIFO via the injected `send`. Returns the outcome with
 * `triggered` reflecting whether the write landed (false when the daemon has
 * exited and the FIFO can no longer be written — the caller then reports a dead
 * daemon and, for a reload, may fall back to the VM service).
 */
export async function hotControl(
  action: HotAction,
  send: (char: FlutterControlChar) => Promise<boolean>,
  confirm?: () => Promise<boolean>
): Promise<HotControlOutcome> {
  const char = controlCharFor(action);
  const triggered = await send(char);
  // Only ask about the effect when the write landed; there is nothing to
  // confirm otherwise, and waiting out a timeout would slow down the one case
  // that is already known to have failed.
  const confirmed = triggered && confirm ? await confirm() : undefined;
  return {
    kind: action,
    via: "pty",
    triggered,
    ...(confirmed === undefined ? {} : { confirmed }),
    char,
  };
}
