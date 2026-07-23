import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { loadWebosClientKey } from "../src/input/webosToken.js";
import {
  buildButtonFrame,
  buildClickFrame,
  buildMoveFrame,
  buildScrollFrame,
  buildSsapUrl,
  evaluateRegisterMessage,
  normalizeWebosButton,
  parsePointerSocketPath,
  WebosSsapClient,
} from "../src/input/webosSsap.js";
import { WebosInputController } from "../src/input/webosInputController.js";

const POINTER_URL = "wss://127.0.0.1:3001/pointer";

describe("normalizeWebosButton", () => {
  it.each([
    ["UP", "UP"],
    ["down", "DOWN"],
    ["enter", "ENTER"],
    ["ok", "ENTER"],
    ["return", "BACK"],
    ["back", "BACK"],
    ["home", "HOME"],
  ])("maps short name %s → %s", (input, expected) => {
    expect(normalizeWebosButton(input)).toBe(expected);
  });

  it("strips a Samsung-style KEY_ prefix for cross-platform callers", () => {
    expect(normalizeWebosButton("KEY_UP")).toBe("UP");
    expect(normalizeWebosButton("key_enter")).toBe("ENTER");
  });

  it("passes an unknown token through uppercased", () => {
    expect(normalizeWebosButton("mute")).toBe("MUTE");
  });
});

describe("ssap pure frame builders", () => {
  it("button/move/click/scroll frames are newline-terminated blocks", () => {
    expect(buildButtonFrame("UP")).toBe("type:button\nname:UP\n\n");
    expect(buildMoveFrame(10, -5)).toBe("type:move\ndx:10\ndy:-5\ndown:0\n\n");
    expect(buildClickFrame()).toBe("type:click\n\n");
    expect(buildScrollFrame(0, 3)).toBe("type:scroll\ndx:0\ndy:3\n\n");
  });

  it("buildSsapUrl appends the :3001 wss port to a bare host", () => {
    expect(buildSsapUrl("h")).toBe("wss://h:3001");
  });
});

describe("evaluateRegisterMessage / parsePointerSocketPath", () => {
  it("completes the handshake and captures the client-key", () => {
    expect(
      evaluateRegisterMessage({ type: "registered", payload: { "client-key": "abc" } })
    ).toEqual({ kind: "registered", clientKey: "abc" });
  });

  it("recognizes the on-screen PROMPT as non-terminal", () => {
    expect(
      evaluateRegisterMessage({ type: "response", payload: { pairingType: "PROMPT" } })
    ).toEqual({ kind: "prompt" });
  });

  it("treats an error frame as terminal", () => {
    expect(evaluateRegisterMessage({ type: "error", error: "denied" })).toEqual({
      kind: "error",
      message: "denied",
    });
  });

  it("ignores unrelated chatter", () => {
    expect(evaluateRegisterMessage({ type: "hello" })).toEqual({ kind: "ignore" });
    expect(evaluateRegisterMessage(null)).toEqual({ kind: "ignore" });
  });

  it("extracts the pointer socketPath from a response", () => {
    expect(
      parsePointerSocketPath({ payload: { socketPath: "ssap://x/pointer" } })
    ).toBe("ssap://x/pointer");
    expect(parsePointerSocketPath({ payload: {} })).toBeUndefined();
  });
});

/** One frame sent by the client, tagged with the URL of the socket it went to. */
interface SentFrame {
  url: string;
  frame: string;
}

/**
 * A fake ssap socket factory that returns a DISTINCT socket per URL and records
 * every send tagged with that socket's URL. This is what lets the tests verify
 * ROUTING: the main channel (`wss://host:3001`) handles register + the
 * pointer-socket request, and the dedicated pointer socket
 * ({@link POINTER_URL}) handles every input frame (button/move/click/scroll). A
 * shared-socket fake would let a mis-route silently pass.
 */
