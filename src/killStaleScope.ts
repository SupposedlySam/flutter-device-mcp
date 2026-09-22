/**
 * Device-scoped teardown of leftover launch drivers.
 *
 * WHY this exists rather than a `pkill -f "flutter run"`: `pkill -f` matches the
 * whole command line, so on a host with two attached targets it cannot tell a
 * wedged session on the device being deployed to from a healthy session someone
 * is actively using on the OTHER device — both match identically. The device
 * selection layer (`device_udid`, env pins, self-heal) is device-aware, so a
 * teardown that is not makes `flutter_deploy` unusable on a multi-target host:
 * choosing the emulator with `device_udid` still killed the phone's session.
 *
 * So attribution is done per PROCESS, not per pattern: read the process table
 * once, decide which launch drivers belong to the resolved device, and signal
 * those pids and their subtrees. What was deliberately left running is named in
 * the result, because a teardown that silently declines to kill a wedged session
 * is the other way to break the one thing this exists to do.
 *
 * Attribution, strongest evidence first:
 *  1. a pid this MCP itself recorded for the device at launch (launchRegistry),
 *     which is proof rather than inference;
 *  2. the driver's own `-d`/`--device-id` argument;
 *  3. any process in the driver's SUBTREE naming the device — a live `flutter
 *     run` on Android keeps an `adb -s <serial> shell -x logcat` child, so a
 *     session launched with no `-d` is still attributable;
 *  4. failing all of that, the target being the ONLY attached device of its
 *     platform, which is the single-device host where a `flutter run` with no
 *     `-d` is the normal shape and cannot be on anything else.
 *
 * An id is only ever read as naming the target when NO OTHER attached device
 * claims it (see {@link buildDeviceIdentity}). That rule is the whole safety
 * property: a physical iPhone is called `iPhone` by default and `flutter run -d`
 * accepts a name, so treating a device name as an identity without checking
 * uniqueness let a deploy to a simulator called "iPhone 16 Pro" kill the phone —
 * the very defect this module removes. Two emulators booted from one AVD image
 * report identical `model`/`product` for the same reason.
 *
 * A driver none of the four rungs attributes is REPORTED, not killed: its pid
 * and what could not be determined go back to the caller.
 */
import { runShell } from "./cli.js";
import { CommandResult } from "./types.js";

/** One row of the process table: pid, parent pid, full command line. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * The process-table read. `pid=`/`ppid=`/`command=` suppress the header (so the
 * parse has no header line to special-case), `command=` is the FULL argv rather
 * than the truncated `comm` — attribution needs the `-d <serial>` argument,
 * which only argv carries — and `-ww` defeats the width truncation `ps` applies
 * when stdout is not a terminal, which would drop a `-d` sitting at the end of a
 * long command line and silently miss the match.
 */
export const PROCESS_TABLE_COMMAND = "ps -Awwo pid=,ppid=,command=";

/**
 * The reconciliation read: the same rows WITHOUT the command column.
 *
 * An argv can contain a newline, which splits one row of {@link
 * PROCESS_TABLE_COMMAND} into phantom rows whose leading numbers are read as a
 * pid and ppid — and a phantom that lands under a targeted driver's pid would be
 * signalled despite having no relationship to it. This read cannot contain argv,
 * so any (pid, ppid) pair absent from it is not a real process.
 */
export const PROCESS_PAIRS_COMMAND = "ps -Awwo pid=,ppid=";

/**
 * Command lines that identify a `flutter run` launch driver.
 *
 * BOTH forms are needed because one launch shows up as several processes: the
 * pty wrapper and the `fvm flutter run …` shim carry the literal `flutter run`,
 * while the process that actually holds the device is the Dart snapshot
 * (`… flutter_tools.snapshot run --debug -d <serial>`), whose argv says
 * `flutter_tools`, never `flutter run`. The `run` in the second pattern is
 * load-bearing: the IDE's own `flutter_tools.snapshot daemon` (and the analysis
 * server) must not read as a launch driver.
 */
export const FLUTTER_RUN_DRIVER_PATTERNS: readonly RegExp[] = [
  /(?:^|[/\s])flutter\s+run(?:\s|$)/,
  /flutter_tools(?:\.snapshot)?\s+run(?:\s|$)/,
];

