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
  - Verify the Tizen build/install path on-device.
  - Verify the tvOS path on-device.
  - A real webOS build path (removing the user-provided `preBuild` requirement).
  - LG Magic-Remote pointer support for webOS.

## Contributing

Contributions and on-device verifications are welcome — especially for the
experimental TV platforms. Open an issue or PR.
