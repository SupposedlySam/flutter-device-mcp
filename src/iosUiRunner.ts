/**
 * The iOS UI-test runner: an XCUITest bundle that presses the hardware volume
 * keys and taps the screen of a physical iPhone, neither of which devicectl or
 * the VM service can do. It is built once per machine, Xcode version, team and
 * device, cached outside the repo, and run with `xcodebuild test-without-building`
 * (about 6-10 s a call).
 *
 * The team is read from the app's iOS project, because signing is per developer.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { CommandResult, runShell, quote, RunOptions } from "./cli.js";
import { classifyRunnerFailure } from "./iosUiRunnerSteps.js";

export type Shell = (command: string, options?: RunOptions) => Promise<CommandResult>;

const SCHEME = "FlutterDeviceUiRunnerHost";
const PROJECT = "FlutterDeviceUiRunner.xcodeproj";
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 2 * 60 * 1000;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const TAIL_LINES = 12;
const MARKER_FILE = "built-devices.json";

export class IosUiRunnerError extends Error {
  constructor(
    message: string,
    readonly kind: string
  ) {
    super(message);
    this.name = "IosUiRunnerError";
  }
}

/** The runner's checked-in sources, resolved from this module so src/ and dist/ agree. */
export function runnerSourceDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "ios-ui-runner"
  );
}

/** A short digest of the runner's checked-in sources, so an edit rebuilds every cache. */
export function runnerSourceHash(dir: string = runnerSourceDir()): string {
  const hash = crypto.createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(dir, full)).update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 10);
}

/** The first real team in an Xcode project file, or undefined when it names none. */
export function parseDevelopmentTeam(pbxproj: string): string | undefined {
  const match = /DEVELOPMENT_TEAM(?:\[[^\]]*\])?"? = "?([A-Z0-9]{10})"?;/.exec(pbxproj);
  return match?.[1];
}

/** `FLUTTER_DEVICE_IOS_TEAM`, else the team the Runner project signs with. */
export function resolveDevelopmentTeam(
  appDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const pinned = env.FLUTTER_DEVICE_IOS_TEAM?.trim();
  if (pinned) {
    if (!TEAM_ID.test(pinned)) {
      throw new IosUiRunnerError(
        `FLUTTER_DEVICE_IOS_TEAM must be a 10-character Apple team id, received '${pinned}'.`,
        "signing"
      );
    }
    return pinned;
  }
  const pbxproj = path.join(appDir, "ios", "Runner.xcodeproj", "project.pbxproj");
  let text: string;
  try {
    text = fs.readFileSync(pbxproj, "utf8");
  } catch {
    throw new IosUiRunnerError(
      `Could not read ${pbxproj} to find the signing team. Set FLUTTER_DEVICE_IOS_TEAM ` +
        "to your Apple development team id.",
      "signing"
    );
  }
  const team = parseDevelopmentTeam(text);
  if (!team) {
    throw new IosUiRunnerError(
      `${pbxproj} names no DEVELOPMENT_TEAM. Set FLUTTER_DEVICE_IOS_TEAM to your Apple ` +
        "development team id.",
      "signing"
    );
  }
  return team;
}

/** Where the built runner for this Xcode build and team lives. */
export function runnerCacheDir(
  xcodeBuild: string,
  team: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const root = path.resolve(
    env.FLUTTER_DEVICE_CACHE_DIR?.trim() ||
      path.join(os.homedir(), ".cache", "flutter-device-mcp")
  );
  return path.join(
    root,
    "ios-ui-runner",
    `${xcodeBuild}-${team}-${runnerSourceHash()}`
  );
}

export function parseXcodeBuild(versionOutput: string): string | undefined {
  return /Build version (\S+)/.exec(versionOutput)?.[1];
}

export function buildForTestingCommand(dir: string, deviceId: string): string {
  return (
    `xcodebuild build-for-testing -project ${quote(path.join(dir, "src", PROJECT))} ` +
    `-scheme ${SCHEME} -destination ${quote(`id=${deviceId}`)} ` +
    `-derivedDataPath ${quote(path.join(dir, "dd"))} -allowProvisioningUpdates`
  );
}

