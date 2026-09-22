#!/usr/bin/env node
/**
 * CLI frontend — the second face over {@link CommandCore}. It parses argv into
 * the same argument shape the MCP tools pass, invokes the identical core method,
 * prints the result as JSON, and maps the result to a process exit code. No
 * device logic lives here; it is a pure translation layer, exactly like the MCP
 * server. A human or a shell script gets the same guardrailed behavior an AI
 * agent gets through MCP.
 *
 * Usage:
 *   flutter-device <command> [--platform <p>] [--app-dir <dir>] [--flag value]
 *
 * Flags are long-form and kebab-case; they map to the tool arguments (e.g.
 * `--no-launch`, `--timeout-ms 60000`, `--coordinate-space logical`). Run
 * `flutter-device help` for the command list.
 */
import { buildRuntime } from "../runtime.js";
import { CommandCore, CommonArgs } from "../core/commandCore.js";
import { InputMode } from "../types.js";

/** Parsed argv: the subcommand, global options, and a bag of tool flags. */
interface ParsedArgs {
  command: string;
  appDir?: string;
  platform?: string;
  flags: Record<string, unknown>;
}

/** Coerce a raw flag string to boolean/number where unambiguous. */
function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** kebab-case → camelCase (so `--coordinate-space` reaches `coordinateSpace`). */
function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Parse argv into a command + flags. Each `--flag value` (or `--flag=value`, or
 * a bare `--flag` boolean) is stored under BOTH its snake_case and camelCase
 * forms so it resolves regardless of which style the core method reads.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, unknown> = {};
  let command = "";
  let appDir: string | undefined;
  let platform: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (!command) command = token;
      continue;
    }
    let name = token.slice(2);
    let raw: string;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      raw = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      raw = argv[++i];
    } else {
      raw = "true"; // bare boolean flag
    }
    if (name === "app-dir" || name === "appDir") {
      appDir = raw;
      continue;
    }
    if (name === "platform") {
      platform = raw;
      continue;
    }
    const value = coerce(raw);
    flags[name.replace(/-/g, "_")] = value;
    flags[toCamel(name)] = value;
  }
  return { command, appDir, platform, flags };
}

const HELP = `flutter-device — build, deploy, launch, and drive Flutter apps

Usage:
  flutter-device <command> [--platform <ios|android|tizen|tvos|webos|macos>] [--app-dir <dir>] [flags]

Commands:
  info                Device + environment status and resolved config (with provenance)
  setup               Prepare the device for development (--device-ip <host>)
  build               Build the app package (--mode release|profile|debug, --profile, --target, --install, --run)
  deploy              Install + launch, capture the VM Service URI (THE key command; --mode to match the built artifact)
                      macOS: stages + launches a prebuilt signed .app (--app-path <path> | --app-url <url>); no VM Service URI exists there
  uninstall           Remove the app from the device
  kill-stale          Kill the stale launch/driver processes holding THIS device's lock
                      (--device-udid to aim it; --all-devices for the host-wide hammer)
  terminate           Force-quit the app (mobile)
  background          Send the app to the background without killing it (mobile)
  foreground          Bring the app back to the foreground (mobile)
  hot-reload          Real hot reload on the running app (--device, --timeout-ms)
  hot-restart         Hot restart (re-run main()) on the running app
  screenshot          Capture the screen to a PNG (--output-path, --include-base64, --target device|simulator)
  record              Record a bounded screen clip (--duration-s, --fps, --format mp4|gif, --target device|simulator)
  set-input-mode      Select the input plane (--mode dpad|pointer) — TV
  key                 Send a remote/navigation key (--key UP|DOWN|ENTER|…) or type text (--text "hi")
  geometry            Report screen size + device pixel ratio (--view-width/--view-height to cross-check)
  pointer             Drive the pointer (--action move|click|scroll, --x --y --dy)
                      Android: pass --x/--y directly on --action click for a one-call tap, no move needed
                      macOS: x/y are WINDOW-RELATIVE points by default (--absolute for raw screen points, --double for a double-click)
  system-prompt       Detect/tap OS-level dialogs (--action detect|tap|dismiss) — iOS

Global flags:
  --platform <p>      Target platform (default from config; else ios)
  --app-dir <dir>     Path to the Flutter app (default: nearest pubspec.yaml)
  --device-udid <id>  Pin WHICH device this call targets, for this call only, overriding the
                      platform's env pin (Android: an adb serial or the model name adb reports;
                      iOS/tvOS: a flutter id, a devicectl id, or a device/simulator name).
                      Accepted by deploy, uninstall, terminate, background, foreground,
                      screenshot, record, key, pointer and geometry.
  --target <kind>     iOS/tvOS: which CLASS of target to act on — device (real hardware) or
                      simulator. Accepted by build, deploy, open-url, screenshot and record.
                      Omitted, resolution is physical-first, so a capture lands on the machine
                      a deploy would have used.

Every command prints a JSON result and exits non-zero on failure.`;

