import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  createAccessInvitationRequestSchema,
  registerAccessRequestSchema,
  RelayAccessStore
} from "./access.js";
import { assertSecureRelayOrigin, createSecret, hashSecret, verifySecret } from "./capability.js";
import {
  createGrantRequestSchema,
  gatewayOutboundEventSchema,
  taskSubmissionSchema,
  type GrantPolicy,
  type RelayStoredTask,
  type TaskSubmission
} from "./protocol.js";

interface GrantRecord {
  id: string;
  relayCredentialHash: string;
  ownerTokenHash: string;
  policy: GrantPolicy;
  acceptedTasks: number;
  clientRequests: Map<string, string>;
  revoked: boolean;
  creatorUserId?: string;
  quotaReleased: boolean;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

interface LiveWebSocket extends WebSocket {
  isAlive?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function samePermissions(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface RelayAddress {
  origin: string;
  port: number;
}

export interface RelayStartOptions {
  host?: string;
  port?: number;
  publicBaseUrl?: string;
  maxRequestsPerMinute?: number;
  trustProxy?: boolean;
  registrationToken?: string;
  adminToken?: string;
  accessFile?: string;
  accessAuditFile?: string;
  onLog?: (message: string) => void;
}

export class RelayServer {
  private readonly grants = new Map<string, GrantRecord>();
  private readonly tasks = new Map<string, RelayStoredTask>();
  private readonly gateways = new Map<string, LiveWebSocket>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly featureRateBuckets = new Map<string, RateBucket>();
  private server: Server | undefined;
  private websocketServer: WebSocketServer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private publicBaseUrl: string | undefined;
  private maxRequestsPerMinute = 120;
  private trustProxy = false;
  private adminTokenHash: string | undefined;
  private accessStore: RelayAccessStore | undefined;
  private onLog: ((message: string) => void) | undefined;

  async start(options: RelayStartOptions = {}): Promise<RelayAddress> {
    if (this.server) throw new Error("Relay is already running");
    const host = options.host ?? "127.0.0.1";
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 120;
    this.trustProxy = options.trustProxy ?? false;
    const adminToken = options.adminToken ?? options.registrationToken;
    this.adminTokenHash = adminToken === undefined ? undefined : hashSecret(adminToken);
    if (options.accessFile && !adminToken) throw new Error("Relay access control requires an admin token");
    if (options.accessAuditFile && !options.accessFile) throw new Error("accessAuditFile requires accessFile");
    this.accessStore = options.accessFile === undefined
      ? undefined
      : await RelayAccessStore.open(options.accessFile, options.accessAuditFile);
    this.onLog = options.onLog;
    if (options.publicBaseUrl) assertSecureRelayOrigin(options.publicBaseUrl);
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error: unknown) => {
        if (error instanceof HttpError) {
          sendJson(response, error.status, { error: error.code, message: error.message });
          return;
        }
        this.onLog?.(`HTTP handler failed: ${error instanceof Error ? error.message : String(error)}`);
        sendJson(response, 500, { error: "internal_error", message: "Internal relay error" });
      });
    });
    this.websocketServer = new WebSocketServer({ noServer: true, maxPayload: 30_000_000 });
    this.server.on("upgrade", (request, socket, head) => {
      if (!this.consumeRateLimit(request)) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const url = new URL(request.url ?? "/", "http://relay.local");
      const match = url.pathname.match(/^\/v1\/gateways\/([0-9a-f-]{36})$/i);
      const grant = match?.[1] ? this.grants.get(match[1]) : undefined;
      const ownerToken = bearerToken(request);
      if (!grant || grant.revoked || !ownerToken || !verifySecret(ownerToken, grant.ownerTokenHash)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocketServer!.handleUpgrade(request, socket, head, (websocket) => {
        this.attachGateway(grant.id, websocket);
      });
    });
    this.heartbeat = setInterval(() => this.heartbeatGateways(), 30_000);
    this.heartbeat.unref();
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(options.port ?? 0, host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve relay address");
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    this.publicBaseUrl = options.publicBaseUrl ?? `http://${urlHost}:${address.port}`;
    return { origin: this.publicBaseUrl, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const gateway of this.gateways.values()) gateway.terminate();
    this.gateways.clear();
    this.websocketServer?.close();
    this.websocketServer = undefined;
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server!.close((error) => (error ? reject(error) : resolve())));
      this.server = undefined;
    }
    await this.accessStore?.flush();
    this.accessStore = undefined;
  }

  dropGatewayConnection(grantId: string): boolean {
    const gateway = this.gateways.get(grantId);
    if (!gateway) return false;
    gateway.terminate();
    return true;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.consumeRateLimit(request)) {
      sendJson(response, 429, { error: "rate_limited", message: "Too many requests" });
      return;
    }
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", this.publicBaseUrl ?? "http://relay.local");

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && /^\/invite\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY"
      });
      response.end("<!doctype html><meta charset='utf-8'><title>Agent Delegation Link</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.15rem .3rem}</style><h1>Agent Delegation Link</h1><p>This URL contains a secret in its fragment. Give the full link only to the intended collaborator.</p><p>Use <code>adl invoke '&lt;full-link&gt;' --goal '...'</code>, or configure the ADL MCP server.</p>");
      return;
    }

    if (method === "POST" && url.pathname === "/v1/access/register") {
      if (!this.accessStore) {
        sendJson(response, 404, { error: "access_disabled", message: "Relay user registration is not enabled" });
        return;
      }
      if (!this.consumeFeatureRateLimit(request, "register", 10)) {
        sendJson(response, 429, { error: "rate_limited", message: "Too many registration attempts" });
        return;
      }
      const parsed = registerAccessRequestSchema.safeParse(await readJson(request, 16_000));
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_registration", message: "Invalid invitation code or display name" });
        return;
      }
      const registration = await this.accessStore.register(parsed.data.invitationCode, parsed.data.displayName);
      if (!registration) {
        sendJson(response, 401, { error: "invalid_invitation", message: "Invitation code is invalid, expired, or already used" });
        return;
      }
      sendJson(response, 201, registration);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/access/me") {
      const user = this.accessStore?.authenticate(bearerToken(request));
      if (!user) {
        sendJson(response, 401, { error: "unauthorized", message: "A valid user API key is required" });
        return;
      }
      sendJson(response, 200, { user });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/access/rotate") {
      const rotated = await this.accessStore?.rotateApiKey(bearerToken(request));
      if (!rotated) {
        sendJson(response, 401, { error: "unauthorized", message: "A valid user API key is required" });
        return;
      }
      sendJson(response, 200, rotated);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/admin/invitations") {
      if (!this.requireAdmin(request, response) || !this.accessStore) return;
      const parsed = createAccessInvitationRequestSchema.safeParse(await readJson(request, 16_000));
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_invitation", message: parsed.error.message });
        return;
      }
      sendJson(response, 201, await this.accessStore.createInvitation(parsed.data));
      return;
    }

    if (method === "GET" && url.pathname === "/v1/admin/users") {
      if (!this.requireAdmin(request, response) || !this.accessStore) return;
      sendJson(response, 200, { users: this.accessStore.listUsers() });
      return;
    }

    const revokeUserMatch = url.pathname.match(/^\/v1\/admin\/users\/([0-9a-f-]{36})$/i);
    if (method === "DELETE" && revokeUserMatch?.[1]) {
      if (!this.requireAdmin(request, response) || !this.accessStore) return;
      const user = await this.accessStore.revokeUser(revokeUserMatch[1]);
      if (!user) {
        sendJson(response, 404, { error: "user_not_found", message: "User not found" });
        return;
      }
      for (const grant of this.grants.values()) {
        if (grant.creatorUserId === user.id && !grant.revoked) await this.revokeGrant(grant, "user_revoked");
      }
      sendJson(response, 200, { user });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/grants") {
      if (!this.accessStore && this.adminTokenHash) {
        const registrationToken = request.headers["x-adl-relay-token"];
        if (typeof registrationToken !== "string" || !verifySecret(registrationToken, this.adminTokenHash)) {
          sendJson(response, 401, { error: "registration_required", message: "A valid relay registration token is required" });
          return;
        }
      }
      const parsed = createGrantRequestSchema.safeParse(await readJson(request, 64_000));
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_grant", message: parsed.error.message });
        return;
      }
      if (Date.parse(parsed.data.policy.expiresAt) <= Date.now()) {
        sendJson(response, 400, { error: "invalid_grant", message: "Grant expiry must be in the future" });
        return;
      }
      if (this.grants.has(parsed.data.grantId)) {
        sendJson(response, 409, { error: "grant_exists", message: "Grant already exists" });
        return;
      }
      let creatorUserId: string | undefined;
      if (this.accessStore) {
        const quota = await this.accessStore.consumeGrant(bearerToken(request), parsed.data.grantId);
        if (!quota) {
          sendJson(response, 401, { error: "user_api_key_required", message: "Register this device with an invitation code before creating links" });
          return;
        }
        if (!quota.allowed) {
          sendJson(response, 429, { error: quota.code, message: quota.message });
          return;
        }
        creatorUserId = quota.user.id;
      }
      const ownerToken = createSecret();
      this.grants.set(parsed.data.grantId, {
        id: parsed.data.grantId,
        relayCredentialHash: parsed.data.relayCredentialHash,
        ownerTokenHash: hashSecret(ownerToken),
        policy: parsed.data.policy,
        acceptedTasks: 0,
        clientRequests: new Map(),
        revoked: false,
        ...(creatorUserId === undefined ? {} : { creatorUserId }),
        quotaReleased: false
      });
      sendJson(response, 201, { grantId: parsed.data.grantId, ownerToken });
      return;
    }

    const grantTasksMatch = url.pathname.match(/^\/v1\/grants\/([0-9a-f-]{36})\/tasks$/i);
    if (method === "POST" && grantTasksMatch?.[1]) {
      const grant = this.authorizeGrant(request, grantTasksMatch[1], response);
      if (!grant) return;
      const parsed = taskSubmissionSchema.safeParse(await readJson(request, 300_000));
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_task", message: parsed.error.message });
        return;
      }
      const existingTaskId = grant.clientRequests.get(parsed.data.clientRequestId);
      if (existingTaskId) {
        const existing = this.tasks.get(existingTaskId)!;
        if (!samePermissions(existing.requestedPermissions, parsed.data.requestedPermissions)) {
          sendJson(response, 409, { error: "idempotency_conflict", message: "Request ID was reused with different metadata" });
          return;
        }
        sendJson(response, 200, {
          taskId: existing.id,
          status: existing.status,
          gatewayOnline: this.isGatewayOnline(grant.id),
          deduplicated: true
        });
        return;
      }
      const policyError = this.validateTaskPolicy(grant, parsed.data);
      if (policyError) {
        sendJson(response, 403, { error: "policy_denied", message: policyError });
        return;
      }
      const now = new Date().toISOString();
      const task: RelayStoredTask = {
        id: randomUUID(),
        grantId: grant.id,
        clientRequestId: parsed.data.clientRequestId,
        requestedPermissions: parsed.data.requestedPermissions,
        requestEnvelope: parsed.data.envelope,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        gatewayOnlineAtAcceptance: this.isGatewayOnline(grant.id),
        progressEnvelopes: []
      };
      grant.acceptedTasks += 1;
      grant.clientRequests.set(task.clientRequestId, task.id);
      this.tasks.set(task.id, task);
      this.offerTask(task);
      sendJson(response, 202, {
        taskId: task.id,
        status: task.status,
        gatewayOnline: task.gatewayOnlineAtAcceptance,
        deduplicated: false
      });
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
      const ownerToken = bearerToken(request);
      if (!grant || !ownerToken || !verifySecret(ownerToken, grant.ownerTokenHash)) {
        sendJson(response, 401, { error: "unauthorized", message: "Invalid owner token" });
        return;
      }
      await this.revokeGrant(grant, "owner_revoked");
      sendJson(response, 200, { revoked: true });
      return;
    }

    sendJson(response, 404, { error: "not_found", message: "Route not found" });
  }

  private authorizeGrant(request: IncomingMessage, grantId: string, response: ServerResponse): GrantRecord | undefined {
    const grant = this.grants.get(grantId);
    const credential = bearerToken(request);
    if (!grant || !credential || !verifySecret(credential, grant.relayCredentialHash)) {
      sendJson(response, 401, { error: "unauthorized", message: "Invalid delegation credential" });
      return undefined;
    }
    if (grant.revoked) {
      sendJson(response, 410, { error: "revoked", message: "Delegation link has been revoked" });
      return undefined;
    }
    return grant;
  }

  private validateTaskPolicy(grant: GrantRecord, task: TaskSubmission): string | undefined {
    if (Date.parse(grant.policy.expiresAt) <= Date.now()) return "Delegation link has expired";
    if (grant.acceptedTasks >= grant.policy.maxTasks) return "Delegation task limit has been reached";
    const allowed = new Set(grant.policy.permissions);
    const denied = task.requestedPermissions.find((permission) => !allowed.has(permission));
    if (denied) return `Permission '${denied}' is outside the delegation scope`;
    return undefined;
  }

  private attachGateway(grantId: string, websocket: LiveWebSocket): void {
    this.gateways.get(grantId)?.close(1000, "Replaced by a new gateway connection");
    websocket.isAlive = true;
    this.gateways.set(grantId, websocket);
    websocket.on("pong", () => { websocket.isAlive = true; });
    websocket.send(JSON.stringify({ type: "gateway.ready" }));
    for (const task of this.tasks.values()) {
      if (task.grantId === grantId && (task.status === "queued" || task.status === "running")) this.offerTask(task);
    }
    websocket.on("message", (data) => this.handleGatewayMessage(grantId, data.toString()));
    websocket.on("close", () => {
      if (this.gateways.get(grantId) === websocket) this.gateways.delete(grantId);
    });
  }

  private offerTask(task: RelayStoredTask): void {
    const gateway = this.gateways.get(task.grantId);
    if (gateway?.readyState === WebSocket.OPEN) {
      gateway.send(JSON.stringify({ type: "task.offered", task }));
    }
  }

  private handleGatewayMessage(grantId: string, raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const parsed = gatewayOutboundEventSchema.safeParse(decoded);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "task.progress" && event.envelope.ciphertext.length > 4_000) return;
    if (event.type === "task.failed" && event.envelope.ciphertext.length > 20_000) return;
    const task = this.tasks.get(event.taskId);
    if (!task || task.grantId !== grantId || task.status === "completed" || task.status === "failed") return;
    task.updatedAt = new Date().toISOString();
    if (event.type === "task.started") {
      task.status = "running";
    } else if (event.type === "task.progress") {
      task.progressEnvelopes.push(event.envelope);
      if (task.progressEnvelopes.length > 100) task.progressEnvelopes.shift();
    } else if (event.type === "task.completed") {
      task.status = "completed";
      task.resultEnvelope = event.envelope;
    } else {
      task.status = "failed";
      task.errorEnvelope = event.envelope;
    }
  }

  private heartbeatGateways(): void {
    for (const [grantId, websocket] of this.gateways) {
      if (websocket.isAlive === false) {
        websocket.terminate();
        this.gateways.delete(grantId);
        continue;
      }
      websocket.isAlive = false;
      websocket.ping();
    }
    const expiry = Date.now() - 2 * 60_000;
    for (const [key, bucket] of this.rateBuckets) {
      if (bucket.startedAt < expiry) this.rateBuckets.delete(key);
    }
    for (const [key, bucket] of this.featureRateBuckets) {
      if (bucket.startedAt < expiry) this.featureRateBuckets.delete(key);
    }
    for (const grant of this.grants.values()) {
      if (!grant.revoked && Date.parse(grant.policy.expiresAt) <= Date.now()) {
        void this.revokeGrant(grant, "expired");
      }
    }
  }

  private isGatewayOnline(grantId: string): boolean {
    return this.gateways.get(grantId)?.readyState === WebSocket.OPEN;
  }

  private consumeRateLimit(request: IncomingMessage): boolean {
    return this.consumeBucket(this.rateBuckets, this.clientKey(request), this.maxRequestsPerMinute);
  }

  private consumeFeatureRateLimit(request: IncomingMessage, feature: string, limit: number): boolean {
    return this.consumeBucket(this.featureRateBuckets, `${feature}:${this.clientKey(request)}`, limit);
  }

  private clientKey(request: IncomingMessage): string {
    const forwarded = this.trustProxy ? request.headers["x-forwarded-for"] : undefined;
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim())
      ?? request.socket.remoteAddress
      ?? "unknown";
  }

  private consumeBucket(buckets: Map<string, RateBucket>, key: string, limit: number): boolean {
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || now - existing.startedAt >= 60_000) {
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= limit;
  }

  private requireAdmin(request: IncomingMessage, response: ServerResponse): boolean {
    if (!this.accessStore || !this.adminTokenHash) {
      sendJson(response, 404, { error: "access_disabled", message: "Relay access administration is not enabled" });
      return false;
    }
    const token = bearerToken(request);
    if (!token || !verifySecret(token, this.adminTokenHash)) {
      sendJson(response, 401, { error: "unauthorized", message: "A valid Relay admin token is required" });
      return false;
    }
    return true;
  }

  private async revokeGrant(grant: GrantRecord, reason: string): Promise<void> {
    grant.revoked = true;
    this.gateways.get(grant.id)?.close(1000, "Grant revoked");
    if (grant.creatorUserId && !grant.quotaReleased) {
      grant.quotaReleased = true;
      await this.accessStore?.releaseGrant(grant.creatorUserId, grant.id, reason).catch((error) => {
        this.onLog?.(`Unable to release user grant quota: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
