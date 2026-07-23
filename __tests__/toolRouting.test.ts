import { routeTool } from "../src/toolRouting.js";

// Each flutter_* tool routes to itself as the canonical handler.
const CANONICAL_TOOLS: string[] = [
  "flutter_info",
  "flutter_setup",
  "flutter_build",
  "flutter_deploy",
  "flutter_uninstall",
  "flutter_kill_stale",
  "flutter_hot_reload",
];

describe("routeTool", () => {
  it.each(CANONICAL_TOOLS)(
    "%s routes to itself as the canonical handler",
    (tool) => {
      expect(routeTool(tool)?.canonical).toBe(tool);
    }
  );

  it("returns undefined for an unknown tool", () => {
    expect(routeTool("nope")).toBeUndefined();
  });

  it("no longer resolves the removed appliance_*/tizen_* aliases", () => {
    expect(routeTool("appliance_info")).toBeUndefined();
    expect(routeTool("tizen_info")).toBeUndefined();
    expect(routeTool("tizen_build")).toBeUndefined();
    expect(routeTool("tizen_hot_reload")).toBeUndefined();
  });

  describe("Stage-2 input tools", () => {
    const INPUT_TOOLS = [
      "flutter_set_input_mode",
      "flutter_key",
      "flutter_pointer",
    ];

    it.each(INPUT_TOOLS)("%s routes to itself", (tool) => {
      expect(routeTool(tool)?.canonical).toBe(tool);
    });

    it("has no tizen_* alias for the input tools", () => {
      expect(routeTool("tizen_set_input_mode")).toBeUndefined();
      expect(routeTool("tizen_key")).toBeUndefined();
      expect(routeTool("tizen_pointer")).toBeUndefined();
    });
  });

  describe("OS-level lifecycle tools (mobile capability)", () => {
    const LIFECYCLE_TOOLS = [
      "flutter_terminate",
      "flutter_background",
      "flutter_foreground",
    ];

    it.each(LIFECYCLE_TOOLS)("%s routes to itself", (tool) => {
      expect(routeTool(tool)?.canonical).toBe(tool);
    });

    it("has no tizen_* alias for the lifecycle tools", () => {
      expect(routeTool("tizen_terminate")).toBeUndefined();
      expect(routeTool("tizen_background")).toBeUndefined();
      expect(routeTool("tizen_foreground")).toBeUndefined();
    });
  });

  describe("hot_restart + screenshot + record", () => {
    const NEW_TOOLS = [
      "flutter_hot_restart",
      "flutter_screenshot",
      "flutter_record",
    ];

    it.each(NEW_TOOLS)("%s routes to itself", (tool) => {
      expect(routeTool(tool)?.canonical).toBe(tool);
    });

    it("has no tizen_* alias for hot_restart / screenshot / record", () => {
      expect(routeTool("tizen_hot_restart")).toBeUndefined();
      expect(routeTool("tizen_screenshot")).toBeUndefined();
      expect(routeTool("tizen_record")).toBeUndefined();
    });
  });

  describe("system-prompt tool (mobile capability)", () => {
    it("flutter_system_prompt routes to itself", () => {
      expect(routeTool("flutter_system_prompt")?.canonical).toBe(
        "flutter_system_prompt"
      );
    });

    it("has no tizen_* alias for the system-prompt tool", () => {
      expect(routeTool("tizen_system_prompt")).toBeUndefined();
    });
  });
});
