import { z } from "zod";

export const permissionSchema = z.enum(["read", "edit", "test"]);
export type Permission = z.infer<typeof permissionSchema>;

export const agentKindSchema = z.enum(["codex", "claude", "fake"]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const grantPolicySchema = z.object({
  label: z.string().trim().min(1).max(100),
  agent: agentKindSchema,
  permissions: z.array(permissionSchema).min(1),
  expiresAt: z.string().datetime(),
  maxTasks: z.number().int().min(1).max(100),
  approval: z.enum(["auto_within_scope", "ask_every_time"]).default("auto_within_scope")
});
export type GrantPolicy = z.infer<typeof grantPolicySchema>;

export const createGrantRequestSchema = z.object({
  grantId: z.string().uuid(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: grantPolicySchema
});
export type CreateGrantRequest = z.infer<typeof createGrantRequestSchema>;

export const taskRequestSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  sender: z.string().trim().min(1).max(100).default("remote-agent"),
  requestedPermissions: z.array(permissionSchema).min(1),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(50).default([])
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const validationResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string()
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const taskResultSchema = z.object({
  summary: z.string(),
  patch: z.string(),
  changedFiles: z.array(z.string()),
  validations: z.array(validationResultSchema),
  rawOutput: z.string().optional()
});
export type TaskResult = z.infer<typeof taskResultSchema>;

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface StoredTask {
  id: string;
  grantId: string;
  request: TaskRequest;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  progress: string[];
  result?: TaskResult;
  error?: string;
}

export type GatewayInboundEvent =
  | { type: "gateway.ready" }
  | { type: "task.offered"; task: StoredTask };

export type GatewayOutboundEvent =
  | { type: "task.started"; taskId: string }
  | { type: "task.progress"; taskId: string; message: string }
  | { type: "task.completed"; taskId: string; result: TaskResult }
  | { type: "task.failed"; taskId: string; error: string };

export interface RelayErrorBody {
  error: string;
  message: string;
}
