/**
 * Minimal Dart VM Service client for driving hot reload over the
 * `ws://.../ws` URI that {@link launchAndCaptureUri} captured (the same URI
 * Marionette connects to).
 *
 * WHY the VM service and not the launch daemon's stdin: flutter's interactive
 * `run` reads `r`/`R` from stdin, but the launch is spawned detached
 * with `stdin: "ignore"` and unref'd so it outlives the MCP process (it must, to
 * hold the VM service open across tool calls and MCP restarts). That child is
 * therefore unreachable for stdin writes — and even a retained handle would not
 * survive an MCP restart. The durable, restart-surviving artifact is the VM
 * service URI itself, so hot reload is driven over it here, exactly as
 * Marionette's own hot_reload does.
 *
 * The wire framing is pure and exported for unit tests; the socket lifecycle is
 * a thin request/response layer. The WebSocket implementation is injected so
 * tests supply a fake and NEVER open a real connection.
 */
import type { WebSocket as WsSocket } from "ws";
import WebSocketImpl from "ws";

/** Default time to wait for the VM service to answer a request. */
export const VM_SERVICE_TIMEOUT_MS = 20000;

/**
 * Redact the auth-token path segment from a VM service URI for use in error
 * text and logs. The URI shape is `ws://127.0.0.1:PORT/TOKEN/ws`, where TOKEN
 * grants full VM-service access — never surface it in a thrown/logged string.
 * The real URI is still used for the actual connection; only display text is
 * redacted. A URI that doesn't match the expected shape is returned unchanged.
 */
export function redactVmServiceUri(uri: string): string {
  return uri.replace(
    /^(wss?:\/\/[^/]+\/)[^/]+(\/ws\/?)$/,
    "$1<redacted>$2"
  );
}

// =========== PURE: JSON-RPC FRAMING ==========

/** A JSON-RPC 2.0 request for a VM service method. */
export interface VmRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Build a JSON-RPC request envelope for a VM service method. */
export function buildRpcRequest(
  id: number,
  method: string,
  params?: Record<string, unknown>
): VmRpcRequest {
  const req: VmRpcRequest = { jsonrpc: "2.0", id, method };
  if (params) req.params = params;
  return req;
}

/** A matched JSON-RPC reply: the result payload or an error. */
export type RpcReply =
  | { kind: "result"; id: number; result: unknown }
  | { kind: "error"; id: number; code: number; message: string }
  | { kind: "other" };

/**
 * Interpret a parsed message as a reply to one of our requests. Notifications
 * (streamed VM events, which have no `id`) are `other` and ignored by the
 * request/response layer.
 */
