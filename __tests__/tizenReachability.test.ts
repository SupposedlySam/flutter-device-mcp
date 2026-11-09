import {
  candidateHosts,
  describeProbes,
  probeRest,
  sdbConnectSucceeded,
} from "../src/tizenReachability.js";

describe("candidateHosts", () => {
  it("strips the sdb port, skips blanks and lists each host once in order", () => {
    expect(
      candidateHosts(["192.0.2.6:26101", undefined, " ", "192.0.2.7", "192.0.2.6"])
    ).toEqual(["192.0.2.6", "192.0.2.7"]);
  });
});

describe("sdbConnectSucceeded", () => {
  it.each([
    ["connected to 192.0.2.6:26101", true],
    ["already connected to 192.0.2.6:26101", true],
    ["failed to connect to 192.0.2.6:26101", false],
    ["cannot connect to 192.0.2.6:26101: Connection timed out", false],
    ["", false],
  ])("%j → %s", (output, expected) => {
    expect(sdbConnectSucceeded(output)).toBe(expected);
  });
});

describe("probeRest", () => {
  const respond = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body }) as unknown as Response) as typeof fetch;

  it("answers with the bound host as a hint", async () => {
    await expect(
      probeRest("192.0.2.6", respond({ device: { developerIP: "192.0.2.7" } }))
    ).resolves.toEqual({ answered: true, developerIp: "192.0.2.7" });
  });

  it("does not answer on a network error or a non-ok response", async () => {
    const refused = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(probeRest("192.0.2.6", refused)).resolves.toEqual({ answered: false });
    await expect(probeRest("192.0.2.6", respond({}, false))).resolves.toEqual({
      answered: false,
    });
  });
});

describe("describeProbes", () => {
  const HOST = "192.0.2.210";
  const failed = {
    ip: "192.0.2.6",
    restAnswered: true,
    restDeveloperIp: HOST,
    connected: false,
    connectOutput: "failed to connect to 192.0.2.6:26101",
  };

  it("gives the TV-side fix naming this host when connect failed, even if REST shows its own address", () => {
    expect(describeProbes([failed], () => HOST)).toBe(
      "192.0.2.6: :8001 answers (it reports Host PC IP 192.0.2.210, a hint only), " +
        "but sdb connect failed (failed to connect to 192.0.2.6:26101). " +
        "On the TV: Apps → 12345 → Developer mode → set Host PC IP to 192.0.2.210 → restart the TV."
    );
  });

  it("says the TV may be off when neither :8001 nor sdb answers", () => {
    const text = describeProbes(
      [{ ...failed, restAnswered: false, restDeveloperIp: undefined, connectOutput: "" }],
      () => undefined
    );
    expect(text).toContain(":8001 does not answer, and sdb connect failed (no output)");
    expect(text).toContain("may be off, asleep or on another address");
    expect(text).toContain("set Host PC IP to this host's LAN IP");
  });

  it("offers no fix when connect succeeded", () => {
    const text = describeProbes([{ ...failed, connected: true, connectOutput: "connected to 192.0.2.6:26101" }], () => HOST);
    expect(text).toContain("The TV is reachable now; retry.");
    expect(text).not.toContain("Developer mode");
  });

  it("is null with nothing probed", () => {
    expect(describeProbes([], () => HOST)).toBeNull();
  });
});
