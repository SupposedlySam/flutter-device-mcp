/**
 * webOS command builders — the LG counterpart of the Tizen `cli.ts` helpers.
 *
 * webOS on-device work uses the host `ares-*` SDK CLI (`ares-install`,
 * `ares-launch`, `ares-device`) for lifecycle + info. Packaging the `.ipk` is
 * left to a caller-supplied `preBuild` hook (there is no standard
 * `flutter-webos build` command), so no build-command builder lives here.
 *
 * Everything here is PURE string construction (no spawning); the adapter runs
 * the strings through the neutral {@link runShell} in `cli.ts`. Keeping it pure
 * lets the exact command wiring be unit-tested without a device or Docker.
 *
 * EXPERIMENTAL: none of these commands has been run end-to-end on a webOS
 * device. The command SHAPES match the documented ares interfaces so the wiring
 * is correct the moment a device lands.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { quote } from "../cli.js";

/** Env var overriding the webOS SDK `bin` dir (holding `ares-*`) on PATH. */
export const WEBOS_SDK_BIN_ENV = "FLUTTER_DEVICE_WEBOS_SDK_BIN";

/**
 * The default webOS SDK bin dir when {@link WEBOS_SDK_BIN_ENV} is unset — the
 * standard webOS TV CLI install location (`~/webos-tv-sdk/CLI/bin`). Mirrors the
 * tvOS adapter's `~/flutter-tvos/bin` default.
 */
export function defaultWebosSdkBin(): string {
  return path.join(os.homedir(), "webos-tv-sdk", "CLI", "bin");
}

/**
 * Resolve the webOS SDK bin dir to prepend to PATH: the env override if set,
 * else the default location. Undefined only when the env var is explicitly set
 * to an empty string (an intentional "no guard" opt-out).
 */
export function resolveWebosSdkBin(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const override = env[WEBOS_SDK_BIN_ENV];
  if (override !== undefined) {
    return override.trim().length > 0 ? override.trim() : undefined;
  }
  return defaultWebosSdkBin();
}

/**
 * PATH guard for `ares-*` invocations.
 *
 * The GUI-spawned MCP server runs under a NON-login shell with the launchd PATH,
 * so a toolchain dir added only by the developer's shell profile is invisible
 * (this exact class of bug hit flutter-tvos: "command not found" under the
 * server). To pre-empt it for webOS, prepend the resolved SDK bin dir to PATH
 * for the command — but ONLY when that dir actually exists on disk, so a
 * missing/unset dir is a no-op that leaves the command unchanged (never breaks a
 * host that already has `ares-*` on PATH).
 *
 * Pure over its inputs (the dir + an existsSync probe) so it is unit-testable
 * without a real SDK install.
 */
export function withWebosPathGuard(
  command: string,
  sdkBinDir: string | undefined = resolveWebosSdkBin(),
  dirExists: (p: string) => boolean = fs.existsSync
): string {
  // `sdkBinDir` defaults to the env-aware resolution when omitted (the adapter's
  // zero-dir call site), so an empty FLUTTER_DEVICE_WEBOS_SDK_BIN opts out (resolves
  // to undefined → no-op). A falsy/empty or non-existent dir is a no-op that
  // leaves the command unchanged, so a host that already has `ares-*` on PATH is
  // never disturbed.
  if (!sdkBinDir || sdkBinDir.trim().length === 0 || !dirExists(sdkBinDir)) {
    return command;
  }
  return `export PATH=${quote(`${sdkBinDir}:`)}"$PATH"; ${command}`;
}

/** Build `ares-install -d <device> <ipkPath>`. */
export function buildAresInstallCommand(device: string, ipkPath: string): string {
  return `ares-install -d ${quote(device)} ${quote(ipkPath)}`;
}

/**
 * Build the `ares-launch` invocation that starts the app in debug and asks the
 * SDK to surface the Dart VM service.
 *
 * Unlike Tizen (where `flutter-tizen run` owns the launch and prints the URI),
 * webOS launches through `ares-launch`. Passing `--inspect` makes the SDK start
 * the app under the inspector and print the debug/VM-service endpoint, which the
 * deploy step parses via the shared VM-service-URI parser. `--display 0`
 * targets the primary display (the app seizes the physical screen — same
 * guardrail as Tizen).
 */
export function buildAresLaunchCommand(device: string, appId: string): string {
  return `ares-launch -d ${quote(device)} --inspect --display 0 ${quote(appId)}`;
}

/** Build `ares-install -d <device> --remove <appId>` (uninstall). */
export function buildAresUninstallCommand(device: string, appId: string): string {
  return `ares-install -d ${quote(device)} --remove ${quote(appId)}`;
}

/** Build `ares-device -d <device> -i` (system/device info). */
export function buildAresDeviceInfoCommand(device: string): string {
  return `ares-device -d ${quote(device)} -i`;
}

/**
 * Build `ares-setup-device --list --full` — the machine-readable device list.
 *
 * `--full` prints one row per configured device with its connection info, which
 * {@link parseAresDevices} turns into the device set for discovery. This is the
 * ares analogue of `sdb devices`.
 */
export function buildAresDeviceListCommand(): string {
  return "ares-setup-device --list --full";
}
