import { buildAdvertisedTools, buildToolList } from "../src/toolRegistry.js";
import { knownToolNames, routeTool } from "../src/toolRouting.js";

describe("buildToolList (ListTools advertisement)", () => {
  const { flutter } = buildToolList();
  const advertised = buildAdvertisedTools();

  it("advertises exactly 19 flutter_ tools", () => {
    expect(flutter).toHaveLength(19);
    expect(advertised).toHaveLength(19);
  });

  it("names every tool with the flutter_ prefix", () => {
    expect(flutter.every((t) => t.name.startsWith("flutter_"))).toBe(true);
    expect(advertised.every((t) => t.name.startsWith("flutter_"))).toBe(true);
  });

  describe("per-call app_dir targeting", () => {
    // Tools that act on a PROJECT get the override; tools that act on a DEVICE
    // do not -- advertising it there would imply a checkout mattered to them.
    const PROJECT_SCOPED = [
      "flutter_info",
      "flutter_build",
      "flutter_deploy",
      "flutter_uninstall",
      "flutter_kill_stale",
      "flutter_hot_reload",
      "flutter_hot_restart",
      // open_url is PROJECT-scoped: its Android package defaults to the
      // project's resolved application id, so which project is in play changes
      // what the call does.
      "flutter_open_url",
    ];
    const DEVICE_SCOPED = [
      "flutter_key",
      "flutter_pointer",
      "flutter_geometry",
      "flutter_screenshot",
      "flutter_set_input_mode",
    ];
    const propsOf = (name: string) =>
      Object.keys(
        (advertised.find((t) => t.name === name)!.inputSchema as {
          properties?: Record<string, unknown>;
        }).properties ?? {}
      );

    it.each(PROJECT_SCOPED)("%s advertises app_dir", (name) => {
      expect(propsOf(name)).toContain("app_dir");
    });

    it.each(DEVICE_SCOPED)("%s does NOT advertise app_dir", (name) => {
      expect(propsOf(name)).not.toContain("app_dir");
    });
  });

  it("has no duplicate advertised names", () => {
    const names = advertised.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe("bidirectional consistency with the routing table", () => {
    it("every advertised tool name is resolvable by routeTool", () => {
      for (const tool of advertised) {
        expect(routeTool(tool.name)?.canonical).toBeDefined();
      }
    });

    it("the advertised set equals knownToolNames() (catches a dropped tool)", () => {
      const advertisedNames = advertised.map((t) => t.name).sort();
      expect(advertisedNames).toEqual([...knownToolNames()].sort());
    });
  });
});
