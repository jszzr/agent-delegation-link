import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AuditLog } from "./audit.js";
import { createSecret, hashSecret, verifySecret } from "./capability.js";

const userRecordSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(100),
  apiKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
  maxActiveGrants: z.number().int().min(1).max(100),
  maxGrantsPerHour: z.number().int().min(1).max(1_000),
  grantTimestamps: z.array(z.string().datetime()).max(1_000)
});

const invitationRecordSchema = z.object({
  id: z.string().uuid(),
  codeHash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().optional(),
  userId: z.string().uuid().optional(),
  maxActiveGrants: z.number().int().min(1).max(100),
  maxGrantsPerHour: z.number().int().min(1).max(1_000)
});

const accessStateSchema = z.object({
  version: z.literal(1),
  users: z.array(userRecordSchema).max(100_000),
  invitations: z.array(invitationRecordSchema).max(100_000)
});

type UserRecord = z.infer<typeof userRecordSchema>;
type InvitationRecord = z.infer<typeof invitationRecordSchema>;
type AccessState = z.infer<typeof accessStateSchema>;

export const createAccessInvitationRequestSchema = z.object({
  label: z.string().trim().min(1).max(100),
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60),
  maxActiveGrants: z.number().int().min(1).max(100).default(5),
  maxGrantsPerHour: z.number().int().min(1).max(1_000).default(20)
});

export const registerAccessRequestSchema = z.object({
  invitationCode: z.string().regex(/^adl_inv_[A-Za-z0-9_-]{43}$/),
  displayName: z.string().trim().min(1).max(100)
});

export interface AccessUser {
  id: string;
  displayName: string;
  createdAt: string;
  revokedAt?: string;
  maxActiveGrants: number;
  maxGrantsPerHour: number;
  activeGrants: number;
  grantsLastHour: number;
}

export interface AccessInvitation {
  id: string;
  invitationCode: string;
  label: string;
  expiresAt: string;
  maxActiveGrants: number;
  maxGrantsPerHour: number;
}

export interface AccessRegistration {
  apiKey: string;
  user: AccessUser;
}

export type GrantQuotaResult =
  | { allowed: true; user: AccessUser }
  | { allowed: false; code: "active_grant_limit" | "grant_rate_limit"; message: string };

export class RelayAccessStore {
  private readonly activeGrants = new Map<string, number>();
  private queue = Promise.resolve();

  private constructor(
    readonly file: string,
    readonly auditFile: string,
    private state: AccessState,
    private readonly audit: AuditLog
  ) {}

  static async open(file: string, auditFile = `${file}.audit.jsonl`): Promise<RelayAccessStore> {
    const resolved = path.resolve(file);
    const state = await loadState(resolved);
    const store = new RelayAccessStore(resolved, path.resolve(auditFile), state, new AuditLog(path.resolve(auditFile)));
    await store.persist();
    return store;
  }

  authenticate(apiKey: string | undefined): AccessUser | undefined {
    if (!apiKey?.startsWith("adl_usr_")) return undefined;
    const record = this.state.users.find((candidate) => verifySecret(apiKey, candidate.apiKeyHash));
    if (!record || record.revokedAt) return undefined;
    return this.publicUser(record);
  }

