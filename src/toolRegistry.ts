/**
 * Pure tool-advertisement registry: builds the `flutter_*` tools exactly as the
 * MCP ListTools handler advertises them — with no dependency on the `Server` or a
 * transport, so the advertised list can be unit-tested directly.
 *
 * This is the ListTools counterpart to {@link ../toolRouting}: the CANONICAL
 * routing table (call-time) and this advertised list (list-time) are maintained
 * separately and can drift, so tests assert them against each other. Mirrors how
 * `toolRouting`/`handlerLogic` were extracted from the server for testability.
 */

/** A single advertised MCP tool entry (name + description + JSON input schema). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The advertised tool list. */
export interface ToolList {
  flutter: ToolDefinition[];
}

const platformProp = {
  platform: {
    type: "string",
    enum: ["tizen", "webos", "ios", "android", "tvos", "auto"],
    description:
      "Target platform. 'tizen' (Samsung TV/monitor via flutter-tizen + sdb), 'webos' (LG TV via ares — EXPERIMENTAL/stub), 'ios' (iPhone/iPad or simulator via xcrun devicectl/simctl + flutter), 'android' (device/emulator via adb + flutter), or 'tvos' (Apple TV via flutter-tvos + xcrun — EXPERIMENTAL; on-device requires a PROFILE/RELEASE build, since a standalone debug launch segfaults, and its VM-service URI is a `ws://127.0.0.1:<port>/<authCode>=/ws` loopback forward held open by the launch process over the CoreDevice tunnel). Defaults to the configured `defaultPlatform` (falls back to ios).",
  },
};

/**
 * The per-call project override, advertised on the tools that operate on a
 * Flutter project (build/deploy/info/uninstall/kill_stale/hot_reload/hot_restart).
 * Input and device-driving tools are left off it deliberately: they act on a
 * DEVICE, not a checkout, and re-resolving a project for them would only invite
 * a caller to think it mattered.
 */
const appDirProp = {
  app_dir: {
    type: "string",
    description:
      "Optional absolute path to a Flutter app (the directory containing pubspec.yaml) to operate on for THIS call — for building/deploying/inspecting a DIFFERENT project or git worktree while a running server would otherwise stay pinned to the one it resolved at startup, with no host restart. Overrides the env var, the flutter-device.config.json file, and the derived app dir (precedence: this arg > env > config file > derived). Must be an existing Flutter app or the call fails with a clear error — it never silently falls back to the server's own project. The whole request runs against it: device resolution, install, VM-service capture, kill-stale.",
  },
};

