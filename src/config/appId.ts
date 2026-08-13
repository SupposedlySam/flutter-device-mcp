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

/**
 * Android applicationId from `android/app/build.gradle[.kts]`.
 *
 * Two rules, both learned on a real device:
 *
 * 1. An UNRESOLVED Gradle interpolation (`$var` / `${var}`) is not an id. The
 *    Xcode reader already skips `$(VARIABLE)` for the same reason. A project
 *    setting `applicationId "$myAppId"` from a property would otherwise yield
 *    the literal `$myAppId`, which reads like a real id, is accepted
 *    everywhere, and then silently fails on-device — `am start` ignores the
 *    bogus package and `adb uninstall` reports the wrong app missing.
 *
 * 2. The FIRST gradle file that exists is authoritative; we never fall through
 *    to the other one. A project can carry both a real `build.gradle` and a
 *    stale `build.gradle.kts` left from the Flutter template, and Gradle itself
 *    uses the Groovy file. Falling through on an unresolved value would answer
 *    from the file the build ignores — observed live, returning a template
 *    `com.example.<name>` for a project whose real id came from a property.
 *
 * Returning `undefined` is the right degradation: callers fall back to "app id
 * not configured" and the user sets it explicitly, rather than acting on a
 * plausible-looking wrong id.
 */
function applicationIdFromGradle(appDir: string): string | undefined {
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const text = readText(path.join(appDir, "android", "app", name));
    if (!text) continue;
    // Matches both Groovy `applicationId "x"` and Kotlin `applicationId = "x"`.
    const matches = [
      ...text.matchAll(/applicationId\s*=?\s*["']([^"']+)["']/g),
    ];
    if (matches.length === 0) continue; // no declaration here; try the next file
    for (const m of matches) {
      const value = m[1].trim();
      if (value.length > 0 && !value.includes("$")) return value;
    }
    // This file OWNS the declaration but every value is an interpolation we
    // cannot resolve. Stop here rather than answering from a different file.
    return undefined;
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
