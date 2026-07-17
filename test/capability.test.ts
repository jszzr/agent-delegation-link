import { describe, expect, it } from "vitest";
import {
  createInvitationUrl,
  createSecret,
  hashSecret,
  parseDuration,
  parseInvitationUrl,
  verifySecret
} from "../src/capability.js";

describe("capability links", () => {
  it("round-trips a secret in the URL fragment", () => {
    const secret = createSecret();
    const grantId = "0198a883-a515-7660-b999-d137ae97c99d";
    const link = createInvitationUrl("https://relay.example", grantId, secret);
    expect(parseInvitationUrl(link)).toEqual({ relayOrigin: "https://relay.example", grantId, secret });
    expect(new URL(link).hash).toContain("secret=");
  });

  it("rejects cleartext public relay links", () => {
    expect(() => parseInvitationUrl("http://relay.example/invite/0198a883-a515-7660-b999-d137ae97c99d#secret=x"))
      .toThrow("must use HTTPS");
  });

  it("allows IPv6 loopback but rejects embedded URL credentials", () => {
    expect(() => parseInvitationUrl("http://[::1]:8787/invite/0198a883-a515-7660-b999-d137ae97c99d#secret=x"))
      .not.toThrow();
    expect(() => parseInvitationUrl("https://user:pass@relay.example/invite/0198a883-a515-7660-b999-d137ae97c99d#secret=x"))
      .toThrow("embedded credentials");
  });

  it("verifies hashed secrets without storing the bearer value", () => {
    const secret = createSecret();
    expect(verifySecret(secret, hashSecret(secret))).toBe(true);
    expect(verifySecret(`${secret}x`, hashSecret(secret))).toBe(false);
  });

  it("parses bounded duration syntax", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(() => parseDuration("tomorrow")).toThrow();
  });
});
