import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/adapters.js";
import { DelegationGateway } from "../src/gateway.js";
import { submitTask, waitForTask } from "../src/invoke.js";
import { RelayServer } from "../src/relay.js";

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("direct execution", () => {
  it("edits an unborn Git repository without requiring HEAD or returning a patch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-direct-"));
    cleanup.push(directory);
    await exec("git", ["init", "-q", directory]);
    await writeFile(path.join(directory, "README.md"), "uncommitted fixture\n", "utf8");
    const relay = new RelayServer();
    const { origin } = await relay.start();
    const gateway = new DelegationGateway({
      relayOrigin: origin,
      repoPath: directory,
      executionMode: "direct",
      adapter: new FakeAdapter(),
      approveTask: () => true,
      policy: {
        label: "direct-test",
        agent: "fake",
        permissions: ["read", "edit"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "ask_every_time",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    });
    try {
      const invitationUrl = (await gateway.start()).invitationUrl;
      const submitted = await submitTask(invitationUrl, {
        goal: "write directly",
        sender: "test",
        requestedPermissions: ["read", "edit"],
        constraints: [],
        acceptanceCriteria: []
      });
      const task = await waitForTask(invitationUrl, submitted.taskId, { timeoutMs: 5_000, pollMs: 20 });
      expect(task.status).toBe("completed");
      expect(task.result?.executionMode).toBe("direct");
      expect(task.result?.patch).toBe("");
      expect(task.result?.changedFiles).toEqual(["delegated-result.txt"]);
      expect(await readFile(path.join(directory, "delegated-result.txt"), "utf8")).toBe("write directly\n");
    } finally {
      await gateway.stop();
      await relay.stop();
    }
  });

  it("refuses direct execution without per-task owner approval", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-direct-policy-"));
    cleanup.push(directory);
    expect(() => new DelegationGateway({
      relayOrigin: "http://127.0.0.1:8787",
      repoPath: directory,
      executionMode: "direct",
      adapter: new FakeAdapter(),
      policy: {
        label: "unsafe-direct-test",
        agent: "fake",
        permissions: ["read", "edit"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    })).toThrow("requires --approval ask_every_time");
  });
});
