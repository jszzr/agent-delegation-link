import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createSecret, verifySecret } from "./capability.js";
import {
  createGrantRequestSchema,
  taskRequestSchema,
  taskResultSchema,
  type GatewayOutboundEvent,
  type GrantPolicy,
  type StoredTask,
  type TaskRequest
} from "./protocol.js";

interface GrantRecord {
  id: string;
  secretHash: string;
  ownerToken: string;
  policy: GrantPolicy;
  acceptedTasks: number;
  revoked: boolean;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

export interface RelayAddress {
  origin: string;
  port: number;
}

export class RelayServer {
  private readonly grants = new Map<string, GrantRecord>();
  private readonly tasks = new Map<string, StoredTask>();
  private readonly gateways = new Map<string, WebSocket>();
  private server: Server | undefined;
  private publicBaseUrl: string | undefined;

  async start(options: { host?: string; port?: number; publicBaseUrl?: string } = {}): Promise<RelayAddress> {
    if (this.server) throw new Error("Relay is already running");
    const host = options.host ?? "127.0.0.1";
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { error: "internal_error", message });
      });
    });
    const websocketServer = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://relay.local");
      const match = url.pathname.match(/^\/v1\/gateways\/([0-9a-f-]{36})$/i);
      if (!match?.[1]) {
        socket.destroy();
        return;
      }
      const grant = this.grants.get(match[1]);
      if (!grant || grant.revoked || url.searchParams.get("ownerToken") !== grant.ownerToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.attachGateway(grant.id, websocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(options.port ?? 0, host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve relay address");
    this.publicBaseUrl = options.publicBaseUrl ?? `http://${host}:${address.port}`;
    return { origin: this.publicBaseUrl, port: address.port };
  }

  async stop(): Promise<void> {
    for (const gateway of this.gateways.values()) gateway.close();
    this.gateways.clear();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => (error ? reject(error) : resolve())));
    this.server = undefined;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", this.publicBaseUrl ?? "http://relay.local");

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/invite/")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset='utf-8'><title>Agent Delegation Link</title><h1>Agent Delegation Link</h1><p>Open this link with the <code>adl invoke</code> command. Keep the URL fragment secret.</p>");
      return;
    }

    if (method === "POST" && url.pathname === "/v1/grants") {
      const parsed = createGrantRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_grant", message: parsed.error.message });
        return;
      }
      if (this.grants.has(parsed.data.grantId)) {
        sendJson(response, 409, { error: "grant_exists", message: "Grant already exists" });
        return;
      }
      const ownerToken = createSecret();
      this.grants.set(parsed.data.grantId, {
        id: parsed.data.grantId,
        secretHash: parsed.data.secretHash,
        ownerToken,
        policy: parsed.data.policy,
        acceptedTasks: 0,
        revoked: false
      });
      sendJson(response, 201, { grantId: parsed.data.grantId, ownerToken });
      return;
    }

    const grantTasksMatch = url.pathname.match(/^\/v1\/grants\/([0-9a-f-]{36})\/tasks$/i);
    if (method === "POST" && grantTasksMatch?.[1]) {
      const grant = this.authorizeGrant(request, grantTasksMatch[1], response);
      if (!grant) return;
      const parsed = taskRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_task", message: parsed.error.message });
        return;
      }
      const policyError = this.validateTaskPolicy(grant, parsed.data);
      if (policyError) {
        sendJson(response, 403, { error: "policy_denied", message: policyError });
        return;
      }
      const now = new Date().toISOString();
      const task: StoredTask = {
        id: randomUUID(),
        grantId: grant.id,
        request: parsed.data,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        progress: []
      };
      grant.acceptedTasks += 1;
      this.tasks.set(task.id, task);
      this.offerTask(task);
      sendJson(response, 202, { taskId: task.id, status: task.status });
      return;
    }

    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([0-9a-f-]{36})$/i);
    if (method === "GET" && taskMatch?.[1]) {
      const task = this.tasks.get(taskMatch[1]);
      if (!task) {
        sendJson(response, 404, { error: "task_not_found", message: "Task not found" });
        return;
      }
      const grant = this.authorizeGrant(request, task.grantId, response);
      if (!grant) return;
      sendJson(response, 200, task);
      return;
    }

    const revokeMatch = url.pathname.match(/^\/v1\/grants\/([0-9a-f-]{36})$/i);
    if (method === "DELETE" && revokeMatch?.[1]) {
      const grant = this.grants.get(revokeMatch[1]);
      if (!grant || bearerToken(request) !== grant.ownerToken) {
        sendJson(response, 401, { error: "unauthorized", message: "Invalid owner token" });
        return;
      }
      grant.revoked = true;
      this.gateways.get(grant.id)?.close();
      sendJson(response, 200, { revoked: true });
      return;
    }

    sendJson(response, 404, { error: "not_found", message: "Route not found" });
  }

  private authorizeGrant(
    request: IncomingMessage,
    grantId: string,
    response: ServerResponse
  ): GrantRecord | undefined {
    const grant = this.grants.get(grantId);
    const secret = bearerToken(request);
    if (!grant || !secret || !verifySecret(secret, grant.secretHash)) {
      sendJson(response, 401, { error: "unauthorized", message: "Invalid delegation secret" });
      return undefined;
    }
    if (grant.revoked) {
      sendJson(response, 410, { error: "revoked", message: "Delegation link has been revoked" });
      return undefined;
    }
    return grant;
  }

  private validateTaskPolicy(grant: GrantRecord, task: TaskRequest): string | undefined {
    if (Date.parse(grant.policy.expiresAt) <= Date.now()) return "Delegation link has expired";
    if (grant.acceptedTasks >= grant.policy.maxTasks) return "Delegation task limit has been reached";
    const allowed = new Set(grant.policy.permissions);
    const denied = task.requestedPermissions.find((permission) => !allowed.has(permission));
    if (denied) return `Permission '${denied}' is outside the delegation scope`;
    if (grant.policy.approval === "ask_every_time") return "Interactive owner approval is not implemented in v0.1";
    return undefined;
  }

  private attachGateway(grantId: string, websocket: WebSocket): void {
    this.gateways.get(grantId)?.close();
    this.gateways.set(grantId, websocket);
    websocket.send(JSON.stringify({ type: "gateway.ready" }));
    for (const task of this.tasks.values()) {
      if (task.grantId === grantId && task.status === "queued") this.offerTask(task);
    }
    websocket.on("message", (data) => this.handleGatewayMessage(grantId, data.toString()));
    websocket.on("close", () => {
      if (this.gateways.get(grantId) === websocket) this.gateways.delete(grantId);
    });
  }

  private offerTask(task: StoredTask): void {
    const gateway = this.gateways.get(task.grantId);
    if (gateway?.readyState === WebSocket.OPEN) {
      gateway.send(JSON.stringify({ type: "task.offered", task }));
    }
  }

  private handleGatewayMessage(grantId: string, raw: string): void {
    let event: GatewayOutboundEvent;
    try {
      event = JSON.parse(raw) as GatewayOutboundEvent;
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || !("taskId" in event)) return;
    const task = this.tasks.get(event.taskId);
    if (!task || task.grantId !== grantId || task.status === "completed" || task.status === "failed") return;
    task.updatedAt = new Date().toISOString();
    if (event.type === "task.started") {
      task.status = "running";
    } else if (event.type === "task.progress") {
      task.progress.push(event.message.slice(0, 2_000));
      if (task.progress.length > 100) task.progress.shift();
    } else if (event.type === "task.completed") {
      const result = taskResultSchema.safeParse(event.result);
      if (!result.success) {
        task.status = "failed";
        task.error = "Gateway returned an invalid result";
      } else {
        task.status = "completed";
        task.result = result.data;
      }
    } else if (event.type === "task.failed") {
      task.status = "failed";
      task.error = event.error.slice(0, 10_000);
    }
  }
}
