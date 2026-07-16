import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliAdapter, CodexCliAdapter } from "../src/adapters.js";

describe("coding-agent CLI adapters", () => {
  let directory: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "adl-adapter-test-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  it("parses a Codex JSONL agent message without calling a real model", async () => {
    const executable = path.join(directory, "codex");
    await writeFile(
      executable,
      "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"stub codex result\"}}'\n",
      "utf8"
    );
    await chmod(executable, 0o755);
    const result = await new CodexCliAdapter().execute({
      task: {
        goal: "inspect the fixture",
        sender: "test",
        requestedPermissions: ["read"],
        constraints: [],
        acceptanceCriteria: []
      },
      cwd: directory,
      permissions: ["read"],
      onProgress: () => undefined
    });
    expect(result.summary).toBe("stub codex result");
  });

  it("parses a Claude stream result without calling a real model", async () => {
    const executable = path.join(directory, "claude");
    await writeFile(
      executable,
      "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"stub claude result\"}'\n",
      "utf8"
    );
    await chmod(executable, 0o755);
    const result = await new ClaudeCliAdapter().execute({
      task: {
        goal: "inspect the fixture",
        sender: "test",
        requestedPermissions: ["read"],
        constraints: [],
        acceptanceCriteria: []
      },
      cwd: directory,
      permissions: ["read"],
      onProgress: () => undefined
    });
    expect(result.summary).toBe("stub claude result");
  });
});