  async createInvitation(input: z.infer<typeof createAccessInvitationRequestSchema>): Promise<AccessInvitation> {
    const parsed = createAccessInvitationRequestSchema.parse(input);
    return await this.transaction(() => {
      pruneInvitations(this.state);
      const invitationCode = `adl_inv_${createSecret()}`;
      const record: InvitationRecord = {
        id: randomUUID(),
        codeHash: hashSecret(invitationCode),
        label: parsed.label,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + parsed.expiresInSeconds * 1_000).toISOString(),
        maxActiveGrants: parsed.maxActiveGrants,
        maxGrantsPerHour: parsed.maxGrantsPerHour
      };
      this.state.invitations.push(record);
      return {
        result: {
          id: record.id,
          invitationCode,
          label: record.label,
          expiresAt: record.expiresAt,
          maxActiveGrants: record.maxActiveGrants,
          maxGrantsPerHour: record.maxGrantsPerHour
        },
        event: "access.invitation_created",
        details: {
          invitationId: record.id,
          label: record.label,
          expiresAt: record.expiresAt,
          maxActiveGrants: record.maxActiveGrants,
          maxGrantsPerHour: record.maxGrantsPerHour
        }
      };
    });
  }

  async register(invitationCode: string, displayName: string): Promise<AccessRegistration | undefined> {
    const parsed = registerAccessRequestSchema.parse({ invitationCode, displayName });
    return await this.transaction(() => {
      const invitation = this.state.invitations.find((candidate) => verifySecret(parsed.invitationCode, candidate.codeHash));
      if (!invitation || invitation.consumedAt || Date.parse(invitation.expiresAt) <= Date.now()) {
        return { result: undefined };
      }
      const apiKey = `adl_usr_${createSecret()}`;
      const now = new Date().toISOString();
      const record: UserRecord = {
        id: randomUUID(),
        displayName: parsed.displayName,
        apiKeyHash: hashSecret(apiKey),
        createdAt: now,
        maxActiveGrants: invitation.maxActiveGrants,
        maxGrantsPerHour: invitation.maxGrantsPerHour,
        grantTimestamps: []
      };
      invitation.consumedAt = now;
      invitation.userId = record.id;
      this.state.users.push(record);
      return {
        result: { apiKey, user: this.publicUser(record) },
        event: "access.user_registered",
        details: { userId: record.id, displayName: record.displayName, invitationId: invitation.id }
      };
    });
  }

  async consumeGrant(apiKey: string | undefined, grantId: string): Promise<GrantQuotaResult | undefined> {
    return await this.transaction<GrantQuotaResult | undefined>(() => {
      const record = this.findActiveUser(apiKey);
      if (!record) return { result: undefined };
      pruneGrantTimestamps(record);
      const active = this.activeGrants.get(record.id) ?? 0;
      if (active >= record.maxActiveGrants) {
        return {
          result: {
            allowed: false as const,
            code: "active_grant_limit" as const,
            message: `Active grant limit reached (${record.maxActiveGrants})`
          }
        };
      }
      if (record.grantTimestamps.length >= record.maxGrantsPerHour) {
        return {
          result: {
            allowed: false as const,
            code: "grant_rate_limit" as const,
            message: `Hourly grant limit reached (${record.maxGrantsPerHour})`
          }
        };
      }
      record.grantTimestamps.push(new Date().toISOString());
      this.activeGrants.set(record.id, active + 1);
      return {
        result: { allowed: true as const, user: this.publicUser(record) },
        event: "access.grant_created",
        details: { userId: record.id, grantId, activeGrants: active + 1 }
      };
    });
  }

  async releaseGrant(userId: string, grantId: string, reason: string): Promise<void> {
    await this.withLock(async () => {
      const active = this.activeGrants.get(userId) ?? 0;
      this.activeGrants.set(userId, Math.max(0, active - 1));
      await this.audit.append("access.grant_released", {
        userId,
        grantId,
        reason,
        activeGrants: Math.max(0, active - 1)
      });
    });
  }

  listUsers(): AccessUser[] {
    return this.state.users.map((record) => this.publicUser(record));
  }

  async revokeUser(userId: string): Promise<AccessUser | undefined> {
    return await this.transaction(() => {
      const record = this.state.users.find((candidate) => candidate.id === userId);
      if (!record) return { result: undefined };
      if (!record.revokedAt) record.revokedAt = new Date().toISOString();
      this.activeGrants.set(record.id, 0);
      return {
        result: this.publicUser(record),
        event: "access.user_revoked",
        details: { userId: record.id, displayName: record.displayName, revokedAt: record.revokedAt }
      };
    });
  }

  async rotateApiKey(apiKey: string | undefined): Promise<AccessRegistration | undefined> {
    return await this.transaction(() => {
      const record = this.findActiveUser(apiKey);
      if (!record) return { result: undefined };
      const replacement = `adl_usr_${createSecret()}`;
      record.apiKeyHash = hashSecret(replacement);
      return {
        result: { apiKey: replacement, user: this.publicUser(record) },
        event: "access.api_key_rotated",
        details: { userId: record.id, displayName: record.displayName }
      };
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.audit.flush();
  }

  private findActiveUser(apiKey: string | undefined): UserRecord | undefined {
    if (!apiKey?.startsWith("adl_usr_")) return undefined;
    const record = this.state.users.find((candidate) => verifySecret(apiKey, candidate.apiKeyHash));
    return record?.revokedAt ? undefined : record;
  }

  private publicUser(record: UserRecord): AccessUser {
    pruneGrantTimestamps(record);
    return {
      id: record.id,
      displayName: record.displayName,
      createdAt: record.createdAt,
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
      maxActiveGrants: record.maxActiveGrants,
      maxGrantsPerHour: record.maxGrantsPerHour,
      activeGrants: this.activeGrants.get(record.id) ?? 0,
      grantsLastHour: record.grantTimestamps.length
    };
  }

  private async transaction<T>(operation: () => {
    result: T;
    event?: string;
    details?: Record<string, unknown>;
  }): Promise<T> {
    return await this.withLock(async () => {
      const previousState = structuredClone(this.state);
      const previousActive = new Map(this.activeGrants);
      try {
        const change = operation();
        if (!change.event) return change.result;
        await this.persist();
        await this.audit.append(change.event, change.details ?? {});
        return change.result;
      } catch (error) {
        this.state = previousState;
        this.activeGrants.clear();
        for (const [key, value] of previousActive) this.activeGrants.set(key, value);
        await this.persist().catch(() => undefined);
        throw error;
      }
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path.dirname(this.file), 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.file);
      if (process.platform !== "win32") await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function loadState(file: string): Promise<AccessState> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Relay access state must be a regular file: ${file}`);
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new Error(`Relay access state permissions are too broad; run: chmod 600 ${file}`);
    }
    return accessStateSchema.parse(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, users: [], invitations: [] };
    throw error;
  }
}

function pruneGrantTimestamps(record: UserRecord): void {
  const cutoff = Date.now() - 60 * 60 * 1_000;
  record.grantTimestamps = record.grantTimestamps.filter((timestamp) => Date.parse(timestamp) > cutoff);
}

function pruneInvitations(state: AccessState): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  state.invitations = state.invitations.filter((invitation) => {
    const terminalAt = invitation.consumedAt ?? invitation.expiresAt;
    return Date.parse(terminalAt) > cutoff;
  });
}
