/**
 * webOS input controller — the real dual-mode (D-pad + native pointer) input
 * plane over LG's ssap channel ({@link WebosSsapClient}).
 *
 * Structurally identical to {@link TizenInputController}: the device host is
 * resolved LAZILY via an injected resolver (multi-dev safe, no baked-in IP) and
 * the socket is created on first use. The BEHAVIORAL difference is the pointer
 * plane: webOS's Magic Remote is a native cursor, so `pointerMove`/
 * `pointerScroll` are SUPPORTED here — they send real move/scroll frames rather
 * than throwing {@link UnsupportedInputError} the way the focus/D-pad-only
 * Tizen controller does.
 *
 * CONTRACT: {@link InputController.pointerMove} takes an ABSOLUTE device-pixel
 * target (the server passes absolute coords, converted logical→device by the DPR
 * helper). The ssap pointer socket only accepts RELATIVE deltas, so this
 * controller tracks a virtual cursor position and emits the delta needed to
 * reach the requested absolute target. This is the reference pointer-native
 * implementation of the neutral contract.
 *
 * SCAFFOLD NOTE: the ssap pointer frames follow the documented LG protocol but
 * are unverified against a webOS-26 device.
 */
import { InputController, InputMode, Platform } from "../types.js";
import { normalizeWebosButton, WebosSsapClient } from "./webosSsap.js";

/** Resolves the current device host (bare IP, no port) on demand. */
export type WebosHostResolver = () => Promise<string>;

/** Creates a {@link WebosSsapClient} for a host. Injected for testability. */
export type WebosSsapClientFactory = (host: string) => WebosSsapClient;

const defaultWebosSsapClientFactory: WebosSsapClientFactory = (host) =>
  new WebosSsapClient({ host });

export class WebosInputController implements InputController {
  readonly platform: Platform = "webos";
  private _mode: InputMode = "dpad";

  private client: WebosSsapClient | undefined;
  private clientHost: string | undefined;

  /**
   * The virtual cursor position, in device pixels, tracked so absolute
   * {@link pointerMove} targets can be turned into the relative deltas the ssap
   * pointer socket requires. Undefined until the first move seeds it.
   */
  private cursor: { x: number; y: number } | undefined;

  constructor(
    private readonly resolveHost: WebosHostResolver,
    private readonly ssapClientFactory: WebosSsapClientFactory = defaultWebosSsapClientFactory
  ) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(mode: InputMode): void {
    this._mode = mode;
  }

  async key(name: string): Promise<void> {
    const client = await this.ensureClient();
    await client.button(normalizeWebosButton(name));
  }

  // Supported on webOS (Magic Remote is a native pointer), unlike Tizen. The
  // contract passes an ABSOLUTE device-pixel target; the ssap pointer socket
  // only accepts RELATIVE deltas, so we track a virtual cursor and emit the
  // delta to reach the target. The cursor seeds at the origin (0,0) on the first
  // move — there is no way to read the TV's actual cursor position over ssap, so
  // the first move carries the full absolute target as its delta from origin and
  // subsequent moves are incremental from there.
  async pointerMove(x: number, y: number): Promise<void> {
    const client = await this.ensureClient();
    const from = this.cursor ?? { x: 0, y: 0 };
    const dx = x - from.x;
    const dy = y - from.y;
    this.cursor = { x, y };
    await client.move(dx, dy);
  }

  async pointerClick(): Promise<void> {
    const client = await this.ensureClient();
    await client.click();
  }

  async pointerScroll(dy: number): Promise<void> {
    const client = await this.ensureClient();
    await client.scroll(dy);
  }

  /** Resolve the host, (re)create the client if the host changed, and return it. */
  private async ensureClient(): Promise<WebosSsapClient> {
    const host = await this.resolveHost();
    if (!this.client || this.clientHost !== host) {
      if (this.client) this.client.close();
      this.client = this.ssapClientFactory(host);
      this.clientHost = host;
    }
    return this.client;
  }
}
