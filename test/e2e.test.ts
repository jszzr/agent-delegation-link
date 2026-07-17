import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/adapters.js";
import { parseInvitationUrl } from "../src/capability.js";
import { deriveRelayCredential } from "../src/crypto.js";
import { DelegationGateway } from "../src/gateway.js";
import { submitTask, waitForTask } from "../src/invoke.js";
import { RelayServer } from "../src/relay.js";
import type { TaskRequest } from "../src/protocol.js";

const exec = promisify(execFile);

describe("local end-to-end delegation", () => {
  let relay: RelayServer;
  let gateway: DelegationGateway;
  let invitationUrl: string;
  let grantId: string;
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "adl-test-repo-"));
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "ADL Test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
    await exec("git", ["-C", repo, "add", "README.md"]);
    await exec("git", ["-C", repo, "commit", "-qm", "fixture"]);

    relay = new RelayServer();
    const { origin } = await relay.start();
    gateway = new DelegationGateway({
      relayOrigin: origin,
      repoPath: repo,
      adapter: new FakeAdapter(),
      policy: {
        label: "e2e-test",
        agent: "fake",
        permissions: ["read", "edit", "test"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      },
      validationCommands: ["test -f delegated-result.txt"]
    });
    ({ invitationUrl, grantId } = await gateway.start());
  });

  afterEach(async () => {
    await gateway.stop();
    await relay.stop();
    await rm(repo, { recursive: true, force: true });
  });

  it("executes in an isolated worktree and returns patch evidence", async () => {
    const { taskId } = await submitTask(invitationUrl, {
      goal: "prove delegation",
      sender: "test-codex",
      requestedPermissions: ["read", "edit", "test"],
      constraints: [],
      acceptanceCriteria: ["return a patch"]
    });
    const task = await waitForTask(invitationUrl, taskId, { timeoutMs: 10_000, pollMs: 25 });
    expect(task.status).toBe("completed");
    expect(task.result?.executionMode).toBe("worktree");
    expect(task.result?.changedFiles).toContain("delegated-result.txt");
    expect(task.result?.patch).toContain("prove delegation");
    expect(task.result?.validations[0]?.exitCode).toBe(0);
    await expect(import("node:fs/promises").then(({ access }) => access(path.join(repo, "delegated-result.txt")))).rejects.toThrow();

    const invitation = parseInvitationUrl(invitationUrl);
    const raw = await fetch(new URL(`/v1/tasks/${taskId}`, invitation.relayOrigin), {
      headers: { authorization: `Bearer ${deriveRelayCredential(invitation.secret, invitation.grantId)}` }
    }).then((response) => response.text());
    expect(raw).not.toContain("prove delegation");
    expect(raw).not.toContain("delegated-result.txt");
  });

  it("enforces one use per link", async () => {
    await submitTask(invitationUrl, {
      goal: "first",
      sender: "test",
      requestedPermissions: ["read"],
      constraints: [],
      acceptanceCriteria: []
    });
    await expect(
      submitTask(invitationUrl, {
        goal: "second",
        sender: "test",
        requestedPermissions: ["read"],
        constraints: [],
        acceptanceCriteria: []
      })
    ).rejects.toThrow("task limit");
  });

  it("deduplicates retries with the same client request ID", async () => {
    const clientRequestId = randomUUID();
    const request: TaskRequest = {
      goal: "idempotent task",
      sender: "test",
      requestedPermissions: ["read"],
      constraints: [],
      acceptanceCriteria: []
    };
    const first = await submitTask(invitationUrl, request, { clientRequestId });
    const second = await submitTask(invitationUrl, request, { clientRequestId });
    expect(second.taskId).toBe(first.taskId);
    expect(second.deduplicated).toBe(true);
    expect((await waitForTask(invitationUrl, first.taskId, { timeoutMs: 10_000, pollMs: 25 })).status).toBe("completed");
  });

  it("queues encrypted work across a gateway disconnect and reconnect", async () => {
    expect(relay.dropGatewayConnection(grantId)).toBe(true);
    const submitted = await submitTask(invitationUrl, {
      goal: "survive reconnect",
      sender: "test",
      requestedPermissions: ["read"],
      constraints: [],
      acceptanceCriteria: []
    });
    const task = await waitForTask(invitationUrl, submitted.taskId, { timeoutMs: 10_000, pollMs: 25 });
    expect(task.status).toBe("completed");
    expect(task.result?.summary).toContain("survive reconnect");
  });
});
