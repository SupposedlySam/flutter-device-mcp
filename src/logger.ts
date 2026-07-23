/**
 * File-based winston logger with an OS-appropriate default directory.
 *
 * Logs go outside the working directory by default (macOS
 * `~/Library/Logs/flutter-device-mcp`), can be redirected via env vars, or
 * disabled entirely. When the directory cannot be created, file logging is
 * silently dropped rather than polluting the working directory.
 */
import winston from "winston";
import os from "os";
import path from "path";
import fs from "fs";

const APP_DIR_NAME = "flutter-device-mcp";

function getDefaultLogDirectory(): string {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", APP_DIR_NAME);
  }
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome && xdgStateHome.length > 0) {
    return path.join(xdgStateHome, APP_DIR_NAME);
  }
  return path.join(os.homedir(), ".local", "state", APP_DIR_NAME);
}

export function isTruthyEnv(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const normalized = String(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function getLogFilePath(): string | undefined {
  if (isTruthyEnv(process.env.FLUTTER_DEVICE_LOG_DISABLE)) {
    return undefined;
  }

  const explicitFile = process.env.FLUTTER_DEVICE_LOG_FILE;
  if (explicitFile && explicitFile.trim().length > 0) {
    return explicitFile;
  }

  const baseDir =
    process.env.FLUTTER_DEVICE_LOG_DIR &&
    process.env.FLUTTER_DEVICE_LOG_DIR.trim().length > 0
      ? process.env.FLUTTER_DEVICE_LOG_DIR
      : getDefaultLogDirectory();

  let effectiveDir = baseDir;
  if (isTruthyEnv(process.env.FLUTTER_DEVICE_LOG_PER_CWD)) {
    const sanitizedCwd = process
      .cwd()
      .replace(/[\\/]/g, "_")
      .replace(/[:*?"<>|]/g, "");
    effectiveDir = path.join(baseDir, sanitizedCwd);
  }

  try {
    fs.mkdirSync(effectiveDir, { recursive: true });
  } catch {
    return undefined; // If we cannot create the directory, disable file logging.
  }

  return path.join(effectiveDir, "flutter-device.log");
}

const resolvedLogFile = getLogFilePath();

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: resolvedLogFile
    ? [new winston.transports.File({ filename: resolvedLogFile })]
    : [],
});
