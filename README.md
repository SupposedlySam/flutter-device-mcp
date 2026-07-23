# flutter-device-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server **and** a
bundled CLI (`flutter-device`) that build, deploy, launch, and drive Flutter apps
across iOS, Android, Tizen, tvOS, and webOS. Its crown-jewel behavior: a
**pty-wrapped launch that reliably captures the Dart VM Service `ws://…/ws`
URI**, so an external driver — for example the third-party
[Marionette](https://pub.dev/packages/marionette_mcp) MCP — can connect to the
live app and tap, type, scroll, screenshot, and read logs. Point your AI client
at the MCP server, or a human/script at the CLI: both are thin faces over one
shared command core, so every guardrail behaves identically no matter who calls.

## Support matrix

Rows are platforms, columns are capabilities. ✅ full · ⚠️ partial / experimental ·
❌ not supported.

| Platform | Deploy + VM URI | Hot reload/restart | Lifecycle (bg/fg/kill) | Screenshot | Record | System prompt | TV input (key/pointer) |
|----------|:---------------:|:------------------:|:----------------------:|:----------:|:------:|:-------------:|:----------------------:|
| **iOS** | ✅ | ✅ | ✅ | ✅ ¹ | ✅ ² | ✅ ³ | ❌ ⁴ |
| **Android** | ✅ | ✅ | ✅ | ✅ | ✅ ⁵ | ❌ | ❌ ⁴ |
| **Tizen** (Samsung) | ✅ ⁶ | ✅ | ❌ | ❌ ⁷ | ❌ ⁷ | ❌ | ✅ ⁸ |
| **tvOS** (Apple TV) | ✅ ⁹ | ✅ | ✅ | ⚠️ ¹⁰ | ❌ | ❌ | ❌ ¹¹ |
| **webOS** (LG) | ⚠️ ¹² | ⚠️ | ❌ | ❌ | ❌ | ❌ | ⚠️ ¹³ |

**iOS is the most mature, best-tested path; Android is well-supported.** Both use
standard Flutter / `adb` / `xcrun` tooling. **Tizen, tvOS, and webOS depend on
community toolchains and are experimental — on-device verifications and
contributions are very welcome.**

<sub>
¹ Simulator natively; physical devices need `pymobiledevice3`.
² Simulator produces an mp4; physical capture is a choppy (~1–3 fps) screenshot burst.
³ Simulator only, via `idb` over the accessibility tree.
⁴ Not a TV/focus platform — drive the app with Marionette over the VM service instead.
⁵ Native mp4 via `adb`.
⁶ Via `flutter-tizen run` (the launch that captures the VM URI); build/install is reimplemented on `flutter-tizen` and still needs on-device verification.
⁷ `sdb shell` is disabled on Samsung devices — use the driver's screenshot over the VM service.
⁸ D-pad / pointer over the Samsung remote channel.
⁹ Requires a **profile/release** build on-device; a debug build segfaults.
¹⁰ Simulator screenshot; on-device capture not wired.
¹¹ Siri-remote / focus-driven — drive via Marionette.
¹² Packaging requires a user-provided `preBuild` hook; there is no standard `flutter-webos build`.
¹³ Input over `ssap` is wired but currently device-blocked.
</sub>

## Why

- **The VM-Service URI actually reaches you.** Launching a Flutter app the normal
  way leaves the `ws://…/ws` URI buried in inherited stdio where an orchestrator
  can't grab it. `flutter-device` launches through a pty, backgrounds the process,
  and returns the URI in its result — ready to hand straight to a driver like
  Marionette. It also keeps the launch alive so hot reload/restart run against the
  same daemon instead of a slow rebuild-and-redeploy loop.
- **One brain, two faces.** The MCP server and the CLI are thin translation layers
  over a single shared command core. Every guardrail —
  **one-deploy-at-a-time** (kills stale drivers before installing),
  **disk-full recovery** (uninstall + retry the install once on `ENOSPC`),
  **stale-device-pin self-heal**, and **VM-URI capture** — lives in the core and
  runs identically whether an AI agent calls a tool or a human runs a command.

## Install

Requires **Node.js 18+**.

Run without installing:

```bash
npx flutter-device-mcp     # the MCP server (speaks MCP over stdio)
npx flutter-device info    # the CLI
```

Or install globally:

```bash
npm i -g flutter-device-mcp
flutter-device info
```

### Running from source

`scripts/run.mjs` is a **self-building launcher**: on first run it installs
dependencies and compiles `dist/` if it is missing or stale (staleness is
content-hashed, so a branch switch triggers a rebuild), then execs the server over
stdio. A fresh checkout Just Works with no manual build step:

```bash
node scripts/run.mjs
```

## Connect your AI client

Register `flutter-device-mcp` as an MCP server in your client's config. For Claude
Code or Cursor, add a server entry (key `flutter`):

```json
{
  "mcpServers": {
    "flutter": {
      "command": "npx",
      "args": ["-y", "flutter-device-mcp"]
    }
  }
}
```

To run from a source checkout instead, point it at the self-building launcher:

```json
{
  "mcpServers": {
    "flutter": {
      "command": "node",
      "args": ["/absolute/path/to/flutter-device-mcp/scripts/run.mjs"]
    }
  }
}
```

**Restart your client** after editing the config so it loads the tools.

## Zero-config

There is usually nothing to configure. `flutter-device`:

- **Finds your app** by walking up from the current directory to the nearest
  `pubspec.yaml`.
- **Detects fvm** via a `.fvmrc` (or `.fvm/` pin) and, when present, uses
  `fvm flutter` so device discovery matches your project's pinned SDK.
- **Derives the app/bundle id** best-effort from the native project files, for
  uninstall and lifecycle operations.

Run `flutter-device info` to see the **fully-resolved config with provenance** —
the `appDir` and where it came from, the `defaultPlatform` and its source, and the
config-file path (if any):

```bash
flutter-device info
```

## Configuration

Every setting is resolved with this precedence (highest wins), applied per
setting:

1. an explicit **flag / MCP arg** (`--app-dir`, `--platform`, …),
2. an **environment variable**,
3. a **`flutter-device.config.json`** file (searched upward from the cwd),
4. **derivation** from the Flutter project itself.

If none of them yields an app dir, the tool errors and tells you how to set one.

### Environment variables

All variables use the `FLUTTER_DEVICE_` prefix (`<PLATFORM>` is one of
`IOS`, `ANDROID`, `TIZEN`, `TVOS`, `WEBOS`):

| Variable | Purpose |
|----------|---------|
| `FLUTTER_DEVICE_APP_DIR` | Path to the Flutter app (overrides the upward search) |
| `FLUTTER_DEVICE_CONFIG` | Explicit path to the config file |
| `FLUTTER_DEVICE_DEFAULT_PLATFORM` | Platform used when a call omits `platform` |
| `FLUTTER_DEVICE_<PLATFORM>_DEVICE` | Device pin (id / name / address) for a platform |
| `FLUTTER_DEVICE_<PLATFORM>_APP_ID` | App / bundle id for a platform |
| `FLUTTER_DEVICE_ANDROID_LAUNCH_MODE` | `debug` \| `profile` \| `release` (default Android mode) |
| `FLUTTER_DEVICE_TIZEN_PROFILE` | Tizen device profile for `flutter-tizen build` |
| `FLUTTER_DEVICE_TIZEN_SDK_PATH` | Tizen SDK data dir (the folder containing `platforms/`) for the rootstrap precheck; else `$TIZEN_SDK` / common locations |
| `FLUTTER_DEVICE_TIZEN_API_VERSION` | Tizen api-version to target (e.g. `8.0`); else read from `tizen/tizen-manifest.xml` |
| `FLUTTER_DEVICE_TIZEN_SECURITY_PROFILE` | Security profile name to sign the TPK with (`-s`); else the active profile |
| `FLUTTER_DEVICE_TVOS_FLUTTER_BIN` | Directory holding the `flutter-tvos` bin (prepended to PATH) |
| `FLUTTER_DEVICE_IDB_PATH` | Path to the `idb` binary (iOS system prompts) |
| `FLUTTER_DEVICE_PYMOBILEDEVICE3` | Path to `pymobiledevice3` (iOS physical capture) |
| `FLUTTER_DEVICE_FFMPEG` | Path to `ffmpeg` (recording / gif encode) |

`APPLE_TV_DEVICE` is also honored as a tvOS device pin fallback, so a value you
already set for other Apple TV tooling is picked up without duplicating it under
the `FLUTTER_DEVICE_` prefix.

### `flutter-device.config.json`

A checked-in config file keeps team defaults in one place. Every field is
optional. Each platform under `platforms` accepts `device`, `appId`, and
`preBuild` (an array of shell commands run in order, from `appDir`, **before** the
build — the **fork-free extension point** for app-specific steps such as compiling
a native engine); plus `tizenProfile` / `securityProfile` / `sdk` (Tizen),
`androidLaunchMode` (Android), and `flutterTvosBinDir` (tvOS).

**Tizen notes.** A Tizen TV is reached over the network, so `sdb` won't list it
until connected — set `device` to the TV's IP and the tool **auto-runs
`sdb connect <ip>:26101`** on first use (no manual `setup` needed). Before a build,
it runs a **rootstrap precheck**: `flutter-tizen build tpk` needs a Tizen SDK
device rootstrap matching the app's `tizen-manifest.xml` `api-version`, and when
it's missing the tool fails fast with exact guidance (install that SDK version via
the VS Code *Tizen: Package Manager*, or set `sdk.apiVersion` to a version you have
installed) instead of a deep build error. `flutter-device info --platform tizen`
shows the rootstrap status and doubles as a Tizen SDK doctor.

