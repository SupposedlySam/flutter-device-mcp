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

/** Mirrors `withControlFifoStdin` from `src/ptyControl.ts`. */
const withControlFifoStdin = (inner: string, fifoPath: string) =>
  `exec 3<>${quote(fifoPath)}; ${inner} <&3`;

/** Behavior-identical stand-in for `buildPtyCaptureCommand`. */
export function mockBuildPtyCaptureCommand(opts: {
  inner: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  controlFifoPath?: string;
}): string {
  const { inner, cwd, platform = process.platform, controlFifoPath } = opts;
  const wiredInner = controlFifoPath
    ? withControlFifoStdin(inner, controlFifoPath)
    : inner;
  const script =
    platform === "darwin"
      ? `exec script -q /dev/null /bin/sh -c ${quote(wiredInner)}`
      : `exec script -q -c ${quote(wiredInner)} /dev/null`;
  return cwd ? `cd ${quote(cwd)} && ${script}` : script;
}
