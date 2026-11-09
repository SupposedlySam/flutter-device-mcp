import { buildSimVmServiceLogCommand, parseSimctlLaunchPid } from "../src/tvosSimulatorLog.js";

describe("parseSimctlLaunchPid", () => {
  it("reads the pid simctl launch prints after the bundle id", () => {
    expect(parseSimctlLaunchPid("com.example.player: 48213\n", "com.example.player")).toBe(48213);
  });

  it("does not take another bundle's pid for a bundle id that differs only by a dot", () => {
    expect(parseSimctlLaunchPid("comXexampleXplayer: 48213", "com.example.player")).toBeUndefined();
  });
});

describe("buildSimVmServiceLogCommand", () => {
  it("reads the launched pid's VM-service line from the simulator's own log", () => {
    expect(buildSimVmServiceLogCommand("SIM-1", 31.2, 48213)).toBe(
      "xcrun simctl spawn 'SIM-1' log show --style compact --last 32s " +
        `--predicate 'processID == 48213 AND eventMessage CONTAINS[c] "vm service"'`
    );
  });

  it("falls back to the Runner process when the launch printed no pid", () => {
    expect(buildSimVmServiceLogCommand("SIM-1", 30)).toContain(`process == "Runner"`);
  });
});
