import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AuditRecord {
  sequence: number;
  timestamp: string;
  event: string;
  taskId?: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

const GENESIS_HASH = "0".repeat(64);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordHash(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(stableJson(record), "utf8").digest("hex");
}

export function digestAuditValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class AuditLog {
  private queue = Promise.resolve();

  constructor(readonly file: string) {}

  append(event: string, details: Record<string, unknown>, taskId?: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const records = await readAuditRecords(this.file);
      const previous = records.at(-1);
      const base: Omit<AuditRecord, "hash"> = {
        sequence: (previous?.sequence ?? 0) + 1,
        timestamp: new Date().toISOString(),
        event,
        ...(taskId === undefined ? {} : { taskId }),
        details,
        previousHash: previous?.hash ?? GENESIS_HASH
      };
      const record: AuditRecord = { ...base, hash: recordHash(base) };
      await appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

async function readAuditRecords(file: string): Promise<AuditRecord[]> {
  const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditRecord);
}

export async function verifyAuditLog(file: string): Promise<{ valid: true; records: number } | { valid: false; reason: string }> {
  let records: AuditRecord[];
  try {
    records = await readAuditRecords(file);
  } catch (error) {
    return { valid: false, reason: `Unable to parse audit log: ${error instanceof Error ? error.message : String(error)}` };
  }
  let previousHash = GENESIS_HASH;
  for (const [index, record] of records.entries()) {
    if (record.sequence !== index + 1) return { valid: false, reason: `Invalid sequence at record ${index + 1}` };
    if (record.previousHash !== previousHash) return { valid: false, reason: `Broken chain at record ${index + 1}` };
    const { hash, ...base } = record;
    if (recordHash(base) !== hash) return { valid: false, reason: `Invalid hash at record ${index + 1}` };
    previousHash = hash;
  }
  return { valid: true, records: records.length };
}
