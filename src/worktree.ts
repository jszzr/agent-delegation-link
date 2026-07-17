import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.js";
import type { ValidationResult } from "./protocol.js";

export interface WorktreeOutcome {
  patch: string;
  changedFiles: string[];
  validations: ValidationResult[];
}

export class TemporaryWorktree {
  private constructor(
    readonly repoRoot: string,
    readonly directory: string,
    private readonly tempRoot: string
  ) {}

  static async create(repoPath: string): Promise<TemporaryWorktree> {
    const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath, timeoutMs: 15_000 });
    if (rootResult.exitCode !== 0) throw new Error("Delegated repository must be a Git repository");
    const repoRoot = rootResult.stdout.trim();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "adl-"));
    const directory = path.join(tempRoot, "workspace");
    const addResult = await runProcess("git", ["worktree", "add", "--detach", directory, "HEAD"], {
      cwd: repoRoot,
      timeoutMs: 30_000
    });
    if (addResult.exitCode !== 0) {
      await rm(tempRoot, { recursive: true, force: true });
      throw new Error(`Unable to create temporary worktree: ${addResult.stderr}`);
    }
    return new TemporaryWorktree(repoRoot, directory, tempRoot);
  }

  async collect(
    validationCommands: string[],
    options: { maxArtifactBytes: number; deadline: number }
  ): Promise<WorktreeOutcome> {
    const validations: ValidationResult[] = [];
    for (const command of validationCommands) {
      const remaining = options.deadline - Date.now();
      if (remaining <= 0) throw new Error("Task timed out before validation completed");
      const result = await runProcess("/bin/sh", ["-lc", command], {
        cwd: this.directory,
        maxOutputBytes: 50_000,
        timeoutMs: remaining
      });
      const validation = {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        outputTruncated: result.stdoutTruncated || result.stderrTruncated
      };
      validations.push(validation);
      if (result.timedOut) throw new Error(`Validation timed out: ${command}`);
      if (result.exitCode !== 0) {
        throw new Error(`Owner validation failed with exit code ${result.exitCode}: ${command}`);
      }
    }
    const intentResult = await runProcess("git", ["add", "--intent-to-add", "--", "."], {
      cwd: this.directory,
      timeoutMs: Math.max(1, options.deadline - Date.now())
    });
    if (intentResult.exitCode !== 0) {
      throw new Error(`Unable to prepare untracked files for patch capture: ${intentResult.stderr}`);
    }
    const patchResult = await runProcess("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], {
      cwd: this.directory,
      maxOutputBytes: options.maxArtifactBytes,
      timeoutMs: Math.max(1, options.deadline - Date.now())
    });
    if (patchResult.timedOut) throw new Error("Task timed out while capturing the patch");
    if (patchResult.stdoutTruncated) {
      throw new Error(`Generated patch exceeds the ${options.maxArtifactBytes} byte artifact limit`);
    }
    const statusResult = await runProcess("git", ["status", "--short"], {
      cwd: this.directory,
      maxOutputBytes: 1_000_000,
      timeoutMs: Math.max(1, options.deadline - Date.now())
    });
    if (statusResult.stdoutTruncated) throw new Error("Changed-file list exceeds the safety limit");
    const changedFiles = statusResult.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    return { patch: patchResult.stdout, changedFiles, validations };
  }

  async dispose(): Promise<void> {
    await runProcess("git", ["worktree", "remove", "--force", this.directory], {
      cwd: this.repoRoot,
      timeoutMs: 30_000
    });
    await runProcess("git", ["worktree", "prune"], { cwd: this.repoRoot, timeoutMs: 15_000 });
    await rm(this.tempRoot, { recursive: true, force: true });
  }
}
