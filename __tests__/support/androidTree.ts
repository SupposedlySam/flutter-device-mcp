import fs from "fs";
import os from "os";
import path from "path";

/**
 * An app dir whose Android build produces `packageId`: `appPackage` in
 * gradle.properties, which build.gradle's `applicationId` names, plus an
 * `applicationIdSuffix` for each build type named in `suffixes`
 * (`{ debug: "dev" }` makes the debug build `<packageId>.dev`). The caller
 * removes it with {@link removeAndroidTrees}.
 */
export function androidAppTree(
  packageId: string,
  suffixes: Partial<Record<"debug" | "profile" | "release", string>> = {}
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-tree-"));
  const android = path.join(root, "android");
  fs.mkdirSync(path.join(android, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(android, "gradle.properties"),
    `org.gradle.jvmargs=-Xmx4G\nappPackage = ${packageId}\n`
  );
  const buildType = (name: "debug" | "profile" | "release") => {
    const suffix = suffixes[name];
    if (name === "profile" && suffix === undefined) return "";
    return (
      `        ${name} {\n` +
      (suffix ? `            applicationIdSuffix ".${suffix}"\n` : "") +
      "        }\n"
    );
  };
  fs.writeFileSync(
    path.join(android, "app", "build.gradle"),
    "android {\n    defaultConfig {\n        applicationId project.appPackage\n    }\n    buildTypes {\n" +
      buildType("debug") +
      buildType("profile") +
      buildType("release") +
      "    }\n}\n"
  );
  created.push(root);
  return root;
}

/** An app dir with no Android tree in it, so no package id can be read. */
export function unreadableAndroidTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-no-tree-"));
  created.push(root);
  return root;
}

const created: string[] = [];

export function removeAndroidTrees(): void {
  for (const root of created.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
