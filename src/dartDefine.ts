/**
 * `--dart-define` passthrough: compile-time constants handed to the Flutter
 * build.
 *
 * WHY this is a first-class option rather than a free-form "extra args" escape
 * hatch: dart-defines are how an app is pointed at a different environment
 * (a local backend, a staging API, a feature flag) — and on the platforms whose
 * install happens INSIDE `flutter run`, they must be spliced into the LAUNCH,
 * not just the build, or the app that actually runs was compiled without them.
 * That asymmetry is exactly the kind of thing a caller should not have to know,
 * so the defines are carried through both paths here.
 *
 * A typed map rather than a raw string list also means this cannot be used to
 * inject arbitrary flags into the build command: every token produced is a
 * `--dart-define=`, and every one is shell-quoted by the caller that builds the
 * command.
 */

/** Compile-time constants, as the caller supplies them. */
export type DartDefines = Record<string, string>;

/**
 * Reject a key that could not survive the trip to the build command intact.
 *
 * A key carrying `=` would silently split into a different define than the one
 * asked for; whitespace or a leading `-` would be re-parsed by the Flutter tool
 * as a separate argument. Both fail LOUDLY here rather than producing a build
 * that is subtly configured wrong — which is far harder to notice than an error.
 */
function assertUsableKey(key: string): void {
  if (key.length === 0) {
    throw new Error("A --dart-define key cannot be empty.");
  }
  if (/[=\s]/.test(key)) {
    throw new Error(
      `Invalid --dart-define key ${JSON.stringify(key)}: keys cannot contain ` +
        "'=' or whitespace (they would split into a different define)."
    );
  }
  if (key.startsWith("-")) {
    throw new Error(
      `Invalid --dart-define key ${JSON.stringify(key)}: a leading '-' would ` +
        "be read as a separate flag by the Flutter tool."
    );
  }
}

/**
 * Build the `--dart-define=KEY=VALUE` tokens for a set of defines, in a STABLE
 * key order so the same defines always produce the same command (a build
 * command that varies run to run is one nobody can compare or cache).
 *
 * Returns an empty array for undefined/empty defines, so callers can splice the
 * result unconditionally. Tokens are NOT shell-quoted — the command builders
 * quote them, since quoting belongs with the shell that will read it.
 */
export function dartDefineArgs(defines?: DartDefines): string[] {
  if (!defines) return [];
  return Object.keys(defines)
    .sort()
    .map((key) => {
      assertUsableKey(key);
      return `--dart-define=${key}=${defines[key]}`;
    });
}
