/**
 * Samsung remote-control WebSocket client.
 *
 * Drives the appliance's physical input over the Samsung Smart Remote channel
 * (WSS on port 8002, `samsung.remote.control`). This encodes the wire protocol
 * verified against the samsungtvws reference library and confirmed on-device:
 *
 *   - Keys ("SendRemoteKey"): Cmd "Click" with a `KEY_*` DataOfCmd.
 *
 * Only the key-event builder is retained: live device testing established that
 * the native `ProcessMouseDevice` Move and `ProcessMouseDeviceWheel` scroll
 * shapes have NO observable effect on the Tizen appliance (its UI is
 * focus/D-pad driven and the Samsung remote touchpad channel never surfaces as
 * pointer/scroll events to the Flutter app), so those unverified builders were
 * removed. Pointer "click" is the KEY_ENTER key event, which activates the
 * currently-focused element.
 *
 * The message-BUILDING function is pure and exported for unit tests; the
 * socket lifecycle (connect/pair/reconnect/send) is a thin class around them.
 * The WebSocket implementation is injected so tests supply a fake socket and
 * NEVER open a real connection.
 *
 * Token + host are sourced live (see samsungToken.ts): host from the resolved
 * sdb target, token from the per-developer file. Nothing device-specific is
 * baked in, and the token is never logged.
 */
import type { WebSocket as WsSocket } from "ws";
import WebSocketImpl from "ws";
import { logger } from "../logger.js";
import { loadToken, saveToken } from "./samsungToken.js";

/** Port for the Samsung remote-control WebSocket channel (always WSS). */
export const REMOTE_WS_PORT = 8002;
/** The client name shown to the TV; base64-encoded into the connect URL. */
export const CLIENT_NAME = "FlutterDeviceMCP";
/** Time to wait for the first connect/pair reply before giving up. */
export const CONNECT_TIMEOUT_MS = 30000;

// =========== PURE: URL + MESSAGE FRAMING ==========

/** Base64-encode the client name for the `name` query param (per the protocol). */
export function encodeName(name: string): string {
  return Buffer.from(name, "utf8").toString("base64");
}

/**
 * Build the remote-channel WSS URL. `host` is the bare device IP (no sdb port);
 * `:8002` is appended here. The `token` query param is included only when a
 * token is present — the first, unpaired connect omits it so the TV shows its
 * on-screen Allow prompt and returns a token to persist.
 */
