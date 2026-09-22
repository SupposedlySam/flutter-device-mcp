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
    enum: ["tizen", "webos", "ios", "android", "tvos", "macos", "auto"],
    description:
      "Target platform. 'tizen' (Samsung TV/monitor via flutter-tizen + sdb), 'webos' (LG TV via ares — EXPERIMENTAL/stub), 'ios' (iPhone/iPad or simulator via xcrun devicectl/simctl + flutter), 'android' (device/emulator via adb + flutter), 'tvos' (Apple TV via flutter-tvos + xcrun — EXPERIMENTAL; on-device requires a PROFILE/RELEASE build, since a standalone debug launch segfaults, and its VM-service URI is a `ws://127.0.0.1:<port>/<authCode>=/ws` loopback forward held open by the launch process over the CoreDevice tunnel), or 'macos' (a prebuilt, SIGNED `.app` you supply — this MCP has no macOS build/sign toolchain — driven via cliclick/screencapture/osascript from a SCRATCH DIR, never /Applications; it launches the bundle directly rather than under `flutter run`, so there is no Dart VM service and flutter_pointer/flutter_key/flutter_screenshot ARE the driver). Defaults to the configured `defaultPlatform` (falls back to ios).",
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

/**
 * The per-call device pin, advertised on every tool that addresses ONE device.
 *
 * One neutral name rather than a per-platform one: each adapter reads it in its
 * own id space, and the alternative — an `android_serial` beside a `device_udid`
 * — would make the same concept look like two capabilities. The `extra` clause
 * carries a tool-specific note (deploy's is about combining it with `target`).
 */
function deviceUdidProp(extra = "") {
  return {
    device_udid: {
      type: "string",
      description:
        "Pin the device this call targets, for THIS CALL ONLY — precedence: this arg > the platform's env pin > auto-resolution — needing no MCP host reload. ANDROID: an adb serial (e.g. '39121FDJH003AB' or 'emulator-5554') or the model name adb reports in `adb devices -l` (e.g. 'Pixel_7', 'sdk_gphone64_arm64'), overriding the FLUTTER_DEVICE_ANDROID_DEVICE env pin. On a host with two attached targets this is the ONLY way to choose between them: discovery takes the first ONLINE device, so a phone that is attached but unusable (PIN-locked — Flutter stops building while the app is not visible, so nothing can be driven on it) otherwise wins every call. iOS/tvOS: a flutter id, a devicectl id, or a device/simulator name (for a simulator the flutter id IS the simctl UUID), overriding FLUTTER_DEVICE_IOS_DEVICE." +
        extra +
        " A pin naming a target that is not currently online SELF-HEALS to the first online device and says so in `deviceWarning`, exactly like a stale env pin — it never hard-fails silently. Ignored on Tizen/webOS/macOS, which resolve their single target another way.",
    },
  };
}

/**
 * The per-call capture-target CLASS, advertised on the capture tools
 * (screenshot/record) for the platforms that have two target kinds.
 *
 * Separate from `device_udid` because the common case is not "this exact id" but
 * "the simulator, not the phone that happens to be plugged in".
 */
