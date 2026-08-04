import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveAppDirWith,
  validateExplicitAppDir,
} from "../src/config/appDir.js";

describe("resolveAppDirWith (per-call > env/config/derived precedence)", () => {
  const resolvers = {
    validateOverride: (candidate: string) => `VALIDATED:${candidate}`,
    fromConfig: () => "FROM_CONFIG",
  };

  it("uses the per-call override when one is supplied", () => {
    expect(resolveAppDirWith("/some/app", resolvers)).toBe(
      "VALIDATED:/some/app"
    );
  });

  it("falls through to the config chain when no override is given", () => {
    expect(resolveAppDirWith(undefined, resolvers)).toBe("FROM_CONFIG");
  });

  it("treats a blank/whitespace override as absent, not as a path", () => {
    // A caller passing "" means "use the default", not "use the empty path" --
    // validating it would fail a request that asked for nothing unusual.
    expect(resolveAppDirWith("", resolvers)).toBe("FROM_CONFIG");
    expect(resolveAppDirWith("   ", resolvers)).toBe("FROM_CONFIG");
  });

  it("trims a supplied path before validating it", () => {
    expect(resolveAppDirWith("  /some/app  ", resolvers)).toBe(
      "VALIDATED:/some/app"
    );
  });

  it("lets a validation failure propagate instead of falling back", () => {
    // THE POINT: a bad app_dir must fail loudly. Silently falling back would
    // run the whole request against a DIFFERENT project and report success.
    expect(() =>
      resolveAppDirWith("/bad", {
        validateOverride: () => {
          throw new McpError(ErrorCode.InvalidParams, "nope");
        },
        fromConfig: () => "FROM_CONFIG",
      })
    ).toThrow(/nope/);
  });
});

describe("validateExplicitAppDir", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flutter-device-appdir-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts a real Flutter app and returns its absolute path", () => {
    const app = path.join(tmp, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "pubspec.yaml"), "name: demo");
    // Resolved, NOT realpath'd: a caller who passes a symlinked path gets that
    // path back, which is what they will recognize in the response.
    expect(validateExplicitAppDir(app)).toBe(path.resolve(app));
  });

  it("resolves a relative path to an absolute one", () => {
    const app = path.join(tmp, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "pubspec.yaml"), "name: demo");
    const resolved = validateExplicitAppDir(app);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    expect(() => validateExplicitAppDir(path.join(tmp, "nope"))).toThrow(
      /does not exist/
    );
  });

  it("rejects a file that is not a directory", () => {
    const file = path.join(tmp, "pubspec.yaml");
    fs.writeFileSync(file, "name: demo");
    expect(() => validateExplicitAppDir(file)).toThrow(/not a directory/);
  });

  it("rejects a directory that is not a Flutter app", () => {
    // A plain directory would otherwise be accepted and every command run in
    // it would fail later with something far less clear than this.
    const notApp = path.join(tmp, "not-an-app");
    fs.mkdirSync(notApp);
    expect(() => validateExplicitAppDir(notApp)).toThrow(/no pubspec.yaml/);
  });

  it("raises InvalidParams so a bad path is a protocol error, not a crash", () => {
    try {
      validateExplicitAppDir(path.join(tmp, "nope"));
      throw new Error("expected validateExplicitAppDir to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });
});
