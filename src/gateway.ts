import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket } from "ws";
import type { AgentAdapter } from "./adapters.js";
import { AuditLog, digestAuditValue } from "./audit.js";
import { assertSecureRelayOrigin, createInvitationUrl, createSecret, hashSecret } from "./capability.js";
import { decryptJson, deriveEncryptionKey, deriveRelayCredential, encryptJson, eventAad, requestAad } from "./crypto.js";
import { fetchWithTimeout, readLimitedJson, readLimitedText } from "./http.js";
import {
  createGrantResponseSchema,
  gatewayInboundEventSchema,
  grantPolicySchema,
  taskRequestSchema,
  type GatewayOutboundEvent,
  type GrantPolicy,
  type Permission,
  type RelayStoredTask,
  type TaskRequest,
  type TaskResult
} from "./protocol.js";
import { TemporaryWorktree } from "./worktree.js";

export interface GatewayOptions {
  relayOrigin: string;
  repoPath: string;
  policy: GrantPolicy;
  adapter: AgentAdapter;
  validationCommands?: string[];
  auditFile?: string;
  relayRegistrationToken?: string;
  approveTask?: (task: TaskRequest, context: { taskId: string; policy: GrantPolicy }) => boolean | Promise<boolean>;
  onLog?: (message: string) => void;
}

export class DelegationGateway {
  private websocket: WebSocket | undefined;
  private ownerToken: string | undefined;
  private secret: string | undefined;
  private encryptionKey: Buffer | undefined;
  private grantId: string | undefined;
  private stopped = false;
  private connectedOnce = false;
  private reconnecting: Promise<void> | undefined;
  private executionQueue = Promise.resolve();
  private readonly outboundQueue: GatewayOutboundEvent[] = [];
  private readonly terminalEvents = new Map<string, GatewayOutboundEvent>();
  private readonly seenTaskIds = new Set<string>();
  private readonly seenClientRequestIds = new Set<string>();
  private readonly policy: GrantPolicy;
  private readonly audit: AuditLog;

  constructor(private readonly options: GatewayOptions) {
    this.policy = grantPolicySchema.parse(options.policy);
    if ((options.validationCommands?.length ?? 0) > 20) throw new Error("At most 20 owner validation commands are allowed");
    if (options.validationCommands?.some((command) => command.length > 2_000)) {
      throw new Error("Owner validation commands must be at most 2000 characters each");
    }
    this.audit = new AuditLog(options.auditFile ?? path.join(options.repoPath, ".adl", "audit.jsonl"));
  }

