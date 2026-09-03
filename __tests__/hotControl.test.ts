import { controlCharFor, hotControl } from "../src/hotControl.js";

describe("controlCharFor", () => {
  it("maps reload → `r` and restart → `R`", () => {
    expect(controlCharFor("reload")).toBe("r");
    expect(controlCharFor("restart")).toBe("R");
  });
});

describe("hotControl", () => {
  it("sends `r` for a reload and reports triggered when the write lands", async () => {
    const sent: string[] = [];
    const outcome = await hotControl("reload", async (c) => {
      sent.push(c);
      return true;
    });
    expect(sent).toEqual(["r"]);
    expect(outcome).toEqual({
      kind: "reload",
      via: "pty",
      triggered: true,
      char: "r",
    });
  });

  it("sends `R` for a restart", async () => {
    const outcome = await hotControl("restart", async () => true);
    expect(outcome.char).toBe("R");
    expect(outcome.kind).toBe("restart");
    expect(outcome.triggered).toBe(true);
  });

  it("reports NOT triggered when the write fails (dead daemon)", async () => {
    const outcome = await hotControl("reload", async () => false);
    expect(outcome.triggered).toBe(false);
    expect(outcome.char).toBe("r");
  });
});

describe("hotControl confirmation", () => {
  it("reports confirmed:false when the write lands but flutter never acts", async () => {
    // The failure this exists for: the FIFO accepts the byte because it has a
    // reader, and flutter's key handler is not that reader.
    const outcome = await hotControl(
      "reload",
      async () => true,
      async () => false
    );
    expect(outcome.triggered).toBe(true);
    expect(outcome.confirmed).toBe(false);
  });

  it("reports confirmed:true when flutter acknowledges", async () => {
    const outcome = await hotControl(
      "reload",
      async () => true,
      async () => true
    );
    expect(outcome.confirmed).toBe(true);
  });

  it("does not ask for confirmation when the write itself failed", async () => {
    let asked = 0;
    const outcome = await hotControl(
      "reload",
      async () => false,
      async () => {
        asked += 1;
        return true;
      }
    );
    expect(asked).toBe(0);
    expect(outcome.confirmed).toBeUndefined();
  });

  it("omits confirmed entirely when nobody looked", async () => {
    const outcome = await hotControl("reload", async () => true);
    expect("confirmed" in outcome).toBe(false);
  });
});