export function evaluateRpcMessage(parsed: unknown): RpcReply {
  if (!parsed || typeof parsed !== "object") return { kind: "other" };
  const msg = parsed as {
    id?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (typeof msg.id !== "number") return { kind: "other" };
  if (msg.error && typeof msg.error === "object") {
    return {
      kind: "error",
      id: msg.id,
      code: typeof msg.error.code === "number" ? msg.error.code : -1,
      message:
        typeof msg.error.message === "string"
          ? msg.error.message
          : "unknown VM service error",
    };
  }
  return { kind: "result", id: msg.id, result: msg.result };
}

/** Extract the isolate ids from a `getVM` result. */
export function isolateIdsFromVm(vm: unknown): string[] {
  if (!vm || typeof vm !== "object") return [];
  const isolates = (vm as { isolates?: unknown }).isolates;
  if (!Array.isArray(isolates)) return [];
  return isolates
    .map((i) => (i && typeof i === "object" ? (i as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

/** True when a `reloadSources` result reports the reload succeeded. */
export function reloadSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const success = (result as { success?: unknown }).success;
  // reloadSources returns { type: "ReloadReport", success: bool }.
  return success === true;
}

/**
 * Extract the registered service-extension RPC names from a `getIsolate`
 * result. The VM service reports them under `extensionRPCs: string[]`; a
 * malformed/absent field degrades to `[]` (treated as "no extensions"), never a
 * throw — the probe reads this defensively.
 */
export function extensionRpcsFromIsolate(isolate: unknown): string[] {
  if (!isolate || typeof isolate !== "object") return [];
  const rpcs = (isolate as { extensionRPCs?: unknown }).extensionRPCs;
  if (!Array.isArray(rpcs)) return [];
  return rpcs.filter((r): r is string => typeof r === "string");
}

/**
 * True when any `ext.flutter.marionette.*` service extension appears in a list
 * of registered extension RPCs. The app registers the Marionette extension only
 * in debug (or with the enabling define); a profile/release build brings up the
 * VM service WITHOUT it, so its absence is the signal the deploy probe reports.
 */
export function hasMarionetteExtension(extensionRpcs: string[]): boolean {
  return extensionRpcs.some((rpc) => rpc.startsWith("ext.flutter.marionette."));
}

// =========== SOCKET LIFECYCLE ==========

/** Minimal socket surface the client needs — satisfied by `ws` and by fakes. */
export interface VmSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/** Opens a {@link VmSocket} for a URL. Injected so tests never dial out. */
export type VmSocketFactory = (url: string) => VmSocket;

/** Default factory: a real `ws` WebSocket to the local VM service. */
export const defaultVmSocketFactory: VmSocketFactory = (url: string) =>
  new WebSocketImpl(url) as unknown as VmSocket;

export interface VmServiceClientOptions {
  /** The `ws://127.0.0.1:PORT/TOKEN/ws` URI captured at launch. */
  wsUri: string;
  /** Override the socket factory (tests inject a fake). */
  socketFactory?: VmSocketFactory;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

/**
 * One short-lived VM service connection. Opened for a reload/restart operation
 * and closed after — the launch daemon (not this client) owns the long-lived
 * service, so we connect, drive it, and disconnect without disturbing it.
 */
export class VmServiceClient {
  private readonly wsUri: string;
  private readonly socketFactory: VmSocketFactory;
  private readonly timeoutMs: number;

  private socket: VmSocket | undefined;
  private connecting: Promise<VmSocket> | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(opts: VmServiceClientOptions) {
    this.wsUri = opts.wsUri;
    this.socketFactory = opts.socketFactory ?? defaultVmSocketFactory;
    this.timeoutMs = opts.timeoutMs ?? VM_SERVICE_TIMEOUT_MS;
  }

  /** Send one RPC and await its matched reply. */
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const socket = await this.ensureConnected();
    const id = this.nextId++;
    const request = buildRpcRequest(id, method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `Timed out after ${this.timeoutMs}ms awaiting VM service reply to "${method}". ` +
                "The launch daemon may have exited — redeploy with flutter_deploy."
            )
          );
        }
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        socket.send(JSON.stringify(request));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** List the running isolate ids (via `getVM`). */
  async isolateIds(): Promise<string[]> {
    return isolateIdsFromVm(await this.call("getVM"));
  }

  /**
   * The service-extension RPC names registered on an isolate (via
   * `getIsolate`). Used by the Marionette-readiness probe to check for
   * `ext.flutter.marionette.*`.
   */
  async isolateExtensionRpcs(isolateId: string): Promise<string[]> {
    return extensionRpcsFromIsolate(
      await this.call("getIsolate", { isolateId })
    );
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
    this.rejectAllPending(new Error("VM service connection closed."));
  }

  /** Reject and drop every outstanding request with the given error. */
  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  private ensureConnected(): Promise<VmSocket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<VmSocket>((resolve, reject) => {
      const socket = this.socketFactory(this.wsUri);
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
            `Timed out connecting to the Dart VM service at ${redactVmServiceUri(
              this.wsUri
            )}. No live launch daemon — run flutter_deploy first.`
          )
        );
      }, this.timeoutMs);

      socket.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.connecting = undefined;
        resolve(socket);
      });
      socket.on("message", (data) => {
        const reply = evaluateRpcMessage(safeParse(data));
        if (reply.kind === "other") return;
        const entry = this.pending.get(reply.id);
        if (!entry) return;
        this.pending.delete(reply.id);
        if (reply.kind === "error") {
          entry.reject(
            new Error(`VM service error ${reply.code}: ${reply.message}`)
          );
        } else {
          entry.resolve(reply.result);
        }
      });
      socket.on("error", (err) => {
        if (this.socket === socket) this.socket = undefined;
        const error = err instanceof Error ? err : new Error(String(err));
        if (settled) {
          // The socket errored after connecting — fail every in-flight request
          // now rather than letting each one sit until its own timeout.
          this.rejectAllPending(
            new Error(
              `VM service socket errored: ${redactVmServiceUri(error.message)}`
            )
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.connecting = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("VM service socket closed before it opened."));
          return;
        }
        // A close after connecting drops the daemon — fail every in-flight
        // request now rather than letting each one sit until its own timeout.
        this.rejectAllPending(new Error("VM service socket closed."));
      });
    }).catch((err) => {
      this.connecting = undefined;
      throw err;
    });
    return this.connecting;
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
