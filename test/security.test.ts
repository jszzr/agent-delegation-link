import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, type AgentAdapter } from "../src/adapters.js";
import { AuditLog, verifyAuditLog } from "../src/audit.js";
import { createSecret } from "../src/capability.js";
import { decryptJson, deriveEncryptionKey, encryptJson } from "../src/crypto.js";
import { DelegationGateway } from "../src/gateway.js";
import { submitTask, waitForTask } from "../src/invoke.js";
import { runProcess } from "../src/process.js";
import { RelayServer } from "../src/relay.js";

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function fixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "adl-security-repo-"));
  cleanup.push(repo);
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "ADL Test"]);
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await exec("git", ["-C", repo, "add", "README.md"]);
  await exec("git", ["-C", repo, "commit", "-qm", "fixture"]);
  return repo;
}

describe("security boundaries", () => {
  it("detects encrypted-envelope tampering", () => {
    const key = deriveEncryptionKey(createSecret(), "0198a883-a515-7660-b999-d137ae97c99d");
    const encrypted = encryptJson({ secret: "task text" }, key, "bound-context");
    expect(decryptJson(encrypted, key, "bound-context")).toEqual({ secret: "task text" });
    const replacement = encrypted.ciphertext.startsWith("A") ? "B" : "A";
    const tampered = { ...encrypted, ciphertext: `${replacement}${encrypted.ciphertext.slice(1)}` };
    expect(() => decryptJson(tampered, key, "bound-context")).toThrow();
    expect(() => decryptJson(encrypted, key, "wrong-context")).toThrow();
  });

  it("terminates overlong processes and marks truncated output", async () => {
    const startedAt = Date.now();
    const timed = await runProcess("/bin/sh", ["-c", `"${process.execPath}" -e 'setTimeout(() => {}, 5000)'`], {
      cwd: process.cwd(),
      timeoutMs: 50
    });
    expect(timed.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const large = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], {
      cwd: process.cwd(),
      maxOutputBytes: 100
    });
    expect(large.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(large.stdout)).toBeLessThanOrEqual(100);
  });

  it("detects audit-log modification", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-audit-"));
    cleanup.push(directory);
    const file = path.join(directory, "audit.jsonl");
    const audit = new AuditLog(file);
    await audit.append("task.received", { goalHash: "abc" }, "0198a883-a515-7660-b999-d137ae97c99d");
    await audit.append("task.completed", { patchHash: "def" }, "0198a883-a515-7660-b999-d137ae97c99d");
    expect(await verifyAuditLog(file)).toEqual({ valid: true, records: 2 });
    const content = await readFile(file, "utf8");
    await writeFile(file, content.replace("abc", "attacker"), "utf8");
    expect((await verifyAuditLog(file)).valid).toBe(false);
    await writeFile(file, "not-json\n", "utf8");
    expect((await verifyAuditLog(file)).valid).toBe(false);
  });

  it("denies execution when explicit owner approval is refused", async () => {
    const repo = await fixtureRepo();
    const relay = new RelayServer();
    const { origin } = await relay.start();
    let executions = 0;
    const adapter: AgentAdapter = {
      name: "counting",
      async execute() {
        executions += 1;
        return { summary: "should not run" };
      }
    };
    const gateway = new DelegationGateway({
      relayOrigin: origin,
      repoPath: repo,
      adapter,
      approveTask: () => false,
      policy: {
        label: "approval-test",
        agent: "fake",
        permissions: ["read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "ask_every_time",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    });
    try {
      const invitation = (await gateway.start()).invitationUrl;
      const submitted = await submitTask(invitation, {
        goal: "please run",
        sender: "untrusted",
        requestedPermissions: ["read"],
        constraints: [],
        acceptanceCriteria: []
      });
      const task = await waitForTask(invitation, submitted.taskId, { timeoutMs: 5_000, pollMs: 20 });
      expect(task.status).toBe("failed");
      expect(task.error).toContain("denied");
      expect(executions).toBe(0);
    } finally {
      await gateway.stop();
      await relay.stop();
    }
  });

  it("fails safely when a generated patch exceeds its grant limit", async () => {
    const repo = await fixtureRepo();
    const relay = new RelayServer();
    const { origin } = await relay.start();
    const adapter: AgentAdapter = {
      name: "large-patch",
      async execute(context) {
        await writeFile(path.join(context.cwd, "large.txt"), "x".repeat(10_000), "utf8");
        return { summary: "large patch" };
      }
    };
    const gateway = new DelegationGateway({
      relayOrigin: origin,
      repoPath: repo,
      adapter,
      policy: {
        label: "artifact-test",
        agent: "fake",
        permissions: ["read", "edit"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_024
      }
    });
    try {
      const invitation = (await gateway.start()).invitationUrl;
      const submitted = await submitTask(invitation, {
        goal: "make a large file",
        sender: "test",
        requestedPermissions: ["read", "edit"],
        constraints: [],
        acceptanceCriteria: []
      });
      const task = await waitForTask(invitation, submitted.taskId, { timeoutMs: 5_000, pollMs: 20 });
      expect(task.status).toBe("failed");
      expect(task.error).toContain("artifact limit");
    } finally {
      await gateway.stop();
      await relay.stop();
    }
  });

  it("fails edit tasks when the agent returns no changes", async () => {
    const repo = await fixtureRepo();
    const relay = new RelayServer();
    const { origin } = await relay.start();
    const adapter: AgentAdapter = {
      name: "no-op",
      async execute() {
        return { summary: "unable to make the requested change" };
      }
    };
    const gateway = new DelegationGateway({
      relayOrigin: origin,
      repoPath: repo,
      adapter,
      policy: {
        label: "no-op-test",
        agent: "fake",
        permissions: ["read", "edit"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    });
    try {
      const invitation = (await gateway.start()).invitationUrl;
      const submitted = await submitTask(invitation, {
        goal: "make a required edit",
        sender: "test",
        requestedPermissions: ["read", "edit"],
        constraints: [],
        acceptanceCriteria: []
      });
      const task = await waitForTask(invitation, submitted.taskId, { timeoutMs: 5_000, pollMs: 20 });
      expect(task.status).toBe("failed");
      expect(task.error).toContain("no changes");
    } finally {
      await gateway.stop();
      await relay.stop();
    }
  });

  it("fails tasks when an owner validation command exits nonzero", async () => {
    const repo = await fixtureRepo();
    const relay = new RelayServer();
    const { origin } = await relay.start();
    const gateway = new DelegationGateway({
      relayOrigin: origin,
      repoPath: repo,
      adapter: new FakeAdapter(),
      validationCommands: ["exit 7"],
      policy: {
        label: "validation-failure-test",
        agent: "fake",
        permissions: ["read", "edit", "test"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    });
    try {
      const invitation = (await gateway.start()).invitationUrl;
      const submitted = await submitTask(invitation, {
        goal: "produce a patch that fails validation",
        sender: "test",
        requestedPermissions: ["read", "edit", "test"],
        constraints: [],
        acceptanceCriteria: []
      });
      const task = await waitForTask(invitation, submitted.taskId, { timeoutMs: 5_000, pollMs: 20 });
      expect(task.status).toBe("failed");
      expect(task.error).toContain("Owner validation failed with exit code 7");
    } finally {
      await gateway.stop();
      await relay.stop();
    }
  });

  it("rate limits repeated requests from one source", async () => {
    const relay = new RelayServer();
    const { origin } = await relay.start({ maxRequestsPerMinute: 2 });
    try {
      expect((await fetch(new URL("/health", origin))).status).toBe(200);
      expect((await fetch(new URL("/health", origin))).status).toBe(200);
      expect((await fetch(new URL("/health", origin))).status).toBe(429);
    } finally {
      await relay.stop();
    }
  });

  it("can require an operator token before accepting new grants", async () => {
    const repo = await fixtureRepo();
    const relay = new RelayServer();
    const { origin } = await relay.start({ registrationToken: "operator-secret" });
    const gateway = new DelegationGateway({
      relayOrigin: origin,
      relayRegistrationToken: "operator-secret",
      repoPath: repo,
      adapter: new FakeAdapter(),
      policy: {
        label: "registered-owner",
        agent: "fake",
        permissions: ["read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    });
    try {
      const response = await fetch(new URL("/v1/grants", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("registration_required");
      await expect(gateway.start()).resolves.toHaveProperty("invitationUrl");
    } finally {
      await gateway.stop();
      await relay.stop();
    }
  });
});
