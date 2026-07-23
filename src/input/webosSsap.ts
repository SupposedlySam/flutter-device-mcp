/**
 * webOS ssap (Simple Service Access Protocol) input client.
 *
 * Drives the appliance's physical input over LG's ssap WebSocket channel — the
 * same protocol the Magic Remote and second-screen apps use. This is the webOS
 * counterpart of `samsungWs.ts`, and it mirrors that module's shape: PURE
 * message builders (exported for unit tests) plus a thin socket-lifecycle class
 * with an INJECTED socket factory so tests never open a real connection.
 *
 * Two planes are involved, because unlike the Samsung remote both work on webOS:
 *   - The main ssap channel: used to register (pairing) and to REQUEST the
 *     dedicated pointer-input socket
 *     (`ssap://com.webos.service.networkinput/getPointerInputSocket`).
 *   - The dedicated POINTER socket that request hands back: ALL input frames —
 *     D-pad buttons (`type:button`) as well as `type:move`/`type:click`/
 *     `type:scroll` — are sent over THIS socket, not the main channel. The Magic
 *     Remote is a real cursor, so `pointerMove`/`pointerScroll` are supported
 *     here (they throw {@link UnsupportedInputError} on Tizen).
 *
 * SCAFFOLD NOTE: the ssap handshake + pointer-socket handoff are written to the
 * documented LG protocol; there is no webOS-26 device to confirm the exact
 * registration payload against, so the connect/register flow is intentionally
 * minimal and the socket factory is injected.
 */
import WebSocketImpl from "ws";
import { logger } from "../logger.js";
import { loadWebosClientKey, saveWebosClientKey } from "./webosToken.js";

/** ssap ports: 3000 (ws) and 3001 (wss). We use wss with the self-signed cert. */
export const SSAP_WSS_PORT = 3001;

// =========== PURE: URL + MESSAGE FRAMING ==========

/** Build the ssap WSS URL for a bare device host (`:3001` appended here). */
export function buildSsapUrl(host: string): string {
  return `wss://${host}:${SSAP_WSS_PORT}`;
}

/**
 * Normalize a caller-supplied key name to a webOS Magic Remote button token.
 *
 * webOS button names differ from Samsung's `KEY_*` scheme: they are bare
 * uppercase tokens (`UP`, `ENTER`, `BACK`, `HOME`). Short navigation names map
 * directly; a Samsung-style `KEY_UP` is accepted and stripped to `UP` so the
 * same caller input works across platforms.
 */
export function normalizeWebosButton(name: string): string {
  const trimmed = name.trim().toUpperCase();
  const stripped = trimmed.replace(/^KEY_/, "");
  const map: Record<string, string> = {
    UP: "UP",
    DOWN: "DOWN",
    LEFT: "LEFT",
    RIGHT: "RIGHT",
    ENTER: "ENTER",
    OK: "ENTER",
    SELECT: "ENTER",
    RETURN: "BACK",
    BACK: "BACK",
    HOME: "HOME",
    EXIT: "EXIT",
  };
  return map[stripped] ?? stripped;
}

/**
 * Build a ssap registration frame. The first frame a client sends; webOS
 * replies with a client-key which later connects are expected to present. We
 * send an empty manifest — enough for input, no app-control permissions.
 */
export function buildRegisterMessage(clientKey?: string): string {
  return JSON.stringify({
    type: "register",
    id: "register_0",
    payload: {
      ...(clientKey ? { "client-key": clientKey } : {}),
      manifest: {
        permissions: ["CONTROL_INPUT_JOYSTICK", "CONTROL_INPUT_MEDIA_RECORDING"],
      },
    },
  });
}

/**
 * Build the request for a dedicated pointer-input socket. webOS replies with a
 * `socketPath` (a nested ssap URI) that the client opens for pointer frames.
 */
export function buildPointerSocketRequest(): string {
  return JSON.stringify({
    type: "request",
    id: "pointer_0",
    uri: "ssap://com.webos.service.networkinput/getPointerInputSocket",
  });
}

/** Build a Magic-Remote button frame for the dedicated pointer socket. */
export function buildButtonFrame(button: string): string {
  // The pointer socket takes newline-terminated `key\nvalue\n\n` blocks.
  return `type:button\nname:${button}\n\n`;
}

/** Build a pointer MOVE frame (device pixels, relative deltas per webOS). */
export function buildMoveFrame(dx: number, dy: number, drag = false): string {
  return `type:move\ndx:${dx}\ndy:${dy}\ndown:${drag ? 1 : 0}\n\n`;
}

/** Build a pointer CLICK frame (activates whatever the cursor is over). */
export function buildClickFrame(): string {
  return `type:click\n\n`;
}

