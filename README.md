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

| Platform | Deploy + VM URI | Hot reload/restart | Lifecycle (bg/fg/kill) | Screenshot | Record | System prompt | OS input (key/pointer) | Screen geometry | Deep links |
|----------|:---------------:|:------------------:|:----------------------:|:----------:|:------:|:-------------:|:----------------------:|:---------------:|:----------:|
| **iOS** | ✅ | ✅ | ✅ | ✅ ¹ | ✅ ² | ✅ ³ | ❌ ⁴ | ❌ | ⚠️ ¹⁶ |
| **Android** | ✅ | ✅ | ✅ | ✅ | ✅ ⁵ | ❌ | ✅ ¹⁴ | ✅ ¹⁵ | ✅ |
| **Tizen** (Samsung) | ✅ ⁶ | ✅ | ❌ | ❌ ⁷ | ❌ ⁷ | ❌ | ✅ ⁸ | ❌ | ❌ ⁷ |
| **tvOS** (Apple TV) | ✅ ⁹ | ✅ | ✅ | ⚠️ ¹⁰ | ❌ | ❌ | ❌ ¹¹ | ❌ | ⚠️ ¹⁶ |
| **webOS** (LG) | ⚠️ ¹² | ⚠️ | ❌ | ❌ | ❌ | ❌ | ⚠️ ¹³ | ❌ | ❌ |
| **macOS** | ⚠️ ¹⁷ | ❌ ¹⁸ | ✅ ¹⁹ | ✅ ²⁰ | ❌ | ❌ | ✅ ²¹ | ✅ ²² | ❌ |

**iOS is the most mature, best-tested path; Android is well-supported.** Both use
standard Flutter / `adb` / `xcrun` tooling. **Tizen, tvOS, and webOS depend on
community toolchains and are experimental — on-device verifications and
contributions are very welcome. macOS drives a prebuilt signed `.app` rather
than building one, and its stage-and-launch path is covered by mocked tests
only — real-app verification is welcome too.**

<sub>
¹ Simulator natively; physical devices need `pymobiledevice3`.
² Simulator produces an mp4; physical capture is a choppy (~1–3 fps) screenshot burst.
³ Simulator only, via `idb` over the accessibility tree.
⁴ No OS-level input channel — drive the app with Marionette over the VM service instead.
⁵ Native mp4 via `adb`.
⁶ Via `flutter-tizen run` (the launch that captures the VM URI); build/install is reimplemented on `flutter-tizen` and still needs on-device verification.
⁷ `sdb shell` is disabled on Samsung devices — use the driver's screenshot over the VM service.
⁸ D-pad / pointer over the Samsung remote channel.
⁹ Requires a **profile/release** build on-device; a debug build segfaults.
¹⁰ Simulator screenshot; on-device capture not wired.
¹¹ Siri-remote / focus-driven — drive via Marionette.
¹² Packaging requires a user-provided `preBuild` hook; there is no standard `flutter-webos build`.
¹³ Input over `ssap` is wired but currently device-blocked.
¹⁴ `adb shell input` (keyevent/tap/swipe/text), on devices and emulators. This is the OS-LEVEL plane — raw system input that bypasses Flutter's gesture arena — and the one to reach for FIRST on Android: one adb call, no VM-service round trip, and coordinates in the same device-pixel space as `flutter_screenshot`. Fall back to a VM-service driver for widget addressing, tree assertions, and gesture-arena-sensitive taps; this plane remains the only option for OS UI outside the Flutter view, non-debug builds, and D-pad navigation on Android TV. See [Which driver first](#which-driver-first).
¹⁵ `adb shell wm size` + `wm density` — the device pixel ratio `flutter_pointer` needs for logical coordinates and refuses to guess.
¹⁶ Simulator only (`simctl openurl`). Apple provides no url-open verb for a physical device — `devicectl` has none and idb is simulator-only — so a physical target reports `{supported:false}` rather than silently doing nothing.
¹⁷ Stages + launches a prebuilt **signed `.app`** (`--app-path`/`--app-url`) via `open -n`; this MCP does not build or sign macOS apps. Nothing is written to the hot-reload/restart launch registry, because there is no VM service to reconnect to.
¹⁸ No Dart VM service exists — `flutter_deploy`'s result carries no `vmServiceUriWs`/`vmServiceUriHttp`, and `marionetteReady` is `null` with a hint that Marionette does not apply here.
¹⁹ Quit/activate by bundle id via `osascript`; "background" activates Finder, since macOS has no OS-level send-to-background verb — losing focus IS backgrounding.
²⁰ **Window-targeted**, never a full-desktop grab — a privacy property, not a framing choice. Needs Screen Recording granted; a denied grant reports `captured:false` rather than a false success.
²¹ `cliclick` — needs Accessibility granted. Because there's no VM service, this **is** the primary driver on macOS, not a fallback plane.
²² Reports the target window's live bounds in points, not a display size — `flutter_geometry` is not Android-only.
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

