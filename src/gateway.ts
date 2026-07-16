import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AgentAdapter } from "./adapters.js";
import { createInvitationUrl, createSecret, hashSecret } from "./capability.js";
import type {
  GatewayInboundEvent,
  GatewayOutboundEvent,
  GrantPolicy,
  Permission,
  StoredTask,
  TaskResult
} from "./protocol.js";
import { TemporaryWorktree } from "./worktree.js";

export interface GatewayOptions {
  relayOrigin: string;
  repoPath: string;
  policy: GrantPolicy;
  adapter: AgentAdapter;
  validationCommands?: string[];
  onLog?: (message: string) => void;
}

export class DelegationGateway {
  private websocket?: WebSocket;
  private ownerToken?: string;
  private secret?: string;
  private grantId?: string;
  private stopped = false;
  private executionQueue = Promise.resolve();

  constructor(private readonly options: GatewayOptions) {}

  async start(): Promise<{ invitationUrl: string; grantId: string }> {
    if (this.websocket) throw new Error("Gateway is already running");
    const grantId = randomUUID();
    const secret = createSecret();
    const response = await fetch(new URL("/v1/grants", this.options.relayOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantId, secretHash: hashSecret(secret), policy: this.options.policy })
    });
    if (!response.ok) throw new Error(`Relay rejected grant: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { ownerToken: string };
    this.ownerToken = body.ownerToken;
    this.secret = secret;
    this.grantId = grantId;
    await this.connectWebSocket();
    return {
      invitationUrl: createInvitationUrl(this.options.relayOrigin, grantId, secret),
      grantId
    };
  }

  async stop(options: { revoke?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (options.revoke !== false && this.grantId && this.ownerToken) {
      await fetch(new URL(`/v1/grants/${this.grantId}`, this.options.relayOrigin), {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.ownerToken}` }
      }).catch(() => undefined);
    }
    this.websocket?.close();
    await this.executionQueue.catch(() => undefined);
  }

  private async connectWebSocket(): Promise<void> {
    const url = new URL(`/v1/gateways/${this.grantId}`, this.options.relayOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ownerToken", this.ownerToken!);
    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(url);
      this.websocket = websocket;
      websocket.once("open", resolve);
      websocket.once("error", reject);
      websocket.on("message", (data) => this.handleInbound(data.toString()));
      websocket.on("close", () => {
        if (!this.stopped) this.options.onLog?.("Gateway disconnected from relay");
      });
    });
  }

  private handleInbound(raw: string): void {
    let event: GatewayInboundEvent;
    try {
      event = JSON.parse(raw) as GatewayInboundEvent;
    } catch {
      return;
    }
    if (event.type === "gateway.ready") {
      this.options.onLog?.("Gateway is ready");
      return;
    }
    if (event.type === "task.offered") {
      this.executionQueue = this.executionQueue.then(() => this.executeTask(event.task));
    }
  }

  private async executeTask(task: StoredTask): Promise<void> {
    const allowed = new Set(this.options.policy.permissions);
    const denied = task.request.requestedPermissions.find((permission) => !allowed.has(permission));
    if (denied) {
      this.send({ type: "task.failed", taskId: task.id, error: `Local policy denied '${denied}'` });
      return;
    }
    this.send({ type: "task.started", taskId: task.id });
    this.options.onLog?.(`Executing delegated task ${task.id}`);
    let worktree: TemporaryWorktree | undefined;
    try {
      worktree = await TemporaryWorktree.create(this.options.repoPath);
      const execution = await this.options.adapter.execute({
        task: task.request,
        cwd: worktree.directory,
        permissions: task.request.requestedPermissions,
        onProgress: (message) => this.sendProgress(task.id, message)
      });
      const collected = await worktree.collect(
        task.request.requestedPermissions.includes("test") ? this.options.validationCommands ?? [] : []
      );
      const result: TaskResult = {
        summary: execution.summary,
        patch: collected.patch,
        changedFiles: collected.changedFiles,
        validations: collected.validations,
        ...(execution.rawOutput === undefined ? {} : { rawOutput: execution.rawOutput })
      };
      this.send({ type: "task.completed", taskId: task.id, result });
      this.options.onLog?.(`Completed delegated task ${task.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "task.failed", taskId: task.id, error: message });
      this.options.onLog?.(`Delegated task failed: ${message}`);
    } finally {
      await worktree?.dispose().catch(() => undefined);
    }
  }

  private sendProgress(taskId: string, message: string): void {
    this.send({ type: "task.progress", taskId, message: message.slice(0, 2_000) });
  }

  private send(event: GatewayOutboundEvent): void {
    if (this.websocket?.readyState !== WebSocket.OPEN) throw new Error("Gateway is not connected");
    this.websocket.send(JSON.stringify(event));
  }
}

export function normalizePermissions(values: string[]): Permission[] {
  const allowed = new Set<Permission>(["read", "edit", "test"]);
  const result = [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()))];
  for (const permission of result) {
    if (!allowed.has(permission as Permission)) throw new Error(`Unknown permission '${permission}'`);
  }
  return result as Permission[];
}
