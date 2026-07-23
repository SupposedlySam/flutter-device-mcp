/**
 * Pure tool-name routing: map a called tool name to its canonical `flutter_*`
 * handler.
 *
 * Keeping this pure lets the switch in the server stay a dumb dispatch and lets
 * tests assert the advertised list ({@link ../toolRegistry}) and this call-time
 * table stay in sync in both directions (a drop in either would otherwise ship
 * green).
 */

export type CanonicalTool =
  | "flutter_info"
  | "flutter_setup"
  | "flutter_build"
  | "flutter_deploy"
  | "flutter_uninstall"
  | "flutter_kill_stale"
  | "flutter_hot_reload"
  | "flutter_hot_restart"
  | "flutter_screenshot"
  | "flutter_record"
  | "flutter_terminate"
  | "flutter_background"
  | "flutter_foreground"
  | "flutter_set_input_mode"
  | "flutter_key"
  | "flutter_pointer"
  | "flutter_system_prompt";

export interface ToolRoute {
  canonical: CanonicalTool;
  /**
   * A platform forced by the tool name (none today). Reserved so a future
   * platform-scoped alias could pin a platform without changing the dispatch;
   * the server honors it over the caller's `platform` arg.
   */
  forcedPlatform?: undefined;
}

const CANONICAL: Record<string, CanonicalTool> = {
  flutter_info: "flutter_info",
  flutter_setup: "flutter_setup",
  flutter_build: "flutter_build",
  flutter_deploy: "flutter_deploy",
  flutter_uninstall: "flutter_uninstall",
  flutter_kill_stale: "flutter_kill_stale",
  flutter_hot_reload: "flutter_hot_reload",
  flutter_hot_restart: "flutter_hot_restart",
  flutter_screenshot: "flutter_screenshot",
  flutter_record: "flutter_record",
  flutter_terminate: "flutter_terminate",
  flutter_background: "flutter_background",
  flutter_foreground: "flutter_foreground",
  flutter_set_input_mode: "flutter_set_input_mode",
  flutter_key: "flutter_key",
  flutter_pointer: "flutter_pointer",
  flutter_system_prompt: "flutter_system_prompt",
};

/**
 * Every tool name the router resolves. Exposed so the ListTools registry tests
 * can assert the advertised list and this call-time table stay in sync in both
 * directions.
 */
export function knownToolNames(): string[] {
  return Object.keys(CANONICAL);
}

/** Resolve a called tool name to its canonical handler. */
export function routeTool(toolName: string): ToolRoute | undefined {
  const canonical = CANONICAL[toolName];
  if (!canonical) return undefined;
  return { canonical };
}
