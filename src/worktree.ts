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
    const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath });
    if (rootResult.exitCode !== 0) throw new Error("Delegated repository must be a Git repository");
    const repoRoot = rootResult.stdout.trim();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "adl-"));
    const directory = path.join(tempRoot, "workspace");
    const addResult = await runProcess("git", ["worktree", "add", "--detach", directory, "HEAD"], { cwd: repoRoot });
    if (addResult.exitCode !== 0) {
      await rm(tempRoot, { recursive: true, force: true });
      throw new Error(`Unable to create temporary worktree: ${addResult.stderr}`);
    }
    return new TemporaryWorktree(repoRoot, directory, tempRoot);
  }

  async collect(validationCommands: string[]): Promise<WorktreeOutcome> {
    const validations: ValidationResult[] = [];
    for (const command of validationCommands) {
      const result = await runProcess("/bin/sh", ["-lc", command], {
        cwd: this.directory,
        maxOutputBytes: 200_000
      });
      validations.push({
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    const intentResult = await runProcess("git", ["add", "--intent-to-add", "--", "."], {
      cwd: this.directory
    });
    if (intentResult.exitCode !== 0) {
      throw new Error(`Unable to prepare untracked files for patch capture: ${intentResult.stderr}`);
    }
    const patchResult = await runProcess("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], {
      cwd: this.directory,
      maxOutputBytes: 5_000_000
    });
    const statusResult = await runProcess("git", ["status", "--short"], { cwd: this.directory });
    const changedFiles = statusResult.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    return { patch: patchResult.stdout, changedFiles, validations };
  }

  async dispose(): Promise<void> {
    await runProcess("git", ["worktree", "remove", "--force", this.directory], { cwd: this.repoRoot });
    await runProcess("git", ["worktree", "prune"], { cwd: this.repoRoot });
    await rm(this.tempRoot, { recursive: true, force: true });
  }
}