/** The Dart compiler process a launch driver spawns as a child. */
const COMPILER_PATTERN = /frontend_server/;

/** Parse `ps -Awwo pid=,ppid=,command=` output; unparseable lines are skipped. */
export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of (output ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    });
  }
  return entries;
}

/** Parse `ps -Awwo pid=,ppid=` into `"<pid>:<ppid>"` keys. */
export function parseProcessPairs(output: string): Set<string> {
  const pairs = new Set<string>();
  for (const line of (output ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) pairs.add(`${Number(match[1])}:${Number(match[2])}`);
  }
  return pairs;
}

/**
 * Drop any parsed row the command-free read does not corroborate — the phantom
 * rows a newline inside an argv produces, and anything a degraded `ps` wrote to
 * stderr that happens to start with two numbers.
 *
 * A process that started between the two reads is dropped too. That is the safe
 * direction: this decides what to SIGNAL, so an unverified row must not be in
 * the set, and a driver missed here is reported rather than killed.
 */
export function reconcileProcessTable(
  rows: readonly ProcessEntry[],
  pairs: Set<string>
): ProcessEntry[] {
  return rows.filter((row) => pairs.has(`${row.pid}:${row.ppid}`));
}

/**
 * Strip one layer of surrounding quotes.
 *
 * Not cosmetic: this MCP's own pty-bridged launch reaches the process table as
 * `… flutter run --debug -d '988a1b413950494c49'` with the quotes INSIDE the
 * argv word, so a bare equality check against the serial misses the very
 * sessions this module is meant to tear down.
 */
function unquote(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * The device argument a `flutter run` command line names, or undefined when it
 * names none. Covers every spelling flutter accepts: `-d X`, `-dX`,
 * `--device-id X`, `--device-id=X`.
 *
 * A QUOTED value is re-joined across the space it contains, because an iOS
 * device is commonly addressed by name (`-d 'My iPhone'`) and reading only the
 * first word would fail to recognize the session as that device's. An UNQUOTED
 * multi-word name cannot be delimited from the flags that follow it, so it comes
 * back as its first word — which will not match uniquely, and the session is
 * then reported rather than killed.
 */
export function extractDeviceToken(command: string): string | undefined {
  const tokens = command.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-d" || token === "--device-id" || token === "--device") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("-")) continue;
      return joinQuoted(tokens, i + 1);
    }
    const inline =
      /^--device(?:-id)?=(.+)$/.exec(token) ?? /^-d(?!-)(.+)$/.exec(token);
    if (inline) return unquote(inline[1]);
  }
  return undefined;
}

/**
 * The value starting at `start`, re-joined across spaces when it opens with a
 * quote that closes on a later token (`'My iPhone'`).
 */
function joinQuoted(tokens: string[], start: number): string {
  const first = tokens[start];
  const opener = first[0];
  const quoted = opener === "'" || opener === '"';
  if (!quoted || (first.length > 1 && first.endsWith(opener))) {
    return unquote(first);
  }
  const parts = [first.slice(1)];
  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.endsWith(opener)) {
      parts.push(token.slice(0, -1));
      return parts.join(" ");
    }
    parts.push(token);
  }
  return unquote(first);
}

/** One attached device as an adapter enumerates it: its id plus other names for it. */
export interface EnumeratedDevice {
  /** The id `flutter run -d` uses (adb serial, iOS flutter id). */
  id: string;
  /** Other ids naming the SAME device (adb model/product, iOS devicectl id, name). */
  aliases?: readonly (string | undefined)[];
  /**
   * Whether the device is usable right now (adb `device` state, a connected
   * iPhone, a booted simulator). Only available devices decide
   * {@link DeviceIdentity.soleAttached}; every listed device — available or not —
   * still takes part in the uniqueness check, which is the conservative
   * direction (more collisions means more sessions reported instead of killed).
   */
  available?: boolean;
}

/**
 * Which ids may be read as naming the target, which name somebody else, and
 * whether the target is the only device attached.
 */
export interface DeviceIdentity {
  /** Ids that name the target and NO other attached device. */
  target: readonly string[];
  /** Ids that name some other attached device, and not the target. */
  others: readonly string[];
  /**
   * Ids the target and some OTHER attached device both answer to — two emulators
   * from one AVD image reporting the same `model`, two identically named
   * simulators. Kept apart from `others` because such an id says nothing either
   * way: a session naming it might be this device's, so it is reported as
   * unattributable rather than as somebody else's.
   */
  ambiguous: readonly string[];
  /** True when the target is the only available device of its platform. */
  soleAttached: boolean;
}

