import {
  parseAnnouncedVmServiceUri,
  parseVmServiceUri,
} from "../src/vmServiceUri.js";

describe("parseAnnouncedVmServiceUri", () => {
  it("takes the DDS loopback URI flutter announces", () => {
    const line =
      "A Dart VM Service on Living Room is available at: http://127.0.0.1:53182/Vr2ii1ySMoE=/";
    expect(parseAnnouncedVmServiceUri(line)).toEqual({
      http: "http://127.0.0.1:53182/Vr2ii1ySMoE=/",
      ws: "ws://127.0.0.1:53182/Vr2ii1ySMoE=/ws",
    });
  });

  it("takes a LAN address, a Bonjour name and a bracketed IPv6 host", () => {
    expect(
      parseAnnouncedVmServiceUri(
        "A Dart VM Service on TV is available at: http://192.168.1.40:40123/"
      )?.ws
    ).toBe("ws://192.168.1.40:40123/ws");
    expect(
      parseAnnouncedVmServiceUri(
        "A Dart VM Service on TV is available at: http://Living-Room.local:40123/tok=/"
      )?.ws
    ).toBe("ws://Living-Room.local:40123/tok=/ws");
    expect(
      parseAnnouncedVmServiceUri(
        "A Dart VM Service on TV is available at: http://[fd12:3456::1]:40123/tok=/"
      )?.ws
    ).toBe("ws://[fd12:3456::1]:40123/tok=/ws");
  });

  it("ignores the device's own listening line, which names a port on the device", () => {
    const log = [
      "The Dart VM service is listening on http://127.0.0.1:52281/",
      "flutter: booting",
    ].join("\n");
    expect(parseAnnouncedVmServiceUri(log)).toBeNull();
    expect(parseVmServiceUri(log)?.http).toBe("http://127.0.0.1:52281/");
  });

  it("refuses the 0.0.0.0 bind address and reads past the DevTools line", () => {
    expect(
      parseAnnouncedVmServiceUri(
        "A Dart VM Service on TV is available at: http://0.0.0.0:40123/tok=/"
      )
    ).toBeNull();
    const log = [
      "A Dart VM Service on TV is available at: http://127.0.0.1:61000/abc=/",
      "The Flutter DevTools debugger and profiler on TV is available at: http://127.0.0.1:9101?uri=http://127.0.0.1:61000/abc=/",
    ].join("\n");
    expect(parseAnnouncedVmServiceUri(log)?.http).toBe(
      "http://127.0.0.1:61000/abc=/"
    );
  });

  it("takes the last announcement", () => {
    const log = [
      "A Dart VM Service on TV is available at: http://127.0.0.1:1111/old=/",
      "A Dart VM Service on TV is available at: http://127.0.0.1:2222/new=/",
    ].join("\n");
    expect(parseAnnouncedVmServiceUri(log)?.http).toBe(
      "http://127.0.0.1:2222/new=/"
    );
  });
});

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
