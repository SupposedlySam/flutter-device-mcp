/**
 * Generic shell-command + flutter-invocation helpers.
 *
 * Everything runs through the login shell so tools like `flutter`, `sdb`, and
 * any platform SDK CLI resolve from the same PATH a developer has. Output is
 * captured (never inherited) so tool responses can return it.
 *
 * These helpers are platform-neutral shell plumbing: run a command
 * ({@link runShell}), shell-quote an argument ({@link quote}), resolve the right
 * `flutter` invocation for an app dir ({@link resolveFlutterCommand}), and tail
 * output ({@link tail}). Platform-specific commands are composed by each adapter.
 */
import { spawn } from "child_process";
import { CommandResult } from "./types.js";

export type { CommandResult } from "./types.js";

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Kill the command after this many ms (default: no timeout). */
  timeoutMs?: number;
  /**
   * Extra environment variables MERGED over the inherited `process.env` (never
   * replacing it), so PATH and everything a developer relies on is preserved.
   * Used to run `pod install` with a UTF-8 locale (LANG/LC_ALL=en_US.UTF-8) to
   * dodge the Ruby-4.0 homebrew CocoaPods `Encoding::CompatibilityError` crash.
   */
  env?: Record<string, string>;
}

/**
 * Run a shell command string, capturing stdout/stderr. Resolves (never
 * rejects) with a {@link CommandResult}; callers inspect `success`/`code`.
 */
export function runShell(
  command: string,
  options: RunOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      // The dev's login shell if set, else POSIX sh — the command strings are
      // sh-compatible (`cd … && <tool> …` with quote()-escaped args, no
      // zsh-isms), so this works on macOS and Linux dev hosts alike.
      shell: process.env.SHELL ?? "/bin/sh",
      cwd: options.cwd,
      // Merge any caller-supplied overrides over the inherited environment so
      // PATH etc. are preserved; only the given keys (e.g. LANG/LC_ALL) change.
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let combined = "";
    let timedOut = false;

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      combined += text;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      combined += text;
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        combined,
        success: code === 0,
        timedOut,
      });
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      stderr += message;
      combined += message;
      resolve({
        code: null,
        stdout,
        stderr,
        combined,
        success: false,
        timedOut,
      });
    });
  });
}

/** Shell-quote a single argument for safe interpolation. */
export function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the `flutter` invocation to use for an app directory.
 *
 * An fvm-managed app pins Flutter via `.fvmrc` (+ `.fvm/flutter_sdk`). A bare
 * `flutter` on the login-shell PATH is a DIFFERENT SDK/config than the app's
 * pinned one — verified on-device: bare `flutter run`'s device list omitted a
 * connected iPhone that `fvm flutter devices` DID show, so a bare `flutter`
 * could not see or target the device. When the app dir is fvm-managed and `fvm`
 * is available, prefer `fvm flutter` so device discovery and `flutter run -d`
 * match the app's pinned SDK.
 *
 * Pure over the two inputs (is the dir fvm-managed, is fvm on PATH) so it is
 * unit-testable; the adapter supplies those from the filesystem/env once.
 */
export function resolveFlutterCommand(opts: {
  fvmManaged: boolean;
  fvmAvailable: boolean;
}): string {
  return opts.fvmManaged && opts.fvmAvailable ? "fvm flutter" : "flutter";
}

/** Return the last `maxLines` lines of `text` (for log tails in responses). */
export function tail(text: string, maxLines = 120): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}
