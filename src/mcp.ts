import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { getTask, submitTask, waitForTask } from "./invoke.js";
import { permissionSchema } from "./protocol.js";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "agent-delegation-link", version: "0.3.0-alpha.1" });
  server.registerTool(
    "delegate_task",
    {
      description: "Send a scoped coding task to another user's Codex or Claude Code through an ADL invitation link.",
      inputSchema: {
        invitation_url: z.string().url().describe("The complete ADL invitation URL, including its #secret fragment"),
        goal: z.string().min(1).max(20_000),
        sender: z.string().min(1).max(100).default("mcp-agent"),
        requested_permissions: z.array(permissionSchema).min(1).default(["read"]),
        constraints: z.array(z.string().min(1).max(2_000)).max(50).default([]),
        acceptance_criteria: z.array(z.string().min(1).max(2_000)).max(50).default([]),
        wait: z.boolean().default(true),
        timeout_seconds: z.number().int().min(1).max(3_600).default(600)
      }
    },
    async (input) => {
      try {
        const submitted = await submitTask(input.invitation_url, {
          goal: input.goal,
          sender: input.sender,
          requestedPermissions: input.requested_permissions,
          constraints: input.constraints,
          acceptanceCriteria: input.acceptance_criteria
        });
        if (!input.wait) return toolResult(submitted);
        const task = await waitForTask(input.invitation_url, submitted.taskId, {
          timeoutMs: input.timeout_seconds * 1_000
        });
        return toolResult(task);
      } catch (error) {
        return toolError(error);
      }
    }
  );
  server.registerTool(
    "get_task",
    {
      description: "Read and decrypt the latest state of a previously delegated ADL task.",
      inputSchema: {
        invitation_url: z.string().url(),
        task_id: z.string().uuid()
      }
    },
    async ({ invitation_url, task_id }) => {
      try {
        return toolResult(await getTask(invitation_url, task_id));
      } catch (error) {
        return toolError(error);
      }
    }
  );
  return server;
}

export async function startMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