const norm = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase();

/**
 * Build the identity of one target out of the full attached-device enumeration.
 *
 * An alias is only kept when NO other listed device claims it, because an alias
 * is a display name, not an identity: two emulators from one AVD image report
 * the same `model`/`product`, and two iPhones or simulators can share a name.
 * A shared alias is moved to `others` instead of being dropped, so a session
 * naming it is recognized as ambiguous (reported) rather than as the target's.
 *
 * When the target is not in the enumeration at all (detached, or a stale pin),
 * only its own id names it and `soleAttached` is false: nothing here may be
 * inferred about a device that is not there.
 */
export function buildDeviceIdentity(opts: {
  target: string;
  devices: readonly EnumeratedDevice[];
}): DeviceIdentity {
  const target = opts.target.trim();
  const targetKey = norm(target);
  const idsFor = (d: EnumeratedDevice): string[] =>
    [d.id, ...(d.aliases ?? [])]
      .map((id) => (id ?? "").trim())
      .filter((id) => id.length > 0);

  const matched = opts.devices.find((d) =>
    idsFor(d).some((id) => norm(id) === targetKey)
  );
  const otherDevices = opts.devices.filter((d) => d !== matched);
  const otherIds = new Set<string>();
  for (const device of otherDevices) {
    for (const id of idsFor(device)) otherIds.add(id);
  }
  const claimedByOthers = new Set([...otherIds].map(norm));

  const targetIds = matched ? idsFor(matched) : [target];
  if (!targetIds.some((id) => norm(id) === targetKey)) targetIds.push(target);

  // The id the caller resolved stays the target's even if something else answers
  // to it: it is the id every other verb of this deploy uses, so a teardown that
  // disowned it could not kill the session it is about to replace.
  const ambiguous = targetIds.filter(
    (id) => norm(id) !== targetKey && claimedByOthers.has(norm(id))
  );
  const ambiguousKeys = new Set(ambiguous.map(norm));

  const availableOthers = otherDevices.filter((d) => d.available !== false);
  return {
    target: [...new Set(targetIds.filter((id) => !ambiguousKeys.has(norm(id))))],
    others: [...otherIds].filter((id) => !ambiguousKeys.has(norm(id))),
    ambiguous: [...new Set(ambiguous)],
    soleAttached:
      !!matched && matched.available !== false && availableOthers.length === 0,
  };
}

/** What a `-d` value on some command line refers to. */
export type TokenClass = "target" | "other" | "unknown";

/**
 * Classify a device argument against one target's identity.
 *
 * An exact id match decides it. Otherwise a PREFIX is honored — flutter itself
 * resolves `-d emu` to `emulator-5554` — but ONLY when the prefix is unique:
 * a token that prefixes the target's ids AND some other attached device's is
 * `unknown`, never the target's. Without that uniqueness test the prefix rule
 * killed across devices (`-d emulator` matching `emulator-5556`), which is why
 * a fixed minimum token length is not a substitute for it.
 */
export function classifyDeviceToken(
  token: string | undefined,
  identity: DeviceIdentity
): TokenClass {
  const needle = norm(token);
  if (!needle) return "unknown";
  const hits = (ids: readonly string[], test: (id: string) => boolean) =>
    ids.filter((id) => test(norm(id))).length;

  // An id two devices answer to decides nothing, and must not be read as either.
  if (hits(identity.ambiguous, (id) => id === needle) > 0) return "unknown";
  if (hits(identity.target, (id) => id === needle) > 0) return "target";
  if (hits(identity.others, (id) => id === needle) > 0) return "other";

  const targetPrefix = hits(identity.target, (id) => id.startsWith(needle));
  const otherPrefix = hits(identity.others, (id) => id.startsWith(needle));
  const ambiguousPrefix = hits(identity.ambiguous, (id) =>
    id.startsWith(needle)
  );
  if (targetPrefix > 0 && otherPrefix === 0 && ambiguousPrefix === 0) {
    return "target";
  }
  if (otherPrefix > 0 && targetPrefix === 0 && ambiguousPrefix === 0) {
    return "other";
  }
  return "unknown";
}