```json
{
  "appDir": "./",
  "defaultPlatform": "ios",
  "platforms": {
    "ios": {
      "device": "My iPhone",
      "appId": "com.example.myapp"
    },
    "android": {
      "appId": "com.example.myapp",
      "androidLaunchMode": "profile"
    },
    "tizen": {
      "device": "192.168.1.42",
      "tizenProfile": "tv",
      "securityProfile": "my-dev-profile",
      "sdk": {
        "dataPath": "~/tizen-studio/data",
        "apiVersion": "8.0"
      },
      "preBuild": [
        "cargo build --release --manifest-path native/engine/Cargo.toml",
        "cp native/engine/target/release/libengine.so tizen/lib/"
      ]
    },
    "tvos": {
      "flutterTvosBinDir": "/opt/flutter-tvos/bin"
    },
    "webos": {
      "device": "lg-tv",
      "preBuild": ["./tools/package-webos.sh"]
    }
  }
}
```

## CLI usage

```
flutter-device <command> [--platform <ios|android|tizen|tvos|webos>] [--app-dir <dir>] [flags]
```

Commands:

| Command | What it does |
|---------|--------------|
| `info` | Device + environment status and resolved config (with provenance) |
| `setup` | Prepare the device for development (`--device-ip <host>`) |
| `build` | Build the app package (`--profile`, `--debug`, `--target`, `--install`, `--run`) |
| `deploy` | Install + launch, capture the VM Service URI (**the key command**) |
| `uninstall` | Remove the app from the device |
| `kill-stale` | Kill stale launch/driver processes holding the device lock |
| `terminate` | Force-quit the app (mobile) |
| `background` | Send the app to the background without killing it (mobile) |
| `foreground` | Bring the app back to the foreground (mobile) |
| `hot-reload` | Real hot reload on the running app |
| `hot-restart` | Hot restart (re-run `main()`) on the running app |
| `screenshot` | Capture the screen to a PNG (`--output-path`, `--include-base64`) |
| `record` | Record a bounded screen clip (`--duration-s`, `--fps`, `--format mp4\|gif`) |
| `set-input-mode` | Select the input plane (`--mode dpad\|pointer`) — TV |
| `key` | Send a remote/navigation key (`--key UP\|DOWN\|ENTER\|…`) — TV |
| `pointer` | Drive the pointer (`--action move\|click\|scroll`, `--x --y --dy`) — TV |
| `system-prompt` | Detect/tap OS dialogs (`--action detect\|tap\|dismiss`) — iOS |

