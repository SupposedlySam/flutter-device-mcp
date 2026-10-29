/**
 * Siri Remote keys and wake for a physical Apple TV, through pyatv's
 * `atvremote` CLI over the Companion protocol.
 *
 * Apple ships no command-line remote: devicectl has no key or wake verb, and
 * pymobiledevice3 has neither for tvOS. pyatv speaks the protocol the iPhone's
 * Remote widget uses, so its keys arrive at tvOS as real remote presses — the
 * focus engine moves, and the app sees exactly what a person with the remote
 * would produce.
 *
 * It is optional. Pairing is a one-time PIN shown on the TV
 * (`atvremote -n "<name>" --protocol companion pair`), and pyatv keeps the
 * credentials in its own per-user storage, so nothing device-specific reaches
 * this repo. Without the CLI or a pairing, keys report `{supported:false}` with
 * the steps to set it up.
 */
import fs from "fs";
import path from "path";
import { CommandResult, quote } from "./cli.js";
import { InputController, InputMode, Platform, UnsupportedInputError } from "./types.js";

export const ATVREMOTE_BIN = "atvremote";

/**
 * pyatv's event-loop setup fails on Python 3.14 ("There is no current event
 * loop"). 3.12 is the interpreter it is known to work under against a physical
 * Apple TV, so the install command names that one.
 */
export const ATVREMOTE_INSTALL_HINT =
  "Install pyatv under a Python known to work, 3.12 (`pipx install pyatv --python python3.12`; " +
  "pyatv's CLI fails on 3.14 with \"There is no current event loop\"), pair once with " +
  '`atvremote -n "<Apple TV name>" --protocol companion pair` (enter the PIN shown on the TV), ' +
  "then retry. Set FLUTTER_DEVICE_ATVREMOTE to the binary when it is not on PATH or in ~/.local/bin.";

/** Directories searched after PATH; pipx installs into ~/.local/bin. */
export function defaultAtvremoteSearchDirs(home: string): string[] {
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin"];
  if (home) dirs.unshift(path.join(home, ".local", "bin"));
  return dirs;
}

/**
 * The `atvremote` to run: `FLUTTER_DEVICE_ATVREMOTE` when it exists, else the first
 * hit on PATH, else the known install dirs. Undefined when there is none.
 */
export function resolveAtvremote(
  opts: { env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}
): string | undefined {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const override = env.FLUTTER_DEVICE_ATVREMOTE?.trim();
  if (override) return exists(override) ? override : undefined;
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...defaultAtvremoteSearchDirs(env.HOME ?? ""),
  ];
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, ATVREMOTE_BIN);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Which Apple TV `atvremote` addresses. pyatv's own identifier (`-i`) is exact;
 * the device name (`-n`) is what devicectl already reports, so it needs no
 * configuration and is used when no identifier is set.
 */
export interface AtvTarget {
  id?: string;
  name?: string;
}

/** Remote key names accepted by `flutter_key`, mapped to atvremote commands. */
const KEY_COMMANDS: Record<string, string> = {
  UP: "up",
  DOWN: "down",
  LEFT: "left",
  RIGHT: "right",
  ENTER: "select",
  SELECT: "select",
  OK: "select",
  BACK: "menu",
  RETURN: "menu",
  MENU: "menu",
  HOME: "home",
  PLAY: "play_pause",
  PAUSE: "play_pause",
  PLAY_PAUSE: "play_pause",
  PLAYPAUSE: "play_pause",
};

export const ATV_SUPPORTED_KEYS = Object.keys(KEY_COMMANDS);

/** The atvremote command for a key, or undefined for a key the remote lacks. */
export function atvremoteKeyCommand(key: string): string | undefined {
  const normalized = key.trim().toUpperCase().replace(/^KEY_/, "");
  return KEY_COMMANDS[normalized];
}

export function buildAtvremoteCommand(
  binary: string,
  target: AtvTarget,
  command: string
): string {
  const selector = target.id
    ? `-i ${quote(target.id)}`
    : target.name
      ? `-n ${quote(target.name)}`
      : "";
  return [quote(binary), selector, command].filter(Boolean).join(" ");
}

/**
 * pyatv's wording when the device is known but no Companion credentials are
 * stored for it, or when the scan never found it.
 */
const NOT_PAIRED = /(?:pair|credentials|authentication|NotPaired|not paired)/i;
const NOT_FOUND = /(?:Could not find any Apple TV|Device .* not found|no device found)/i;

/** A failed atvremote run, phrased with what to do about it. */
export function describeAtvremoteFailure(result: CommandResult): string {
  const output = result.combined.trim().slice(-400);
  if (NOT_FOUND.test(output)) {
    return (
      `atvremote could not find the Apple TV on the network (${output}). It must be on ` +
      "the same LAN; set FLUTTER_DEVICE_TVOS_ATV_ID to its pyatv identifier (`atvremote scan`) " +
      "if its name is ambiguous."
    );
  }
  if (NOT_PAIRED.test(output)) {
    return `atvremote is not paired with this Apple TV (${output}). ${ATVREMOTE_INSTALL_HINT}`;
  }
  return `atvremote failed: ${output || `exit ${result.code}`}`;
}

/**
 * Sends Siri Remote presses. The device is resolved per send, because the same
 * controller lives across calls that may name different targets.
 */
export class AtvRemoteInputController implements InputController {
  readonly platform: Platform = "tvos";
  private _mode: InputMode = "dpad";

  constructor(
    private readonly deps: {
      binary: () => string | undefined;
      target: () => Promise<AtvTarget | { unsupported: string }>;
      run: (command: string) => Promise<CommandResult>;
    }
  ) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(mode: InputMode): void {
    this._mode = mode;
  }

  async key(name: string): Promise<void> {
    const command = atvremoteKeyCommand(name);
    if (!command) {
      throw new UnsupportedInputError(
        `The Siri Remote has no "${name}" key. Supported: ${ATV_SUPPORTED_KEYS.join(", ")}.`
      );
    }
    const binary = this.deps.binary();
    if (!binary) {
      throw new UnsupportedInputError(
        `Remote keys on a physical Apple TV go through pyatv's atvremote, which is not installed. ${ATVREMOTE_INSTALL_HINT}`
      );
    }
    const target = await this.deps.target();
    if ("unsupported" in target) throw new UnsupportedInputError(target.unsupported);
    const result = await this.deps.run(buildAtvremoteCommand(binary, target, command));
    if (!result.success) {
      throw new UnsupportedInputError(describeAtvremoteFailure(result));
    }
  }

  async pointerMove(): Promise<void> {
    throw new UnsupportedInputError(
      "tvOS has no free cursor: the Siri Remote moves focus. Use flutter_key " +
        "UP/DOWN/LEFT/RIGHT, or Marionette over the VM service."
    );
  }

  async pointerClick(): Promise<void> {
    throw new UnsupportedInputError(
      "tvOS has no pointer. flutter_key ENTER selects the focused element; " +
        "Marionette tap reaches a widget directly."
    );
  }

  async pointerScroll(): Promise<void> {
    throw new UnsupportedInputError(
      "tvOS has no free-cursor scroll. Move focus with flutter_key, or use " +
        "Marionette scroll_to/swipe."
    );
  }
}