export function testWithoutBuildingCommand(dir: string, deviceId: string): string {
  return (
    `xcodebuild test-without-building -project ${quote(path.join(dir, "src", PROJECT))} ` +
    `-scheme ${SCHEME} -destination ${quote(`id=${deviceId}`)} ` +
    `-derivedDataPath ${quote(path.join(dir, "dd"))}`
  );
}

function builtDevices(dir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function tail(output: string): string {
  return output.trim().split("\n").slice(-TAIL_LINES).join("\n");
}

export interface RunSteps {
  /** The Flutter/xcodebuild id of a physical device. */
  deviceId: string;
  /** Comma-separated runner script (see iosUiRunnerSteps.ts). */
  steps: string;
  /** Bundle id of the app to bring to the front and act on. */
  appId: string;
  appDir: string;
}

export class IosUiRunner {
  constructor(
    private readonly shell: Shell = runShell,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private queue: Promise<unknown> = Promise.resolve();

  /** One runner call at a time: builds and test runs share one cache and one device. */
  run(request: RunSteps): Promise<{ output: string }> {
    const next = this.queue.then(() => this.runNow(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runNow(request: RunSteps): Promise<{ output: string }> {
    const team = resolveDevelopmentTeam(request.appDir, this.env);
    const dir = await this.ensureBuilt(request.deviceId, team);
    const result = await this.shell(testWithoutBuildingCommand(dir, request.deviceId), {
      timeoutMs: RUN_TIMEOUT_MS,
      env: {
        TEST_RUNNER_FLUTTER_DEVICE_UI_STEPS: request.steps,
        TEST_RUNNER_FLUTTER_DEVICE_UI_TARGET: request.appId,
      },
    });
    if (!result.success) {
      throw this.failure(result, "run");
    }
    return { output: tail(result.combined) };
  }

  private async ensureBuilt(deviceId: string, team: string): Promise<string> {
    const version = await this.shell("xcodebuild -version");
    const xcodeBuild = parseXcodeBuild(version.stdout);
    if (!version.success || !xcodeBuild) {
      throw new IosUiRunnerError(
        "xcodebuild is not available. Install Xcode and run `xcode-select -s` at it.",
        "toolchain"
      );
    }
    const dir = runnerCacheDir(xcodeBuild, team, this.env);
    const devices = builtDevices(dir);
    if (devices.includes(deviceId)) return dir;

    await this.requireSigningIdentity();
    await this.stageSources(dir, team);
    const build = await this.shell(buildForTestingCommand(dir, deviceId), {
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (!build.success) throw this.failure(build, "build");
    const marker = path.join(dir, MARKER_FILE);
    fs.writeFileSync(`${marker}.tmp`, JSON.stringify([...devices, deviceId]));
    fs.renameSync(`${marker}.tmp`, marker);
    return dir;
  }

  private async requireSigningIdentity(): Promise<void> {
    const identities = await this.shell("security find-identity -v -p codesigning");
    if (!/Apple Development|iPhone Developer/.test(identities.stdout)) {
      throw new IosUiRunnerError(
        "No Apple Development signing identity is installed, so the UI runner " +
          "cannot be signed for a device. Sign in to Xcode > Settings > Accounts " +
          "with the account that owns the team and let it create one.",
        "signing"
      );
    }
  }

  private async stageSources(dir: string, team: string): Promise<void> {
    const source = path.join(dir, "src");
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source, { recursive: true });
    fs.cpSync(runnerSourceDir(), source, { recursive: true });
    const spec = path.join(source, "project.yml");
    fs.writeFileSync(
      spec,
      fs.readFileSync(spec, "utf8").split("__DEVELOPMENT_TEAM__").join(team)
    );
    const generated = await this.shell(
      `cd ${quote(source)} && xcodegen generate --spec project.yml`
    );
    if (!generated.success) {
      throw new IosUiRunnerError(
        "xcodegen failed or is missing (`brew install xcodegen`): " +
          tail(generated.combined),
        "toolchain"
      );
    }
  }

  private failure(result: CommandResult, phase: "build" | "run"): IosUiRunnerError {
    const classified = classifyRunnerFailure(result.combined);
    if (classified.kind !== "test-failed") {
      return new IosUiRunnerError(classified.message, classified.kind);
    }
    const timedOut = result.timedOut ? ` (timed out after the ${phase} limit)` : "";
    return new IosUiRunnerError(
      `${classified.message}${timedOut}\n${tail(result.combined)}`,
      classified.kind
    );
  }
}
