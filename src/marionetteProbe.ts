/**
 * Marionette-readiness probe for a freshly-deployed app.
 *
 * WHY: `flutter_deploy` can succeed — install the app, launch it, and capture
 * a live `ws://…/ws` Dart VM Service URI — for a build that is NOT actually
 * drivable by Marionette. The app registers the `ext.flutter.marionette.*`
 * service extension only in DEBUG (or with the enabling platform define); a
 * profile/release build brings up the VM service without it. A caller that then
 * hands the URI to Marionette hits a cryptic "No isolate with
 * ext.flutter.marionette.getLogs" error, long after deploy reported success.
 *
 * So after capturing the URI the deploy PROBES the VM service for the extension
 * and reflects the finding in the response — a WARNING signal, never a deploy
 * failure (the deploy itself succeeded). The extension can register a beat after
 * the isolate starts, so the probe POLLS briefly before concluding it is absent
 * (connecting too early is exactly what tripped the human). Any error/timeout
 * connecting yields an `unknown` verdict with a note — the probe NEVER throws
 * out of a successful deploy.
 *
 * Platform-neutral: it reasons only about the VM service (iOS/Android/Tizen/
 * webOS today; a later platform inherits it unchanged). The VM-service client is
 * injected so tests supply a fake and never dial out.
 */
import { hasMarionetteExtension } from "./vmServiceClient.js";

/** The minimal VM-service surface the probe needs; satisfied by VmServiceClient. */
export interface MarionetteProbeClient {
  /** Running isolate ids (via `getVM`). */
  isolateIds(): Promise<string[]>;
  /** Registered service-extension RPC names on an isolate (via `getIsolate`). */
  isolateExtensionRpcs(isolateId: string): Promise<string[]>;
  /** Release the connection (always called, even on error). */
  close(): void;
}

/** The probe verdict reflected into the deploy response. */
export interface MarionetteProbeResult {
  /**
   * `true` — the marionette extension is registered on a live isolate (drivable).
   * `false` — the VM service is up but the extension is absent after polling.
   * `null` — the probe could not determine readiness (connect/RPC error/timeout);
   *          the deploy still succeeded, this is advisory only.
   */
  marionetteReady: boolean | null;
  /** Actionable guidance, present only when NOT ready (`false` or `null`). */
  marionetteHint?: string;
}

/** The actionable hint surfaced when the extension is confirmed absent. */
export const MARIONETTE_ABSENT_HINT =
  "VM service is up but the marionette extension isn't registered — the app " +
  "was likely built without marionette instrumentation (profile/release " +
  "without the enabling define). Redeploy a debug build (or a build with the " +
  "marionette define) to drive it.";

/** Options for {@link probeMarionetteReady}. */
export interface MarionetteProbeOptions {
  /** Total budget across all attempts, ms. Default ~10s. */
  totalTimeoutMs?: number;
  /** Delay between attempts, ms. Default 1s. */
  intervalMs?: number;
  /** Sleep primitive (injected in tests to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (injected in tests). Default Date.now. */
  now?: () => number;
}

const DEFAULT_TOTAL_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_MS = 1000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the VM service for the `ext.flutter.marionette.*` extension.
 *
 * Loops until the extension is found (→ ready), or the time budget is spent
 * without ever finding it (→ not ready). Any thrown error from the client
 * (connect/RPC failure or timeout) short-circuits to an `unknown` verdict — the
 * probe swallows it so a successful deploy is never turned into a fault. The
 * client is always closed before returning.
 */
export async function probeMarionetteReady(
  client: MarionetteProbeClient,
  options: MarionetteProbeOptions = {}
): Promise<MarionetteProbeResult> {
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const deadline = now() + totalTimeoutMs;
  try {
    // At least one attempt runs even with a zero/negative budget.
    let firstAttempt = true;
    while (firstAttempt || now() < deadline) {
      firstAttempt = false;
      const ids = await client.isolateIds();
      for (const id of ids) {
        const rpcs = await client.isolateExtensionRpcs(id);
        if (hasMarionetteExtension(rpcs)) {
          return { marionetteReady: true };
        }
      }
      // Not found yet — wait and retry while budget remains.
      if (now() + intervalMs < deadline) {
        await sleep(intervalMs);
      } else {
        break;
      }
    }
    return {
      marionetteReady: false,
      marionetteHint: MARIONETTE_ABSENT_HINT,
    };
  } catch (error) {
    // A connect/RPC error or timeout is advisory-only: the deploy already
    // succeeded, so report unknown rather than failing.
    const message = error instanceof Error ? error.message : String(error);
    return {
      marionetteReady: null,
      marionetteHint:
        "Could not probe the VM service for the marionette extension " +
        `(${message}); readiness is unknown. The deploy still succeeded — the ` +
        "URI is live. Try connecting Marionette; if it reports a missing " +
        "ext.flutter.marionette extension, redeploy a debug build.",
    };
  } finally {
    try {
      client.close();
    } catch {
      // best effort — never mask the verdict with a close error
    }
  }
}
