import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { EncryptedEnvelope } from "./protocol.js";

const SALT_PREFIX = "agent-delegation-link/v1";

function derive(secret: string, grantId: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(`${SALT_PREFIX}:${grantId}`, "utf8"),
      Buffer.from(purpose, "utf8"),
      32
    )
  );
}

export function deriveEncryptionKey(secret: string, grantId: string): Buffer {
  return derive(secret, grantId, "content-encryption");
}

export function deriveRelayCredential(secret: string, grantId: string): string {
  return derive(secret, grantId, "relay-authentication").toString("base64url");
}

export function requestAad(grantId: string, clientRequestId: string): string {
  return `${SALT_PREFIX}:${grantId}:request:${clientRequestId}`;
}

export function eventAad(grantId: string, taskId: string, kind: "progress" | "result" | "error"): string {
  return `${SALT_PREFIX}:${grantId}:${kind}:${taskId}`;
}

export function encryptJson(value: unknown, key: Buffer, additionalData: string): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(additionalData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

export function decryptJson(envelope: EncryptedEnvelope, key: Buffer, additionalData: string): unknown {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(additionalData, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}