/** Build a pointer SCROLL frame (positive dy = down). */
export function buildScrollFrame(dx: number, dy: number): string {
  return `type:scroll\ndx:${dx}\ndy:${dy}\n\n`;
}

// =========== PURE: REGISTER-REPLY INTERPRETATION ==========

export type SsapRegisterEvaluation =
  | { kind: "registered"; clientKey?: string }
  | { kind: "prompt" }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

/**
 * Interpret a parsed ssap frame received while awaiting registration.
 *
 * `registered` completes the handshake (and may carry a `client-key` to
 * persist). `PROMPT` means the TV is showing its on-screen pairing prompt — keep
 * waiting. An `error` type is terminal.
 */
export function evaluateRegisterMessage(parsed: unknown): SsapRegisterEvaluation {
  if (!parsed || typeof parsed !== "object") return { kind: "ignore" };
  const msg = parsed as {
    type?: string;
    payload?: { "client-key"?: unknown; pairingType?: unknown; returnValue?: unknown };
    error?: unknown;
  };
  if (msg.type === "registered") {
    const key = msg.payload?.["client-key"];
    return { kind: "registered", clientKey: typeof key === "string" ? key : undefined };
  }
  if (msg.type === "response" && msg.payload?.pairingType === "PROMPT") {
    return { kind: "prompt" };
  }
  if (msg.type === "error") {
    return {
      kind: "error",
      message: typeof msg.error === "string" ? msg.error : "ssap registration error",
    };
  }
  return { kind: "ignore" };
}

/** Extract the pointer `socketPath` from a getPointerInputSocket response. */
export function parsePointerSocketPath(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const msg = parsed as { payload?: { socketPath?: unknown } };
  const path = msg.payload?.socketPath;
  return typeof path === "string" ? path : undefined;
}

// =========== SOCKET LIFECYCLE ==========

/** Minimal socket surface the client needs — satisfied by `ws` and by fakes. */
export interface SsapSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/** Opens an {@link SsapSocket} for a URL. Injected so tests never dial out. */
export type SsapSocketFactory = (url: string) => SsapSocket;

/** Default factory: a real `ws` socket that accepts the TV's self-signed cert. */
export const defaultSsapSocketFactory: SsapSocketFactory = (url: string) => {
  return new WebSocketImpl(url, {
    rejectUnauthorized: false,
  }) as unknown as SsapSocket;
};

export const SSAP_CONNECT_TIMEOUT_MS = 30000;

export interface WebosSsapClientOptions {
  /** Bare device host (no port). :3001 is appended internally. */
  host: string;
  /** Override the socket factory (tests inject a fake). */
  socketFactory?: SsapSocketFactory;
  /**
   * A previously-issued client-key to skip the on-screen prompt. When omitted,
   * the persisted key (if any) is loaded from {@link tokenFile} on connect.
   */
  clientKey?: string;
  /** Override the client-key file path (tests / non-default homes). */
  tokenFile?: string;
  /** Connect/register timeout in ms. */
  connectTimeoutMs?: number;
}

/**
 * One persistent ssap connection per host. Lazily opened + registered on first
 * send, reused across calls, and reopened after a drop. On the first (unpaired)
 * connect webOS shows an on-screen Allow prompt and returns a client-key.
 *
 * The pointer socket is requested lazily on the first pointer op and cached.
 */
export class WebosSsapClient {
  private readonly host: string;
  private readonly socketFactory: SsapSocketFactory;
  private clientKey: string | undefined;
  private readonly tokenFile: string | undefined;
  private readonly connectTimeoutMs: number;

  private socket: SsapSocket | undefined;
  private pointerSocket: SsapSocket | undefined;
  private connecting: Promise<SsapSocket> | undefined;

  constructor(opts: WebosSsapClientOptions) {
    this.host = opts.host;
    this.socketFactory = opts.socketFactory ?? defaultSsapSocketFactory;
    this.clientKey = opts.clientKey;
    this.tokenFile = opts.tokenFile;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? SSAP_CONNECT_TIMEOUT_MS;
  }

  /** Send a Magic-Remote button over the pointer socket (opening as needed). */
  async button(name: string): Promise<void> {
    const pointer = await this.ensurePointerSocket();
    pointer.send(buildButtonFrame(name));
  }

  /** Move the native cursor by a relative device-pixel delta. */
  async move(dx: number, dy: number): Promise<void> {
    const pointer = await this.ensurePointerSocket();
    pointer.send(buildMoveFrame(dx, dy));
  }

  /** Click at the current cursor position. */
  async click(): Promise<void> {
    const pointer = await this.ensurePointerSocket();
    pointer.send(buildClickFrame());
  }

  /** Scroll by a device-pixel delta (positive dy = down). */
  async scroll(dy: number): Promise<void> {
    const pointer = await this.ensurePointerSocket();
    pointer.send(buildScrollFrame(0, dy));
  }

