import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, opendir, readlink, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.js";
import type { ValidationResult } from "./protocol.js";

export interface WorktreeOutcome {
  patch: string;
  changedFiles: string[];
  validations: ValidationResult[];
}

export type ExecutionMode = "worktree" | "direct";

export interface ExecutionWorkspace {
  readonly directory: string;
  collect(validationCommands: string[], options: { maxArtifactBytes: number; deadline: number }): Promise<WorktreeOutcome>;
  dispose(): Promise<void>;
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
    const validations = await runValidations(this.directory, validationCommands, options.deadline);
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

const SNAPSHOT_MAX_FILES = 50_000;
const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_IGNORED_DIRECTORIES = new Set([".git", ".adl", "node_modules"]);

type WorkspaceSnapshot = Map<string, string>;

export class DirectWorkspace implements ExecutionWorkspace {
  private constructor(readonly directory: string, private readonly baseline: WorkspaceSnapshot) {}

  static async create(directory: string, deadline = Number.POSITIVE_INFINITY): Promise<DirectWorkspace> {
    const resolved = await realpath(directory);
    const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error(`Delegated path is not a directory: ${resolved}`);
    return new DirectWorkspace(resolved, await snapshotWorkspace(resolved, deadline));
  }

  async collect(
    validationCommands: string[],
    options: { maxArtifactBytes: number; deadline: number }
  ): Promise<WorktreeOutcome> {
    const validations = await runValidations(this.directory, validationCommands, options.deadline);
    if (Date.now() >= options.deadline) throw new Error("Task timed out before direct-workspace inspection completed");
    const current = await snapshotWorkspace(this.directory, options.deadline);
    const changedFiles = [...new Set([...this.baseline.keys(), ...current.keys()])]
      .filter((entry) => this.baseline.get(entry) !== current.get(entry))
      .sort();
    if (changedFiles.length > 10_000) throw new Error("Changed-file list exceeds the safety limit");
    return { patch: "", changedFiles, validations };
  }

  async dispose(): Promise<void> {
    // Direct mode intentionally keeps edits in the owner's selected directory.
  }
}

async function runValidations(directory: string, commands: string[], deadline: number): Promise<ValidationResult[]> {
  const validations: ValidationResult[] = [];
  for (const command of commands) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Task timed out before validation completed");
    const result = await runProcess("/bin/sh", ["-lc", command], {
      cwd: directory,
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
  return validations;
}

async function snapshotWorkspace(root: string, deadline = Number.POSITIVE_INFINITY): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  let fileCount = 0;
  let byteCount = 0;

  async function visit(directory: string): Promise<void> {
    if (Date.now() >= deadline) throw new Error("Task timed out while inspecting the direct workspace");
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (Date.now() >= deadline) throw new Error("Task timed out while inspecting the direct workspace");
      if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      let details;
      try {
        details = await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (details.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!details.isFile() && !details.isSymbolicLink()) continue;
      fileCount += 1;
      if (fileCount > SNAPSHOT_MAX_FILES) {
        throw new Error(`Direct workspace exceeds the ${SNAPSHOT_MAX_FILES} file inspection limit`);
      }
      if (details.isSymbolicLink()) {
        snapshot.set(relative, `symlink:${await readlink(absolute)}`);
        continue;
      }
      byteCount += details.size;
      if (byteCount > SNAPSHOT_MAX_BYTES) {
        throw new Error(`Direct workspace exceeds the ${SNAPSHOT_MAX_BYTES} byte inspection limit`);
      }
      snapshot.set(relative, `file:${details.size}:${await hashFile(absolute)}`);
    }
  }

  await visit(root);
  return snapshot;
}

async function hashFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  return await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}
