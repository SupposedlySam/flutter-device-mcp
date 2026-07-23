import fs from "fs";
import os from "os";
import path from "path";
import {
  loadWebosClientKey,
  saveWebosClientKey,
  webosTokenPath,
} from "../src/input/webosToken.js";

describe("webosTokenPath", () => {
  it("roots at $HOME/.config/flutter-device-mcp/webos-client-key.txt (per-developer)", () => {
    expect(webosTokenPath()).toBe(
      path.join(os.homedir(), ".config", "flutter-device-mcp", "webos-client-key.txt")
    );
  });

  it("shares the flutter-device-mcp dir with the Samsung token", () => {
    // Same credentials dir, distinct filename — no collision with token.txt.
    expect(path.dirname(webosTokenPath())).toBe(
      path.join(os.homedir(), ".config", "flutter-device-mcp")
    );
    expect(path.basename(webosTokenPath())).toBe("webos-client-key.txt");
  });
});

describe("loadWebosClientKey / saveWebosClientKey", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-webos-key-test-"));
    file = path.join(dir, "nested", "webos-client-key.txt");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the key file is absent", () => {
    expect(loadWebosClientKey(file)).toBeUndefined();
  });

  it("persists a key, creating the directory (mkdir -p)", () => {
    saveWebosClientKey("abc-123-key", file);
    expect(fs.existsSync(file)).toBe(true);
    expect(loadWebosClientKey(file)).toBe("abc-123-key");
  });

  it("trims a trailing newline on load", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "key-with-newline\n", "utf8");
    expect(loadWebosClientKey(file)).toBe("key-with-newline");
  });

  it("treats an empty/whitespace file as no key", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "   \n", "utf8");
    expect(loadWebosClientKey(file)).toBeUndefined();
  });

  it("round-trips a saved key", () => {
    saveWebosClientKey("roundtrip-key", file);
    expect(loadWebosClientKey(file)).toBe("roundtrip-key");
  });

  it("writes the key file owner-only (0600) — it is a LAN bearer credential", () => {
    saveWebosClientKey("secret-key", file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("re-secures perms when overwriting an existing key file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old", { encoding: "utf8", mode: 0o644 });
    saveWebosClientKey("new-key", file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
