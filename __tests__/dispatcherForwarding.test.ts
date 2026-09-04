import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildToolList } from "../src/toolRegistry.js";

/**
 * Every argument a tool ADVERTISES must reach the code that implements it.
 *
 * The schema in toolRegistry says what a tool accepts; the dispatcher in index.ts decides what it
 * forwards. They are two statements of one policy and nothing compared them, so `mode` — described
 * in its own schema as "the PREFERRED way to ask for one" — was advertised on flutter_build and
 * flutter_deploy, accepted by CommandCore, and silently dropped in between. A caller asking for a
 * release build got the debug path and a success report.
 *
 * Every existing test exercised a handler or a controller directly, so the whole suite passed with
 * the feature unreachable. This is the only test that crosses the dispatcher.
 */
const dispatcherSource = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "..", "src", "index.ts"), "utf8");
})();

/**
 * Arguments the dispatcher consumes at entry instead of forwarding into a handler.
 *
 * Deliberately an explicit, short allowlist rather than a clever parse. `app_dir` selects the
 * CommandCore the whole call runs against (`this.coreFor(args.app_dir)`) and `platform` is resolved
 * into the shared `common` object, so neither appears inside an individual case block. A detector
 * that could not see this reported seven false positives out of eight on its first run, and a check
 * that cries wolf on seven of eight is one people learn to ignore.
 */
const CONSUMED_AT_ENTRY = new Set(["app_dir", "platform"]);

/**
 * Pre-built argument objects the dispatcher passes whole, e.g. `core.terminate(withDevicePin)`.
 *
 * The lifecycle verbs share one object rather than re-listing its fields, so the properties it
 * carries never appear as `args.<name>` inside their case blocks. A detector blind to this reported
 * four of them as dropping `device_udid` when all four forward it correctly. The map is verified
 * against the source below, so it cannot quietly stop being true.
 */
const PREBUILT: Record<string, readonly string[]> = {
  withDevicePin: ["device_udid"],
};

/** The body of one `case "<tool>":` block, up to the next case label. */
function caseBlockFor(tool: string): string | undefined {
  const start = dispatcherSource.indexOf(`case "${tool}":`);
  if (start < 0) return undefined;
  const next = dispatcherSource.indexOf('case "', start + tool.length + 8);
  return dispatcherSource.slice(start, next < 0 ? undefined : next);
}

describe("dispatcher forwards every advertised argument", () => {
  const { flutter } = buildToolList();

  it.each(flutter.map((t) => [t.name, t] as const))(
    "%s reaches its handler with every argument its schema declares",
    (name, tool) => {
      const block = caseBlockFor(name);
      expect(block).toBeDefined();

      const viaPrebuilt = new Set(
        Object.entries(PREBUILT)
          .filter(([obj]) => block!.includes(obj))
          .flatMap(([, props]) => props)
      );

      const dropped = Object.keys(tool.inputSchema.properties ?? {}).filter(
        (prop) =>
          !CONSUMED_AT_ENTRY.has(prop) &&
          !viaPrebuilt.has(prop) &&
          !block!.includes(`args.${prop}`)
      );

      expect({ tool: name, dropped }).toEqual({ tool: name, dropped: [] });
    }
  );

  it.each(Object.entries(PREBUILT))(
    "%s really does carry the arguments this test credits it with",
    (obj, props) => {
      // Without this, PREBUILT is an unchecked assertion: deleting `device_udid` from
      // withDevicePin would silently excuse four tools from the very check that should catch it.
      const decl = dispatcherSource.slice(dispatcherSource.indexOf(`const ${obj} = {`));
      const body = decl.slice(0, decl.indexOf("};") + 2);
      for (const prop of props) expect(body).toContain(`args.${prop}`);
    }
  );

  it("reads a dispatcher that actually contains the cases it checks", () => {
    // Without this the suite passes vacuously if index.ts moves or the case syntax changes:
    // caseBlockFor would return undefined for everything and `dropped` would be empty.
    expect(flutter.every((t) => caseBlockFor(t.name) !== undefined)).toBe(true);
  });
});
