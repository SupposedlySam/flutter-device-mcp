import {
  buildRpcRequest,
  evaluateRpcMessage,
  isolateIdsFromVm,
  redactVmServiceUri,
  reloadSucceeded,
  VmServiceClient,
  VmSocket,
} from "../src/vmServiceClient.js";

// =========== PURE FRAMING ==========

describe("buildRpcRequest", () => {
  it("frames a JSON-RPC 2.0 request with params", () => {
    expect(buildRpcRequest(3, "reloadSources", { isolateId: "iso-1", force: true })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "reloadSources",
      params: { isolateId: "iso-1", force: true },
    });
  });

  it("omits params when none are given", () => {
    expect(buildRpcRequest(1, "getVM")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getVM",
    });
  });
});

describe("evaluateRpcMessage", () => {
  it("matches a result reply by id", () => {
    expect(evaluateRpcMessage({ id: 7, result: { type: "VM" } })).toEqual({
      kind: "result",
      id: 7,
      result: { type: "VM" },
    });
  });

  it("matches an error reply by id", () => {
    expect(
      evaluateRpcMessage({ id: 7, error: { code: 105, message: "boom" } })
    ).toEqual({ kind: "error", id: 7, code: 105, message: "boom" });
  });

  it("treats notifications (no id) as other", () => {
    expect(evaluateRpcMessage({ method: "streamNotify", params: {} }).kind).toBe(
      "other"
    );
    expect(evaluateRpcMessage(null).kind).toBe("other");
  });
});

describe("isolateIdsFromVm", () => {
  it("extracts isolate ids from a getVM result", () => {
    expect(
      isolateIdsFromVm({ isolates: [{ id: "iso-1" }, { id: "iso-2" }] })
    ).toEqual(["iso-1", "iso-2"]);
  });

  it("returns [] for a malformed VM object", () => {
    expect(isolateIdsFromVm({})).toEqual([]);
    expect(isolateIdsFromVm(null)).toEqual([]);
  });
});

describe("reloadSucceeded", () => {
  it("is true only for success:true ReloadReports", () => {
    expect(reloadSucceeded({ type: "ReloadReport", success: true })).toBe(true);
    expect(reloadSucceeded({ type: "ReloadReport", success: false })).toBe(false);
    expect(reloadSucceeded(undefined)).toBe(false);
  });
});

describe("redactVmServiceUri", () => {
  it("replaces the token path segment with <redacted>", () => {
    expect(redactVmServiceUri("ws://127.0.0.1:51182/s3cr3tT0ken/ws")).toBe(
      "ws://127.0.0.1:51182/<redacted>/ws"
    );
  });

  it("handles a wss URI and a trailing slash", () => {
    expect(redactVmServiceUri("wss://127.0.0.1:51182/tok/ws/")).toBe(
      "wss://127.0.0.1:51182/<redacted>/ws/"
    );
  });

  it("leaves a non-matching URI unchanged", () => {
    expect(redactVmServiceUri("ws://x/ws")).toBe("ws://x/ws");
  });
});

// =========== LIFECYCLE (fake socket — never dials out) ==========

class FakeSocket implements VmSocket {
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  // These overloads mirror VmSocket exactly, so the fake genuinely satisfies the
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
  /** Reply to the last-sent request with a result. */
  replyResult(result: unknown): void {
    const last = JSON.parse(this.sent[this.sent.length - 1]);
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: last.id, result }));
  }
  replyError(code: number, message: string): void {
    const last = JSON.parse(this.sent[this.sent.length - 1]);
    this.emit(
      "message",
      JSON.stringify({ jsonrpc: "2.0", id: last.id, error: { code, message } })
    );
  }
  /** Wait until the client has framed and sent its request. */
  async waitForSend(count = 1): Promise<void> {
    while (this.sent.length < count) await Promise.resolve();
  }
}

describe("VmServiceClient", () => {
  it("opens the socket, sends an RPC, and resolves its matched reply", async () => {
    const socket = new FakeSocket();
    let dialedUrl = "";
    const client = new VmServiceClient({
      wsUri: "ws://127.0.0.1:51182/tok/ws",
      socketFactory: (url) => {
        dialedUrl = url;
        return socket;
      },
    });

    const p = client.call("getVM");
    socket.emit("open");
    // The request is framed and sent once open.
    await socket.waitForSend();
    expect(socket.sent).toHaveLength(1);
    socket.replyResult({ isolates: [{ id: "iso-1" }] });
    await expect(p).resolves.toEqual({ isolates: [{ id: "iso-1" }] });
    expect(dialedUrl).toBe("ws://127.0.0.1:51182/tok/ws");
  });

  it("isolateIds pulls ids via getVM", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://x/ws",
      socketFactory: () => socket,
    });
    const p = client.isolateIds();
    socket.emit("open");
    await socket.waitForSend();
    socket.replyResult({ isolates: [{ id: "a" }, { id: "b" }] });
    await expect(p).resolves.toEqual(["a", "b"]);
  });

  it("rejects a call when the VM service returns an error", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://x/ws",
      socketFactory: () => socket,
    });
    const p = client.call("reloadSources", { isolateId: "iso-1" });
    socket.emit("open");
    await socket.waitForSend();
    socket.replyError(105, "reload rejected");
    await expect(p).rejects.toThrow(/105: reload rejected/);
  });

  it("times out with an actionable message when the socket never opens", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://x/ws",
      timeoutMs: 5,
      socketFactory: () => socket,
    });
    await expect(client.call("getVM")).rejects.toThrow(/flutter_deploy/);
  });

  it("redacts the auth token from the connect-timeout error", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://127.0.0.1:51182/s3cr3tT0ken/ws",
      timeoutMs: 5,
      socketFactory: () => socket,
    });
    await expect(client.call("getVM")).rejects.toThrow(
      /ws:\/\/127\.0\.0\.1:51182\/<redacted>\/ws/
    );
    // The raw token never appears in the surfaced error.
    await expect(client.call("getVM")).rejects.not.toThrow(/s3cr3tT0ken/);
  });

  it("rejects in-flight calls promptly when the socket closes post-connect", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      // A long timeout proves the rejection comes from the close, not expiry.
      wsUri: "ws://x/ws",
      timeoutMs: 100000,
      socketFactory: () => socket,
    });
    const p = client.call("getVM");
    socket.emit("open");
    await socket.waitForSend();
    // Socket drops after connecting, with no reply.
    socket.emit("close");
    await expect(p).rejects.toThrow(/closed/);
  });

  it("rejects in-flight calls promptly when the socket errors post-connect", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://x/ws",
      timeoutMs: 100000,
      socketFactory: () => socket,
    });
    const p = client.call("getVM");
    socket.emit("open");
    await socket.waitForSend();
    socket.emit("error", new Error("ECONNRESET"));
    await expect(p).rejects.toThrow(/errored: ECONNRESET/);
  });

  it("times out awaiting a reply and points at redeploy", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://x/ws",
      timeoutMs: 10,
      socketFactory: () => socket,
    });
    const p = client.call("getVM");
    socket.emit("open");
    await socket.waitForSend();
    // no reply ever arrives
    await expect(p).rejects.toThrow(/Timed out.*getVM/);
  });

  it("close() is idempotent and rejects any pending calls", async () => {
    const socket = new FakeSocket();
    const client = new VmServiceClient({
      wsUri: "ws://x/ws",
      socketFactory: () => socket,
    });
    const p = client.call("getVM");
    socket.emit("open");
    await socket.waitForSend();
    client.close();
    await expect(p).rejects.toThrow(/closed/);
    expect(socket.closed).toBe(true);
    client.close(); // no throw
  });
});