To run from a source checkout instead, point it at `scripts/run.sh`, not
`run.mjs` directly:

```json
{
  "mcpServers": {
    "flutter": {
      "command": "bash",
      "args": ["/absolute/path/to/flutter-device-mcp/scripts/run.sh"]
    }
  }
}
```

**Why a shim in front of a Node script.** MCP hosts spawn servers from a
non-interactive shell that never sources `~/.zshrc`, so a Node installed via
nvm/fnm/volta is on your PATH and invisible to the spawned server — and
`run.mjs`, being itself a Node script, can't fix that. `run.sh` searches
`NODE_BIN_OVERRIDE`, PATH, nvm, fnm, volta, and the Homebrew/system prefixes
for a Node that actually runs and is `>=18` (a version manager can leave a
dead shim on PATH), then `exec`s `run.mjs`; if none qualifies it exits 127
naming what it looked for. Set `NODE_BIN_OVERRIDE` to an absolute path if your
Node lives somewhere else.

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
| `FLUTTER_DEVICE_PYMOBILEDEVICE3` | Path to `pymobiledevice3` (iOS physical capture) — probed by effect, not merely trusted; a path that is missing, unreadable, or exits zero without actually being `pymobiledevice3` is rejected, and the capture continues with a `pymobiledevice3Warning` naming what was ignored |
| `FLUTTER_DEVICE_FFMPEG` | Path to `ffmpeg` (recording / gif encode) |
| `FLUTTER_DEVICE_PYTHON3` | Path to a `python3` usable for the pty control-channel bridge (hot reload/restart keypress delivery). Probed by importing `pty`, not merely located; without one, deploy carries no control channel and says so via `controlChannelWarning` |
| `FLUTTER_DEVICE_WEBOS_SDK_BIN` | Directory holding the webOS `ares-*` SDK binaries (prepended to PATH) |
| `FLUTTER_DEVICE_CLICLICK_PATH` | Path to the `cliclick` binary (macOS key/pointer input). Searched per-call across `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` plus the inherited PATH otherwise, since a GUI-launched MCP server's PATH often omits Homebrew |
| `FLUTTER_DEVICE_MACOS_APP_PATH` | Default `.app`/`.tar.gz`/`.tgz`/`.dmg` to stage for `flutter_deploy` on macOS |
| `FLUTTER_DEVICE_MACOS_APP_URL` | Default archive URL to fetch and stage, used when no `app_path` is given |
| `FLUTTER_DEVICE_MACOS_PROCESS_NAME` | Pin an **already-running** macOS app by its `CFBundleExecutable` (the name System Events lists it under — not its display name) |
| `FLUTTER_DEVICE_STATE_DIR` | Directory for per-developer durable state — currently the Android pointer stage (`pointer-stage.json`), which lets a staged tap position survive a server restart. Defaults to `~/.config/flutter-device-mcp` |
| `FLUTTER_DEVICE_LOG_DIR` | Redirect the file logger's base directory (default: an OS-appropriate location outside the working directory, e.g. `~/Library/Logs/flutter-device-mcp` on macOS) |
| `FLUTTER_DEVICE_LOG_FILE` | Explicit log file path, overriding `FLUTTER_DEVICE_LOG_DIR` entirely |
| `FLUTTER_DEVICE_LOG_DISABLE` | Disable file logging (`1`/`true`/`yes`/`on`) |
| `FLUTTER_DEVICE_LOG_PER_CWD` | Nest the log directory under a sanitized copy of the current working directory, so multiple projects don't share one log file |

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
flutter-device <command> [--platform <ios|android|tizen|tvos|webos|macos>] [--app-dir <dir>] [flags]
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

