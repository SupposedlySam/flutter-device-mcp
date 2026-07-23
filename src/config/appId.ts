/**
 * Best-effort derivation of a platform's app/bundle id from the Flutter
 * project's native sub-projects, so uninstall + lifecycle work with zero config
 * in a standard app layout. A configured id (env / config file) ALWAYS wins;
 * this is only the last-resort fallback. Every function is best-effort and
 * non-throwing — an unreadable/unexpected file yields `undefined`, and the
 * caller degrades to an "app id not configured" message rather than crashing.
 */
import fs from "fs";
import path from "path";
import { Platform } from "../types.js";

/** Read a file as UTF-8, or `undefined` when it does not exist / can't be read. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** iOS/tvOS bundle id from the first PRODUCT_BUNDLE_IDENTIFIER in the pbxproj. */
function bundleIdFromXcodeProject(appDir: string, iosDir: string): string | undefined {
  const pbxproj = path.join(appDir, iosDir, "Runner.xcodeproj", "project.pbxproj");
  const text = readText(pbxproj);
  if (!text) return undefined;
  // Prefer a concrete id over a $(VARIABLE) reference (the first match may be a
  // build-setting reference); scan all and take the first non-variable value.
  const matches = text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g);
  for (const m of matches) {
    const value = m[1].trim().replace(/^["']|["']$/g, "");
    if (value && !value.includes("$(")) return value;
  }
  return undefined;
}

/** Android applicationId from `android/app/build.gradle[.kts]`. */
function applicationIdFromGradle(appDir: string): string | undefined {
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const text = readText(path.join(appDir, "android", "app", name));
    if (!text) continue;
    // Matches both Groovy `applicationId "x"` and Kotlin `applicationId = "x"`.
    const m = text.match(/applicationId\s*=?\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return undefined;
}

/** Tizen package id from `tizen/tizen-manifest.xml`. */
function packageIdFromTizenManifest(appDir: string): string | undefined {
  const text = readText(path.join(appDir, "tizen", "tizen-manifest.xml"));
  if (!text) return undefined;
  const m = text.match(/<manifest[^>]*\bpackage\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : undefined;
}

/** webOS app id from `webos/appinfo.json`. */
function appIdFromWebosAppinfo(appDir: string): string | undefined {
  const text = readText(path.join(appDir, "webos", "appinfo.json"));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { id?: string };
    return parsed.id;
  } catch {
    return undefined;
  }
}

/**
 * Derive the app/bundle id for `platform` from the project's native files, or
 * `undefined` when it can't be determined (then the caller should require it be
 * configured). Never throws.
 */
export function deriveAppId(platform: Platform, appDir: string): string | undefined {
  switch (platform) {
    case "ios":
      return bundleIdFromXcodeProject(appDir, "ios");
    case "tvos":
      // flutter-tvos projects keep the Runner under `ios/`; fall back to `tvos/`.
      return (
        bundleIdFromXcodeProject(appDir, "ios") ??
        bundleIdFromXcodeProject(appDir, "tvos")
      );
    case "android":
      return applicationIdFromGradle(appDir);
    case "tizen":
      return packageIdFromTizenManifest(appDir);
    case "webos":
      return appIdFromWebosAppinfo(appDir);
    default:
      return undefined;
  }
}
