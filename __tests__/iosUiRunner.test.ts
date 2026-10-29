import fs from "fs";
import os from "os";
import path from "path";
import {
  buildForTestingCommand,
  IosUiRunner,
  IosUiRunnerError,
  parseDevelopmentTeam,
  parseXcodeBuild,
  resolveDevelopmentTeam,
  runnerCacheDir,
  runnerSourceDir,
  runnerSourceHash,
  Shell,
  testWithoutBuildingCommand,
} from "../src/iosUiRunner.js";
import { CommandResult } from "../src/cli.js";

const PBXPROJ_WITH_EMPTY_FIRST = `
  DEVELOPMENT_TEAM = "";
  "DEVELOPMENT_TEAM[sdk=iphoneos*]" = ABCDE12345;
`;

function result(partial: Partial<CommandResult>): CommandResult {
  const combined = partial.combined ?? partial.stdout ?? "";
  return {
    code: partial.success === false ? 1 : 0,
    stdout: "",
    stderr: "",
    combined,
    success: true,
    timedOut: false,
    ...partial,
  };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ios-ui-runner-test-"));
}

describe("signing team", () => {
  it("reads the first real team, skipping an empty one", () => {
    expect(parseDevelopmentTeam(PBXPROJ_WITH_EMPTY_FIRST)).toBe("ABCDE12345");
    expect(parseDevelopmentTeam("DEVELOPMENT_TEAM = ;")).toBeUndefined();
  });

  it("prefers FLUTTER_DEVICE_IOS_TEAM over the project", () => {
    expect(resolveDevelopmentTeam("/nowhere", { FLUTTER_DEVICE_IOS_TEAM: "ABCDE12345" })).toBe(
      "ABCDE12345"
    );
  });

  it("takes the team from the app's iOS project", () => {
    const appDir = tmp();
    fs.mkdirSync(path.join(appDir, "ios", "Runner.xcodeproj"), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "ios", "Runner.xcodeproj", "project.pbxproj"),
      PBXPROJ_WITH_EMPTY_FIRST
    );
    expect(resolveDevelopmentTeam(appDir, {})).toBe("ABCDE12345");
  });

  it("rejects a pinned team that is not a 10-character id", () => {
    expect(() => resolveDevelopmentTeam("/nowhere", { FLUTTER_DEVICE_IOS_TEAM: "../x" })).toThrow(
      /10-character/
    );
  });

  it("fails naming the override when the project has no team", () => {
    expect(() => resolveDevelopmentTeam(tmp(), {})).toThrow(/FLUTTER_DEVICE_IOS_TEAM/);
  });
});

describe("cache and commands", () => {
  it("keys the cache by Xcode build and team under the cache root", () => {
    expect(runnerCacheDir("17B55", "TEAM", { FLUTTER_DEVICE_CACHE_DIR: "/c" })).toBe(
      `/c/ios-ui-runner/17B55-TEAM-${runnerSourceHash()}`
    );
  });

  it("changes the cache key when a runner source changes", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.swift"), "one");
    const before = runnerSourceHash(dir);
    fs.writeFileSync(path.join(dir, "a.swift"), "two");
    expect(runnerSourceHash(dir)).not.toBe(before);
  });

  it("parses the Xcode build version", () => {
    expect(parseXcodeBuild("Xcode 26.1\nBuild version 17B55\n")).toBe("17B55");
  });

  it("targets the device by id and the cached derived data", () => {
    expect(buildForTestingCommand("/c/x", "UDID1")).toContain("-destination 'id=UDID1'");
    expect(buildForTestingCommand("/c/x", "UDID1")).toContain("-allowProvisioningUpdates");
    expect(testWithoutBuildingCommand("/c/x", "UDID1")).toContain("-derivedDataPath '/c/x/dd'");
  });

  it("ships the runner sources it stages", () => {
    for (const file of ["project.yml", "Host/App.swift", "UITests/FlutterDeviceUiRunnerTests.swift"]) {
      expect(fs.existsSync(path.join(runnerSourceDir(), file))).toBe(true);
    }
  });
});

