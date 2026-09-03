/**
 * Single shared stand-in for the real `buildPtyCaptureCommand`
 * (`src/launchCapture.ts`), used by the adapter tests that mock the whole
 * `launchCapture.js` module (so they can stub the side-effecting
 * `launchAndCaptureUri`). The mock registry in this jest 29 native-ESM setup has
 * no `requireActual`/`importActual` for ES modules and re-enters the factory on
 * any in-factory dynamic import of the mocked specifier, so the pure helper
 * cannot be pulled from source inside the mock. Rather than hand-copy the body
 * into three factories (which silently drift), all three import this ONE copy,
 * and `launchCapture.test.ts` pins it byte-for-byte against the REAL helper (see
 * the "shared mock stand-in matches the real buildPtyCaptureCommand" test) so
 * any drift fails loudly.
 */

/** Mirrors `quote` from `src/cli.js` (POSIX single-quote escaping). */
const quote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;

/** Mirrors `buildPtyForwardCommand` from `src/ptyForward.ts`. */
const buildPtyForwardCommand = (opts: {
  forwarder: { python: string; script: string };
  fifoPath: string;
  inner: string;
}) =>
  [
    "exec",
    quote(opts.forwarder.python),
    quote(opts.forwarder.script),
    quote(opts.fifoPath),
    quote(opts.inner),
  ].join(" ");

/** Behavior-identical stand-in for `buildPtyCaptureCommand`. */
export function mockBuildPtyCaptureCommand(opts: {
  inner: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  controlChannel?: {
    fifoPath: string;
    forwarder: { python: string; script: string };
  };
}): string {
  const { inner, cwd, platform = process.platform, controlChannel } = opts;
  const launch = controlChannel
    ? buildPtyForwardCommand({
        forwarder: controlChannel.forwarder,
        fifoPath: controlChannel.fifoPath,
        inner,
      })
    : platform === "darwin"
      ? `exec script -q /dev/null /bin/sh -c ${quote(inner)}`
      : `exec script -q -c ${quote(inner)} /dev/null`;
  return cwd ? `cd ${quote(cwd)} && ${launch}` : launch;
}