function buildFlutterTools(): ToolDefinition[] {
  return [
    {
      name: "flutter_info",
      description:
        "Run the platform info command and return device/environment status (flutter-tizen, sdb, Docker, connected devices, .tizen-target config, and the REST-sourced device summary). GUARDRAIL: sdb shell is never invoked (it is disabled/unreliable on Samsung devices); device facts come from the Samsung REST API on port 8001, which the CLI already handles.",
      inputSchema: {
        type: "object",
        properties: { ...platformProp, ...appDirProp },
      },
    },
    {
      name: "flutter_setup",
      description:
        "Configure the device for development and write <appDir>/.tizen-target (Tizen). Optionally connect to a device IP first.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          device_ip: {
            type: "string",
            description:
              "Optional device IP (or host:26101) to connect to before setup. Normalized to the bare host — the CLI appends :26101 itself. Non-default ports are rejected.",
          },
        },
      },
    },
    {
      name: "flutter_build",
      description:
        "Build the app package. Any app-specific pre-build steps (e.g. compiling a native engine) are configured via the `preBuild` hook in flutter-device.config.json and run first. Returns the tail of the build output plus the built package path and detected failure signatures (Install failed / No space left on device). WARNING: passing `run: true` installs AND launches the app, which SEIZES the physical TV/monitor display. This can run long (pre-build hooks + package build).",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...appDirProp,
          dart_define: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "`--dart-define` compile-time constants as a {KEY: VALUE} map — how an app is pointed at a different environment (a local backend, a staging API, a build-time flag). Each pair becomes `--dart-define=KEY=VALUE`. On iOS/Android the install happens INSIDE `flutter run`, so these are spliced into the LAUNCH as well as the build; without that the app that actually runs would be compiled without them. On Tizen the launch reuses an already-built package, so defines apply at BUILD time only — build with the same defines you deploy. Keys cannot contain '=' or whitespace or start with '-' (they would be re-parsed as different arguments) and are rejected with a clear error.",
          },
          profile: {
            type: "string",
            description: "Device profile (tv, mobile, wearable). Defaults to tv.",
          },
          mode: {
            type: "string",
            enum: ["release", "profile", "debug"],
            description:
              "The 3-way build mode, and the PREFERRED way to ask for one. 'release' = AOT, NO Dart VM service (not drivable). 'profile' = AOT with REALISTIC timing but the VM service stays OPEN — the mode to use for any measurement, since a debug build's JIT slowdown makes its numbers meaningless and a release build cannot be connected to at all. 'debug' = JIT, VM service open (the classic Marionette path). Wins over the legacy `debug` boolean when both are given; when omitted, falls back to `debug` (true→debug, else release). Honored on Tizen, Android, and iOS.",
          },
          debug: {
            type: "boolean",
            description:
              "Build in debug mode. Legacy 2-way shorthand for `mode` (which wins when both are set); it cannot express `profile`. When false/omitted, builds release (Tizen/iOS). ANDROID: the mode follows the same resolution as the launch — explicit true→debug, false→profile; when OMITTED it uses FLUTTER_DEVICE_ANDROID_LAUNCH_MODE (debug|profile|release), defaulting to DEBUG so the built apk is coherent with the debug launch a plain flutter_deploy performs (Marionette is gated on kDebugMode).",
          },
          skip_rust: {
            type: "boolean",
            description:
              "Skip the native pre-build hook (reuse the existing native artifact).",
          },
          skip_flutter: {
            type: "boolean",
            description: "Skip the Flutter package build (reuse the existing package).",
          },
          install: {
            type: "boolean",
            description: "Install the package on the device after building.",
          },
          run: {
            type: "boolean",
            description:
              "Install AND launch after building. SEIZES the physical display. Note: this launch uses inherited stdio so the VM Service URI is NOT captured — use flutter_deploy to capture the URI for Marionette.",
          },
          target: {
            type: "string",
            enum: ["simulator", "device"],
            description:
              "iOS ONLY: which slice to build. 'simulator' builds the iphonesimulator slice (for a booted simulator); 'device' builds for a physical device. Lets a simulator UI walkthrough build for the sim even when a physical iPhone is attached, WITHOUT a host reload. Ignored on Tizen (use `profile` there). When omitted, iOS builds for a physical device.",
          },
        },
      },
    },
    {
      name: "flutter_deploy",
      description:
        "THE KEY TOOL. Installs the already-built package and launches the app in DEBUG, then returns the Dart VM Service `ws://…/ws` URI for Marionette to connect to. Kills any stale `flutter-tizen` / `flutter run` processes first (one deploy at a time — concurrent installs wedge the device lock). Recovers from a full device (No space left on device / Install failed) by uninstalling and retrying the install once. The launch runs through a pty (so flutter line-flushes the URI), backgrounded, and is LEFT RUNNING to hold the VM service open. A device pin that is not currently an online device (stale — e.g. the device moved DHCP address) is ignored in favor of the first online device, noted via `deviceWarning` in the response. WARNING: launching SEIZES the physical TV/monitor display. NOTE: Marionette coordinates are LOGICAL (e.g. 1200x675), not screenshot pixels.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...appDirProp,
          dart_define: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "`--dart-define` compile-time constants as a {KEY: VALUE} map — how an app is pointed at a different environment (a local backend, a staging API, a build-time flag). Each pair becomes `--dart-define=KEY=VALUE`. On iOS/Android the install happens INSIDE `flutter run`, so these are spliced into the LAUNCH as well as the build; without that the app that actually runs would be compiled without them. On Tizen the launch reuses an already-built package, so defines apply at BUILD time only — build with the same defines you deploy. Keys cannot contain '=' or whitespace or start with '-' (they would be re-parsed as different arguments) and are rejected with a clear error.",
          },
          no_launch: {
            type: "boolean",
            description:
              "Install only; do not launch and do not capture a URI.",
          },
          mode: {
            type: "string",
            enum: ["release", "profile", "debug"],
            description:
              "The 3-way mode of the artifact to redeploy, and the PREFERRED way to ask for one. On Tizen this reinstalls the EXISTING package of that mode (skipping the long native/TPK rebuild) and relaunches via `flutter-tizen run --no-build --<mode>` — so `mode` MUST match the package you built, or --no-build has nothing of that mode to reuse. 'profile' = AOT with realistic timing AND the VM service open, so this STILL captures and returns the ws://…/ws URI — the point of a profile deploy. 'debug' = JIT, VM service open. 'release' = no VM service, so no URI is captured. Wins over the legacy `debug` boolean.",
          },
          debug: {
            type: "boolean",
            description:
              "Reinstall the DEBUG artifact instead of release. Legacy 2-way shorthand for `mode` (which wins when both are set); it cannot express `profile`. On Tizen this redeploys the existing debug TPK (skipping the long native/TPK rebuild) so a debug build can be relaunched for Marionette. On ANDROID this selects the `flutter run` launch mode: explicit true→--debug, false→--profile; when OMITTED it uses FLUTTER_DEVICE_ANDROID_LAUNCH_MODE (debug|profile|release), defaulting to DEBUG so a plain deploy comes up Marionette-drivable (Marionette is gated on kDebugMode — a profile/release launch registers no ext.flutter.marionette.* extension, matching the iOS debug default). Inert on platforms that don't distinguish a debug install artifact.",
          },
          timeout_ms: {
            type: "number",
            description:
              "Max time to wait for the VM Service URI to appear (default 180000).",
          },
          target: {
            type: "string",
            enum: ["simulator", "device"],
            description:
              "iOS ONLY per-call target selection: 'simulator' deploys to the booted simulator (booted-first) EVEN WHEN a physical iPhone is attached — the fix for the device-first default that made a simulator UI walkthrough impossible without a host reload; 'device' forces a physical device. Ignored on Tizen/webOS/Android (they don't distinguish the kind here). When omitted, iOS is physical-first.",
          },
          device_udid: {
            type: "string",
            description:
              "iOS ONLY: pin a SPECIFIC target for THIS call by id (a flutter id, a devicectl id, or a device/simulator name), overriding the FLUTTER_DEVICE_IOS_DEVICE env pin without a host reload. Combine with `target` or use alone. For a simulator the flutter id equals the simctl UUID.",
          },
        },
      },
    },
    {
      name: "flutter_uninstall",
      description:
        "Uninstall the app (`sdb -s <device> uninstall <app_id>` on Tizen) to free device space or reset to a clean state. Soft-succeeds when the app is not installed.",
      inputSchema: {
        type: "object",
        properties: { ...platformProp, ...appDirProp },
      },
    },
    {
      name: "flutter_kill_stale",
      description:
        "Kill any stale launch/driver processes (pkill -f). On Tizen: `flutter-tizen`. On iOS/Android: `flutter run` and the Dart `frontend_server`. Use to clear a wedged device lock before deploying. This is also run automatically at the start of flutter_deploy.",
      inputSchema: {
        type: "object",
        properties: { ...platformProp, ...appDirProp },
      },
    },
    {
      name: "flutter_terminate",
      description:
        "OS-level lifecycle: force-quit the app on the resolved device (iOS: xcrun simctl/devicectl terminate; Android: adb shell am force-stop). MOBILE capability — on TV platforms (Tizen/webOS) this returns {supported:false}. The app's Dart VM service is gone after termination; redeploy to get a fresh URI for Marionette.",
      inputSchema: { type: "object", properties: { ...platformProp } },
    },
    {
      name: "flutter_background",
      description:
        "OS-level lifecycle: send the app to the BACKGROUND without killing it (iOS: foreground the neutral com.apple.Preferences app; Android: HOME keyevent via adb). Exercises the app's didEnterBackground/onPause path for lifecycle testing while keeping its VM service alive. MOBILE capability — Tizen/webOS return {supported:false}.",
      inputSchema: { type: "object", properties: { ...platformProp } },
    },
    {
      name: "flutter_foreground",
      description:
        "OS-level lifecycle: bring the app back to the FOREGROUND by relaunching it (iOS: xcrun simctl/devicectl launch by bundle id; Android: adb monkey LAUNCHER intent by package). Exercises didBecomeActive/onResume. Pair with flutter_background for background→foreground lifecycle testing. MOBILE capability — Tizen/webOS return {supported:false}.",
      inputSchema: { type: "object", properties: { ...platformProp } },
    },
    {
      name: "flutter_hot_reload",
      description:
        "FAST INNER LOOP. Trigger a REAL Dart hot reload on the app already running from flutter_deploy — seconds, not the minutes a full flutter_build + flutter_deploy takes. Preserves app state, recompiles changed Dart, and reassembles the widget tree. PREFERRED PATH: writes `r` to the running flutter daemon's stdin over a durable pty control channel (a FIFO recorded at deploy time) — the flutter tool's own hot reload. If no live control channel exists (a launch from before this feature, or a dead daemon), it FALLS BACK to the VM-service reloadSources+reassemble path (weaker — reloads sources in place; the response's `fellBackFrom` says why). flutter_deploy must have been run first; if no live daemon is recorded this returns a clear {triggered:false} telling you to deploy. Some changes can't be hot-reloaded (new enums/static fields, changes to main(), top-level/global state) — use flutter_hot_restart for those. NOTE: Marionette also exposes a hot_reload, but it is only a reassemble (no Dart recompile); the pty `r` here is the real path.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...appDirProp,
          device: {
            type: "string",
            description:
              "Optional device target to disambiguate when multiple devices have been deployed to. Defaults to the most recent launch for the platform.",
          },
          timeout_ms: {
            type: "number",
            description:
              "Max time to wait for the VM service to answer on the fallback path (default 20000).",
          },
        },
      },
    },
    {
      name: "flutter_hot_restart",
      description:
        "Hot RESTART the app already running from flutter_deploy: re-runs main() and DISCARDS in-memory state, while KEEPING the process, its Dart VM Service ws://…/ws URI, and any Marionette connection ALIVE (no redeploy, no new URI to reconnect). Use this for changes a hot reload can't apply — changes to main(), top-level/global/static state, new enums, or app-wide initialization. This is driven by writing `R` to the running flutter daemon's stdin over the pty control channel established at deploy time — it IS reachable this way (unlike over the raw VM service, where re-running main() is not exposed). Requires a live control channel: if the launch recorded none (older launch) or the daemon has exited, this returns a clear {triggered:false} telling you to redeploy with flutter_deploy (which re-establishes the channel). NOTE: Marionette's hot_reload is only a reassemble; there is no Marionette hot-restart — this tool is the restart path.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...appDirProp,
          device: {
            type: "string",
            description:
              "Optional device target to disambiguate when multiple devices have been deployed to. Defaults to the most recent launch for the platform.",
          },
        },
      },
    },
    {
      name: "flutter_screenshot",
      description:
        "Capture the current device/app screen to a PNG on disk and return the absolute saved path (optionally the base64 bytes too). PER-PLATFORM capture reality (encoded so you don't re-derive it): iOS SIMULATOR — reliable via `xcrun simctl io <udid> screenshot` (the primary iOS path; a booted simulator is picked automatically); iOS PHYSICAL device — `pymobiledevice3 developer dvt screenshot` (verified live: captures a real PNG over a no-root userspace tunnel on iOS 17+, no sudo; requires the Developer Disk Image to be mounted, which Xcode does automatically). Requires `pymobiledevice3` on the host (`pipx install pymobiledevice3`, or a venv; override its path with FLUTTER_DEVICE_PYMOBILEDEVICE3); ONLY if it is not installed does the physical path return {supported:false} with an install hint. Android — `adb -s <serial> exec-out screencap -p`; tvOS SIMULATOR — simctl (physical Apple TV returns {supported:false}); Tizen/webOS — {supported:false} (no clean path — `sdb shell` is DISABLED on Samsung devices, so no device-side screencap; use Marionette take_screenshots over the VM service for the Flutter view). When output_path is omitted the PNG is written to a predictable temp path that is returned.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          output_path: {
            type: "string",
            description:
              "Absolute path to write the PNG to. When omitted, a predictable temp path is used and returned as savedPath.",
          },
          include_base64: {
            type: "boolean",
            description:
              "When true, also return the PNG bytes base64-encoded inline (in addition to the saved path). Default false.",
          },
        },
      },
    },
    {
      name: "flutter_record",
      description:
        "Record a bounded screen CLIP (video/gif) to a file and return the absolute saved path — for before/after captures. DURATION-BOUNDED: it records `duration_s` seconds then stops cleanly. PER-PLATFORM reality (encoded so you don't re-derive it): Android (best) — native mp4 via `adb shell screenrecord`, SIGINT'd on-device to flush, then pulled (no ffmpeg needed for mp4); iOS SIMULATOR — native mp4 via `xcrun simctl io recordVideo`; iOS PHYSICAL device — NO native recorder, so a screenshot BURST is assembled with ffmpeg (realistically only ~1–3 fps and CHOPPY because each dvt screenshot takes ~0.3–1s — a documented tradeoff, not a bug; needs pymobiledevice3 + ffmpeg); tvOS/Tizen/webOS — {supported:false} (no validated recording path; use Marionette take_screenshots over the VM service for the Flutter view). `format` 'gif' ALWAYS needs ffmpeg (native recorders emit mp4 only); absent ffmpeg, gif + the iOS-device path return {supported:false} with an install hint while native-mp4 paths still work (detect via FLUTTER_DEVICE_FFMPEG override / PATH / Homebrew). When output_path is omitted the clip is written to a predictable temp path that is returned as savedPath.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          output_path: {
            type: "string",
            description:
              "Absolute path to write the clip to. When omitted, a predictable temp path is used and returned as savedPath. The extension should match `format`.",
          },
          duration_s: {
            type: "number",
            description:
              "How long to record, in seconds (the recorder stops cleanly after this). Default 10. Android caps a single recording at 180s.",
          },
          fps: {
            type: "number",
            description:
              "Frame rate for the iOS-physical-device screenshot BURST and for gif output. Default 2. On a physical iOS device the ACHIEVABLE rate is only ~1–3 fps regardless (screenshot latency), so higher values do not make it smoother.",
          },
          format: {
            type: "string",
            enum: ["mp4", "gif"],
            description:
              "Output container. 'mp4' (default) uses the native recorder where available (no ffmpeg). 'gif' always requires ffmpeg.",
          },
          device_udid: {
            type: "string",
            description:
              "Optional specific target id (iOS). When omitted the adapter resolves the target the normal way (simulator-first for a sim walkthrough, else the physical device).",
          },
        },
      },
    },
    {
      name: "flutter_set_input_mode",
      description:
        "Select the session-sticky physical input mode: 'dpad' (D-pad navigation via remote keys) or 'pointer' (virtual touchpad cursor). This records the active plane for the session; flutter_key and flutter_pointer both send regardless of the recorded mode. Input is driven over the Samsung remote channel (WSS :8002); the first use on an unpaired device shows an on-screen Allow prompt and persists a per-developer token.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          mode: {
            type: "string",
            enum: ["dpad", "pointer"],
            description: "The input mode to activate.",
          },
        },
        required: ["mode"],
      },
    },
    {
      name: "flutter_key",
      description:
        "Send a navigation/remote key, or type a text string, on the resolved device. Accepts short names (UP/DOWN/LEFT/RIGHT/ENTER/RETURN/BACK/HOME) on every wired platform. TIZEN: sent over the Samsung remote channel; also accepts full Samsung KEY_* names (e.g. KEY_VOLUP); BACK maps to KEY_RETURN. ANDROID: injected via `adb shell input keyevent` (device AND emulator) — short names map to Android keycodes (arrows→DPAD, ENTER/OK/SELECT→KEYCODE_DPAD_CENTER which activates the focused element, RETURN/BACK→KEYCODE_BACK, HOME→KEYCODE_HOME); also accepts full KEYCODE_* names and bare numeric keycodes. `text` (instead of `key`) types into the focused field via `adb shell input text` (Android only today). NOTE: adb input is the OS-LEVEL plane — raw system input injection that bypasses Flutter's gesture-arena semantics; a driver over the Dart VM service remains the primary in-app path, and this covers what it cannot reach (OS UI outside the Flutter view, non-debug builds, D-pad navigation on Android TV). iOS reports {supported:false}. This is the D-pad input plane; it works irrespective of the recorded input mode.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          key: {
            type: "string",
            description:
              "Key to send: a short name (UP/DOWN/LEFT/RIGHT/ENTER/RETURN/BACK/HOME), a full Samsung KEY_* name (Tizen), or a full KEYCODE_* name / bare numeric keycode (Android). Provide exactly one of `key` or `text`.",
          },
          text: {
            type: "string",
            description:
              "A string to TYPE into the currently-focused field (Android: `adb shell input text`). Cannot carry newlines/tabs — send those as key events (KEYCODE_ENTER / KEYCODE_TAB). Platforms without an OS-level text channel return {supported:false}. Provide exactly one of `key` or `text`.",
          },
        },
      },
    },
    {
      name: "flutter_geometry",
      description:
        "REPORT THE DEVICE'S REAL SCREEN GEOMETRY so nothing is assumed: display size in DEVICE pixels, the density buckets (physical vs an active override), the device pixel ratio and where it came from, and the logical display size that follows. This is the ratio flutter_pointer requires for `coordinateSpace: \"logical\"` and refuses to guess — read it here instead of eyeballing a screenshot. OS-LEVEL: it describes the DISPLAY, so it needs no app installed, no debug build, and no Dart VM service. The Flutter VIEW is a different, smaller box — on a device whose display is 1440x2960 at density 640 (dpr 4.0, logical display 360x740) the Flutter view can be 360x725 logical, because the 60px navigation bar is outside the view; dividing the DISPLAY height by the dpr gives 740 and is WRONG for anything view-derived. Pass the view's own numbers (`view_width`/`view_height` in Flutter LOGICAL px, and optionally `view_dpr`) — from a VM-service driver, since this server never reads the app — to have them cross-checked: a WIDTH mismatch comes back as a warning (it means the dpr is wrong and every derived tap will mis-land), a height shortfall as an expected note naming the system chrome. `device_udid` targets a specific device (geometry differs per device); otherwise the target resolves exactly as it does for deploy/lifecycle. ANDROID ONLY (`adb shell wm size` + `wm density`, preferring the Override density line — the density actually in force); other platforms return {supported:false} rather than a guess.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          device_udid: {
            type: "string",
            description:
              "Pin the device to report on for THIS call (Android: the adb serial or model name; overrides the FLUTTER_DEVICE_ANDROID_DEVICE env pin). Omit to resolve the same target deploy/lifecycle use. Screen geometry differs per device, so a multi-device host should say which one it means.",
          },
          view_width: {
            type: "number",
            description:
              "The Flutter view's width in LOGICAL px, to cross-check against the display. Must be supplied together with view_height. Width is the reliable axis (no system chrome takes horizontal space in portrait), so a mismatch here is reported as a WARNING: the dpr is wrong and every derived tap will mis-land.",
          },
          view_height: {
            type: "number",
            description:
              "The Flutter view's height in LOGICAL px, to cross-check against the display. Must be supplied together with view_width. A shortfall here is EXPECTED (navigation/status bars) and comes back as a note naming how many device px are system chrome — not a warning.",
          },
          view_dpr: {
            type: "number",
            description:
              "The view's own reported devicePixelRatio, to compare against the platform density. A disagreement is surfaced as a warning; taps are always scaled with the PLATFORM value.",
          },
        },
      },
    },
    {
      name: "flutter_pointer",
      description:
        "Drive the TV pointer. action 'click' activates the currently-focused element (KEY_ENTER) — on the focus/D-pad-driven Tizen TV this is the working 'click', so use flutter_key to move focus first, then flutter_pointer click. action 'move'/'scroll' is a free-cursor primitive reserved for pointer-native platforms (webOS Magic Remote); on Tizen it is unsupported (the native Samsung touchpad channel has no observable effect) and returns a clear {supported:false} result. Coordinates default to DEVICE pixels; pass coordinateSpace 'logical' together with the device's dpr to send Marionette-style LOGICAL coordinates (e.g. 1200x675) — they are converted to device pixels before sending. dpr is never assumed; it must be supplied for logical space — but it no longer has to be GUESSED: flutter_geometry reports the device's real ratio and screen sizes. NOTE: this exposes the logical→device pointer primitive only; element-geometry→tap orchestration lives in the agent/skill layer (this MCP does not call Marionette).",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          action: {
            type: "string",
            enum: ["move", "click", "scroll"],
            description: "Pointer action to perform.",
          },
          x: {
            type: "number",
            description: "X coordinate for 'move' (device or logical per coordinateSpace).",
          },
          y: {
            type: "number",
            description: "Y coordinate for 'move' (device or logical per coordinateSpace).",
          },
          dy: {
            type: "number",
            description: "Vertical delta for 'scroll' (positive = down).",
          },
          coordinateSpace: {
            type: "string",
            enum: ["device", "logical"],
            description:
              "Coordinate space of x/y/dy. Default 'device'. 'logical' requires dpr and is converted to device pixels.",
          },
          dpr: {
            type: "number",
            description:
              "Device pixel ratio, required when coordinateSpace is 'logical'. Never assumed — devices differ.",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "flutter_system_prompt",
      description:
        "Detect and tap/dismiss SYSTEM-LEVEL UI prompts that live OUTSIDE the Flutter app's view tree — SpringBoard alerts, permission dialogs (notifications/tracking/photos/location), and Safari's 'Open in <app>?' confirmation shown when you open an https universal link on the simulator. Marionette drives the app over the Dart VM service and CANNOT see or tap these OS prompts, so this closes the last gap to fully autonomous testing. action 'detect' returns whether a prompt is present plus its message text and button labels; action 'tap' taps the button named by button_label (case-insensitive, exact-then-substring — 'Open' matches 'Open in <app>'); action 'dismiss' taps the negative/last button. MOBILE (iOS) capability driven by idb over the accessibility tree (idb ui describe-all + idb ui tap). SIMULATOR-ONLY (verified): idb's ui commands require the FBSimulatorLifecycle protocol, so they DO NOT work on a physical iOS device (idb returns \"Target doesn't conform to FBSimulatorLifecycleCommands protocol\"). This tool targets a booted SIMULATOR (booted-first; pass `udid` to pick a specific one); when only a physical device is connected it returns a structured simulator-only note instead of failing. Requires idb: `brew install idb-companion` AND the `idb` CLI (`pip install fb-idb` / `pipx install fb-idb`); this tool shells the `idb` CLI, which talks to idb_companion. idb is located per-call (so a just-installed idb works without a server restart) across Homebrew/pipx locations; set FLUTTER_DEVICE_IDB_PATH to override. Needs no macOS Accessibility grant. On Tizen/webOS/Android this returns {supported:false}. NOTE: a genuine universal-link tap from Messages/Notes on a real device usually opens the app directly (no prompt) when AASA is valid, so this is primarily a simulator/Safari-navigation and permission-dialog need.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          action: {
            type: "string",
            enum: ["detect", "tap", "dismiss"],
            description:
              "'detect' (report presence + buttons), 'tap' (tap button_label), or 'dismiss' (tap the negative/last button).",
          },
          button_label: {
            type: "string",
            description:
              "Button to tap for action 'tap' (e.g. 'Open', 'Allow', 'Continue'). Case-insensitive; matches exact label first, then substring. Ignored for 'detect'/'dismiss'.",
          },
          udid: {
            type: "string",
            description:
              "Explicit iOS SIMULATOR udid to target (idb ui is simulator-only). Optional; when omitted a booted simulator is picked automatically (booted-first). Use `xcrun simctl list devices booted` to find it.",
          },
        },
        required: ["action"],
      },
    },
  ];
}

/**
 * Build the tool list advertised by ListTools. Pure — no `Server` or transport —
 * so the advertised registry can be asserted directly in tests.
 */
export function buildToolList(): ToolList {
  return { flutter: buildFlutterTools() };
}

/** The flat tool list in the exact order ListTools advertises. */
export function buildAdvertisedTools(): ToolDefinition[] {
  return buildFlutterTools();
}