The server advertises **19 tools**. Each takes an optional `platform` arg
(`ios` | `android` | `tizen` | `tvos` | `webos` | `macos`); omit it to use the
default platform from your config.

**Per-call device targeting.** `device_udid` is a per-call argument on 11 of
those tools — `flutter_deploy`, `flutter_uninstall`, `flutter_terminate`,
`flutter_background`, `flutter_foreground`, `flutter_screenshot`,
`flutter_open_url`, `flutter_record`, `flutter_key`, `flutter_pointer`, and
`flutter_geometry` — so one call can target a specific device without
changing what every other call resolves to. It beats the platform's env pin
(`FLUTTER_DEVICE_<PLATFORM>_DEVICE`), which beats auto-discovery, and it lasts
exactly one call: an unpinned call afterward goes back to whatever it would
have resolved to anyway. On Android it accepts an adb serial
(`emulator-5554`) or the model name `adb devices -l` reports (`Pixel_7`). A
stale pin self-heals to the live device rather than failing, and says so in
the result's `deviceWarning`, naming whichever of the two — argument or env
var — it came from.

| Tool | Summary |
|------|---------|
| `flutter_info` | Device + environment status and resolved config with provenance |
| `flutter_setup` | Prepare the device for development |
| `flutter_build` | Build the app package. `mode` picks release/profile/debug — reach for `profile` when measuring, since it is AOT-timed *and* keeps the VM service open. `dart_define` passes compile-time constants. macOS: `{supported:false}` — building/signing an arbitrary desktop app is out of scope |
| `flutter_deploy` | **Install + launch through a pty and return the captured `ws://…/ws` VM Service URI** to hand to a driver. Runs the guardrails: kills stale drivers first, recovers from `ENOSPC`, records the launch for hot reload/restart, and probes whether the build is Marionette-drivable. macOS: stages + launches a prebuilt signed `.app` (`app_path`/`app_url`); no VM Service URI exists there |
| `flutter_open_url` | **Open a URL on the device — the deep-link driver.** Drives custom schemes (`myapp://…`) and `https://…` App Links / universal links through the real OS plumbing, so intent-filters and domain associations are actually exercised. Android + Apple **simulators**; a physical iPhone/Apple TV reports `{supported:false}` because Apple provides no url-open verb — see [Deep links](#deep-links-flutter_open_url) |
| `flutter_uninstall` | Remove the app from the device |
| `flutter_kill_stale` | Kill stale launch/driver processes holding the device lock |
| `flutter_hot_reload` | Real hot reload, **confirmed against the flutter tool's own acknowledgement in the launch log** before it is reported — not merely that the keystroke was written. Falls back to a weaker VM-service reload when unconfirmed or when no control channel exists |
| `flutter_hot_restart` | Hot restart (re-run `main()`), confirmed the same way. `confirmed` in the response is `true` (seen), `false` (window passed, nothing seen — reported as `success:false`, since there's no VM-service equivalent to fall back to), or absent (no launch log to watch — `success:true` but the note says UNVERIFIED). Absent means neither of the other two, not "probably fine" |
| `flutter_screenshot` | Capture the screen. macOS: window-targeted, never full-desktop |
| `flutter_record` | Record a bounded screen clip. macOS: not implemented — `{supported:false}` |
| `flutter_terminate` | Force-quit the app (mobile, macOS) |
| `flutter_background` | Background the app without killing it (mobile, macOS) |
| `flutter_foreground` | Foreground the app again (mobile, macOS) |
| `flutter_set_input_mode` | Select the input plane (dpad/pointer) — TV |
| `flutter_key` | Send a remote/navigation key, or type text into the focused field — Android, Tizen, webOS, macOS. See [Which driver first](#which-driver-first) |
| `flutter_pointer` | Drive the pointer (move/click/scroll) — Android, Tizen, webOS, macOS. `click` takes `x`/`y` directly, so a tap is one call. See [Which driver first](#which-driver-first) |
| `flutter_geometry` | **Report the screen's real size and device pixel ratio** so `flutter_pointer`'s logical coordinates are read rather than guessed. Optionally cross-checks a supplied Flutter view size and warns when the ratio cannot be right — Android, macOS |
| `flutter_system_prompt` | Detect/tap OS-level dialogs — iOS |

## Which driver first

An in-app driver over the Dart VM service (for example
[Marionette](https://pub.dev/packages/marionette_mcp)) and this server's own
`flutter_key`/`flutter_pointer` are not equally fast everywhere, and starting
with the VM-service driver by default is wrong on three of the five wired
platforms — it costs a round trip to the VM service plus a coordinate
conversion every time. Reach for the fastest plane that can do the job, and
fall back only for what it genuinely cannot reach:

| Platform | Reach for FIRST | Fall back to | Why |
|---|---|---|---|
| **Android** | `flutter_key` (BACK/HOME/D-pad/`text:`) and `flutter_pointer` (tap/scroll) | A VM-service driver, for widget addressing by key/text, reading the tree, and gesture-arena-sensitive taps | One `adb` call, no VM round trip. Coordinates are **device pixels — the same space `flutter_screenshot` returns** — so a coordinate read off a screenshot sends as-is |
| **Tizen** | `flutter_key` to move focus, then `flutter_pointer click` to activate it | A VM-service driver's `tap`, for a genuine coordinate tap (the only path that reaches gesture handlers) | The appliance is focus/D-pad-driven; `flutter_pointer` move/scroll is unsupported and says so |
| **iOS** | A VM-service driver (tap/enter_text/scroll) | — | `flutter_key`/`flutter_pointer` report `{supported:false}`; there is no OS-level input plane wired here |
| **macOS** | `flutter_pointer` / `flutter_key` / `flutter_screenshot` | — | There is no Dart VM service, so these **are** the driver |
| **tvOS** | A VM-service driver over the loopback service | — | Siri-Remote / focus-driven; no free cursor to drive at the OS level |

**The coordinate-space trap, stated once.** On Android and Tizen,
`flutter_screenshot` and `flutter_pointer` both speak **device pixels**. A
VM-service driver like Marionette speaks **logical** coordinates. Sending a
screenshot-derived coordinate to it without converting by the device pixel
ratio is the most common mis-tap in this codebase's history — and is why the
OS-level plane is preferred for position-based input rather than merely
allowed. `flutter_pointer` accepts `coordinateSpace: "logical"` with an
explicit `dpr` when you do want VM-service-style logical coordinates;
`flutter_geometry` reports the real ratio so `dpr` never has to be guessed.

**A scroll reports the gesture it sent (Android), under `gesture`.** A swipe
has two independent variables and `dy` only reaches one of them, which made an
ineffective scroll indistinguishable from a working one:

- **Distance is bounded by the screen.** The swipe runs from the anchor to the
  screen edge and no further, so `dy: 9000` from `y=1600` travels 1600px, not
  9000. `gesture.requestedDy` vs `gesture.appliedDy` and `gesture.clamped` say
  so instead of leaving you to infer it.
- **Past that bound, a bigger `dy` buys speed, not distance.** The duration is
  fixed, so the same travel in the same time — a larger `dy` emits the
  *byte-identical* command. "It didn't scroll, ask for more" is not a fix, and
  it is the natural first reaction, so the response says this in
  `gesture.notes`.
- **`duration_ms` is the variable you actually want** (default 300, max
  10000). It is the gesture's speed: short is a flick that carries fling
  velocity into the app, long is a slow drag. A scrollable that ignores one can
  accept the other, so this is the first thing to change when the swipe lands
  but nothing moves — try 600–800. `gesture.speedPxPerMs` reports the result.
- **`verify: true`** fingerprints the screen on-device (`screencap | md5sum`,
  both sides of the pipe running there, so only a digest crosses the wire)
  before and after, and reports `gesture.verification`. Read the three states
  asymmetrically: `unchanged` is strong evidence the gesture did nothing *and
  that the input plane is fine* (so nobody goes hunting a dead Dart VM
  service), `changed` is weak (a clock or animation also counts), and
  `unavailable` means the check could not run and says nothing either way.

The default duration stays 300ms deliberately. A slower drag is not strictly
better — it carries less velocity, so a surface that relies on fling momentum
travels further at the current speed than at a slower one, and raising the
default to rescue one surface would quietly shorten every scroll that works
today.

**Provenance.** The Android, iOS and Tizen rows above were verified on a
device in the sibling codebase this server tracks (not re-run in this repo):
BACK popped three routes on a physical Android handset and a move-plus-click
at screenshot-read device pixels landed on the intended tab; iOS's key/pointer
verbs returned `{supported:false}`; Tizen's pointer move returned
`{supported:false}`, pointing at the key verb. The macOS and tvOS rows come
from the recorded platform model rather than a verified session, there too.
The scroll behaviour above was measured the same way — on a physical handset in
that sibling codebase, where a bottom sheet refused seven consecutive scrolls at
increasing `dy` (every one of them the byte-identical command) and moved on the
first try at an explicit 600ms duration. Why a fast drag can do nothing on such
a surface was never measured, and nothing here claims to know.

## Deep links (`flutter_open_url`)

A deep link is reachable only by *following* a link, so testing one otherwise
means hand-rolling `adb shell am start` — or, on a physical iPhone, tapping a
link by hand and giving up on the automated run.

```bash
flutter_open_url platform=android url='myapp://details?id=42'
flutter_open_url platform=android url='https://example.com/details?id=42'
flutter_open_url platform=ios target=simulator url='https://example.com/details?id=42'
```

This hands the URL to the **OS**, so the app's real intent-filter / URL-scheme /
universal-link association runs. It is not in-app navigation — that belongs to a
VM-service driver such as Marionette.

| Platform | Support |
| --- | --- |
| **Android** (device + emulator) | Full — `adb shell am start -a android.intent.action.VIEW -d <url> <pkg>` |
| **iOS / tvOS simulator** | Full — `xcrun simctl openurl <udid> <url>` |
| **iOS / tvOS physical device** | `{supported:false}` — no Apple automation path exists |
| **Tizen / webOS** | `{supported:false}` — `sdb shell` is disabled on Samsung devices |

**Why a physical iPhone/Apple TV can't do this.** Checked against the toolchain,
not assumed: `xcrun devicectl device` exposes copy / info / install /
notification / orientation / process / reboot / sysdiagnose / uninstall and **no**
url-open verb, and idb's `open`/`ui` commands reject a physical target
("Target doesn't conform to FBSimulatorLifecycleCommands protocol"). The tool
reports the gap rather than silently doing nothing — a no-op there reads as
"the deep link is broken" and sends you debugging the app.

**Apple targets are physical-first, so pass `target: "simulator"`.** Otherwise,
on a host with a paired iPhone or Apple TV, the call resolves the physical device
and correctly returns `{supported:false}` — the working path would be
unreachable.

**Android scoping.** The VIEW intent defaults to the project's resolved
application id, because an unscoped https link can raise a browser-vs-app
disambiguation chooser that an automated run cannot answer — the call then looks
like a hang rather than a failure. Pass `package_or_bundle_id: ""` to go unscoped
on purpose (what a real user tap does).

**`am` lies about success.** It reports a refused intent on STDOUT while still
exiting 0, so the output is classified rather than trusting the exit code. An
unresolvable link comes back as a failure naming the App Links /
`assetlinks.json` requirement. The very common
`Warning: Activity not started, intent has been delivered to currently running
top-most instance.` is treated as **success** — it is just re-delivery to an
already-foregrounded app, which is what firing several links in a row looks like.

## Per-platform prerequisites

- **iOS** — macOS with Xcode command-line tools (`xcrun devicectl` / `simctl`) and
  `flutter`. Optional: `idb` for system-prompt handling; `pymobiledevice3` +
  `ffmpeg` for capture on physical devices.
- **Android** — `adb` and `flutter` on PATH.
- **Tizen** — `flutter-tizen`, `sdb`, and a Tizen device in **Developer Mode**.
- **tvOS** — the `flutter-tvos` toolchain and Xcode.
- **webOS** — the `ares` SDK.
- **macOS** — a prebuilt, **signed** `.app` you supply (this MCP does not build
  or sign one), plus [`cliclick`](https://github.com/BlueM/cliclick)
  (`brew install cliclick`) for key/pointer input. Needs Accessibility granted
  to the process that launched the MCP server (not to `cliclick` itself —
  macOS attributes synthetic-input permission to the responsible parent) for
  input, and Screen Recording granted for `flutter_screenshot`. Both fail
  **silently** without the grant (`cliclick`/`screencapture` exit 0 and do
  nothing useful), so `flutter_info` probes both by effect and names which
  process needs which grant — run it first on this platform.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # jest
npm run inspector  # launch the MCP Inspector against dist/index.js
```

## License

MIT © SupposedlySam