  async start(): Promise<{ invitationUrl: string; grantId: string }> {
    if (this.grantId) throw new Error("Gateway is already running");
    assertSecureRelayOrigin(this.options.relayOrigin);
    const grantId = randomUUID();
    const secret = createSecret();
    const relayCredential = deriveRelayCredential(secret, grantId);
    const response = await fetchWithTimeout(new URL("/v1/grants", this.options.relayOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.relayRegistrationToken === undefined
          ? {}
          : { "x-adl-relay-token": this.options.relayRegistrationToken })
      },
      body: JSON.stringify({ grantId, relayCredentialHash: hashSecret(relayCredential), policy: this.policy })
    }, 15_000);
    if (!response.ok) throw new Error(`Relay rejected grant: ${response.status} ${await readLimitedText(response, 100_000)}`);
    const body = createGrantResponseSchema.parse(await readLimitedJson(response, 100_000));
    if (body.grantId !== grantId) throw new Error("Relay returned a mismatched grant identifier");
    this.ownerToken = body.ownerToken;
    this.secret = secret;
    this.encryptionKey = deriveEncryptionKey(secret, grantId);
    this.grantId = grantId;
    try {
      await this.openWebSocket();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    if (!await this.recordAudit("grant.created", {
      grantId,
      label: this.policy.label,
      agent: this.policy.agent,
      permissions: this.policy.permissions,
      expiresAt: this.policy.expiresAt,
      maxTasks: this.policy.maxTasks,
      approval: this.policy.approval
    })) {
      await this.stop();
      throw new Error("Unable to initialize the local security audit log");
    }
    return {
      invitationUrl: createInvitationUrl(this.options.relayOrigin, grantId, secret),
      grantId
    };
  }

  async stop(options: { revoke?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (options.revoke !== false && this.grantId && this.ownerToken) {
      await fetchWithTimeout(new URL(`/v1/grants/${this.grantId}`, this.options.relayOrigin), {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.ownerToken}` }
      }, 10_000).catch(() => undefined);
      await this.recordAudit("grant.revoked", { grantId: this.grantId });
    }
    this.websocket?.close(1000, "Gateway stopped");
    await this.executionQueue.catch(() => undefined);
    await this.reconnecting?.catch(() => undefined);
    await this.audit.flush();
  }

  private async openWebSocket(): Promise<void> {
    const url = new URL(`/v1/gateways/${this.grantId}`, this.options.relayOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.ownerToken}` },
        handshakeTimeout: 10_000,
        maxPayload: 30_000_000
      });
      let opened = false;
      const onInitialError = (error: Error) => {
        if (!opened) reject(error);
      };
      this.websocket = websocket;
      websocket.once("open", () => {
        opened = true;
        this.connectedOnce = true;
        websocket.off("error", onInitialError);
        this.flushOutboundQueue();
        resolve();
      });
      websocket.once("error", onInitialError);
      websocket.on("message", (data) => this.handleInbound(data.toString()));
      websocket.on("error", (error) => this.options.onLog?.(`Gateway connection error: ${error.message}`));
      websocket.on("close", () => {
        if (this.websocket === websocket) this.websocket = undefined;
        if (!this.stopped && opened) {
          this.options.onLog?.("Gateway disconnected; reconnecting");
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.stopped || !this.connectedOnce) return;
    this.reconnecting = (async () => {
      let delayMs = 250;
      while (!this.stopped && this.websocket?.readyState !== WebSocket.OPEN) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          await this.openWebSocket();
          this.options.onLog?.("Gateway reconnected");
          return;
        } catch (error) {
          this.options.onLog?.(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
          delayMs = Math.min(delayMs * 2, 5_000);
        }
      }
    })().finally(() => { this.reconnecting = undefined; });
  }

  private handleInbound(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const parsed = gatewayInboundEventSchema.safeParse(decoded);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "gateway.ready") {
      this.options.onLog?.("Gateway is ready");
      return;
    }
    const terminalEvent = this.terminalEvents.get(event.task.id);
    if (terminalEvent) {
      this.send(terminalEvent);
      return;
    }
    if (this.seenTaskIds.has(event.task.id)) return;
    this.seenTaskIds.add(event.task.id);
    if (this.seenClientRequestIds.has(event.task.clientRequestId)) {
      this.executionQueue = this.executionQueue.then(() => this.failTask(event.task.id, "Duplicate client request ID was rejected"));
      return;
    }
    this.seenClientRequestIds.add(event.task.clientRequestId);
    this.executionQueue = this.executionQueue.then(() => this.executeTask(event.task));
  }

  private async executeTask(task: RelayStoredTask): Promise<void> {
    let request: TaskRequest;
    try {
      request = taskRequestSchema.parse(
        decryptJson(task.requestEnvelope, this.encryptionKey!, requestAad(task.grantId, task.clientRequestId))
      );
      if (!samePermissions(request.requestedPermissions, task.requestedPermissions)) {
        throw new Error("Encrypted request permissions do not match relay metadata");
      }
    } catch (error) {
      await this.failTask(task.id, `Unable to authenticate delegated request: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!await this.recordAudit("task.received", {
      sender: request.sender,
      goalHash: digestAuditValue(request.goal),
      requestedPermissions: request.requestedPermissions
    }, task.id)) {
      await this.failTask(task.id, "Local security audit log is unavailable");
      return;
    }
    const allowed = new Set(this.policy.permissions);
    const denied = request.requestedPermissions.find((permission) => !allowed.has(permission));
    if (denied) {
      await this.failTask(task.id, `Local policy denied '${denied}'`);
      return;
    }
    if (this.policy.approval === "ask_every_time") {
      const approved = await this.options.approveTask?.(request, { taskId: task.id, policy: this.policy }) ?? false;
      if (!await this.recordAudit("task.approval", { approved }, task.id)) {
        await this.failTask(task.id, "Local security audit log is unavailable");
        return;
      }
      if (!approved) {
        await this.failTask(task.id, "Task was denied by the repository owner");
        return;
      }
    }
    if (!await this.recordAudit("task.started", { agent: this.policy.agent }, task.id)) {
      await this.failTask(task.id, "Local security audit log is unavailable");
      return;
    }
    this.send({ type: "task.started", taskId: task.id });
    this.options.onLog?.(`Executing delegated task ${task.id}`);
    const deadline = Date.now() + this.policy.maxTaskDurationSeconds * 1_000;
    let worktree: TemporaryWorktree | undefined;
    try {
      worktree = await TemporaryWorktree.create(this.options.repoPath);
      const execution = await this.options.adapter.execute({
        task: request,
        cwd: worktree.directory,
        permissions: request.requestedPermissions,
        timeoutMs: Math.max(1, deadline - Date.now()),
        onProgress: (message) => this.sendProgress(task.id, message)
      });
      if (Date.now() >= deadline) throw new Error("Task exceeded its execution time limit");
      const collected = await worktree.collect(
        request.requestedPermissions.includes("test") ? this.options.validationCommands ?? [] : [],
        { maxArtifactBytes: this.policy.maxArtifactBytes, deadline }
      );
      if (request.requestedPermissions.includes("edit") && collected.changedFiles.length === 0) {
        throw new Error("Agent produced no changes for a task that requested edit capability");
      }
      const result: TaskResult = {
        summary: execution.summary.slice(0, 100_000),
        patch: collected.patch,
        changedFiles: collected.changedFiles,
        validations: collected.validations,
        artifactTruncated: false,
        ...(execution.rawOutput === undefined ? {} : { rawOutput: execution.rawOutput.slice(-100_000) })
      };
      const event: GatewayOutboundEvent = {
        type: "task.completed",
        taskId: task.id,
        envelope: encryptJson(result, this.encryptionKey!, eventAad(task.grantId, task.id, "result"))
      };
      this.terminalEvents.set(task.id, event);
      this.send(event);
      await this.recordAudit("task.completed", {
        changedFiles: result.changedFiles,
        patchHash: digestAuditValue(result.patch),
        patchBytes: Buffer.byteLength(result.patch)
      }, task.id);
      this.options.onLog?.(`Completed delegated task ${task.id}`);
    } catch (error) {
      await this.failTask(task.id, error instanceof Error ? error.message : String(error));
    } finally {
      await worktree?.dispose().catch(() => undefined);
    }
  }

  private sendProgress(taskId: string, message: string): void {
    const grantId = this.grantId!;
    this.send({
      type: "task.progress",
      taskId,
      envelope: encryptJson(message.slice(0, 2_000), this.encryptionKey!, eventAad(grantId, taskId, "progress"))
    });
  }

  private async failTask(taskId: string, message: string): Promise<void> {
    const event: GatewayOutboundEvent = {
      type: "task.failed",
      taskId,
      envelope: encryptJson(message.slice(0, 10_000), this.encryptionKey!, eventAad(this.grantId!, taskId, "error"))
    };
    this.terminalEvents.set(taskId, event);
    this.send(event);
    await this.recordAudit("task.failed", { errorHash: digestAuditValue(message) }, taskId);
    this.options.onLog?.(`Delegated task failed: ${message}`);
  }

  private send(event: GatewayOutboundEvent): void {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(event));
    } else {
      if (event.type === "task.progress" && this.outboundQueue.filter((item) => item.type === "task.progress").length >= 100) {
        return;
      }
      this.outboundQueue.push(event);
    }
  }

  private flushOutboundQueue(): void {
    while (this.websocket?.readyState === WebSocket.OPEN && this.outboundQueue.length > 0) {
      this.websocket.send(JSON.stringify(this.outboundQueue.shift()!));
    }
  }

  private async recordAudit(event: string, details: Record<string, unknown>, taskId?: string): Promise<boolean> {
    try {
      await this.audit.append(event, details, taskId);
      return true;
    } catch (error) {
      this.options.onLog?.(`Audit log failure: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

function samePermissions(left: Permission[], right: Permission[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizePermissions(values: string[]): Permission[] {
  const allowed = new Set<Permission>(["read", "edit", "test"]);
  const result = [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()))];
  for (const permission of result) {
    if (!allowed.has(permission as Permission)) throw new Error(`Unknown permission '${permission}'`);
  }
  if (result.length === 0) throw new Error("At least one permission is required");
  return result as Permission[];
}