function makeFakeSocketFactory(sent: SentFrame[]) {
  return (url: string) => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const emit = (event: string, arg?: unknown) =>
      (listeners[event] ?? []).forEach((cb) => cb(arg));

    const socket = {
      url,
      send: jest.fn((data: string) => {
        sent.push({ url, frame: data });
        const parsed = safeJson(data);
        if (parsed?.type === "register") {
          setImmediate(() =>
            emit(
              "message",
              JSON.stringify({ type: "registered", payload: { "client-key": "ck-1" } })
            )
          );
        } else if (parsed?.uri?.includes("getPointerInputSocket")) {
          setImmediate(() =>
            emit("message", JSON.stringify({ payload: { socketPath: POINTER_URL } }))
          );
        }
      }),
      close: jest.fn(),
      on: (event: string, cb: (arg?: unknown) => void) => {
        (listeners[event] ??= []).push(cb);
        if (event === "open") setImmediate(() => cb());
      },
    };
    return socket as never;
  };
}

/** Frames that landed on the dedicated pointer socket. */
const onPointer = (sent: SentFrame[]) =>
  sent.filter((s) => s.url === POINTER_URL).map((s) => s.frame);
/** Frames that landed on the main ssap channel. */
const onMain = (sent: SentFrame[]) =>
  sent.filter((s) => s.url !== POINTER_URL).map((s) => s.frame);

function safeJson(s: string): { type?: string; uri?: string } | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

describe("WebosInputController (real dual-mode over ssap)", () => {
  function makeController() {
    const sent: SentFrame[] = [];
    const resolveHost = jest.fn<() => Promise<string>>(async () => "192.168.1.50");
    const controller = new WebosInputController(
      resolveHost,
      (host) =>
        new WebosSsapClient({
          host,
          socketFactory: makeFakeSocketFactory(sent),
          connectTimeoutMs: 2000,
          // Isolate from any real ~/.config client-key file.
          tokenFile: "/nonexistent/webos-client-key.txt",
        })
    );
    return { controller, sent, resolveHost };
  }

  it("defaults to dpad mode and is session-sticky", () => {
    const { controller } = makeController();
    expect(controller.mode).toBe("dpad");
    controller.setMode("pointer");
    expect(controller.mode).toBe("pointer");
  });

  it("sends a normalized button frame over the POINTER socket, not the main channel", async () => {
    const { controller, sent, resolveHost } = makeController();
    await controller.key("up");
    expect(resolveHost).toHaveBeenCalled();
    // Routing: the button lands on the pointer socket, NOT the main channel.
    expect(onPointer(sent)).toContain(buildButtonFrame("UP"));
    expect(onMain(sent)).not.toContain(buildButtonFrame("UP"));
    // Literal-frame assertion (not builder-vs-builder): pin the exact wire bytes.
    expect(onPointer(sent)).toContain("type:button\nname:UP\n\n");
  });

  it("routes the getPointerInputSocket REQUEST over the MAIN channel", async () => {
    const { controller, sent } = makeController();
    await controller.key("up");
    // The register frame and the pointer-socket request go over the main socket;
    // no input frame does.
    const main = onMain(sent).map((f) => safeJson(f));
    expect(main.some((m) => m?.type === "register")).toBe(true);
    expect(main.some((m) => m?.uri?.includes("getPointerInputSocket"))).toBe(true);
    // And the request never went to the pointer socket.
    expect(
      onPointer(sent).some((f) => f.includes("getPointerInputSocket"))
    ).toBe(false);
  });

  it("SUPPORTS pointer move (unlike Tizen) over the pointer socket", async () => {
    const { controller, sent } = makeController();
    // First move from the origin seed (0,0): delta equals the absolute target.
    await expect(controller.pointerMove(12, 8)).resolves.toBeUndefined();
    expect(onPointer(sent)).toContain(buildMoveFrame(12, 8));
    expect(onMain(sent)).not.toContain(buildMoveFrame(12, 8));
  });

  it("converts consecutive ABSOLUTE moves into correct RELATIVE deltas", async () => {
    const { controller, sent } = makeController();
    await controller.pointerMove(100, 50); // from (0,0) → delta (100,50)
    await controller.pointerMove(120, 40); // from (100,50) → delta (20,-10)
    await controller.pointerMove(120, 40); // no movement → delta (0,0)
    const moves = onPointer(sent).filter((f) => f.startsWith("type:move"));
    expect(moves).toEqual([
      buildMoveFrame(100, 50),
      buildMoveFrame(20, -10),
      buildMoveFrame(0, 0),
    ]);
  });

  it("SUPPORTS pointer scroll and click over the pointer socket", async () => {
    const { controller, sent } = makeController();
    await controller.pointerScroll(4);
    await controller.pointerClick();
    expect(onPointer(sent)).toContain(buildScrollFrame(0, 4));
    expect(onPointer(sent)).toContain(buildClickFrame());
    expect(onMain(sent)).not.toContain(buildClickFrame());
  });

  it("resolves the host on every send (multi-dev safe)", async () => {
    const { controller, resolveHost } = makeController();
    await controller.key("UP");
    await controller.key("DOWN");
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });
});

