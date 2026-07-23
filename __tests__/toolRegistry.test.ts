import { buildAdvertisedTools, buildToolList } from "../src/toolRegistry.js";
import { knownToolNames, routeTool } from "../src/toolRouting.js";

describe("buildToolList (ListTools advertisement)", () => {
  const { flutter } = buildToolList();
  const advertised = buildAdvertisedTools();

  it("advertises exactly 17 flutter_ tools", () => {
    expect(flutter).toHaveLength(17);
    expect(advertised).toHaveLength(17);
  });

  it("names every tool with the flutter_ prefix", () => {
    expect(flutter.every((t) => t.name.startsWith("flutter_"))).toBe(true);
    expect(advertised.every((t) => t.name.startsWith("flutter_"))).toBe(true);
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
