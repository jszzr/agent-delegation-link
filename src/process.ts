import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function safeAgentEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "CODEX_HOME",
    "CLAUDE_CONFIG_DIR"
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  );
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    maxOutputBytes?: number;
    timeoutMs?: number;
  }
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timer?.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      options.onStdout?.(chunk);
      const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
      const bytes = Buffer.byteLength(chunk);
      if (remaining > 0) {
        const buffer = Buffer.from(chunk);
        stdout += buffer.subarray(0, remaining).toString("utf8");
      }
      stdoutBytes += bytes;
      if (stdoutBytes > maxOutputBytes) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk: string) => {
      options.onStderr?.(chunk);
      const remaining = Math.max(0, maxOutputBytes - stderrBytes);
      const bytes = Buffer.byteLength(chunk);
      if (remaining > 0) {
        const buffer = Buffer.from(chunk);
        stderr += buffer.subarray(0, remaining).toString("utf8");
      }
      stderrBytes += bytes;
      if (stderrBytes > maxOutputBytes) stderrTruncated = true;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may have exited between the timeout and the signal.
  }
}