Every command prints a JSON result and exits non-zero on failure, so scripts can
gate on it.

Examples:

```bash
# Deploy to iOS and print the captured VM Service URI
flutter-device deploy --platform ios

# See the fully-resolved config and device status
flutter-device info

# Reinstall + relaunch an existing Tizen build in debug
flutter-device deploy --platform tizen --debug

# Record a 10s clip from the running Android app
flutter-device record --platform android --duration-s 10 --output-path ./demo.mp4
```

## MCP tools

The server advertises **17 tools**. Each takes an optional `platform` arg
(`ios` | `android` | `tizen` | `tvos` | `webos`); omit it to use the default
platform from your config.

| Tool | Summary |
|------|---------|
| `flutter_info` | Device + environment status and resolved config with provenance |
| `flutter_setup` | Prepare the device for development |
| `flutter_build` | Build the app package |
| `flutter_deploy` | **Install + launch through a pty and return the captured `ws://…/ws` VM Service URI** to hand to a driver. Runs the guardrails: kills stale drivers first, recovers from `ENOSPC`, records the launch for hot reload/restart, and probes whether the build is Marionette-drivable |
| `flutter_uninstall` | Remove the app from the device |
| `flutter_kill_stale` | Kill stale launch/driver processes holding the device lock |
| `flutter_hot_reload` | Real hot reload on the running app |
| `flutter_hot_restart` | Hot restart (re-run `main()`) on the running app |
| `flutter_screenshot` | Capture the screen |
| `flutter_record` | Record a bounded screen clip |
| `flutter_terminate` | Force-quit the app (mobile) |
| `flutter_background` | Background the app without killing it (mobile) |
| `flutter_foreground` | Foreground the app again (mobile) |
| `flutter_set_input_mode` | Select the input plane (dpad/pointer) — TV |
| `flutter_key` | Send a remote/navigation key — TV |
| `flutter_pointer` | Drive the pointer (move/click/scroll) — TV |
| `flutter_system_prompt` | Detect/tap OS-level dialogs — iOS |

## Per-platform prerequisites

- **iOS** — macOS with Xcode command-line tools (`xcrun devicectl` / `simctl`) and
  `flutter`. Optional: `idb` for system-prompt handling; `pymobiledevice3` +
  `ffmpeg` for capture on physical devices.
- **Android** — `adb` and `flutter` on PATH.
- **Tizen** — `flutter-tizen`, `sdb`, and a Tizen device in **Developer Mode**.
- **tvOS** — the `flutter-tvos` toolchain and Xcode.
- **webOS** — the `ares` SDK.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # jest
npm run inspector  # launch the MCP Inspector against dist/index.js
```

## License

MIT © SupposedlySam
