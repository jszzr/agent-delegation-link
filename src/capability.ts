import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function verifySecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createInvitationUrl(relayOrigin: string, grantId: string, secret: string): string {
  const url = new URL(`/invite/${grantId}`, relayOrigin);
  url.hash = new URLSearchParams({ secret }).toString();
  return url.toString();
}

export interface ParsedInvitation {
  relayOrigin: string;
  grantId: string;
  secret: string;
}

export function parseInvitationUrl(value: string): ParsedInvitation {
  const url = new URL(value);
  assertSecureRelayOrigin(value);
  const match = url.pathname.match(/^\/invite\/([0-9a-f-]{36})$/i);
  const secret = new URLSearchParams(url.hash.slice(1)).get("secret");
  if (!match?.[1] || !secret) {
    throw new Error("Invalid delegation link: expected /invite/<grant-id>#secret=<secret>");
  }
  return { relayOrigin: url.origin, grantId: match[1], secret };
}

export function assertSecureRelayOrigin(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Relay URLs must not contain embedded credentials");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Public relay URLs must use HTTPS; plain HTTP is allowed only on loopback");
  }
}

export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+)(s|m|h)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error("Duration must look like 30s, 15m, or 2h");
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}
