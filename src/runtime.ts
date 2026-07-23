/**
 * Composition root: resolve configuration once, then construct every platform
 * adapter and the registry from it. Both frontends — the MCP server and the
 * `flutter-device` CLI — call {@link buildRuntime} so they share one wiring and
 * one config-resolution path (the "one brain, two faces" seam).
 *
 * This replaces the monorepo-coupled predecessor's `resolveRepoRoot()` +
 * per-adapter `*ConfigFromRepoRoot()` factories: adapters no longer know about a
 * repo, only the resolved Flutter `appDir` and their per-platform settings.
 */
import { AdapterRegistry } from "./adapters/registry.js";
import { PlatformAdapter } from "./adapters/platformAdapter.js";
import { TizenAdapter } from "./adapters/tizen.js";
import { WebOSAdapter } from "./adapters/webos.js";
import { IosAdapter } from "./adapters/ios.js";
import { AndroidAdapter } from "./adapters/android.js";
import { TvosAdapter } from "./adapters/tvos.js";
import { Platform } from "./types.js";
import {
  ResolveConfigOptions,
  ResolvedConfig,
  resolveConfig,
} from "./config/config.js";
import { deriveAppId } from "./config/appId.js";

/** The constructed runtime shared by both frontends. */
export interface Runtime {
  registry: AdapterRegistry;
  config: ResolvedConfig;
}

/**
 * Resolve the app/bundle id for a platform: an explicitly configured id wins,
 * else a best-effort derivation from the project's native files, else an empty
 * string (uninstall/lifecycle then surface an "app id not configured" note
 * rather than acting on a wrong id).
 */
function resolveAppId(
  platform: Platform,
  configuredAppId: string | undefined,
  appDir: string
): string {
  return configuredAppId ?? deriveAppId(platform, appDir) ?? "";
}

/** Build the full runtime (config + adapters + registry) for both frontends. */
export function buildRuntime(opts: ResolveConfigOptions = {}): Runtime {
  const config = resolveConfig(opts);
  const { appDir, platforms } = config;

  const tizen = new TizenAdapter({
    appDir,
    device: platforms.tizen.device,
    appId: resolveAppId("tizen", platforms.tizen.appId, appDir),
    profile: platforms.tizen.tizenProfile,
    preBuild: platforms.tizen.preBuild,
    sdkPath: platforms.tizen.tizenSdkPath,
    apiVersion: platforms.tizen.tizenApiVersion,
    securityProfile: platforms.tizen.tizenSecurityProfile,
  });

  const ios = new IosAdapter({
    appDir,
    device: platforms.ios.device,
    appId: resolveAppId("ios", platforms.ios.appId, appDir),
  });

  const android = new AndroidAdapter({
    appDir,
    device: platforms.android.device,
    appId: resolveAppId("android", platforms.android.appId, appDir),
    launchMode: platforms.android.androidLaunchMode,
  });

  const tvos = new TvosAdapter({
    appDir,
    device: platforms.tvos.device,
    appId: resolveAppId("tvos", platforms.tvos.appId, appDir),
    flutterTvosBinDir: platforms.tvos.flutterTvosBinDir,
    preBuild: platforms.tvos.preBuild,
  });

  const webos = new WebOSAdapter({
    appDir,
    device: platforms.webos.device,
    appId: resolveAppId("webos", platforms.webos.appId, appDir),
    preBuild: platforms.webos.preBuild,
  });

  const adapters: PlatformAdapter[] = [tizen, webos, ios, android, tvos];
  const registry = new AdapterRegistry(adapters, config.defaultPlatform);
  return { registry, config };
}
