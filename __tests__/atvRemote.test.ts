import { describe, expect, it } from "@jest/globals";
import {
  AtvRemoteInputController,
  atvremoteKeyCommand,
  buildAtvremoteCommand,
  describeAtvremoteFailure,
  resolveAtvremote,
} from "../src/atvRemote.js";
import type { CommandResult } from "../src/cli.js";
import { UnsupportedInputError } from "../src/types.js";

const failed = (combined: string): CommandResult => ({
  code: 1,
  stdout: "",
  stderr: combined,
  combined,
  success: false,
  timedOut: false,
});

const ok: CommandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  combined: "",
  success: true,
  timedOut: false,
};

describe("resolveAtvremote", () => {
  it("takes FLUTTER_DEVICE_ATVREMOTE when the file exists, and nothing else when it does not", () => {
    const env = { FLUTTER_DEVICE_ATVREMOTE: "/custom/atvremote", PATH: "/usr/bin", HOME: "/Users/dev" };
    expect(resolveAtvremote({ env, exists: (p) => p === "/custom/atvremote" })).toBe(
      "/custom/atvremote"
    );
    expect(resolveAtvremote({ env, exists: (p) => p === "/usr/bin/atvremote" })).toBeUndefined();
  });

  it("finds it on PATH first, then in pipx's ~/.local/bin", () => {
    const env = { PATH: "/usr/bin:/opt/tools", HOME: "/Users/dev" };
    expect(resolveAtvremote({ env, exists: (p) => p === "/opt/tools/atvremote" })).toBe(
      "/opt/tools/atvremote"
    );
    expect(
      resolveAtvremote({ env, exists: (p) => p === "/Users/dev/.local/bin/atvremote" })
    ).toBe("/Users/dev/.local/bin/atvremote");
  });

  it("returns undefined when it is nowhere", () => {
    expect(resolveAtvremote({ env: { PATH: "/usr/bin", HOME: "/Users/dev" }, exists: () => false })).toBeUndefined();
  });
});

describe("atvremoteKeyCommand", () => {
  it("maps D-pad, select, back, home and play/pause onto atvremote commands", () => {
    expect(atvremoteKeyCommand("UP")).toBe("up");
    expect(atvremoteKeyCommand("right")).toBe("right");
    expect(atvremoteKeyCommand("KEY_ENTER")).toBe("select");
    expect(atvremoteKeyCommand("OK")).toBe("select");
    expect(atvremoteKeyCommand("RETURN")).toBe("menu");
    expect(atvremoteKeyCommand("BACK")).toBe("menu");
    expect(atvremoteKeyCommand("HOME")).toBe("home");
    expect(atvremoteKeyCommand("PLAY")).toBe("play_pause");
  });

  it("has no command for a key the Siri Remote lacks", () => {
    expect(atvremoteKeyCommand("VOLUME_UP_TWICE")).toBeUndefined();
  });
});

describe("buildAtvremoteCommand", () => {
  it("addresses the box by pyatv id when one is set, else by name", () => {
    expect(buildAtvremoteCommand("/bin/atvremote", { id: "AA:BB", name: "Den" }, "up")).toBe(
      "'/bin/atvremote' -i 'AA:BB' up"
    );
    expect(buildAtvremoteCommand("/bin/atvremote", { name: "Living Room" }, "turn_on")).toBe(
      "'/bin/atvremote' -n 'Living Room' turn_on"
    );
  });
});

describe("describeAtvremoteFailure", () => {
  it("explains a box it could not find on the network", () => {
    expect(describeAtvremoteFailure(failed("Could not find any Apple TV on current network"))).toMatch(
      /could not find the Apple TV on the network/
    );
  });

  it("gives the pairing steps when there are no credentials", () => {
    expect(describeAtvremoteFailure(failed("pyatv.exceptions.NoCredentialsError"))).toMatch(
      /not paired.*--protocol companion pair/
    );
  });

  it("passes any other failure through", () => {
    expect(describeAtvremoteFailure(failed("boom"))).toBe("atvremote failed: boom");
  });
});

describe("AtvRemoteInputController", () => {
  function controller(opts: {
    binary?: string;
    target?: { id?: string; name?: string } | { unsupported: string };
    result?: CommandResult;
  }) {
    const sent: string[] = [];
    const input = new AtvRemoteInputController({
      binary: () => opts.binary,
      target: async () => opts.target ?? { name: "Living Room" },
      run: async (command) => {
        sent.push(command);
        return opts.result ?? ok;
      },
    });
    return { input, sent };
  }

  it("sends the mapped command to the resolved Apple TV", async () => {
    const { input, sent } = controller({ binary: "/bin/atvremote" });
    await input.key("DOWN");
    await input.key("ENTER");
    expect(sent).toEqual([
      "'/bin/atvremote' -n 'Living Room' down",
      "'/bin/atvremote' -n 'Living Room' select",
    ]);
  });

  it("refuses an unknown key without running anything", async () => {
    const { input, sent } = controller({ binary: "/bin/atvremote" });
    await expect(input.key("RED")).rejects.toThrow(/no "RED" key/);
    expect(sent).toEqual([]);
  });

  it("reports unsupported with the install steps when atvremote is missing", async () => {
    const { input, sent } = controller({});
    await expect(input.key("UP")).rejects.toThrow(/pipx install pyatv --python python3\.12/);
    expect(sent).toEqual([]);
  });

  it("reports unsupported with the target's reason", async () => {
    const { input } = controller({ binary: "/bin/atvremote", target: { unsupported: "a simulator" } });
    await expect(input.key("UP")).rejects.toThrow("a simulator");
  });

  it("turns a failed send into an unsupported error with the reason", async () => {
    const { input } = controller({ binary: "/bin/atvremote", result: failed("NoCredentialsError") });
    const error = await input.key("UP").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedInputError);
    expect((error as Error).message).toMatch(/not paired/);
  });
});