describe("IosUiRunner.run", () => {
  const request = { deviceId: "UDID1", steps: "down4", appId: "com.example.app", appDir: "/app" };

  function harness(testResult: Partial<CommandResult> = {}) {
    const cache = tmp();
    const calls: { command: string; env?: Record<string, string> }[] = [];
    const shell: Shell = async (command, options) => {
      calls.push({ command, env: options?.env });
      if (command.startsWith("xcodebuild -version")) {
        return result({ stdout: "Xcode 26.1\nBuild version 17B55\n" });
      }
      if (command.startsWith("security find-identity")) {
        return result({ stdout: '1) ABC "Apple Development: someone"' });
      }
      if (command.includes("test-without-building")) return result(testResult);
      return result({});
    };
    const runner = new IosUiRunner(shell, { FLUTTER_DEVICE_IOS_TEAM: "TEAM123456", FLUTTER_DEVICE_CACHE_DIR: cache });
    return { runner, calls };
  }

  it("builds once, then runs the steps with the target app in the runner's environment", async () => {
    const { runner, calls } = harness();
    await runner.run(request);
    await runner.run({ ...request, steps: "up2" });

    expect(calls.filter((c) => c.command.startsWith("xcodegen") || c.command.includes("xcodegen generate"))).toHaveLength(1);
    expect(calls.filter((c) => c.command.startsWith("xcodebuild build-for-testing"))).toHaveLength(1);
    const runs = calls.filter((c) => c.command.includes("test-without-building"));
    expect(runs.map((c) => c.env?.TEST_RUNNER_FLUTTER_DEVICE_UI_STEPS)).toEqual(["down4", "up2"]);
    expect(runs[0].env?.TEST_RUNNER_FLUTTER_DEVICE_UI_TARGET).toBe("com.example.app");
  });

  it("runs overlapping calls one at a time", async () => {
    const { runner, calls } = harness();
    await Promise.all([runner.run(request), runner.run({ ...request, steps: "up2" })]);
    expect(calls.filter((c) => c.command.startsWith("xcodebuild build-for-testing"))).toHaveLength(1);
    const runs = calls.filter((c) => c.command.includes("test-without-building"));
    expect(runs.map((c) => c.env?.TEST_RUNNER_FLUTTER_DEVICE_UI_STEPS)).toEqual(["down4", "up2"]);
  });

  it("rebuilds for a device the cached build was not made for", async () => {
    const { runner, calls } = harness();
    await runner.run(request);
    await runner.run({ ...request, deviceId: "UDID2" });
    expect(calls.filter((c) => c.command.startsWith("xcodebuild build-for-testing"))).toHaveLength(2);
  });

  it("stages the team into the project spec", async () => {
    const { runner, calls } = harness();
    await runner.run(request);
    const generate = calls.find((c) => c.command.includes("xcodegen generate"))!;
    const dir = /cd '([^']+)'/.exec(generate.command)![1];
    const spec = fs.readFileSync(path.join(dir, "project.yml"), "utf8");
    expect(spec).toContain("DEVELOPMENT_TEAM: TEAM123456");
    expect(spec).toContain("PRODUCT_BUNDLE_IDENTIFIER: dev.flutterdevice.uirunner.tTEAM123456\n");
    expect(spec).not.toContain("__DEVELOPMENT_TEAM__");
  });

  it("returns the UI Automation message, not a generic error, for that failure", async () => {
    const { runner } = harness({
      success: false,
      combined: "Timed out while enabling automation mode.",
    });
    const error = await runner.run(request).catch((e) => e);
    expect(error).toBeInstanceOf(IosUiRunnerError);
    expect(error.kind).toBe("ui-automation-disabled");
    expect(error.message).toContain("Settings > Developer > Enable UI Automation");
  });

  it("fails clearly when no signing identity can sign the runner", async () => {
    const shell: Shell = async (command) =>
      command.startsWith("xcodebuild -version")
        ? result({ stdout: "Build version 17B55" })
        : result({ stdout: "0 valid identities found" });
    const runner = new IosUiRunner(shell, { FLUTTER_DEVICE_IOS_TEAM: "TEAM123456", FLUTTER_DEVICE_CACHE_DIR: tmp() });
    const error = await runner.run(request).catch((e) => e);
    expect(error.kind).toBe("signing");
    expect(error.message).toMatch(/signing identity/);
  });
});