export function buildRemoteUrl(host: string, token?: string): string {
  const name = encodeName(CLIENT_NAME);
  const base = `wss://${host}:${REMOTE_WS_PORT}/api/v2/channels/samsung.remote.control?name=${name}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/** Build a `SendRemoteKey` Click message for a full `KEY_*` name. */
export function buildKeyMessage(key: string): string {
  return JSON.stringify({
    method: "ms.remote.control",
    params: {
      Cmd: "Click",
      DataOfCmd: key,
      Option: "false",
      TypeOfRemote: "SendRemoteKey",
    },
  });
}

// =========== PURE: CONNECT-REPLY INTERPRETATION ==========

/** How the client should react to a message received during the connect phase. */
export type ConnectEvaluation =
  | { kind: "connected"; token?: string }
  | { kind: "unauthorized" }
  | { kind: "ignore" };

/**
 * Interpret a parsed message received while awaiting the connect reply.
 *
 * `ms.channel.connect` completes the handshake and may carry `data.token` (the
 * newly-issued pairing token to persist). `ms.channel.unauthorized` means the
 * user dismissed / never answered the Allow prompt. Anything else (start-up
 * chatter) is ignored so we keep waiting for the real reply.
 */
export function evaluateConnectMessage(parsed: unknown): ConnectEvaluation {
  if (!parsed || typeof parsed !== "object") return { kind: "ignore" };
  const msg = parsed as { event?: string; data?: { token?: unknown } };
  if (msg.event === "ms.channel.connect") {
    const token = typeof msg.data?.token === "string" ? msg.data.token : undefined;
    return { kind: "connected", token };
  }
  if (msg.event === "ms.channel.unauthorized") {
    return { kind: "unauthorized" };
  }
  return { kind: "ignore" };
}

// =========== SOCKET LIFECYCLE ==========

/** Minimal socket surface the client needs — satisfied by `ws` and by fakes. */
export interface RemoteSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/** Opens a {@link RemoteSocket} for a URL. Injected so tests never dial out. */
export type SocketFactory = (url: string) => RemoteSocket;

/** Default factory: a real `ws` WebSocket that accepts Samsung's self-signed cert. */
export const defaultSocketFactory: SocketFactory = (url: string) => {
  // rejectUnauthorized:false — the TV presents a self-signed cert on :8002.
  return new WebSocketImpl(url, {
    rejectUnauthorized: false,
  }) as unknown as RemoteSocket;
};

export interface SamsungWsClientOptions {
  /** Bare device host (no sdb port). :8002 is appended internally. */
  host: string;
  /** Override the socket factory (tests inject a fake). */
  socketFactory?: SocketFactory;
  /** Override the token file path (tests / non-default homes). */
  tokenFile?: string;
  /** Connect/pair timeout in ms. */
  connectTimeoutMs?: number;
}

/**
 * One persistent Samsung remote socket per host. Lazily opened on first send,
 * reused across calls, and transparently reopened after a drop. On the first
 * (unpaired) connect the TV shows an Allow prompt and returns a token, which is
 * persisted so later connects are silent.
 */
export class SamsungWsClient {
  private readonly host: string;
  private readonly socketFactory: SocketFactory;
  private readonly tokenFile?: string;
  private readonly connectTimeoutMs: number;

  private socket: RemoteSocket | undefined;
  private connecting: Promise<RemoteSocket> | undefined;

  constructor(opts: SamsungWsClientOptions) {
    this.host = opts.host;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.tokenFile = opts.tokenFile;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /**
   * Send a raw remote-channel message, opening/reusing the socket as needed.
   *
   * A cached socket can transition to CLOSING between calls (the TV dropped the
   * channel) without our close/error handlers having fired yet, so `send` can
   * throw synchronously. In that case we drop the cached socket and retry the
   * connect+send exactly once; a second failure is surfaced as a clear error.
   */
  async send(message: string): Promise<void> {
    const socket = await this.ensureConnected();
    try {
      socket.send(message);
    } catch (firstError) {
      // The socket went stale mid-send. Discard it and reconnect once.
      if (this.socket === socket) this.socket = undefined;
      this.connecting = undefined;
      let retrySocket: RemoteSocket;
      try {
        retrySocket = await this.ensureConnected();
        retrySocket.send(message);
      } catch (retryError) {
        throw new Error(
          `Failed to send to the Samsung remote channel on ${this.host}:${REMOTE_WS_PORT} ` +
            `after reconnecting: ${
              retryError instanceof Error ? retryError.message : String(retryError)
            } (initial send error: ${
              firstError instanceof Error ? firstError.message : String(firstError)
            })`
        );
      }
    }
  }

  /** Close the socket cleanly (idempotent). */
  close(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // best effort
      }
    }
    this.socket = undefined;
    this.connecting = undefined;
  }

  /** Open the socket if needed and complete the connect/pair handshake once. */
  private ensureConnected(): Promise<RemoteSocket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = this.openAndPair()
      .then((socket) => {
        this.socket = socket;
        this.connecting = undefined;
        // Reconnect on drop: clear the cached socket so the next send reopens.
        socket.on("close", () => {
          if (this.socket === socket) this.socket = undefined;
        });
        socket.on("error", () => {
          if (this.socket === socket) this.socket = undefined;
        });
        return socket;
      })
      .catch((err) => {
        this.connecting = undefined;
        throw err;
      });
    return this.connecting;
  }

  private openAndPair(): Promise<RemoteSocket> {
    const token = this.tokenFile ? loadToken(this.tokenFile) : loadToken();
    const url = buildRemoteUrl(this.host, token);
    const socket = this.socketFactory(url);

    return new Promise<RemoteSocket>((resolve, reject) => {
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
            token
              ? `Timed out connecting to the Samsung remote channel on ${this.host}:${REMOTE_WS_PORT}. The device may be offline or the paired token may be stale.`
              : `Timed out waiting for the on-screen Allow prompt on ${this.host}:${REMOTE_WS_PORT}. The device is unpaired — accept the "FlutterDeviceMCP" prompt on the TV and retry.`
          )
        );
      }, this.connectTimeoutMs);

      const finish = (result: RemoteSocket | Error) => {
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

      socket.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
      socket.on("close", () => {
        if (!settled) finish(new Error("Samsung remote socket closed before connect completed."));
      });
      socket.on("message", (data) => {
        const parsed = safeParse(data);
        const evaluation = evaluateConnectMessage(parsed);
        if (evaluation.kind === "connected") {
          if (evaluation.token) {
            try {
              if (this.tokenFile) saveToken(evaluation.token, this.tokenFile);
              else saveToken(evaluation.token);
            } catch (persistErr) {
              logger.warn("Failed to persist Samsung remote token", {
                error: persistErr,
              });
            }
          }
          finish(socket);
        } else if (evaluation.kind === "unauthorized") {
          finish(
            new Error(
              `Samsung remote pairing was refused (ms.channel.unauthorized) on ${this.host}. Accept the "FlutterDeviceMCP" prompt on the TV.`
            )
          );
        }
        // ignore: keep waiting for the real connect reply
      });
    });
  }
}

/** Parse WS message data (string or Buffer) as JSON; undefined on failure. */
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
    return undefined;
  }
}

export type { WsSocket };
