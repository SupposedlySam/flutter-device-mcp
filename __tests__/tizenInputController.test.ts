import { jest } from "@jest/globals";
import { buildKeyMessage, SamsungWsClient } from "../src/input/samsungWs.js";
import {
  normalizeKeyName,
  TizenInputController,
} from "../src/input/tizenInputController.js";
import { UnsupportedInputError } from "../src/types.js";

describe("normalizeKeyName", () => {
  it.each([
    ["UP", "KEY_UP"],
    ["down", "KEY_DOWN"],
    ["Left", "KEY_LEFT"],
    ["right", "KEY_RIGHT"],
    ["enter", "KEY_ENTER"],
    ["ok", "KEY_ENTER"],
    ["return", "KEY_RETURN"],
    ["back", "KEY_RETURN"],
    ["home", "KEY_HOME"],
  ])("maps short name %s → %s", (input, expected) => {
    expect(normalizeKeyName(input)).toBe(expected);
  });

  it("passes through a full KEY_ name (uppercased)", () => {
    expect(normalizeKeyName("KEY_VOLUP")).toBe("KEY_VOLUP");
    expect(normalizeKeyName("key_volup")).toBe("KEY_VOLUP");
  });

  it("best-effort prefixes an unknown short name", () => {
    expect(normalizeKeyName("mute")).toBe("KEY_MUTE");
  });
});

describe("TizenInputController", () => {
  function makeController() {
    const sent: string[] = [];
    const fakeClient = {
      send: jest.fn(async (message: string) => {
        sent.push(message);
      }),
      close: jest.fn(),
    } as unknown as SamsungWsClient;
    const resolveHost = jest.fn<() => Promise<string>>(async () => "192.0.2.7");
    const controller = new TizenInputController(resolveHost, () => fakeClient);
    return { controller, sent, resolveHost };
  }

  it("defaults to dpad mode and is session-sticky via setMode", () => {
    const { controller } = makeController();
    expect(controller.mode).toBe("dpad");
    controller.setMode("pointer");
    expect(controller.mode).toBe("pointer");
  });

  it("sends a normalized key over the ws client", async () => {
    const { controller, sent, resolveHost } = makeController();
    await controller.key("UP");
    expect(resolveHost).toHaveBeenCalled();
    expect(sent).toEqual([buildKeyMessage("KEY_UP")]);
  });

  it("pointerClick sends the verified KEY_ENTER message (activates focus)", async () => {
    const { controller, sent } = makeController();
    await controller.pointerClick();
    expect(sent).toEqual([buildKeyMessage("KEY_ENTER")]);
  });

  it("pointerMove throws a clear unsupported error and sends nothing", async () => {
    const { controller, sent } = makeController();
    await expect(controller.pointerMove(1920, 1080)).rejects.toBeInstanceOf(
      UnsupportedInputError
    );
    await expect(controller.pointerMove(1920, 1080)).rejects.toThrow(
      /not supported on the Tizen appliance.*flutter_key.*webOS/s
    );
    expect(sent).toEqual([]);
  });

  it("pointerScroll throws a clear unsupported error and sends nothing", async () => {
    const { controller, sent } = makeController();
    await expect(controller.pointerScroll(-5)).rejects.toBeInstanceOf(
      UnsupportedInputError
    );
    await expect(controller.pointerScroll(-5)).rejects.toThrow(
      /focus\/D-pad|touchpad channel does not reach/
    );
    expect(sent).toEqual([]);
  });

  it("resolves the host on every send (multi-dev safe, never cached IP)", async () => {
    const { controller, resolveHost } = makeController();
    await controller.key("UP");
    await controller.key("DOWN");
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("recreates the client when the resolved host changes", async () => {
    const clients: Array<{ send: jest.Mock; close: jest.Mock }> = [];
    let host = "192.0.2.7";
    const resolveHost = jest.fn<() => Promise<string>>(async () => host);
    const controller = new TizenInputController(resolveHost, () => {
      const c = { send: jest.fn(async () => {}), close: jest.fn() };
      clients.push(c);
      return c as unknown as SamsungWsClient;
    });

    await controller.key("UP");
    host = "10.0.0.9";
    await controller.key("DOWN");

    expect(clients).toHaveLength(2);
    // The first client was closed before the second was used.
    expect(clients[0].close).toHaveBeenCalled();
  });
});
