/**
 * Hot reload / hot restart over the launch pty's control channel.
 *
 * This is the AUTHORITATIVE path (preferred over the VM-service fallback in
 * hotReload.ts): the flutter TOOL — not the VM service — owns genuine hot reload
 * (`r`: recompile Dart + reassemble) and hot restart (`R`: re-run `main()`).
 * Both are driven by writing the control char to the running daemon's flutter
 * stdin, which the launch exposes as a durable FIFO (see ptyControl). The
 * VM-service `reloadSources`/`reassemble` path can only approximate a reload and
 * cannot restart at all, so when a control FIFO is present it wins.
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
  send: (char: FlutterControlChar) => Promise<boolean>
): Promise<HotControlOutcome> {
  const char = controlCharFor(action);
  const triggered = await send(char);
  return {
    kind: action,
    via: "pty",
    triggered,
    char,
  };
}
