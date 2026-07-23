import { quote, resolveFlutterCommand, tail } from "../src/cli.js";

describe("quote", () => {
  it("wraps a plain argument in single quotes", () => {
    expect(quote("tv")).toBe("'tv'");
  });

  it("escapes embedded single quotes", () => {
    expect(quote("it's")).toBe("'it'\\''s'");
  });
});

describe("resolveFlutterCommand", () => {
  it("prefers fvm flutter when the dir is fvm-managed and fvm is available", () => {
    expect(
      resolveFlutterCommand({ fvmManaged: true, fvmAvailable: true })
    ).toBe("fvm flutter");
  });

  it("falls back to bare flutter when fvm is unavailable", () => {
    expect(
      resolveFlutterCommand({ fvmManaged: true, fvmAvailable: false })
    ).toBe("flutter");
  });

  it("uses bare flutter when the dir is not fvm-managed", () => {
    expect(
      resolveFlutterCommand({ fvmManaged: false, fvmAvailable: true })
    ).toBe("flutter");
  });
});

describe("tail", () => {
  it("returns the whole string when under the line cap", () => {
    expect(tail("a\nb\nc", 10)).toBe("a\nb\nc");
  });

  it("returns only the last N lines when over the cap", () => {
    expect(tail("a\nb\nc\nd", 2)).toBe("c\nd");
  });
});
