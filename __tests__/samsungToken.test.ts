import fs from "fs";
import os from "os";
import path from "path";
import {
  hostFromSdbTarget,
  loadToken,
  saveToken,
  tokenPath,
} from "../src/input/samsungToken.js";

describe("hostFromSdbTarget", () => {
  it("strips the sdb :26101 port, keeping the IP", () => {
    expect(hostFromSdbTarget("192.0.2.7:26101")).toBe("192.0.2.7");
  });

  it("strips any port, keeping the host (sdb port != TV :8002 host)", () => {
    expect(hostFromSdbTarget("10.0.0.5:26101")).toBe("10.0.0.5");
  });

  it("passes a bare host through unchanged", () => {
    expect(hostFromSdbTarget("192.168.1.9")).toBe("192.168.1.9");
  });
});

describe("tokenPath", () => {
  it("roots at $HOME/.config/flutter-device-mcp/token.txt (per-developer, not a fixed user)", () => {
    expect(tokenPath()).toBe(
      path.join(os.homedir(), ".config", "flutter-device-mcp", "token.txt")
    );
  });
});

describe("loadToken / saveToken", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-tv-remote-test-"));
    file = path.join(dir, "nested", "token.txt");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the token file is absent", () => {
    expect(loadToken(file)).toBeUndefined();
  });

  it("persists a token, creating the directory (mkdir -p)", () => {
    saveToken("12345678", file);
    expect(fs.existsSync(file)).toBe(true);
    expect(loadToken(file)).toBe("12345678");
  });

  it("trims a trailing newline on load", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "abcd1234\n", "utf8");
    expect(loadToken(file)).toBe("abcd1234");
  });

  it("treats an empty/whitespace file as no token", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "   \n", "utf8");
    expect(loadToken(file)).toBeUndefined();
  });

  it("round-trips a saved token", () => {
    saveToken("roundtrip-token", file);
    expect(loadToken(file)).toBe("roundtrip-token");
  });

  it("writes the token file owner-only (0600)", () => {
    saveToken("secret-token", file);
    // Mask to the permission bits; the token is a device credential and must
    // not be group/world-readable.
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-secures perms when overwriting an existing token file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old", { encoding: "utf8", mode: 0o644 });
    saveToken("new-token", file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