/**
 * A manually-driven fake socket: it opens (so the client sends the register
 * frame) but NEVER auto-replies, so the test controls whether registration
 * errors, closes, or times out. Exposes `emit` to fire lifecycle events.
 */
function makeManualSocket() {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const socket = {
    send: jest.fn(),
    close: jest.fn(),
    on: (event: string, cb: (arg?: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
      if (event === "open") setImmediate(() => cb());
    },
  };
  const emit = (event: string, arg?: unknown) =>
    (listeners[event] ?? []).forEach((cb) => cb(arg));
  return { socket, emit };
}

describe("WebosSsapClient client-key persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-webos-ssap-test-"));
    file = path.join(dir, "webos-client-key.txt");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("persists the client-key returned in the registered reply", async () => {
    const sent: SentFrame[] = [];
    const client = new WebosSsapClient({
      host: "10.0.0.9",
      socketFactory: makeFakeSocketFactory(sent),
      connectTimeoutMs: 2000,
      tokenFile: file,
    });
    await client.click(); // drives connect → register → registered({client-key:"ck-1"})
    expect(loadWebosClientKey(file)).toBe("ck-1");
  });

  it("presents a previously-saved client-key on register (skips the prompt)", async () => {
    fs.writeFileSync(file, "saved-ck");
    const sent: SentFrame[] = [];
    const client = new WebosSsapClient({
      host: "10.0.0.9",
      socketFactory: makeFakeSocketFactory(sent),
      connectTimeoutMs: 2000,
      tokenFile: file,
    });
    await client.click();
    const register = onMain(sent)
      .map((f) => safeJson(f) as { type?: string; payload?: { "client-key"?: string } } | undefined)
      .find((m) => m?.type === "register");
    expect(register?.payload?.["client-key"]).toBe("saved-ck");
  });
});

describe("WebosSsapClient fail-fast / timeout (no hang)", () => {
  it("rejects when the socket emits an error during registration", async () => {
    const { socket, emit } = makeManualSocket();
    const client = new WebosSsapClient({
      host: "10.0.0.1",
      socketFactory: () => socket as never,
      connectTimeoutMs: 5000,
      tokenFile: "/nonexistent/webos-client-key.txt",
    });
    // Let the socket "open" (which triggers the register send), then error.
    setImmediate(() => emit("error", new Error("ECONNREFUSED")));
    await expect(client.click()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("rejects when the socket closes before registration completes", async () => {
    const { socket, emit } = makeManualSocket();
    const client = new WebosSsapClient({
      host: "10.0.0.1",
      socketFactory: () => socket as never,
      connectTimeoutMs: 5000,
      tokenFile: "/nonexistent/webos-client-key.txt",
    });
    setImmediate(() => emit("close"));
    await expect(client.click()).rejects.toThrow(/closed before registration/i);
  });

  it("rejects (does not hang) when registration times out", async () => {
    jest.useFakeTimers();
    try {
      const { socket } = makeManualSocket(); // opens but never replies
      const client = new WebosSsapClient({
        host: "10.0.0.1",
        socketFactory: () => socket as never,
        connectTimeoutMs: 50,
        clientKey: "ck-existing", // paired path → "connecting" timeout message
      });
      const pending = client.click();
      const assertion = expect(pending).rejects.toThrow(/Timed out connecting/i);
      // Flush the open callback, then trip the connect timer.
      await Promise.resolve();
      jest.advanceTimersByTime(60);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("times out with the pairing-prompt message when unpaired", async () => {
    jest.useFakeTimers();
    try {
      const { socket } = makeManualSocket();
      const client = new WebosSsapClient({
        host: "10.0.0.1",
        socketFactory: () => socket as never,
        connectTimeoutMs: 50,
        tokenFile: "/nonexistent/webos-client-key.txt", // no key → prompt wording
      });
      const pending = client.click();
      const assertion = expect(pending).rejects.toThrow(/Allow prompt/i);
      await Promise.resolve();
      jest.advanceTimersByTime(60);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