/** True when a command line names one of these ids as a whole token. */
function commandNamesAny(command: string, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const wanted = new Set(ids.map(norm).filter(Boolean));
  return command
    .split(/\s+/)
    .map((token) => norm(unquote(token)))
    .some((token) => wanted.has(token));
}

/** How a driver process relates to the device being torn down. */
export type DriverAttribution = "targeted" | "other-device" | "unattributed";

/** A driver process, the decision made about it, and why. */
export interface AttributedDriver {
  process: ProcessEntry;
  attribution: DriverAttribution;
  /** The device argument the driver named, when it named one. */
  deviceToken?: string;
  /** Which rung of attribution decided it, for the result note. */
  reason: string;
}

/** What {@link planScopedKill} decided, so a caller can report it verbatim. */
export interface KillPlan {
  /** Pids to signal, deepest-first so a subtree tears down from the leaves. */
  pids: number[];
  targeted: AttributedDriver[];
  otherDevice: AttributedDriver[];
  unattributed: AttributedDriver[];
  /** `frontend_server` processes inside a targeted subtree (killed with it). */
  compilers: ProcessEntry[];
  /** `frontend_server` processes belonging to nobody killed here (left alone). */
  sparedCompilers: ProcessEntry[];
  /**
   * Processes matching a caller's report-only pattern that were NOT killed —
   * possibly-related leftovers this teardown cannot attribute (see
   * {@link planScopedKill}'s `reportOnlyPatterns`).
   */
  unrelated: ProcessEntry[];
}

/** Index children by parent pid. */
function childrenByParent(
  processes: readonly ProcessEntry[]
): Map<number, ProcessEntry[]> {
  const map = new Map<number, ProcessEntry[]>();
  for (const p of processes) {
    const siblings = map.get(p.ppid);
    if (siblings) siblings.push(p);
    else map.set(p.ppid, [p]);
  }
  return map;
}

/** Every descendant of `root`, breadth-first. */
function subtreeOf(
  root: ProcessEntry,
  children: Map<number, ProcessEntry[]>
): ProcessEntry[] {
  const collected: ProcessEntry[] = [];
  const seen = new Set<number>([root.pid]);
  let frontier = children.get(root.pid) ?? [];
  while (frontier.length > 0) {
    const next: ProcessEntry[] = [];
    for (const child of frontier) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      collected.push(child);
      next.push(...(children.get(child.pid) ?? []));
    }
    frontier = next;
  }
  return collected;
}

