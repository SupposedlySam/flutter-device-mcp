import { dartDefineArgs } from "../src/dartDefine.js";

describe("dartDefineArgs", () => {
  it("returns nothing for absent or empty defines, so callers can splice unconditionally", () => {
    expect(dartDefineArgs(undefined)).toEqual([]);
    expect(dartDefineArgs({})).toEqual([]);
  });

  it("renders each pair as a --dart-define token", () => {
    expect(dartDefineArgs({ USE_LOCAL_ENV: "true" })).toEqual([
      "--dart-define=USE_LOCAL_ENV=true",
    ]);
  });

  it("orders keys stably so the same defines always build the same command", () => {
    // A build command that varies run to run cannot be compared or cached.
    const a = dartDefineArgs({ B: "2", A: "1", C: "3" });
    const b = dartDefineArgs({ C: "3", A: "1", B: "2" });
    expect(a).toEqual([
      "--dart-define=A=1",
      "--dart-define=B=2",
      "--dart-define=C=3",
    ]);
    expect(a).toEqual(b);
  });

  it("allows '=' and spaces inside a VALUE (only keys are constrained)", () => {
    expect(dartDefineArgs({ URL: "https://x/?a=b&c=d" })).toEqual([
      "--dart-define=URL=https://x/?a=b&c=d",
    ]);
    expect(dartDefineArgs({ NAME: "two words" })).toEqual([
      "--dart-define=NAME=two words",
    ]);
  });

  it("accepts an empty value (a define that is present but blank)", () => {
    expect(dartDefineArgs({ FLAG: "" })).toEqual(["--dart-define=FLAG="]);
  });

  it("rejects a key containing '=' — it would become a different define", () => {
    expect(() => dartDefineArgs({ "A=B": "1" })).toThrow(/cannot contain/);
  });

  it("rejects a key containing whitespace — it would split into two arguments", () => {
    expect(() => dartDefineArgs({ "A B": "1" })).toThrow(/cannot contain/);
  });

  it("rejects a key starting with '-' — the tool would read it as a flag", () => {
    expect(() => dartDefineArgs({ "--oops": "1" })).toThrow(/leading '-'/);
  });

  it("rejects an empty key", () => {
    expect(() => dartDefineArgs({ "": "1" })).toThrow(/cannot be empty/);
  });

  it("produces only --dart-define tokens, never a bare flag", () => {
    // The typed map exists so this cannot become an arbitrary-argument channel.
    const tokens = dartDefineArgs({ A: "1", B: "--not-a-flag" });
    expect(tokens.every((t) => t.startsWith("--dart-define="))).toBe(true);
  });
});