async function run(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  const { registry, config } = buildRuntime({ appDir: parsed.appDir });
  const core = new CommandCore(registry, config);
  const common: CommonArgs = { platform: parsed.platform };
  const f = parsed.flags;
  const merge = (extra: Record<string, unknown>) => ({ ...common, ...extra });
  // The per-call device pin. `merge(f)` already carries it for the commands
  // that forward the whole flag bag; the ones below build their args explicitly
  // and would otherwise ACCEPT --device-udid and silently ignore it.
  const devicePin = f.device_udid as string | undefined;

  let result: Record<string, unknown>;
  switch (parsed.command) {
    case "info":
    case "doctor":
      result = await core.info(common);
      break;
    case "setup":
      result = await core.setup(merge({ device_ip: f.device_ip }));
      break;
    case "build":
      result = await core.build(merge(f));
      break;
    case "deploy":
      result = await core.deploy(merge(f));
      break;
    case "uninstall":
      result = await core.uninstall({ ...common, device_udid: devicePin });
      break;
    case "kill-stale":
    case "kill_stale":
      // The teardown is device-SCOPED on iOS/Android, so the pin has to reach it
      // here too: without it a `--device-udid` would aim discovery at one device
      // and the kill at whatever resolved first. `--all-devices` is the explicit
      // host-wide hammer.
      result = await core.killStale({
        ...common,
        device_udid: devicePin,
        all_devices: f.all_devices as boolean | undefined,
      });
      break;
    case "terminate":
      result = await core.terminate({ ...common, device_udid: devicePin });
      break;
    case "background":
      result = await core.background({ ...common, device_udid: devicePin });
      break;
    case "foreground":
      result = await core.foreground({ ...common, device_udid: devicePin });
      break;
    case "hot-reload":
    case "hot_reload":
      result = await core.hotReload(merge(f));
      break;
    case "hot-restart":
    case "hot_restart":
      result = await core.hotRestart(merge(f));
      break;
    case "screenshot":
      result = await core.screenshot(merge(f));
      break;
    case "record":
      result = await core.record(merge(f));
      break;
    case "set-input-mode":
    case "set_input_mode":
      result = await core.setInputMode({ ...common, mode: f.mode as InputMode });
      break;
    case "key":
      result = await core.key({
        ...common,
        key: f.key as string | undefined,
        text: f.text as string | undefined,
        device_udid: devicePin,
      });
      break;
    case "geometry":
      result = await core.geometry(merge(f) as never);
      break;
    case "pointer":
      result = await core.pointer(merge(f) as never);
      break;
    case "system-prompt":
    case "system_prompt":
      result = await core.systemPrompt(merge(f) as never);
      break;
    default:
      process.stderr.write(
        `Unknown command "${parsed.command}". Run \`flutter-device help\`.\n`
      );
      return 2;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // A command that reports success:false (or triggered:false) exits non-zero so
  // scripts can gate on it; commands with no `success` field are treated as ok.
  const ok =
    result.success !== false &&
    result.triggered !== false &&
    result.captured !== false &&
    result.recorded !== false;
  return ok ? 0 : 1;
}

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(
      "flutter-device error: " +
        (error instanceof Error ? error.message : String(error)) +
        "\n"
    );
    process.exit(1);
  });