const captureTargetProp = {
  target: {
    type: "string",
    enum: ["device", "simulator"],
    description:
      "iOS/tvOS ONLY: which CLASS of target to capture. Omitted, resolution is PHYSICAL-FIRST (the same order flutter_deploy uses, so a capture lands on the machine you deployed to) after any `device_udid`/FLUTTER_DEVICE_IOS_DEVICE pin. 'simulator' captures the booted simulator EVEN WHEN a physical device is attached; 'device' forces real hardware. Ignored on Android/Tizen/webOS/macOS, which have one target class (on Android an emulator is just another adb serial — name it with `device_udid`).",
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
        "Build the app package. Any app-specific pre-build steps (e.g. compiling a native engine) are configured via the `preBuild` hook in flutter-device.config.json and run first. Returns the tail of the build output plus the built package path and detected failure signatures (Install failed / No space left on device). WARNING: passing `run: true` installs AND launches the app, which SEIZES the physical TV/monitor display. This can run long (pre-build hooks + package build). MACOS: returns `{supported:false}` — this MCP has no build/sign toolchain for macOS; bring your own signed `.app` and point flutter_deploy at it.",
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
              "The 3-way build mode, and the PREFERRED way to ask for one. 'release' = AOT, NO Dart VM service (not drivable). 'profile' = AOT with REALISTIC timing but the VM service stays OPEN — the mode to use for any measurement, since a debug build's JIT slowdown makes its numbers meaningless and a release build cannot be connected to at all. 'debug' = JIT, VM service open (the classic Marionette path). Wins over the legacy `debug` boolean when both are given; when omitted, falls back to `debug` (true→debug, else release). Honored on Tizen, Android, and iOS. IOS: resolved as `mode` > `debug` (true→debug, false→release) > FLUTTER_DEVICE_IOS_LAUNCH_MODE > default DEBUG, so a plain build is coherent with the debug launch a plain flutter_deploy performs — and a `target: \"simulator\"` build never composes the `--simulator --release` flutter rejects. Only debug registers ext.flutter.marionette.* (the app gates bootstrapMarionette on kDebugMode); profile is the mode that reproduces release-only code paths.",
          },
          debug: {
            type: "boolean",
            description:
              "Build in debug mode. Legacy 2-way shorthand for `mode` (which wins when both are set); it cannot express `profile`. When false, builds release (Tizen/iOS); when omitted, builds release on Tizen. IOS: when OMITTED it uses FLUTTER_DEVICE_IOS_LAUNCH_MODE (debug|profile|release), defaulting to DEBUG (it was release) so the artifact matches the debug launch a plain flutter_deploy performs. ANDROID: the mode follows the same resolution as the launch — explicit true→debug, false→profile; when OMITTED it uses FLUTTER_DEVICE_ANDROID_LAUNCH_MODE (debug|profile|release), defaulting to DEBUG so the built apk is coherent with the debug launch a plain flutter_deploy performs (Marionette is gated on kDebugMode).",
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
        "THE KEY TOOL. Installs the already-built package and launches the app in DEBUG, then returns the Dart VM Service `ws://…/ws` URI for Marionette to connect to. Kills the stale launch/build drivers HOLDING THE DEVICE IT IS DEPLOYING TO first (one deploy at a time — concurrent installs wedge the device lock): Tizen's `flutter-tizen`, or on iOS/Android the `flutter run` driver attributed to that device and its children. A session on ANOTHER device is left running, so deploying to an emulator no longer kills the `flutter run` on a phone attached beside it; a `flutter run` that names no device anywhere in its process tree is reported (with its pid) rather than killed. The teardown detail is in `detail.<key>Note` in the response. Recovers from a full device (No space left on device / Install failed) by uninstalling and retrying the install once. The launch runs through a pty (so flutter line-flushes the URI), backgrounded, and is LEFT RUNNING to hold the VM service open. A device pin that is not currently an online device (stale — e.g. the device moved DHCP address) is ignored in favor of the first online device, noted via `deviceWarning` in the response. MULTI-TARGET HOSTS: discovery takes the first ONLINE device, which on Android means an attached physical phone beats a running emulator every time — pass `device_udid` (an adb serial or model name) to deploy to the other one for this call, without touching FLUTTER_DEVICE_ANDROID_DEVICE or reloading the host. WARNING: launching SEIZES the physical TV/monitor display. NOTE: Marionette coordinates are LOGICAL (e.g. 1200x675), not screenshot pixels. MACOS: a different shape entirely — stages `app_path`/`app_url` (or FLUTTER_DEVICE_MACOS_APP_PATH/FLUTTER_DEVICE_MACOS_APP_URL) into a SCRATCH DIR (never /Applications) and launches it with `open -n`, returning its pid; the bundle runs directly rather than under `flutter run`, so there is no Dart VM service (`vmServiceUriWs` is empty) and no display seizure — drive it with flutter_pointer/flutter_key/flutter_screenshot instead.",
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
              "The 3-way mode of the artifact to redeploy, and the PREFERRED way to ask for one. On Tizen this reinstalls the EXISTING package of that mode (skipping the long native/TPK rebuild) and relaunches via `flutter-tizen run --no-build --<mode>` — so `mode` MUST match the package you built, or --no-build has nothing of that mode to reuse. 'profile' = AOT with realistic timing AND the VM service open, so this STILL captures and returns the ws://…/ws URI — the point of a profile deploy. 'debug' = JIT, VM service open. 'release' = no VM service, so no URI is captured. Wins over the legacy `debug` boolean. IOS → `flutter run --<mode>`, resolved as `mode` > `debug: true` > FLUTTER_DEVICE_IOS_LAUNCH_MODE > default DEBUG. Only debug is Marionette-drivable (the app gates bootstrapMarionette on kDebugMode): a profile launch still returns a REAL ws://…/ws URI (for DevTools/timeline work) but connect succeeds and every ext.flutter.marionette.* call fails, and a release launch returns an EMPTY URI with `noVmServiceReason` saying why rather than a field that reads like a failed capture. The response reports the mode actually launched in `launchMode` (an env pin is invisible otherwise) and what that mode costs in `launchModeCaveat`. A non-debug launch that comes up resident without printing a URI ends the wait after a short grace window instead of sitting on `timeout_ms`.",
          },
          debug: {
            type: "boolean",
            description:
              "Reinstall the DEBUG artifact instead of release. Legacy 2-way shorthand for `mode` (which wins when both are set); it cannot express `profile`. On Tizen this redeploys the existing debug TPK (skipping the long native/TPK rebuild) so a debug build can be relaunched for Marionette. On ANDROID this selects the `flutter run` launch mode: explicit true→--debug, false→--profile; when OMITTED it uses FLUTTER_DEVICE_ANDROID_LAUNCH_MODE (debug|profile|release), defaulting to DEBUG so a plain deploy comes up Marionette-drivable (Marionette is gated on kDebugMode — a profile/release launch registers no ext.flutter.marionette.* extension, matching the iOS debug default). On IOS `true` pins the --debug launch; use `mode` to reach profile/release, because on a DEPLOY an explicit `false` means only 'no debug pin' (it falls through to FLUTTER_DEVICE_IOS_LAUNCH_MODE, then the DEBUG default) — a deploy never launches release implicitly. Inert on platforms that don't distinguish a debug install artifact.",
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
              "iOS ONLY per-call target selection: 'simulator' deploys to the booted simulator (booted-first) EVEN WHEN a physical iPhone is attached — the fix for the device-first default that made a simulator UI walkthrough impossible without a host reload; 'device' forces a physical device. Ignored on Tizen/webOS/Android, which have no device-vs-simulator id split — on Android an emulator is just another adb serial, so name it with `device_udid` instead. When omitted, iOS is physical-first.",
          },
          ...deviceUdidProp(
            " Combine with `target` (iOS) or use alone; on Android `target` has no meaning and this is the whole selection."
          ),
          app_path: {
            type: "string",
            description:
              "MACOS ONLY: a local path to what to stage — a `.app` bundle, a `.tar.gz`/`.tgz`, or a `.dmg`. Overrides FLUTTER_DEVICE_MACOS_APP_PATH for this call. Wins over `app_url` when both are set. Ignored on every other platform.",
          },
          app_url: {
            type: "string",
            description:
              "MACOS ONLY: a URL to fetch (a `.tar.gz`/`.tgz` or `.dmg`, sniffed by extension), used when `app_path` is not set. Overrides FLUTTER_DEVICE_MACOS_APP_URL for this call. Ignored on every other platform.",
          },
        },
      },
    },
    {
      name: "flutter_open_url",
      description:
        "Open a URL ON the device, exactly as tapping a link would — the DEEP-LINK / universal-link driver. Use it to exercise custom schemes (`myapp://…`) and `https://…` App Links / universal links end-to-end: it hands the URL to the OS, so the app's real intent-filter / URL-scheme / association plumbing runs (it does NOT navigate inside the app — that belongs to a VM-service driver such as Marionette). PER-PLATFORM reality (encoded so you don't re-derive it): ANDROID — full support via `adb shell am start -a android.intent.action.VIEW -d <url>`; the target package defaults to the project's resolved application id so an https link cannot raise a disambiguation chooser an automated run can't answer (pass package_or_bundle_id: \"\" to go unscoped on purpose). `am` refuses an intent on STDOUT while still exiting 0, so the output is classified — an unresolvable link is reported as a failure with the App Links/assetlinks.json hint, while the common 'delivered to currently running top-most instance' warning is treated as SUCCESS. iOS / tvOS SIMULATOR — full support via `xcrun simctl openurl`. iOS / tvOS PHYSICAL DEVICE — {supported:false}: Apple ships NO url-open verb on `xcrun devicectl device` and idb's open/ui commands are simulator-only, so there is no automation path; open the link by hand or use a simulator. Tizen/webOS — {supported:false} (`sdb shell` is disabled on Samsung devices, so there is no device-side launcher).",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...appDirProp,
          url: {
            type: "string",
            description:
              "The URL to open. Must include a scheme — e.g. 'myapp://details?id=42' or 'https://example.com/details?id=42'. Passed to the device verbatim (percent-encoding is preserved, not re-encoded), and shell-quoted at the boundary so '&' and other characters in a query string are safe.",
          },
          package_or_bundle_id: {
            type: "string",
            description:
              "ANDROID only: the package the VIEW intent is scoped to. Defaults to the project's resolved application id, which prevents a browser-vs-app chooser on https links. Pass an empty string to send an UNSCOPED intent (letting the OS disambiguate, which is what a real user tap does). Ignored on Apple platforms, where simctl routes by scheme/association.",
          },
          target: {
            type: "string",
            enum: ["device", "simulator"],
            description:
              "iOS/tvOS: which target to open the URL on. This matters more here than on other tools — Apple supports opening a URL on a SIMULATOR and not on a physical device, while discovery is physical-first. On a host with a paired iPhone/Apple TV you MUST pass 'simulator' to reach the working path; otherwise the call resolves the physical device and correctly returns {supported:false}.",
          },
          ...deviceUdidProp(),
        },
        required: ["url"],
      },
    },
    {
      name: "flutter_uninstall",
      description:
        "Uninstall the app (`sdb -s <device> uninstall <app_id>` on Tizen; `adb -s <serial> uninstall <app_id>` on Android) to free device space or reset to a clean state. Soft-succeeds when the app is not installed. `device_udid` picks WHICH device to uninstall from on a multi-target host.",
      inputSchema: {
        type: "object",
        properties: { ...platformProp, ...appDirProp, ...deviceUdidProp() },
      },
    },
    {
      name: "flutter_kill_stale",
      description:
        "Kill the stale launch/driver processes for ONE DEVICE — by default the resolved target, or the one `device_udid` names. On iOS/Android that is the `flutter run` driver whose process tree holds that device, plus its children (the Dart `frontend_server` among them); a session on any OTHER device is LEFT RUNNING, and one that cannot be tied to a device is reported with its pid rather than killed. Attribution uses the pid this MCP recorded for the device at launch, else the driver's `-d` argument, else what its child processes name (a live Android session keeps an `adb -s <serial>` child), else the target being the only device attached. On Tizen/webOS/tvOS/macOS the teardown is PLATFORM-WIDE and needs no device: those drivers are named after their own toolchain (`flutter-tizen`, `ares-launch`/`flutter-webos`, `flutter-tvos`) or identified by process name (macOS), so they cannot belong to another platform — the response reports `scope: \"platform-wide\"` for them, and a `device_udid` does not narrow it. Pass `all_devices: true` on iOS/Android for the host-wide hammer: EVERY launch driver regardless of device, orphaned compilers included — that will kill a session someone else (or another agent) is using, so use it only when you mean to. If NO device can be resolved on iOS/Android, it kills nothing and says so — with no device to attribute sessions to it could only kill them all — so attach the device, name it with `device_udid`, or pass `all_devices: true` deliberately. The response names what was killed and what was deliberately spared (`detail.<key>Note`); a `<key>Killed: false` means nothing of that kind belonged to this device, while an exit of 2 means the process scan itself FAILED and nothing is known. This is also run automatically (scoped to the deploy target) at the start of flutter_deploy.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...appDirProp,
          ...deviceUdidProp(
            " On flutter_kill_stale it also scopes the TEARDOWN, not just discovery: only this device's drivers are killed."
          ),
          all_devices: {
            type: "boolean",
            description:
              "Kill every launch driver on this host regardless of device (plus every orphaned `frontend_server`), instead of scoping to one device. The deliberate big hammer — it takes down sessions on devices you did not name, including ones another person or agent is using. Only meaningful on iOS/Android, whose teardown is device-scoped; the other platforms are always platform-wide. Default false.",
          },
        },
      },
    },
    {
      name: "flutter_terminate",
      description:
        "OS-level lifecycle: force-quit the app on the resolved device (iOS: xcrun simctl/devicectl terminate; Android: adb shell am force-stop; macOS: `osascript ... tell application id \"<bundle id>\" to quit`). MOBILE/MACOS capability — on TV platforms (Tizen/webOS) this returns {supported:false}. The app's Dart VM service is gone after termination (N/A on macOS, which has none); redeploy to get a fresh URI for Marionette.",
      inputSchema: { type: "object", properties: { ...platformProp, ...deviceUdidProp() } },
    },
    {
      name: "flutter_background",
      description:
        "OS-level lifecycle: send the app to the BACKGROUND without killing it (iOS: foreground the neutral com.apple.Preferences app; Android: HOME keyevent via adb; macOS: activate Finder — there is no OS-level \"background\" verb, so losing focus IS backgrounding). Exercises the app's didEnterBackground/onPause path for lifecycle testing while keeping its VM service alive. MOBILE/MACOS capability — Tizen/webOS return {supported:false}.",
      inputSchema: { type: "object", properties: { ...platformProp, ...deviceUdidProp() } },
    },
    {
      name: "flutter_foreground",
      description:
        "OS-level lifecycle: bring the app back to the FOREGROUND by relaunching it (iOS: xcrun simctl/devicectl launch by bundle id; Android: adb monkey LAUNCHER intent by package; macOS: `osascript ... tell application id \"<bundle id>\" to activate`). Exercises didBecomeActive/onResume. Pair with flutter_background for background→foreground lifecycle testing. MOBILE/MACOS capability — Tizen/webOS return {supported:false}.",
      inputSchema: { type: "object", properties: { ...platformProp, ...deviceUdidProp() } },
    },
    {
      name: "flutter_hot_reload",
      description:
        "FAST INNER LOOP. Trigger a REAL Dart hot reload on the app already running from flutter_deploy — seconds, not the minutes a full flutter_build + flutter_deploy takes. Preserves app state, recompiles changed Dart, and reassembles the widget tree. PREFERRED PATH: writes `r` to the running flutter daemon's stdin over a durable pty control channel established at deploy time (a FIFO on disk, bridged onto a real pty — the flutter tool only reads keys when its stdin is a terminal, so the bridge is what makes this work at all) — the flutter tool's own hot reload. The response's `confirmed` field is `true` when the effect was SEEN in the launch log, and reported as a reload; `false` when the write landed but nothing was seen — this FALLS BACK to the weaker VM-service reloadSources+reassemble path rather than reporting a reload that did not happen (the response's `fellBackFrom` says why); and absent/`undefined` when no launch log was available to watch, which still reports success but the note says the reload is UNVERIFIED rather than claiming it. Absent must not be read as either of the other two. If no live control channel exists at all (a launch from before this feature, a dead daemon, or a host with no usable python3 for the bridge — see the deploy response's controlChannelWarning), it also FALLS BACK to the VM-service path. flutter_deploy must have been run first; if no live daemon is recorded this returns a clear {triggered:false} telling you to deploy. Some changes can't be hot-reloaded (new enums/static fields, changes to main(), top-level/global state) — use flutter_hot_restart for those. NOTE: Marionette also exposes a hot_reload, but it is only a reassemble (no Dart recompile); the pty `r` here is the real path.",
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
        "Hot RESTART the app already running from flutter_deploy: re-runs main() and DISCARDS in-memory state, while KEEPING the process, its Dart VM Service ws://…/ws URI, and any Marionette connection ALIVE (no redeploy, no new URI to reconnect). Use this for changes a hot reload can't apply — changes to main(), top-level/global/static state, new enums, or app-wide initialization. This is driven by writing `R` to the running flutter daemon's stdin over the pty control channel established at deploy time — it IS reachable this way (unlike over the raw VM service, where re-running main() is not exposed: reloadSources reloads in place and only the flutter tool can recompile the Dart in the first place). The channel is a FIFO on disk BRIDGED ONTO A REAL PTY, because the flutter tool reads `r`/`R` only when its stdin is a terminal — a plain stdin redirect to the FIFO accepts every write and delivers none, which is what made this report a restart that never happened. The response's `confirmed` field carries three distinct states, and absent must not be read as either of the other two: `true` — the flutter tool was SEEN to acknowledge the `R` in the launch log, and this is reported as a restart. `false` — the confirmation window passed with no acknowledgement; there is no VM-service equivalent to fall back to (reloadSources cannot re-run main()), so this comes back as `success:false`, never as a restart. Absent/`undefined` — no launch log was available to watch (e.g. a launch record from before this field existed), so this still reports `success:true` but the note says UNVERIFIED: do not assume main() re-ran or that in-memory state was dropped. Requires a live control channel: if the launch recorded none (older launch, or a host with no usable python3 for the bridge — the deploy response's controlChannelWarning says so) or the daemon has exited, this returns a clear {triggered:false} telling you to redeploy with flutter_deploy (which re-establishes the channel). NOTE: Marionette's hot_reload is only a reassemble; there is no Marionette hot-restart — this tool is the restart path.",
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
        "Capture the current device/app screen to a PNG on disk and return the absolute saved path (optionally the base64 bytes too), ALONG WITH the device it was captured from (`device`/`deviceKind`/`via`) and the PNG's pixel dimensions — so a capture can never be mistaken for one of a different machine. WHICH TARGET: on iOS/tvOS the capture is routed by the RESOLVED target's kind, not by what else is attached — `device_udid` (or FLUTTER_DEVICE_IOS_DEVICE) wins, otherwise resolution is PHYSICAL-FIRST exactly like flutter_deploy, so a capture lands on the machine a deploy would have used; pass `target: \"simulator\"` to capture a booted simulator while a phone is attached. A `device_udid` naming a physical device is NEVER served from the simulator. PER-PLATFORM capture reality (encoded so you don't re-derive it): iOS SIMULATOR — `xcrun simctl io <udid> screenshot`; iOS PHYSICAL device — `pymobiledevice3 developer dvt screenshot` (verified live: captures a real PNG over a no-root userspace tunnel on iOS 17+, no sudo — its stderr WARNING about the native tunnel is NOT a failure; requires the Developer Disk Image to be mounted, which Xcode does automatically). Requires `pymobiledevice3` on the host (`pipx install pymobiledevice3`, or a venv; override its path with FLUTTER_DEVICE_PYMOBILEDEVICE3); when it is missing the physical path returns {supported:false} with an install hint and captures NOTHING — it never substitutes another device. Android — `adb -s <serial> exec-out screencap -p`; tvOS SIMULATOR — simctl (physical Apple TV returns {supported:false}); macOS — `screencapture -R<x,y,w,h>` WINDOW-TARGETED against the target app's LIVE front-window bounds (never a full-desktop grab — that would leak whatever else the machine's owner has open); needs Screen Recording granted (flutter_info probes this by effect); Tizen/webOS — {supported:false} (no clean path — `sdb shell` is DISABLED on Samsung devices, so no device-side screencap; use Marionette take_screenshots over the VM service for the Flutter view). When output_path is omitted the PNG is written to a predictable temp path that is returned.",
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
          ...captureTargetProp,
          ...deviceUdidProp(),
        },
      },
    },
    {
      name: "flutter_record",
      description:
        "Record a bounded screen CLIP (video/gif) to a file and return the absolute saved path — for before/after captures. DURATION-BOUNDED: it records `duration_s` seconds then stops cleanly. PER-PLATFORM reality (encoded so you don't re-derive it): Android (best) — native mp4 via `adb shell screenrecord`, SIGINT'd on-device to flush, then pulled (no ffmpeg needed for mp4); iOS SIMULATOR — native mp4 via `xcrun simctl io recordVideo`; iOS PHYSICAL device — NO native recorder, so a screenshot BURST is assembled with ffmpeg (realistically only ~1–3 fps and CHOPPY because each dvt screenshot takes ~0.3–1s — a documented tradeoff, not a bug; needs pymobiledevice3 + ffmpeg); tvOS/Tizen/webOS — {supported:false} (no validated recording path; use Marionette take_screenshots over the VM service for the Flutter view). `format` 'gif' ALWAYS needs ffmpeg (native recorders emit mp4 only); absent ffmpeg, gif + the iOS-device path return {supported:false} with an install hint while native-mp4 paths still work (detect via FLUTTER_DEVICE_FFMPEG override / PATH / Homebrew). When output_path is omitted the clip is written to a predictable temp path that is returned as savedPath. WHICH TARGET: routed exactly like flutter_screenshot — `device_udid` wins, otherwise PHYSICAL-FIRST on iOS/tvOS, with `target: \"simulator\"` to record a booted simulator while a phone is attached; the response names the `device`/`deviceKind` it recorded.",
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
          ...captureTargetProp,
          ...deviceUdidProp(),
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
        "Send a navigation/remote key, or type a text string, on the resolved device. Accepts short names (UP/DOWN/LEFT/RIGHT/ENTER/RETURN/BACK/HOME) on every wired platform. TIZEN: sent over the Samsung remote channel; also accepts full Samsung KEY_* names (e.g. KEY_VOLUP); BACK maps to KEY_RETURN. ANDROID: injected via `adb shell input keyevent` (device AND emulator) — short names map to Android keycodes (arrows→DPAD, ENTER/OK/SELECT→KEYCODE_DPAD_CENTER which activates the focused element, RETURN/BACK→KEYCODE_BACK, HOME→KEYCODE_HOME); also accepts full KEYCODE_* names and bare numeric keycodes. `text` (instead of `key`) types into the focused field via `adb shell input text` (Android only today). WHICH DRIVER FIRST — ANDROID and TIZEN: this is the FASTEST plane and the one to reach for FIRST for navigation (BACK/HOME/D-pad/typing) — one call, no VM-service round trip, no coordinate maths. It bypasses Flutter's gesture-arena semantics (no widget/element addressing), so fall back to a driver over the Dart VM service (e.g. Marionette) when you need to address a specific widget by key or text, read the widget tree, or go through the gesture arena; this plane remains the only option for OS UI outside the Flutter view, non-debug builds, and D-pad navigation on Android TV. MACOS: sent via `cliclick kp:` (short names map to arrow-up/down/left/right, return, esc, tab, space, home, end, delete, page-up/down; a cliclick-native token like 'f1' or 'volume-up' passes straight through) — needs Accessibility granted (flutter_info probes this by effect: without it cliclick exits 0 and silently does nothing). On macOS this IS the primary driver, not a fallback: a prebuilt `.app` exposes no Dart VM service. iOS reports {supported:false}. This is the D-pad input plane; it works irrespective of the recorded input mode.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          key: {
            type: "string",
            description:
              "Key to send: a short name (UP/DOWN/LEFT/RIGHT/ENTER/RETURN/BACK/HOME), a full Samsung KEY_* name (Tizen), a full KEYCODE_* name / bare numeric keycode (Android), or a cliclick kp: token (macOS). Provide exactly one of `key` or `text`.",
          },
          text: {
            type: "string",
            description:
              "A string to TYPE into the currently-focused field (Android: `adb shell input text`; macOS: `cliclick t:`). Cannot carry newlines/tabs — send those as key events (KEYCODE_ENTER / KEYCODE_TAB). Platforms without an OS-level text channel return {supported:false}. Provide exactly one of `key` or `text`.",
          },
          ...deviceUdidProp(),
        },
      },
    },
    {
      name: "flutter_geometry",
      description:
        "REPORT THE DEVICE'S REAL SCREEN GEOMETRY so nothing is assumed: display size in DEVICE pixels, the density buckets (physical vs an active override), the device pixel ratio and where it came from, and the logical display size that follows. This is the ratio flutter_pointer requires for `coordinateSpace: \"logical\"` and refuses to guess — read it here instead of eyeballing a screenshot. OS-LEVEL: it describes the DISPLAY, so it needs no app installed, no debug build, and no Dart VM service. The Flutter VIEW is a different, smaller box — on a device whose display is 1440x2960 at density 640 (dpr 4.0, logical display 360x740) the Flutter view can be 360x725 logical, because the 60px navigation bar is outside the view; dividing the DISPLAY height by the dpr gives 740 and is WRONG for anything view-derived. Pass the view's own numbers (`view_width`/`view_height` in Flutter LOGICAL px, and optionally `view_dpr`) — from a VM-service driver, since this server never reads the app — to have them cross-checked: a WIDTH mismatch comes back as a warning (it means the dpr is wrong and every derived tap will mis-land), a height shortfall as an expected note naming the system chrome. `device_udid` targets a specific device (geometry differs per device); otherwise the target resolves exactly as it does for deploy/lifecycle. ANDROID (`adb shell wm size` + `wm density`, preferring the Override density line — the density actually in force). MACOS: a DIFFERENT contract — reports the TARGET WINDOW's live bounds (via osascript/System Events) in POINTS, the same space flutter_pointer/flutter_screenshot address (there is no separate logical/device split on macOS — points already ARE the addressable space); `dpr` there is the display's backingScaleFactor, relevant only for interpreting a flutter_screenshot PNG's pixel dimensions. Other platforms return {supported:false} rather than a guess.",
      inputSchema: {
        type: "object",
        properties: {
          ...platformProp,
          ...deviceUdidProp(
            " Screen geometry differs per device, so a multi-device host should always say which one it means."
          ),
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
        "Drive the device pointer. action 'click' activates the currently-focused element (KEY_ENTER) — on the focus/D-pad-driven Tizen TV this is the working 'click', so use flutter_key to move focus first, then flutter_pointer click; fall back to a driver over the Dart VM service (e.g. Marionette) for a genuine coordinate tap, since it is the only path here that reaches gesture handlers. action 'move'/'scroll' is a free-cursor primitive reserved for pointer-native platforms (webOS Magic Remote); on Tizen it is unsupported (the native Samsung touchpad channel has no observable effect) and returns a clear {supported:false} result. ANDROID (device AND emulator, via `adb shell input`): WHICH DRIVER FIRST — this is the fastest plane for a coordinate tap or scroll, and it is coordinate-native with flutter_screenshot: both speak DEVICE pixels, so a coordinate read straight off a screenshot sends as-is, while a VM-service driver takes LOGICAL coordinates and needs a dpr conversion first — the most common cause of mis-taps, and the concrete reason to prefer this plane for position-based input. Fall back to a VM-service driver for WIDGET addressing (by key or text) rather than a position, or an assertion on the widget tree. PREFER THE ONE-CALL TAP — pass `x`/`y` ON the 'click' call and it taps there directly (`input tap x y`), no 'move' needed. 'move' stages a tap position (no visible cursor — no event is sent) for a later 'click'/'scroll'; that staged position is DURABLE (persisted per device, so it survives server restarts and session boundaries — it is not lost between calls) and a 'click' reports the position it actually tapped as `devicePosition`. 'scroll' swipes vertically (`input swipe`, positive dy = scroll down), anchored at the staged position or the screen center (`wm size`), and REPORTS THE GESTURE IT SENT under `gesture` — requested vs applied dy, whether the screen's bounds clamped it, the start/end points, the duration and the resulting px/ms — because a scroll has two ways to succeed at doing nothing and `sent: true` alone hides both. Tune the gesture's SPEED with `duration_ms` (the fix when a scroll lands but nothing moves — a flick and a slow drag are different gestures to a scrollable), and pass `verify: true` to have the tool tell you whether the screen actually changed. Coordinates default to DEVICE pixels; pass coordinateSpace 'logical' together with the device's dpr to send Marionette-style LOGICAL coordinates (e.g. 1200x675) — they are converted to device pixels before sending. dpr is never assumed; it must be supplied for logical space — but it no longer has to be GUESSED: flutter_geometry reports the device's real ratio and screen sizes. MACOS (via `cliclick`): 'move' moves the REAL cursor (`m:`) and coordinates are WINDOW-RELATIVE by default — translated through the target window's LIVE bounds (0,0 = its own top-left), so a script survives the window moving; pass `absolute: true` to send raw screen points instead. 'click' clicks at the current cursor position (`c:`, or `dc:` for a double-click via `double: true`). 'scroll' is UNSUPPORTED on macOS — cliclick 5.1 has no scroll verb; use flutter_key (page-up/page-down/arrow keys) instead. macOS pointerMove VERIFIES the cursor actually moved (reads it back) and fails loudly if not — the signature of a DENIED Accessibility grant (flutter_info probes this explicitly). On macOS this IS the driver, not a fallback: there is no Dart VM service to fall back to. IOS: reports {supported:false} — no OS-level input plane is wired here; drive with a VM-service driver instead. NOTE: this exposes the logical→device pointer primitive only; element-geometry→tap orchestration lives in the agent/skill layer (this MCP does not call Marionette).",
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
            description:
              "X coordinate for 'move' — or for 'click' on Android, which then taps there in ONE call (no separate 'move'). Device pixels / logical per coordinateSpace on Android/Tizen; window-relative points on macOS unless `absolute` is set.",
          },
          y: {
            type: "number",
            description:
              "Y coordinate for 'move' — or for 'click' on Android, which then taps there in ONE call (no separate 'move'). Device pixels / logical per coordinateSpace on Android/Tizen; window-relative points on macOS unless `absolute` is set.",
          },
          dy: {
            type: "number",
            description:
              "Vertical delta for 'scroll' (positive = down). N/A on macOS (unsupported). ANDROID — READ THIS BEFORE RAISING IT: the swipe runs from the anchor to the screen edge and no further, so a dy larger than the distance from the anchor to that edge is BOUNDED, and because the gesture's duration is fixed the surplus turns into SPEED, not distance. Past the bound, a bigger dy emits the byte-identical command, only sooner interpreted as a flick. The response reports `gesture.requestedDy` vs `gesture.appliedDy` and sets `gesture.clamped` so you can see this rather than infer it. If a scroll did nothing, do NOT raise dy: send it again for more distance, or pass `duration_ms` for a slower drag.",
          },
          duration_ms: {
            type: "number",
            description:
              "ANDROID ONLY, for action 'scroll': how long the synthetic drag takes, in milliseconds (default 300, max 10000). This is the gesture's SPEED — the second variable of a swipe, and the one `dy` cannot reach. A short duration is a flick and carries fling velocity into the app; a long one is a slow drag that travels exactly the distance asked for and stops. Surfaces do not treat these the same, and a scrollable that ignores a flick can still accept a drag, so this is the first thing to change when a scroll lands but nothing moves — try 600-800. The cost is only wall-clock. Ignored on every other platform.",
          },
          verify: {
            type: "boolean",
            description:
              "ANDROID ONLY, for action 'scroll': check whether the screen actually changed and report it as `gesture.verification`. Opt-in because it costs two on-device screen fingerprints plus a settle wait. Read the three states asymmetrically: 'unchanged' is STRONG evidence the gesture did nothing (the input plane worked and the app ignored it — do not go hunting a dead Dart VM service), 'changed' is WEAK (some pixel differs, which a clock or an animation would also cause), and 'unavailable' means the check could not run and tells you nothing either way. Ignored on every other platform.",
          },
          coordinateSpace: {
            type: "string",
            enum: ["device", "logical"],
            description:
              "Coordinate space of x/y/dy. Default 'device'. 'logical' requires dpr and is converted to device pixels. Ignored on macOS (see `absolute` there instead).",
          },
          dpr: {
            type: "number",
            description:
              "Device pixel ratio, required when coordinateSpace is 'logical'. Never assumed — devices differ. Not used on macOS, whose points already are the addressable space.",
          },
          absolute: {
            type: "boolean",
            description:
              "MACOS ONLY: when true, x/y are ABSOLUTE screen points rather than the default window-relative space (bypasses translation through the target window's bounds). Ignored on every other platform.",
          },
          double: {
            type: "boolean",
            description:
              "MACOS ONLY, for action 'click': perform a double-click (`cliclick dc:`) instead of a single click. Ignored on every other platform.",
          },
          ...deviceUdidProp(),
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
