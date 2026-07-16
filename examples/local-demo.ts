import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FakeAdapter } from "../src/adapters.js";
import { DelegationGateway } from "../src/gateway.js";
import { submitTask, waitForTask } from "../src/invoke.js";
import { RelayServer } from "../src/relay.js";

const exec = promisify(execFile);
const repo = await mkdtemp(path.join(os.tmpdir(), "adl-demo-repo-"));
await exec("git", ["init", "-q", repo]);
await exec("git", ["-C", repo, "config", "user.email", "demo@example.com"]);
await exec("git", ["-C", repo, "config", "user.name", "ADL Demo"]);
await writeFile(path.join(repo, "README.md"), "# Demo repository\n", "utf8");
await exec("git", ["-C", repo, "add", "README.md"]);
await exec("git", ["-C", repo, "commit", "-qm", "Initial demo repository"]);

const relay = new RelayServer();
const { origin } = await relay.start();
const gateway = new DelegationGateway({
  relayOrigin: origin,
  repoPath: repo,
  adapter: new FakeAdapter(),
  policy: {
    label: "local-demo",
    agent: "fake",
    permissions: ["read", "edit"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxTasks: 1,
    approval: "auto_within_scope"
  },
  onLog: (message) => console.error(`[demo gateway] ${message}`)
});

try {
  const { invitationUrl } = await gateway.start();
  console.log(`Invitation: ${invitationUrl}`);
  const { taskId } = await submitTask(invitationUrl, {
    goal: "Create a delegated result proving that the cross-agent loop works",
    sender: "demo-codex",
    requestedPermissions: ["read", "edit"],
    constraints: ["Do not modify README.md"],
    acceptanceCriteria: ["Return a Git patch"]
  });
  const task = await waitForTask(invitationUrl, taskId, {
    timeoutMs: 10_000,
    onProgress: (message) => console.error(`[demo progress] ${message}`)
  });
  console.log(JSON.stringify(task.result, null, 2));
  if (task.status !== "completed" || !task.result?.patch.includes("delegated-result.txt")) {
    throw new Error("Demo did not produce the expected delegated patch");
  }
  console.log("Local end-to-end demo passed.");
} finally {
  await gateway.stop();
  await relay.stop();
  await rm(repo, { recursive: true, force: true });
}
