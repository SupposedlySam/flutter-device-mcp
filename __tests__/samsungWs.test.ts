import fs from "fs";
import os from "os";
import path from "path";
import {
  buildKeyMessage,
  buildRemoteUrl,
  encodeName,
  evaluateConnectMessage,
  RemoteSocket,
  SamsungWsClient,
} from "../src/input/samsungWs.js";

// =========== PURE FRAMING ==========

describe("buildRemoteUrl", () => {
  it("targets :8002 samsung.remote.control with the base64 name", () => {
    const url = buildRemoteUrl("192.0.2.7");
    expect(url).toBe(
      `wss://192.0.2.7:8002/api/v2/channels/samsung.remote.control?name=${encodeName(
        "FlutterDeviceMCP"
      )}`
    );
  });

  it("appends the token query param only when a token is supplied", () => {
    const withToken = buildRemoteUrl("192.0.2.7", "TOK123");
    expect(withToken).toContain("&token=TOK123");
    const without = buildRemoteUrl("192.0.2.7");
    expect(without).not.toContain("token=");
  });

  it("base64-encodes the client name", () => {
    expect(encodeName("FlutterDeviceMCP")).toBe(
      Buffer.from("FlutterDeviceMCP", "utf8").toString("base64")
    );
  });
});

describe("buildKeyMessage", () => {
  it("frames a SendRemoteKey Click", () => {
    expect(JSON.parse(buildKeyMessage("KEY_UP"))).toEqual({
      method: "ms.remote.control",
      params: {
        Cmd: "Click",
        DataOfCmd: "KEY_UP",
        Option: "false",
        TypeOfRemote: "SendRemoteKey",
      },
    });
  });
});

describe("evaluateConnectMessage", () => {
  it("recognizes a connect reply and extracts the token", () => {
    expect(
      evaluateConnectMessage({ event: "ms.channel.connect", data: { token: "T1" } })
    ).toEqual({ kind: "connected", token: "T1" });
  });

  it("recognizes a connect reply with no token", () => {
    expect(evaluateConnectMessage({ event: "ms.channel.connect", data: {} })).toEqual(
      { kind: "connected", token: undefined }
    );
  });

  it("recognizes an unauthorized reply", () => {
    expect(
      evaluateConnectMessage({ event: "ms.channel.unauthorized" })
    ).toEqual({ kind: "unauthorized" });
  });

  it("ignores startup chatter and malformed input", () => {
    expect(evaluateConnectMessage({ event: "ms.channel.clientConnect" }).kind).toBe(
      "ignore"
    );
    expect(evaluateConnectMessage(null).kind).toBe("ignore");
    expect(evaluateConnectMessage("nope").kind).toBe("ignore");
  });
});

// =========== CLIENT LIFECYCLE (fake socket — never dials out) ==========

/**
 * A scriptable in-memory socket. Records everything sent and lets tests drive
 * open/message/close/error events. NO real network is ever touched.
 */
class FakeSocket implements RemoteSocket {
  sent: string[] = [];
  closed = false;
  /** When set, the next send() throws (simulates a CLOSING socket) and clears. */
  throwOnNextSend = false;
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};

  send(data: string): void {
    if (this.throwOnNextSend) {
      this.throwOnNextSend = false;
      throw new Error("WebSocket is not open: readyState 2 (CLOSING)");
    }
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  // These overloads mirror RemoteSocket exactly, so the fake genuinely satisfies the
  // interface it claims rather than only looking like it. Declaring ONLY the
  // permissive signature below was the previous state, and it hid a real
  // mismatch: it transpiles and runs green under `npm test` (ts-jest reports no
  // type diagnostics at all) while not being assignable to the overloaded
  // interface — one of the errors `npm run typecheck:tests` exists to surface.
  //
  // The IMPLEMENTATION signature stays permissive on purpose. The four listener
  // shapes are heterogeneous (`(data: unknown)` vs `(err: Error)`), so no single
  // strict signature covers them all, and one fan-out map beats a mapped type in
  // a fake. Callers only ever see the four exact overloads above.
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: string, cb: (arg?: any) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  /** Simulate the TV completing the handshake, optionally issuing a token. */
  completeConnect(token?: string): void {
    this.emit(
      "message",
      JSON.stringify({ event: "ms.channel.connect", data: token ? { token } : {} })
    );
  }
}

function tempTokenFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-tv-ws-test-"));
  return path.join(dir, "token.txt");
}

