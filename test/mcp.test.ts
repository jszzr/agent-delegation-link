import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/adapters.js";
import { DelegationGateway } from "../src/gateway.js";
import { createMcpServer } from "../src/mcp.js";
import { RelayServer } from "../src/relay.js";

const exec = promisify(execFile);

describe("MCP integration", () => {
  let relay: RelayServer;
  let gateway: DelegationGateway;
  let invitationUrl: string;
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "adl-mcp-repo-"));
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
        label: "mcp-test",
        agent: "fake",
        permissions: ["read", "edit"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    });
    invitationUrl = (await gateway.start()).invitationUrl;
  });

  afterEach(async () => {
    await gateway.stop();
    await relay.stop();
    await rm(repo, { recursive: true, force: true });
  });

  it("delegates through a real MCP client/server exchange", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["delegate_task", "get_task"]));
      const result = await client.callTool({
        name: "delegate_task",
        arguments: {
          invitation_url: invitationUrl,
          goal: "delegate through MCP",
          sender: "test-agent",
          requested_permissions: ["read", "edit"],
          wait: true,
          timeout_seconds: 10
        }
      });
      expect(result.isError).not.toBe(true);
      const content = (result as { content: Array<{ type: string; text?: string }> }).content;
      const text = content.find((item) => item.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("delegated-result.txt");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
