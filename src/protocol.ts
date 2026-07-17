import { z } from "zod";

export const permissionSchema = z.enum(["read", "edit", "test"]);
export type Permission = z.infer<typeof permissionSchema>;

export const agentKindSchema = z.enum(["codex", "claude", "fake"]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const grantPolicySchema = z.object({
  label: z.string().trim().min(1).max(100),
  agent: agentKindSchema,
  permissions: z.array(permissionSchema).min(1).max(3),
  expiresAt: z.string().datetime(),
  maxTasks: z.number().int().min(1).max(100),
  approval: z.enum(["auto_within_scope", "ask_every_time"]).default("ask_every_time"),
  maxTaskDurationSeconds: z.number().int().min(10).max(3_600).default(600),
  maxArtifactBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000)
});
export type GrantPolicy = z.infer<typeof grantPolicySchema>;

export const createGrantRequestSchema = z.object({
  grantId: z.string().uuid(),
  relayCredentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: grantPolicySchema
});
export type CreateGrantRequest = z.infer<typeof createGrantRequestSchema>;

export const createGrantResponseSchema = z.object({
  grantId: z.string().uuid(),
  ownerToken: z.string().min(32).max(200)
});

export const taskRequestSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  sender: z.string().trim().min(1).max(100).default("remote-agent"),
  requestedPermissions: z.array(permissionSchema).min(1).max(3),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(50).default([])
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const validationResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean().default(false),
  outputTruncated: z.boolean().default(false)
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const taskResultSchema = z.object({
  summary: z.string().max(100_000),
  patch: z.string(),
  changedFiles: z.array(z.string()).max(10_000),
  validations: z.array(validationResultSchema).max(100),
  rawOutput: z.string().max(100_000).optional(),
  artifactTruncated: z.boolean().default(false)
});
export type TaskResult = z.infer<typeof taskResultSchema>;

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const encryptedEnvelopeSchema = z.object({
  version: z.literal(1),
  iv: base64UrlSchema.length(16),
  ciphertext: base64UrlSchema.min(1).max(28_000_000),
  tag: base64UrlSchema.length(22)
});
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export const taskSubmissionSchema = z.object({
  clientRequestId: z.string().uuid(),
  requestedPermissions: z.array(permissionSchema).min(1).max(3),
  envelope: encryptedEnvelopeSchema
});
export type TaskSubmission = z.infer<typeof taskSubmissionSchema>;

export const taskAcceptedResponseSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  gatewayOnline: z.boolean(),
  deduplicated: z.boolean()
});

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export const relayStoredTaskSchema = z.object({
  id: z.string().uuid(),
  grantId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  requestedPermissions: z.array(permissionSchema).min(1).max(3),
  requestEnvelope: encryptedEnvelopeSchema,
  status: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  gatewayOnlineAtAcceptance: z.boolean(),
  progressEnvelopes: z.array(encryptedEnvelopeSchema).max(100),
  resultEnvelope: encryptedEnvelopeSchema.optional(),
  errorEnvelope: encryptedEnvelopeSchema.optional()
});
export type RelayStoredTask = z.infer<typeof relayStoredTaskSchema>;

export interface StoredTask {
  id: string;
  grantId: string;
  clientRequestId: string;
  request: TaskRequest;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  gatewayOnlineAtAcceptance: boolean;
  progress: string[];
  result?: TaskResult;
  error?: string;
}

export type GatewayInboundEvent =
  | { type: "gateway.ready" }
  | { type: "task.offered"; task: RelayStoredTask };

export const gatewayInboundEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gateway.ready") }),
  z.object({ type: z.literal("task.offered"), task: relayStoredTaskSchema })
]);

export const gatewayOutboundEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.started"), taskId: z.string().uuid() }),
  z.object({ type: z.literal("task.progress"), taskId: z.string().uuid(), envelope: encryptedEnvelopeSchema }),
  z.object({ type: z.literal("task.completed"), taskId: z.string().uuid(), envelope: encryptedEnvelopeSchema }),
  z.object({ type: z.literal("task.failed"), taskId: z.string().uuid(), envelope: encryptedEnvelopeSchema })
]);
export type GatewayOutboundEvent = z.infer<typeof gatewayOutboundEventSchema>;

export interface RelayErrorBody {
  error: string;
  message: string;
}
