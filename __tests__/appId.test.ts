import fs from "fs";
import os from "os";
import path from "path";
import { deriveAppId } from "../src/config/appId.js";

/** Build a throwaway Flutter-ish app dir with the given android gradle body. */
function appDirWithGradle(body: string, name = "build.gradle"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appId-"));
  const gradleDir = path.join(dir, "android", "app");
  fs.mkdirSync(gradleDir, { recursive: true });
  fs.writeFileSync(path.join(gradleDir, name), body);
  return dir;
}

describe("deriveAppId (android)", () => {
  it("reads a literal Groovy applicationId", () => {
    const dir = appDirWithGradle('android {\n  applicationId "com.example.app"\n}\n');
    expect(deriveAppId("android", dir)).toBe("com.example.app");
  });

  it("reads a literal Kotlin applicationId", () => {
    const dir = appDirWithGradle(
      'android {\n  applicationId = "com.example.kts"\n}\n',
      "build.gradle.kts"
    );
    expect(deriveAppId("android", dir)).toBe("com.example.kts");
  });

  it("does NOT return an unresolved Gradle variable", () => {
    // Found on a real device: the derived id came back as the literal string
    // "$dropsAndroidApplicationId". It reads like a real id and is accepted
    // everywhere, then silently fails on-device — `am start` ignores the bogus
    // package and `adb uninstall` reports the wrong app missing.
    const dir = appDirWithGradle(
      'android {\n  applicationId "$dropsAndroidApplicationId"\n}\n'
    );
    expect(deriveAppId("android", dir)).toBeUndefined();
  });

  it("does NOT return a braced Gradle interpolation", () => {
    const dir = appDirWithGradle('android {\n  applicationId "${myAppId}"\n}\n');
    expect(deriveAppId("android", dir)).toBeUndefined();
  });

  it("skips a variable declaration in favour of a concrete one later in the file", () => {
    const dir = appDirWithGradle(
      'flavorDimensions "x"\n' +
        'productFlavors {\n  dev { applicationId "$devId" }\n' +
        '  prod { applicationId "com.example.prod" }\n}\n'
    );
    expect(deriveAppId("android", dir)).toBe("com.example.prod");
  });

  it("returns undefined when there is no gradle file at all", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appId-empty-"));
    expect(deriveAppId("android", dir)).toBeUndefined();
  });

  it("does NOT fall through to a stale build.gradle.kts when build.gradle owns the id", () => {
    // Observed live: a project carried a real Groovy build.gradle whose id came
    // from a property, plus a stale Flutter-template build.gradle.kts. Falling
    // through answered `com.example.<name>` — an id Gradle itself never uses,
    // and one concrete enough that nothing downstream questioned it.
    const dir = appDirWithGradle(
      'android {\n  applicationId "$dropsAndroidApplicationId"\n}\n'
    );
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle.kts"),
      'android {\n  applicationId = "com.example.template_app"\n}\n'
    );
    expect(deriveAppId("android", dir)).toBeUndefined();
  });

  it("still reads build.gradle.kts when build.gradle declares no id at all", () => {
    const dir = appDirWithGradle("android {\n  compileSdk = 34\n}\n");
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle.kts"),
      'android {\n  applicationId = "com.example.kts_only"\n}\n'
    );
    expect(deriveAppId("android", dir)).toBe("com.example.kts_only");
  });
});
