/**
 * Type-level pin on {@link PlatformAdapter.killStale}'s signature. No runtime
 * behavior — it exists so `tsc` fails when the teardown's scope argument stops
 * being mandatory in any adapter.
 *
 * WHY a file for this: "the argument is required" was claimed as the guardrail
 * against a caller reintroducing the host-wide kill by forgetting it, and the
 * claim was false. TypeScript's parameter bivariance means a zero-parameter
 * `async killStale()` satisfies `killStale(scope: KillStaleScope)` — four
 * adapters did exactly that — and changing one adapter's own signature to
 * `scope?: KillStaleScope` restores the forgotten-argument path with `tsc`
 * clean. Neither shows up in a test run either, since the parameter is only
 * ever passed, never inspected.
 *
 * `Parameters<…>` is what can tell them apart: for a mandatory parameter the
 * empty argument list is NOT assignable to the parameter tuple, and for an
 * optional or absent one it is. Asserting that on every adapter turns a dropped
 * or optional parameter into a compile error in the same build that ships it.
 *
 * This lives under `src/` deliberately: the test tsconfig type-checks test
 * files, but the SHIPPED build (`tsconfig.json`) does not, so a pin written as
 * a test file would not fail the build that ships the regression.
 */
import type { AndroidAdapter } from "./android.js";
import type { IosAdapter } from "./ios.js";
import type { MacosAdapter } from "./macos.js";
import type { PlatformAdapter } from "./platformAdapter.js";
import type { TizenAdapter } from "./tizen.js";
import type { TvosAdapter } from "./tvos.js";
import type { WebOSAdapter } from "./webos.js";

/**
 * False when `killStale`'s scope parameter is optional or missing (calling it
 * with no arguments type-checks), true when it is mandatory.
 */
type ScopeIsMandatory<A extends { killStale: (...args: never[]) => unknown }> =
  [] extends Parameters<A["killStale"]> ? false : true;

/** Each of these must read `true`; a `false` is the compile error. */
type Pinned = {
  seam: ScopeIsMandatory<PlatformAdapter>;
  android: ScopeIsMandatory<AndroidAdapter>;
  ios: ScopeIsMandatory<IosAdapter>;
  tizen: ScopeIsMandatory<TizenAdapter>;
  webos: ScopeIsMandatory<WebOSAdapter>;
  tvos: ScopeIsMandatory<TvosAdapter>;
  macos: ScopeIsMandatory<MacosAdapter>;
};

export const KILL_STALE_SCOPE_IS_MANDATORY: Pinned = {
  seam: true,
  android: true,
  ios: true,
  tizen: true,
  webos: true,
  tvos: true,
  macos: true,
};
