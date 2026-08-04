import {
  parseSimulatorDestinations,
  resolveSimDestination,
  SimCandidate,
} from "../src/iosSimDestination.js";

const SHOWDESTINATIONS = `
        Available destinations for the "Runner" scheme:
                { platform:iOS Simulator, id:AAAA1111-1111-1111-1111-111111111111, OS:17.5, name:iPhone 15 }
                { platform:iOS Simulator, id:BBBB2222-2222-2222-2222-222222222222, OS:17.5, name:iPhone 15 Pro }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS Simulator, id:CCCC3333-3333-3333-3333-333333333333, OS:16.0, name:iPhone 13 }
`;

describe("parseSimulatorDestinations", () => {
  it("keeps only eligible concrete iOS Simulator destinations", () => {
    const dests = parseSimulatorDestinations(SHOWDESTINATIONS);
    expect(dests.map((d) => d.name)).toEqual(["iPhone 15", "iPhone 15 Pro"]);
    expect(dests[0].id).toBe("AAAA1111-1111-1111-1111-111111111111");
  });

  it("excludes placeholder rows and ineligible-section simulators", () => {
    const dests = parseSimulatorDestinations(SHOWDESTINATIONS);
    expect(dests.some((d) => /placeholder/i.test(d.id))).toBe(false);
    // iPhone 13 lives under Ineligible destinations — must be dropped.
    expect(dests.some((d) => d.name === "iPhone 13")).toBe(false);
  });

  it("returns [] for empty output", () => {
    expect(parseSimulatorDestinations("")).toEqual([]);
  });
});

describe("resolveSimDestination", () => {
  const dests = parseSimulatorDestinations(SHOWDESTINATIONS);
  const iphone15 = "AAAA1111-1111-1111-1111-111111111111";
  const iphone15pro = "BBBB2222-2222-2222-2222-222222222222";
  const iphone13 = "CCCC3333-3333-3333-3333-333333333333";

  it("keeps a requested target that IS a valid destination", () => {
    const candidates: SimCandidate[] = [
      { udid: iphone15, name: "iPhone 15", booted: true },
    ];
    const r = resolveSimDestination(dests, candidates, iphone15)!;
    expect(r.udid).toBe(iphone15);
    expect(r.needsBoot).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it("substitutes + warns when the booted target is NOT a valid destination (the live bug)", () => {
    // iPhone 13 is booted but ineligible; iPhone 15 is the valid booted one.
    const candidates: SimCandidate[] = [
      { udid: iphone13, name: "iPhone 13", booted: true },
      { udid: iphone15, name: "iPhone 15", booted: true },
    ];
    const r = resolveSimDestination(dests, candidates, iphone13)!;
    expect(r.udid).toBe(iphone15);
    expect(r.needsBoot).toBe(false);
    expect(r.warning).toMatch(/not a valid Runner-scheme destination/i);
    expect(r.warning).toContain(iphone13);
  });

  it("prefers a booted valid destination over one needing a boot", () => {
    const candidates: SimCandidate[] = [
      { udid: iphone15, name: "iPhone 15", booted: false },
      { udid: iphone15pro, name: "iPhone 15 Pro", booted: true },
    ];
    const r = resolveSimDestination(dests, candidates)!;
    expect(r.udid).toBe(iphone15pro);
    expect(r.needsBoot).toBe(false);
  });

  it("picks a valid destination needing a boot when none is booted", () => {
    const candidates: SimCandidate[] = [
      { udid: iphone15, name: "iPhone 15", booted: false },
    ];
    const r = resolveSimDestination(dests, candidates)!;
    expect(r.udid).toBe(iphone15);
    expect(r.needsBoot).toBe(true);
  });

  it("falls back to the first destination when no candidate matches", () => {
    const r = resolveSimDestination(dests, [], "ZZZZ-not-a-thing")!;
    expect(r.udid).toBe(iphone15);
    expect(r.needsBoot).toBe(true);
    expect(r.warning).toMatch(/not a valid Runner-scheme destination/i);
  });

  it("returns null when the scheme lists no simulator destinations", () => {
    expect(resolveSimDestination([], [{ udid: iphone13, booted: true }])).toBeNull();
  });
});