  /** Close both sockets cleanly (idempotent). */
  close(): void {
    for (const s of [this.pointerSocket, this.socket]) {
      if (s) {
        try {
          s.close();
        } catch {
          // best effort
        }
      }
    }
    this.socket = undefined;
    this.pointerSocket = undefined;
    this.connecting = undefined;
  }

  /** Open + register the main ssap socket once, reusing it thereafter. */
  private ensureConnected(): Promise<SsapSocket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = this.openAndRegister()
      .then((socket) => {
        this.socket = socket;
        this.connecting = undefined;
        socket.on("close", () => {
          if (this.socket === socket) {
            this.socket = undefined;
            this.pointerSocket = undefined;
          }
        });
        socket.on("error", () => {
          if (this.socket === socket) {
            this.socket = undefined;
            this.pointerSocket = undefined;
          }
        });
        return socket;
      })
      .catch((err) => {
        this.connecting = undefined;
        throw err;
      });
    return this.connecting;
  }

  private openAndRegister(): Promise<SsapSocket> {
    // Prefer an explicitly-supplied key; otherwise load the persisted one so a
    // paired device skips the on-screen prompt across MCP restarts.
    if (!this.clientKey) {
      this.clientKey = this.tokenFile
        ? loadWebosClientKey(this.tokenFile)
        : loadWebosClientKey();
    }
    const socket = this.socketFactory(buildSsapUrl(this.host));
    return new Promise<SsapSocket>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(
          new Error(
            this.clientKey
              ? `Timed out connecting to the webOS ssap channel on ${this.host}:${SSAP_WSS_PORT}. The device may be offline or the client-key may be stale.`
              : `Timed out waiting for the on-screen Allow prompt on ${this.host}:${SSAP_WSS_PORT}. Accept the pairing prompt on the TV and retry.`
          )
        );
      }, this.connectTimeoutMs);

      const finish = (result: SsapSocket | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result instanceof Error) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          reject(result);
        } else {
          resolve(result);
        }
      };

      socket.on("open", () => socket.send(buildRegisterMessage(this.clientKey)));
      socket.on("error", (err) =>
        finish(err instanceof Error ? err : new Error(String(err)))
      );
      socket.on("close", () => {
        if (!settled) finish(new Error("ssap socket closed before registration completed."));
      });
      socket.on("message", (data) => {
        const parsed = safeParse(data);
        const evaluation = evaluateRegisterMessage(parsed);
        if (evaluation.kind === "registered") {
          if (evaluation.clientKey) {
            this.clientKey = evaluation.clientKey;
            // Persist the newly-issued key so later MCP runs skip the prompt.
            try {
              if (this.tokenFile) saveWebosClientKey(evaluation.clientKey, this.tokenFile);
              else saveWebosClientKey(evaluation.clientKey);
            } catch (persistErr) {
              logger.warn("Failed to persist webOS ssap client-key", {
                error: persistErr,
              });
            }
          }
          finish(socket);
        } else if (evaluation.kind === "error") {
          finish(new Error(`webOS ssap registration failed: ${evaluation.message}`));
        }
        // prompt/ignore: keep waiting for the real register reply.
      });
    });
  }

  /**
   * Request + open the dedicated pointer-input socket once. webOS returns a
   * nested ssap `socketPath`; the pointer frames (move/click/scroll/button) go
   * to THAT socket, not the main one.
   */
  private ensurePointerSocket(): Promise<SsapSocket> {
    if (this.pointerSocket) return Promise.resolve(this.pointerSocket);
    return this.ensureConnected().then(
      (main) =>
        new Promise<SsapSocket>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
              new Error(
                `Timed out requesting the webOS pointer-input socket on ${this.host}.`
              )
            );
          }, this.connectTimeoutMs);

          const onMessage = (data: unknown) => {
            const path = parsePointerSocketPath(safeParse(data));
            if (!path || settled) return;
            settled = true;
            clearTimeout(timer);
            const pointer = this.socketFactory(path);
            pointer.on("error", () => {
              if (this.pointerSocket === pointer) this.pointerSocket = undefined;
            });
            pointer.on("close", () => {
              if (this.pointerSocket === pointer) this.pointerSocket = undefined;
            });
            this.pointerSocket = pointer;
            resolve(pointer);
          };

          main.on("message", onMessage);
          try {
            main.send(buildPointerSocketRequest());
          } catch (err) {
            settled = true;
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })
    );
  }
}

/** Parse ssap frame data (string or Buffer) as JSON; undefined on failure. */
function safeParse(data: unknown): unknown {
  try {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : String(data);
    return JSON.parse(text);
  } catch {
    logger.debug("Non-JSON ssap frame ignored");
    return undefined;
  }
}
