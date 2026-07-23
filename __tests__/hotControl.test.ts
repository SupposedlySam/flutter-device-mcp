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