describe("SamsungWsClient", () => {
  it("opens lazily, completes the handshake, then sends the key message", async () => {
    const socket = new FakeSocket();
    const tokenFile = tempTokenFile();
    fs.writeFileSync(tokenFile, "EXISTING", "utf8");
    let dialedUrl = "";
    const client = new SamsungWsClient({
      host: "192.0.2.7",
      tokenFile,
      socketFactory: (url) => {
        dialedUrl = url;
        return socket;
      },
    });

    const sendPromise = client.send(buildKeyMessage("KEY_LEFT"));
    // Nothing sent until the handshake completes.
    expect(socket.sent).toEqual([]);
    socket.emit("open");
    socket.completeConnect();
    await sendPromise;

    expect(dialedUrl).toContain("token=EXISTING");
    expect(socket.sent).toEqual([buildKeyMessage("KEY_LEFT")]);
  });

  it("reuses one socket across multiple sends", async () => {
    const socket = new FakeSocket();
    let factoryCalls = 0;
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile: tempTokenFile(),
      socketFactory: () => {
        factoryCalls += 1;
        return socket;
      },
    });

    const p1 = client.send(buildKeyMessage("KEY_UP"));
    socket.completeConnect();
    await p1;
    await client.send(buildKeyMessage("KEY_ENTER"));

    expect(factoryCalls).toBe(1);
    expect(socket.sent).toEqual([
      buildKeyMessage("KEY_UP"),
      buildKeyMessage("KEY_ENTER"),
    ]);
  });

  it("persists a token issued on first (unpaired) connect", async () => {
    const socket = new FakeSocket();
    const tokenFile = tempTokenFile();
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile,
      socketFactory: (url) => {
        // First connect is unpaired: no token on the URL.
        expect(url).not.toContain("token=");
        return socket;
      },
    });

    const p = client.send(buildKeyMessage("KEY_ENTER"));
    socket.completeConnect("NEWTOKEN");
    await p;

    expect(fs.readFileSync(tokenFile, "utf8")).toBe("NEWTOKEN");
  });

  it("rejects when the pairing prompt is refused (unauthorized)", async () => {
    const socket = new FakeSocket();
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile: tempTokenFile(),
      socketFactory: () => socket,
    });

    const p = client.send(buildKeyMessage("KEY_ENTER"));
    socket.emit(
      "message",
      JSON.stringify({ event: "ms.channel.unauthorized" })
    );
    await expect(p).rejects.toThrow(/refused|unauthorized/i);
  });

  it("times out with an unpaired message when no reply arrives", async () => {
    const socket = new FakeSocket();
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile: tempTokenFile(),
      connectTimeoutMs: 5,
      socketFactory: () => socket,
    });
    await expect(client.send(buildKeyMessage("KEY_ENTER"))).rejects.toThrow(
      /Allow prompt|unpaired/i
    );
  });

  it("reopens the socket after a drop", async () => {
    const sockets: FakeSocket[] = [];
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile: tempTokenFile(),
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });

    const p1 = client.send(buildKeyMessage("KEY_UP"));
    sockets[0].completeConnect();
    await p1;
    // Drop the socket.
    sockets[0].emit("close");

    const p2 = client.send(buildKeyMessage("KEY_DOWN"));
    sockets[1].completeConnect();
    await p2;

    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toEqual([buildKeyMessage("KEY_DOWN")]);
  });

  it("reconnects and resends once when send throws on a stale socket", async () => {
    const sockets: FakeSocket[] = [];
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile: tempTokenFile(),
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });

    const p1 = client.send(buildKeyMessage("KEY_UP"));
    sockets[0].completeConnect();
    await p1;

    // The cached socket goes CLOSING without our close/error handlers firing;
    // the next send throws synchronously. The reconnect opens a fresh socket;
    // complete its handshake once it exists (the factory creates it on retry).
    sockets[0].throwOnNextSend = true;
    const p2 = client.send(buildKeyMessage("KEY_DOWN"));
    while (sockets.length < 2) await Promise.resolve();
    sockets[1].completeConnect();
    await p2;

    expect(sockets).toHaveLength(2);
    // The failed message landed on the fresh socket, not the stale one.
    expect(sockets[0].sent).toEqual([buildKeyMessage("KEY_UP")]);
    expect(sockets[1].sent).toEqual([buildKeyMessage("KEY_DOWN")]);
  });

  it("throws a clear error when the retry send also fails", async () => {
    const sockets: FakeSocket[] = [];
    const client = new SamsungWsClient({
      host: "10.0.0.9",
      tokenFile: tempTokenFile(),
      connectTimeoutMs: 5,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });

    const p1 = client.send(buildKeyMessage("KEY_UP"));
    sockets[0].completeConnect();
    await p1;

    // First send throws; the reconnect never completes its handshake (times out).
    sockets[0].throwOnNextSend = true;
    await expect(client.send(buildKeyMessage("KEY_DOWN"))).rejects.toThrow(
      /after reconnecting/i
    );
  });
});
