/**
 * Read the Dart VM Service URI of an app launched on a tvOS simulator.
 *
 * A tvOS simulator app writes the engine's "Dart VM service is listening on"
 * line to the unified log, not to the stdout `simctl launch --console-pty`
 * relays, so the console of a launch never carries it. The simulator's own
 * `log show` does.
 */
import { quote } from "./cli.js";

/** The pid `simctl launch` prints as `<bundle id>: <pid>`. */
export function parseSimctlLaunchPid(output: string, appId: string): number | undefined {
  const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*(\\d+)`).exec(output);
  return match ? Number(match[1]) : undefined;
}

/**
 * `log show` inside the simulator for the VM-service line of one launch.
 *
 * With the launch's pid the predicate cannot reach an earlier instance's URI.
 * Without it, the window is what keeps the read to this launch, so it covers
 * only the time since the launch was issued.
 */
export function buildSimVmServiceLogCommand(
  device: string,
  windowSeconds: number,
  pid?: number
): string {
  const processClause = pid !== undefined ? `processID == ${pid}` : `process == "Runner"`;
  const predicate = `${processClause} AND eventMessage CONTAINS[c] "vm service"`;
  const window = Math.max(1, Math.ceil(windowSeconds));
  return (
    `xcrun simctl spawn ${quote(device)} log show --style compact ` +
    `--last ${window}s --predicate ${quote(predicate)}`
  );
}