/** The pid chain from a process up to a root (excluding the process itself). */
function ancestorsOf(
  entry: ProcessEntry,
  byPid: Map<number, ProcessEntry>
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([entry.pid]);
  let current = byPid.get(entry.ppid);
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    chain.push(current.pid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

/** Depth from the process table's roots, for a deepest-first kill order. */
function depthOf(pid: number, byPid: Map<number, ProcessEntry>): number {
  const entry = byPid.get(pid);
  return entry ? ancestorsOf(entry, byPid).length : 0;
}

/**
 * Decide which launch drivers belong to the resolved device and which pids to
 * signal — pure over an already-read process table.
 *
 * No `identity` means UNSCOPED: every driver matching the patterns is targeted.
 * That is right for a platform whose driver pattern names its own toolchain
 * (`flutter-tvos`, which cannot be another platform's session) and for
 * `flutter_kill_stale`'s deliberate `all_devices` hammer — which additionally
 * passes `sweepOrphanCompilers`, the only mode that touches a `frontend_server`
 * belonging to nothing it killed.
 */
export function planScopedKill(opts: {
  processes: readonly ProcessEntry[];
  driverPatterns: readonly RegExp[];
  /** The target's identity; omitted → unscoped (every matching driver). */
  identity?: DeviceIdentity;
  /**
   * Pids this MCP recorded for the target at launch. Proof of ownership that
   * needs no inference from a command line, and it survives a session whose
   * argv says nothing about a device.
   */
  knownTargetPids?: readonly number[];
  /**
   * Patterns whose matches are REPORTED when not killed. For a platform whose
   * drivers are matched by their own toolchain name, an orphaned Dart snapshot
   * (its parent gone, so nothing links it to this platform) can no longer be
   * identified — naming it is better than either killing it blind or staying
   * silent.
   */
  reportOnlyPatterns?: readonly RegExp[];
  /**
   * Also kill `frontend_server` processes attributable to nothing torn down here
   * (an orphan, or an IDE's). Only the explicit all-devices hammer asks for
   * this: a compiler holds no device lock, so killing someone else's buys
   * nothing and interrupts their build.
   */
  sweepOrphanCompilers?: boolean;
  /** Pids never to signal (this process, and anything it must not take down). */
  protectedPids?: readonly number[];
}): KillPlan {
  const { processes, driverPatterns, identity } = opts;
  const scoped = !!identity;
  const sweepOrphanCompilers = opts.sweepOrphanCompilers === true;
  const protectedPids = new Set(opts.protectedPids ?? []);
  const knownPids = new Set(opts.knownTargetPids ?? []);

  const byPid = new Map(processes.map((p) => [p.pid, p] as const));
  const children = childrenByParent(processes);

  const drivers = processes.filter(
    (p) =>
      !protectedPids.has(p.pid) &&
      driverPatterns.some((pattern) => pattern.test(p.command))
  );

  const targeted: AttributedDriver[] = [];
  const otherDevice: AttributedDriver[] = [];
  const unattributed: AttributedDriver[] = [];

  for (const entry of drivers) {
    const deviceToken = extractDeviceToken(entry.command);
    if (!scoped) {
      targeted.push({
        process: entry,
        attribution: "targeted",
        deviceToken,
        reason: "unscoped teardown (every device)",
      });
      continue;
    }

    // Rung 1: a pid this MCP recorded for the device at launch.
    if (
      knownPids.has(entry.pid) ||
      ancestorsOf(entry, byPid).some((pid) => knownPids.has(pid))
    ) {
      targeted.push({
        process: entry,
        attribution: "targeted",
        deviceToken,
        reason: "pid recorded for this device by a previous deploy",
      });
      continue;
    }

    // Rung 2: the driver's own device argument.
    const own = classifyDeviceToken(deviceToken, identity);
    if (own === "target") {
      targeted.push({
        process: entry,
        attribution: "targeted",
        deviceToken,
        reason: "its -d argument names this device",
      });
      continue;
    }
    if (own === "other") {
      otherDevice.push({
        process: entry,
        attribution: "other-device",
        deviceToken,
        reason: "its -d argument names another attached device",
      });
      continue;
    }

    // Rung 3: what its subtree names. A live Android session keeps an
    // `adb -s <serial> …` child, so a session launched with no `-d` is still
    // attributable.
    const subtree = subtreeOf(entry, children);
    const subtreeClasses = subtree.map((child) => {
      const childToken = extractDeviceToken(child.command);
      if (childToken) return classifyDeviceToken(childToken, identity);
      if (commandNamesAny(child.command, identity.target)) return "target";
      if (commandNamesAny(child.command, identity.others)) return "other";
      return "unknown";
    });
    if (subtreeClasses.includes("target")) {
      targeted.push({
        process: entry,
        attribution: "targeted",
        deviceToken,
        reason: "a child process names this device",
      });
      continue;
    }
    if (subtreeClasses.includes("other")) {
      otherDevice.push({
        process: entry,
        attribution: "other-device",
        deviceToken,
        reason: "a child process names another attached device",
      });
      continue;
    }

    // Rung 4: nothing in the tree names any device, and this is the only device
    // attached — the single-device host, where a `flutter run` with no `-d` is
    // the normal shape and cannot be running on anything else.
    if (!deviceToken && identity.soleAttached) {
      targeted.push({
        process: entry,
        attribution: "targeted",
        reason: "names no device, and this is the only device attached",
      });
      continue;
    }

    unattributed.push({
      process: entry,
      attribution: "unattributed",
      deviceToken,
      reason: deviceToken
        ? `its -d argument (${deviceToken}) names no attached device, or more than one`
        : "nothing in its process tree names a device, and this host has more than one",
    });
  }

  // A driver's descendants come down with it — that is how the compiler
  // (frontend_server) and the `adb -s <serial>` helpers get attributed at all.
  const killSet = new Map<number, ProcessEntry>();
  for (const { process: driver } of targeted) {
    if (!protectedPids.has(driver.pid)) killSet.set(driver.pid, driver);
    for (const child of subtreeOf(driver, children)) {
      if (!protectedPids.has(child.pid)) killSet.set(child.pid, child);
    }
  }

  const orphanCompilers = processes.filter(
    (p) =>
      COMPILER_PATTERN.test(p.command) &&
      !killSet.has(p.pid) &&
      !protectedPids.has(p.pid)
  );
  if (sweepOrphanCompilers) {
    for (const compiler of orphanCompilers) killSet.set(compiler.pid, compiler);
  }

  const unrelated = (opts.reportOnlyPatterns ?? []).length
    ? processes.filter(
        (p) =>
          !killSet.has(p.pid) &&
          (opts.reportOnlyPatterns ?? []).some((pattern) =>
            pattern.test(p.command)
          )
      )
    : [];

  const pids = [...killSet.keys()].sort(
    (a, b) => depthOf(b, byPid) - depthOf(a, byPid)
  );

  return {
    pids,
    targeted,
    otherDevice,
    unattributed,
    compilers: [...killSet.values()].filter((p) =>
      COMPILER_PATTERN.test(p.command)
    ),
    sparedCompilers: sweepOrphanCompilers ? [] : orphanCompilers,
    unrelated,
  };
}

/** Shorten a command line so a result note stays readable. */
function brief(command: string, max = 110): string {
  return command.length <= max ? command : `${command.slice(0, max - 1)}…`;
}

/** `pid 8123 (fvm flutter run --debug -d 'emulator-5554')` */
function describe(process: ProcessEntry): string {
  return `pid ${process.pid} (${brief(process.command)})`;
}

/**
 * The human half of the result: what was killed, and what was deliberately left
 * running. The second half is the point — a caller whose wedged session could
 * not be attributed is told the pid and what could not be determined rather than
 * left to wonder why the deploy still fails.
 *
 * It states facts and stops there. It deliberately does NOT hand back a `kill
 * <pid>` to paste: this module exists because killing a process nothing has tied
 * to the device is the defect, and offering that as a remedy would put the blind
 * kill back in the caller's hands with none of the attribution behind it.
 */
export function describeKillPlan(plan: KillPlan, deviceLabel?: string): string {
  const scope = deviceLabel ? ` for ${deviceLabel}` : " (every device)";
  const lines: string[] = [];
  lines.push(
    plan.targeted.length > 0
      ? `Killed ${plan.targeted.length} launch driver(s)${scope}: ` +
          plan.targeted
            .map((d) => `${describe(d.process)} — ${d.reason}`)
            .join("; ") +
          (plan.pids.length > plan.targeted.length
            ? ` (with ${plan.pids.length - plan.targeted.length} child process(es)).`
            : ".")
      : `No launch driver found${scope} — nothing to kill.`
  );
  if (plan.otherDevice.length > 0) {
    lines.push(
      "Left running, on another device: " +
        plan.otherDevice
          .map((d) => `${describe(d.process)} — ${d.reason}`)
          .join("; ") +
        "."
    );
  }
  if (plan.unattributed.length > 0) {
    lines.push(
      "Left running, could not be attributed to any device: " +
        plan.unattributed
          .map((d) => `${describe(d.process)} — ${d.reason}`)
          .join("; ") +
        ". If a deploy still reports the device busy, one of these is the holder."
    );
  }
  if (plan.unrelated.length > 0) {
    lines.push(
      `Left running, possibly related but no longer identifiable: ` +
        plan.unrelated.map((p) => describe(p)).join("; ") +
        "."
    );
  }
  if (plan.sparedCompilers.length > 0) {
    lines.push(
      `Left ${plan.sparedCompilers.length} frontend_server process(es) alone ` +
        `(pid ${plan.sparedCompilers.map((p) => p.pid).join(", ")}) — not a child of ` +
        "anything killed here, so it belongs to another session or an IDE. It holds no " +
        "device lock."
    );
  }
  return lines.join(" ");
}

/** Exit codes this module reports, read by the server's kill_stale summary. */
export const KILL_STALE_EXIT = {
  /** Something was killed (`pkill`'s convention, which the summary already reads). */
  killed: 0,
  /** Nothing matched — a legitimate outcome, not a failure. */
  noMatch: 1,
  /**
   * The teardown could not be PERFORMED (the process table could not be read).
   * Distinct from `noMatch` on purpose: a scan that failed must never be
   * reported as a scan that found nothing, or an outage reads as a clean host.
   */
  unavailable: 2,
} as const;

/** Build a {@link CommandResult} out of a note and one of the exit codes. */
function resultFor(code: number, note: string): CommandResult {
  return {
    code,
    stdout: code === KILL_STALE_EXIT.unavailable ? "" : note,
    stderr: code === KILL_STALE_EXIT.unavailable ? note : "",
    combined: note,
    success: code === KILL_STALE_EXIT.killed,
    timedOut: false,
  };
}

/**
 * Read the process table, attribute the launch drivers, and signal the ones
 * belonging to the target.
 *
 * `driverKey` names the driver entry in the returned map so each adapter keeps
 * its own response field (`flutterRun` on iOS/Android). The `frontendServer`
 * entry reports the compiler separately, as it always has — but it is now the
 * compiler INSIDE the killed subtree, not every `frontend_server` on the host.
 */
export async function killScopedLaunchDrivers(opts: {
  driverPatterns: readonly RegExp[];
  driverKey: string;
  identity?: DeviceIdentity;
  knownTargetPids?: readonly number[];
  reportOnlyPatterns?: readonly RegExp[];
  sweepOrphanCompilers?: boolean;
  deviceLabel?: string;
}): Promise<Record<string, CommandResult>> {
  const [table, pairsRead] = await Promise.all([
    runShell(PROCESS_TABLE_COMMAND, { timeoutMs: 10000 }),
    runShell(PROCESS_PAIRS_COMMAND, { timeoutMs: 10000 }),
  ]);
  // Parse stdout ONLY. `combined` folds in stderr, whose lines are not process
  // rows — a degraded `ps` writing "2026 09 04 ps failed to read kmem" parses as
  // a pid/ppid pair otherwise.
  const pairs = parseProcessPairs(pairsRead.stdout);
  const processes = reconcileProcessTable(
    parseProcessTable(table.stdout),
    pairs
  );
  if (!table.success || !pairsRead.success || pairs.size === 0) {
    const note =
      "Could not read the process table, so NOTHING was killed and nothing is known " +
      `about what is running (${PROCESS_TABLE_COMMAND} exited ${table.code}, ` +
      `${PROCESS_PAIRS_COMMAND} exited ${pairsRead.code} with ${pairs.size} row(s)). ` +
      "This is not 'no stale processes' — the check itself failed.";
    return {
      [opts.driverKey]: resultFor(KILL_STALE_EXIT.unavailable, note),
      frontendServer: resultFor(KILL_STALE_EXIT.unavailable, note),
    };
  }

  const plan = planScopedKill({
    processes,
    driverPatterns: opts.driverPatterns,
    identity: opts.identity,
    knownTargetPids: opts.knownTargetPids,
    reportOnlyPatterns: opts.reportOnlyPatterns,
    sweepOrphanCompilers: opts.sweepOrphanCompilers,
    protectedPids: [process.pid],
  });

  let killNote = "";
  if (plan.pids.length > 0) {
    const kill = await runShell(`kill ${plan.pids.join(" ")} 2>&1`, {
      timeoutMs: 10000,
    });
    // A pid that vanished between the read and the signal (a parent's death
    // reaping its child) makes `kill` exit non-zero; that is not a failure of
    // the teardown, so it is reported as a note rather than flipping the result.
    const output = kill.combined.trim();
    if (output) killNote = ` kill reported: ${brief(output, 200)}`;
  }

  const note = `${describeKillPlan(plan, opts.deviceLabel)}${killNote}`;
  const compilerNote =
    plan.compilers.length > 0
      ? "Killed the launch driver's Dart compiler: " +
        plan.compilers.map((p) => `pid ${p.pid}`).join(", ") +
        "."
      : "No frontend_server belonged to the launch driver(s) torn down here." +
        (plan.sparedCompilers.length > 0
          ? ` ${plan.sparedCompilers.length} other frontend_server process(es) were left alone.`
          : "");

  return {
    [opts.driverKey]: resultFor(
      plan.targeted.length > 0
        ? KILL_STALE_EXIT.killed
        : KILL_STALE_EXIT.noMatch,
      note
    ),
    frontendServer: resultFor(
      plan.compilers.length > 0
        ? KILL_STALE_EXIT.killed
        : KILL_STALE_EXIT.noMatch,
      compilerNote
    ),
  };
}
