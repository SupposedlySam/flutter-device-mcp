import { parseVmServiceUri } from "../src/vmServiceUri.js";

describe("parseVmServiceUri", () => {
  it("extracts the URI from a flutter-tizen launch line and derives ws", () => {
    const line =
      "A Dart VM Service on Tizen SM is available at: http://127.0.0.1:51182/tys47XX1iAw=/";
    expect(parseVmServiceUri(line)).toEqual({
      http: "http://127.0.0.1:51182/tys47XX1iAw=/",
      ws: "ws://127.0.0.1:51182/tys47XX1iAw=/ws",
    });
  });

  it("adds a trailing slash when the raw URI lacks one", () => {
    const line = "available at: http://127.0.0.1:34025/wG7X7TSM38k=";
    expect(parseVmServiceUri(line)).toEqual({
      http: "http://127.0.0.1:34025/wG7X7TSM38k=/",
      ws: "ws://127.0.0.1:34025/wG7X7TSM38k=/ws",
    });
  });

  it("handles a token with url-safe base64 characters (_ and -)", () => {
    const line = "http://127.0.0.1:8181/a-b_c123=/";
    expect(parseVmServiceUri(line)).toEqual({
      http: "http://127.0.0.1:8181/a-b_c123=/",
      ws: "ws://127.0.0.1:8181/a-b_c123=/ws",
    });
  });

  it("takes the LAST match when multiple URIs appear", () => {
    const text = [
      "old: http://127.0.0.1:11111/OLDTOKEN=/",
      "The Dart VM service is listening on http://127.0.0.1:22222/NEWTOKEN=/",
    ].join("\n");
    expect(parseVmServiceUri(text)).toEqual({
      http: "http://127.0.0.1:22222/NEWTOKEN=/",
      ws: "ws://127.0.0.1:22222/NEWTOKEN=/ws",
    });
  });

  it("handles an https scheme", () => {
    const line = "https://127.0.0.1:51182/tok=/";
    expect(parseVmServiceUri(line)).toEqual({
      http: "https://127.0.0.1:51182/tok=/",
      ws: "wss://127.0.0.1:51182/tok=/ws",
    });
  });

  it("returns null when no VM Service URI is present", () => {
    expect(parseVmServiceUri("Building TPK...\nInstalling...")).toBeNull();
    expect(parseVmServiceUri("")).toBeNull();
  });

  it("ignores non-loopback hosts", () => {
    expect(
      parseVmServiceUri("http://192.168.1.5:51182/tok=/")
    ).toBeNull();
  });
});
