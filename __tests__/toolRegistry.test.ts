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

  /** The property names one advertised tool's input schema exposes. */
  const propsOf = (name: string) =>
    Object.keys(
      (advertised.find((t) => t.name === name)!.inputSchema as {
        properties?: Record<string, unknown>;
      }).properties ?? {}
    );

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
    it.each(PROJECT_SCOPED)("%s advertises app_dir", (name) => {
      expect(propsOf(name)).toContain("app_dir");
    });

    it.each(DEVICE_SCOPED)("%s does NOT advertise app_dir", (name) => {
      expect(propsOf(name)).not.toContain("app_dir");
    });
  });

  describe("the per-call device pin (device_udid)", () => {
    /** One advertised tool's device_udid property description. */
    const deviceUdidDescription = (name: string) =>
      (
        (
          advertised.find((t) => t.name === name)!.inputSchema as {
            properties?: Record<string, { description: string }>;
          }
        ).properties ?? {}
      ).device_udid?.description;

    // Every tool that acts on ONE resolved device. A device-addressing tool
    // missing from this list is a tool a caller cannot aim on a multi-target
    // host, which is exactly the gap that made a two-device Android host
    // undrivable without an env pin and a host reload.
    //
    // flutter_build is deliberately NOT here: this server's build never
    // resolves a device (it shells the platform build with no target), so the
    // pin would advertise a knob that does nothing.
    const deviceAddressing = [
      "flutter_deploy",
      "flutter_uninstall",
      "flutter_terminate",
      "flutter_background",
      "flutter_foreground",
      "flutter_screenshot",
      "flutter_open_url",
      "flutter_record",
      "flutter_key",
      "flutter_pointer",
      "flutter_geometry",
    ];

    it.each(deviceAddressing)("%s accepts device_udid", (name) => {
      expect(propsOf(name)).toContain("device_udid");
    });

    it("is not advertised on the tools that address no single device", () => {
      // info/setup enumerate ALL devices, build resolves none, kill_stale kills
      // host processes, the hot tools address a recorded launch by its own
      // `device` field, and set_input_mode only records a mode.
      for (const name of [
        "flutter_info",
        "flutter_setup",
        "flutter_build",
        "flutter_kill_stale",
        "flutter_hot_reload",
        "flutter_hot_restart",
        "flutter_set_input_mode",
      ]) {
        expect(propsOf(name)).not.toContain("device_udid");
      }
    });

    it("never describes itself as iOS-only", () => {
      // The description IS the capability as far as a caller is concerned: while
      // deploy's read "iOS ONLY", an Android caller had no way to learn the
      // parameter worked for them.
      for (const name of deviceAddressing) {
        const description = deviceUdidDescription(name)!;
        expect(description).not.toMatch(/iOS ONLY/i);
        expect(description).toMatch(/ANDROID/);
        expect(description).toMatch(/adb serial/i);
      }
    });

    it("names the env pin it overrides, so a caller knows the precedence", () => {
      for (const name of deviceAddressing) {
        expect(deviceUdidDescription(name)!).toMatch(
          /FLUTTER_DEVICE_ANDROID_DEVICE/
        );
      }
    });
  });

  describe("macos is advertised as a selectable platform", () => {
    // Every tool takes `platform`, and a value the schema does not list is a
    // value a strict MCP host will refuse to send — so an adapter registered
    // in the runtime but missing from this enum is unreachable from the wire.
    it("every tool's platform enum offers macos", () => {
      for (const tool of advertised) {
        const platform = (
          (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
            .properties ?? {}
        ).platform;
        expect(platform?.enum).toContain("macos");
      }
    });

    it("flutter_deploy advertises the macOS-only app_path/app_url staging args", () => {
      expect(propsOf("flutter_deploy")).toEqual(
        expect.arrayContaining(["app_path", "app_url"])
      );
    });

    it("flutter_pointer advertises the macOS-only absolute/double escape hatches", () => {
      expect(propsOf("flutter_pointer")).toEqual(
        expect.arrayContaining(["absolute", "double"])
      );
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
