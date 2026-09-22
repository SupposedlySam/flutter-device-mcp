#!/usr/bin/env node
/**
 * MCP server frontend — a thin translation layer over {@link CommandCore}.
 *
 * It owns only MCP concerns: advertising the tool list, routing a called tool
 * name to a canonical handler, resolving the platform arg, and wrapping the
 * core's plain result object in a JSON content block. Every guardrail and device
 * behavior lives in the shared core, so the `flutter-device` CLI gets identical
 * behavior from the same methods.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import { buildRuntime } from "./runtime.js";
import { CommandCore, CommonArgs } from "./core/commandCore.js";
import { routeTool } from "./toolRouting.js";
import { buildAdvertisedTools } from "./toolRegistry.js";
import { resolvePlatform } from "./handlerLogic.js";
import {
  resolveAppDirWith,
  validateExplicitAppDir,
} from "./config/appDir.js";
import { BuildMode, InputMode } from "./types.js";

class FlutterDeviceServer {
  private readonly server: Server;
  private readonly core: CommandCore;
  private readonly defaultPlatform: string;

  /**
   * Runtimes for per-call `app_dir` overrides, keyed by the RESOLVED absolute
   * path. Building one resolves config and constructs every adapter, so a
   * caller iterating over one project would otherwise pay that on every call;
   * the key is the validated path, so two spellings of the same directory share
   * one entry.
   */
  private readonly runtimeByAppDir = new Map<string, CommandCore>();

  constructor() {
    this.server = new Server(
      { name: "flutter-device-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    const { registry, config } = buildRuntime();
    this.core = new CommandCore(registry, config);
    this.defaultPlatform = config.defaultPlatform;
    this.setupToolHandlers();
    this.server.onerror = (error) => logger.error("[MCP Error]", error);
  }

  /**
   * The CommandCore this call runs against, honoring a per-call `app_dir`.
   *
   * A long-running server otherwise resolves its app ONCE at startup and is
   * pinned to it for the process's life — so operating on a second checkout (a
   * git worktree, a second project) meant restarting the MCP host. An explicit
   * `app_dir` re-resolves config for THIS call only; everything downstream —
   * device resolution, install, VM-service capture, kill-stale — then runs
   * against that project.
   */
  private coreFor(appDir: unknown): CommandCore {
    const resolved = resolveAppDirWith(
      typeof appDir === "string" ? appDir : undefined,
      {
        validateOverride: validateExplicitAppDir,
        // No override: the server's own startup-resolved app.
        fromConfig: () => "",
      }
    );
    if (!resolved) return this.core;
    const cached = this.runtimeByAppDir.get(resolved);
    if (cached) return cached;
    const { registry, config } = buildRuntime({ appDir: resolved });
    const core = new CommandCore(registry, config);
    this.runtimeByAppDir.set(resolved, core);
    return core;
  }

  private json(result: unknown) {
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildAdvertisedTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.info(`Called tool: ${request.params.name}`, {
        arguments: request.params.arguments,
      });
      const args = request.params.arguments ?? {};
      const route = routeTool(request.params.name);
      if (!route) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      const common: CommonArgs = { platform: resolvePlatform(route, args) };
      // uninstall and the lifecycle verbs take no arguments of their own beyond
      // the per-call device pin, so they share one pre-built args object.
      const withDevicePin = {
        ...common,
        device_udid: args.device_udid as string | undefined,
      };
      const core = this.coreFor(args.app_dir);

      switch (route.canonical) {
        case "flutter_info":
          return this.json(await core.info(common));
        case "flutter_setup":
          return this.json(
            await core.setup({
              ...common,
              device_ip: args.device_ip as string | undefined,
            })
          );
        case "flutter_build":
          return this.json(
            await core.build({
              ...common,
              profile: args.profile as string | undefined,
              mode: args.mode as BuildMode | undefined,
              debug: args.debug as boolean | undefined,
              dart_define: args.dart_define as
                | Record<string, string>
                | undefined,
              skip_rust: args.skip_rust as boolean | undefined,
              skip_flutter: args.skip_flutter as boolean | undefined,
              install: args.install as boolean | undefined,
              run: args.run as boolean | undefined,
              target: args.target as "simulator" | "device" | undefined,
            })
          );
        case "flutter_deploy":
          return this.json(
            await core.deploy({
              ...common,
              mode: args.mode as BuildMode | undefined,
              no_launch: args.no_launch as boolean | undefined,
              timeout_ms: args.timeout_ms as number | undefined,
              dart_define: args.dart_define as
                | Record<string, string>
                | undefined,
              debug: args.debug as boolean | undefined,
              target: args.target as "simulator" | "device" | undefined,
              device_udid: args.device_udid as string | undefined,
              app_path: args.app_path as string | undefined,
              app_url: args.app_url as string | undefined,
            })
          );
        case "flutter_uninstall":
          return this.json(await core.uninstall(withDevicePin));
        case "flutter_kill_stale":
          return this.json(await core.killStale(common));
        case "flutter_terminate":
          return this.json(await core.terminate(withDevicePin));
        case "flutter_background":
          return this.json(await core.background(withDevicePin));
        case "flutter_foreground":
          return this.json(await core.foreground(withDevicePin));
        case "flutter_hot_reload":
          return this.json(
            await core.hotReload({
              ...common,
              device: args.device as string | undefined,
              timeout_ms: args.timeout_ms as number | undefined,
            })
          );
        case "flutter_hot_restart":
          return this.json(
            await core.hotRestart({
              ...common,
              device: args.device as string | undefined,
            })
          );
        case "flutter_screenshot":
          return this.json(
            await core.screenshot({
              ...common,
              output_path: args.output_path as string | undefined,
              include_base64: args.include_base64 as boolean | undefined,
              device_udid: args.device_udid as string | undefined,
              target: args.target as "simulator" | "device" | undefined,
            })
          );
        case "flutter_record":
          return this.json(
            await core.record({
              ...common,
              output_path: args.output_path as string | undefined,
              duration_s: args.duration_s as number | undefined,
              fps: args.fps as number | undefined,
              format: args.format as "mp4" | "gif" | undefined,
              device_udid: args.device_udid as string | undefined,
              target: args.target as "simulator" | "device" | undefined,
            })
          );
        case "flutter_set_input_mode":
          return this.json(
            await core.setInputMode({
              ...common,
              mode: args.mode as InputMode,
            })
          );
        case "flutter_key":
          return this.json(
            await core.key({
              ...common,
              key: args.key as string | undefined,
              text: args.text as string | undefined,
              device_udid: args.device_udid as string | undefined,
            })
          );
        case "flutter_geometry":
          return this.json(
            await core.geometry({
              ...common,
              device_udid: args.device_udid as string | undefined,
              view_width: args.view_width as number | undefined,
              view_height: args.view_height as number | undefined,
              view_dpr: args.view_dpr as number | undefined,
            })
          );
        case "flutter_pointer":
          return this.json(
            await core.pointer({
              ...common,
              action: args.action as "move" | "click" | "scroll",
              x: args.x as number | undefined,
              y: args.y as number | undefined,
              dy: args.dy as number | undefined,
              coordinateSpace: args.coordinateSpace as
                | "device"
                | "logical"
                | undefined,
              dpr: args.dpr as number | undefined,
              absolute: args.absolute as boolean | undefined,
              double: args.double as boolean | undefined,
              duration_ms: args.duration_ms as number | undefined,
              verify: args.verify as boolean | undefined,
              device_udid: args.device_udid as string | undefined,
            })
          );
        case "flutter_open_url":
          return this.json(
            await core.openUrl({
              ...common,
              url: args.url as string,
              package_or_bundle_id: args.package_or_bundle_id as
                | string
                | undefined,
              target: args.target as "device" | "simulator" | undefined,
              device_udid: args.device_udid as string | undefined,
            })
          );
        case "flutter_system_prompt":
          return this.json(
            await core.systemPrompt({
              ...common,
              action: args.action as "detect" | "tap" | "dismiss",
              button_label: args.button_label as string | undefined,
              udid: args.udid as string | undefined,
            })
          );
        default: {
          // Exhaustiveness guard: a routed-but-unhandled canonical is a compile
          // error via `never`, and a runtime MethodNotFound as a backstop.
          const unhandled: never = route.canonical;
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unhandled tool route: ${String(unhandled)}`
          );
        }
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("flutter-device-mcp server started", {
      defaultPlatform: this.defaultPlatform,
    });
  }
}

const server = new FlutterDeviceServer();
server.run().catch((error) => {
  logger.error("Fatal error running flutter-device-mcp server", { error });
  process.exit(1);
});
