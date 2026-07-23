/**
 * Tizen input controller — the real dual-mode (D-pad + pointer) input plane.
 *
 * Implements the platform-neutral {@link InputController} over the Samsung
 * remote-control WebSocket channel ({@link SamsungWsClient}). The device host is
 * NOT held here directly: it is resolved LAZILY via an injected resolver so the
 * controller always targets the currently-connected device (multi-dev safe —
 * no baked-in IP), and the underlying socket is created on first use.
 *
 * D-pad keys map to verified Samsung `KEY_*` wire messages. Pointer CLICK uses
 * the verified KEY_ENTER path (which activates the currently-focused element —
 * confirmed on-device). Free-cursor pointer MOVE and SCROLL are
 * non-functional-by-design on Tizen: live device testing established the native
 * touchpad channel has no observable effect on this focus/D-pad-driven app, so
 * those methods throw {@link UnsupportedInputError} rather than sending a
 * no-op message. They remain on the class for interface compliance; webOS will
 * implement them for real (Magic Remote pointer).
 */
import { buildKeyMessage, SamsungWsClient } from "./samsungWs.js";
import {
  InputController,
  InputMode,
  Platform,
  UnsupportedInputError,
} from "../types.js";

/** Shared message for the Tizen-unsupported free-cursor pointer methods. */
const POINTER_UNSUPPORTED_MESSAGE =
  "Pointer move/scroll is not supported on the Tizen appliance: its UI is " +
  "focus/D-pad-based and the Samsung remote touchpad channel does not reach " +
  "the app. Use flutter_key for navigation (and flutter_pointer 'click' to " +
  "activate the focused element). Free-cursor pointer move/scroll is a " +
  "pointer-native-platform capability (webOS Magic Remote).";

/**
 * Normalize a caller-supplied key name to a full Samsung `KEY_*` token.
 *
 * Accepts short navigation names (case-insensitive) and passes through anything
 * that already looks like a `KEY_*` name. `BACK` maps to Samsung's KEY_RETURN.
 */
export function normalizeKeyName(name: string): string {
  const trimmed = name.trim();
  if (/^KEY_/i.test(trimmed)) return trimmed.toUpperCase();

  const short: Record<string, string> = {
    UP: "KEY_UP",
    DOWN: "KEY_DOWN",
    LEFT: "KEY_LEFT",
    RIGHT: "KEY_RIGHT",
    ENTER: "KEY_ENTER",
    OK: "KEY_ENTER",
    SELECT: "KEY_ENTER",
    RETURN: "KEY_RETURN",
    BACK: "KEY_RETURN",
    HOME: "KEY_HOME",
  };
  const mapped = short[trimmed.toUpperCase()];
  if (mapped) return mapped;

  // Unknown short name: uppercase + KEY_ prefix as a best-effort passthrough.
  return `KEY_${trimmed.toUpperCase()}`;
}

/** Resolves the current device host (bare IP, no sdb port) on demand. */
export type HostResolver = () => Promise<string>;

/** Creates a {@link SamsungWsClient} for a host. Injected for testability. */
export type WsClientFactory = (host: string) => SamsungWsClient;

const defaultWsClientFactory: WsClientFactory = (host) =>
  new SamsungWsClient({ host });

export class TizenInputController implements InputController {
  readonly platform: Platform = "tizen";
  private _mode: InputMode = "dpad";

  private client: SamsungWsClient | undefined;
  private clientHost: string | undefined;

  constructor(
    private readonly resolveHost: HostResolver,
    private readonly wsClientFactory: WsClientFactory = defaultWsClientFactory
  ) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(mode: InputMode): void {
    this._mode = mode;
  }

  async key(name: string): Promise<void> {
    await this.sendRaw(buildKeyMessage(normalizeKeyName(name)));
  }

  // Non-functional-by-design on Tizen (interface compliance only): live device
  // testing confirmed the native touchpad move/scroll has no effect on this
  // focus/D-pad-driven app. `x`/`y`/`dy` are accepted for signature parity.
  async pointerMove(_x: number, _y: number): Promise<void> {
    throw new UnsupportedInputError(POINTER_UNSUPPORTED_MESSAGE);
  }

  async pointerClick(): Promise<void> {
    // Verified on-device: KEY_ENTER activates the currently-focused element.
    await this.sendRaw(buildKeyMessage("KEY_ENTER"));
  }

  async pointerScroll(_dy: number): Promise<void> {
    throw new UnsupportedInputError(POINTER_UNSUPPORTED_MESSAGE);
  }

  /** Resolve the host, (re)create the client if the host changed, and send. */
  private async sendRaw(message: string): Promise<void> {
    const host = await this.resolveHost();
    if (!this.client || this.clientHost !== host) {
      if (this.client) this.client.close();
      this.client = this.wsClientFactory(host);
      this.clientHost = host;
    }
    await this.client.send(message);
  }
}
