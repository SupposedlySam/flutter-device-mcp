# Roadmap

`flutter-device-mcp` works today across iOS, Android, and (experimentally) Tizen,
tvOS, and webOS. This is where it's headed. Nothing here is committed — it's a set
of design directions surfaced during architecture review, framed as future work.

## Planned / ideas

- **Event-stream command bus.** Turn each core command into an async generator
  that yields structured progress + streaming log events, so both faces (MCP and
  CLI) render the same event stream — live progress in the CLI, incremental tool
  output over MCP — instead of a single terminal JSON blob.

- **Brokered VM-Service URI.** Publish the live `ws://…/ws` URI to a well-known
  runtime file and add a `flutter-device attach` command, so any driver or a
  second agent can connect to an already-running app without a redeploy.

- **Richer environment configuration.** `dart_define` covers compile-time
  constants; the per-target host resolution an app usually needs alongside them
  (simulator → `localhost`, Android emulator → `10.0.2.2`, a physical Android
  device → `adb reverse` back to the host) is still the caller's job.

- **Executable config + lifecycle hooks.** A typed `flutter-device.config.ts` with
  `preBuild`/`postDeploy`-style hooks for richer extensibility beyond today's shell
  `preBuild` array. Would ship with a clear trust-boundary note: executing config
  is fine for a human, but needs an explicit opt-in when the tool is driven by an
  AI agent.

- **In-code capability/quirk matrix.** Move the support matrix into a
  machine-readable table the core consults at runtime (to answer "is this
  supported here?" consistently) and that also renders the docs table — one source
  of truth instead of two.

- **Platform hardening.**
  - Verify the Tizen build/install path on-device — including that
    `flutter-tizen run --no-build --<mode>` reuses the package of that mode
    rather than rebuilding.
  - Verify the tvOS path on-device.
  - A real webOS build path (removing the user-provided `preBuild` requirement).
  - LG Magic-Remote pointer support for webOS.
  - Screen geometry beyond Android. `flutter_geometry` reports the display size
    and device pixel ratio from `adb shell wm size`/`wm density`; the equivalent
    is unwired elsewhere, and every other platform answers `{supported: false}`
    rather than guessing a ratio.
  - Verify the Android `adb shell input` plane on an Android TV, where the
    D-pad keycodes matter most.

## Contributing

Contributions and on-device verifications are welcome — especially for the
experimental TV platforms. Open an issue or PR.
