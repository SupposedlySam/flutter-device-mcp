/**
 * Hot reload orchestration over the Dart VM service.
 *
 * A hot reload swaps in recompiled Dart and re-runs `build`/widget trees while
 * PRESERVING isolate state. Over the raw VM service it is driven by the
 * `reloadSources` RPC per running isolate, followed by a framework reassemble
 * so the reloaded code takes effect on screen.
 *
 * SCOPE — this module is the VM-service reload path, used as the FALLBACK when no
 * live pty control channel is available. A genuine hot RESTART (re-run `main()`,
 * drop state) is NOT reachable over just the captured `ws://…/ws` VM-service URI:
 * `reloadSources` (even with `force:true`) only reloads sources in place and
 * never re-runs `main()`. The authoritative reload/restart path is the flutter
 * tool's own `r`/`R` over the launch pty's stdin (see hotControl + ptyControl),
 * which the server prefers; this VM-service reload is the degraded fallback for a
 * launch with no control channel.
 *
 * These functions take a minimal driver so the branching is unit-testable
 * without a real socket. The concrete driver is a {@link VmServiceClient}.
 */
import { reloadSucceeded } from "./vmServiceClient.js";

/** The subset of a VM service client these orchestrations need. */
export interface VmDriver {
  /** List running isolate ids (via getVM). */
  isolateIds(): Promise<string[]>;
  /** Issue one VM service RPC. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Close the connection. */
  close(): void;
}

/** Outcome of a reload across all isolates. */
export interface ReloadOutcome {
  kind: "reload";
  /** True when every targeted isolate reported success. */
  success: boolean;
  /** Number of isolates the operation was issued against. */
  isolates: number;
  /** Per-isolate reload reports (id + whether it succeeded + any message). */
  reports: Array<{ isolateId: string; success: boolean; message?: string }>;
}

/**
 * Run `reloadSources` against every running isolate.
 *
 * Each isolate's ReloadReport is collected; overall success requires at least
 * one isolate and success on all of them.
 */
async function reloadAllIsolates(driver: VmDriver): Promise<ReloadOutcome> {
  const isolateIds = await driver.isolateIds();
  const reports: ReloadOutcome["reports"] = [];
  for (const isolateId of isolateIds) {
    try {
      const result = await driver.call("reloadSources", { isolateId });
      const success = reloadSucceeded(result);
      const message =
        result && typeof result === "object"
          ? extractNotice(result)
          : undefined;
      reports.push({ isolateId, success, message });
    } catch (error) {
      reports.push({
        isolateId,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    kind: "reload",
    success: reports.length > 0 && reports.every((r) => r.success),
    isolates: reports.length,
    reports,
  };
}

/**
 * Hot reload: re-run build/widget trees, preserving state. Issues
 * `reloadSources` per isolate, then asks the Flutter framework to reassemble so
 * the reloaded code takes effect on screen.
 */
export async function hotReload(driver: VmDriver): Promise<ReloadOutcome> {
  const outcome = await reloadAllIsolates(driver);
  if (outcome.success) await reassemble(driver);
  return outcome;
}

/**
 * Ask the Flutter framework to reassemble the widget tree so a completed
 * reload is reflected on screen. Best-effort: a failure here does not undo the
 * reload, so it is swallowed (the ReloadReport already carries success).
 */
async function reassemble(driver: VmDriver): Promise<void> {
  try {
    const isolateIds = await driver.isolateIds();
    for (const isolateId of isolateIds) {
      try {
        await driver.call("ext.flutter.reassemble", { isolateId });
      } catch {
        // Not every isolate hosts the Flutter binding; ignore per-isolate misses.
      }
    }
  } catch {
    // best effort — the reload already applied.
  }
}

/** Pull a human-readable notice out of a ReloadReport, when present. */
function extractNotice(result: object): string | undefined {
  const notices = (result as { notices?: unknown }).notices;
  if (Array.isArray(notices)) {
    const messages = notices
      .map((n) =>
        n && typeof n === "object" ? (n as { message?: unknown }).message : undefined
      )
      .filter((m): m is string => typeof m === "string");
    if (messages.length > 0) return messages.join("; ");
  }
  return undefined;
}
