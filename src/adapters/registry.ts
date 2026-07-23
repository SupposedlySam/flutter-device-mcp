/**
 * Adapter registry: maps a {@link Platform} to its {@link PlatformAdapter} and
 * resolves the active adapter for a request.
 *
 * Resolution rule (Stage 1): a `platform` tool arg selects explicitly; with no
 * arg we default to the single platform whose device is currently connected —
 * which for now is always Tizen. When more platforms come online this is where
 * auto-detection lands.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Platform } from "../types.js";
import { PlatformAdapter } from "./platformAdapter.js";

export class AdapterRegistry {
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  constructor(
    adapters: PlatformAdapter[],
    private readonly defaultPlatform: Platform
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.platform, adapter);
    }
    if (!this.adapters.has(defaultPlatform)) {
      throw new Error(
        `Default platform "${defaultPlatform}" has no registered adapter`
      );
    }
  }

  /** True when `value` is a known platform key. */
  static isPlatform(value: unknown): value is Platform {
    return (
      value === "tizen" ||
      value === "webos" ||
      value === "ios" ||
      value === "android" ||
      value === "tvos"
    );
  }

  /**
   * Resolve the adapter for an optional `platform` arg. Falls back to the
   * default (the currently-connected platform — Tizen in Stage 1).
   */
  resolve(platform?: string): PlatformAdapter {
    if (platform === undefined || platform === "auto") {
      return this.get(this.defaultPlatform);
    }
    if (!AdapterRegistry.isPlatform(platform)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown platform "${platform}". Supported: tizen, webos, ios, android, tvos (or omit for auto).`
      );
    }
    return this.get(platform);
  }

  private get(platform: Platform): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No adapter registered for platform "${platform}".`
      );
    }
    return adapter;
  }
}
