import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayAccessStore } from "../src/access.js";
import { verifyAuditLog } from "../src/audit.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("persistent Relay access control", () => {
  it("exchanges a one-use invitation without persisting raw credentials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-access-"));
    cleanup.push(directory);
    const file = path.join(directory, "access.json");
    const auditFile = path.join(directory, "access-audit.jsonl");
    const store = await RelayAccessStore.open(file, auditFile);
    const invitation = await store.createInvitation({
      label: "friend",
      expiresInSeconds: 3_600,
      maxActiveGrants: 1,
      maxGrantsPerHour: 2
    });
    const registered = await store.register(invitation.invitationCode, "Friend laptop");
    expect(registered?.apiKey).toMatch(/^adl_usr_/);
    expect(await store.register(invitation.invitationCode, "Replay attempt")).toBeUndefined();
    expect(store.authenticate(registered!.apiKey)?.displayName).toBe("Friend laptop");

    const persisted = await readFile(file, "utf8");
    expect(persisted).not.toContain(invitation.invitationCode);
    expect(persisted).not.toContain(registered!.apiKey);
    expect(persisted).not.toContain("adl_inv_");
    expect(persisted).not.toContain("adl_usr_");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    await store.flush();
    expect(await verifyAuditLog(auditFile)).toEqual({ valid: true, records: 2 });
  });

  it("enforces quotas, persists user keys, rotates, and revokes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-access-lifecycle-"));
    cleanup.push(directory);
    const file = path.join(directory, "access.json");
    const store = await RelayAccessStore.open(file);
    const invitation = await store.createInvitation({
      label: "quota user",
      expiresInSeconds: 3_600,
      maxActiveGrants: 1,
      maxGrantsPerHour: 2
    });
    const registered = (await store.register(invitation.invitationCode, "Quota user"))!;
    expect((await store.consumeGrant(registered.apiKey, "grant-1"))?.allowed).toBe(true);
    expect(await store.consumeGrant(registered.apiKey, "grant-2")).toMatchObject({
      allowed: false,
      code: "active_grant_limit"
    });
    await store.releaseGrant(registered.user.id, "grant-1", "test");
    expect((await store.consumeGrant(registered.apiKey, "grant-2"))?.allowed).toBe(true);
    await store.releaseGrant(registered.user.id, "grant-2", "test");
    expect(await store.consumeGrant(registered.apiKey, "grant-3")).toMatchObject({
      allowed: false,
      code: "grant_rate_limit"
    });
    await store.flush();

    const reopened = await RelayAccessStore.open(file);
    expect(reopened.authenticate(registered.apiKey)?.id).toBe(registered.user.id);
    const rotated = (await reopened.rotateApiKey(registered.apiKey))!;
    expect(reopened.authenticate(registered.apiKey)).toBeUndefined();
    expect(reopened.authenticate(rotated.apiKey)?.id).toBe(registered.user.id);
    expect((await reopened.revokeUser(registered.user.id))?.revokedAt).toBeDefined();
    expect(reopened.authenticate(rotated.apiKey)).toBeUndefined();
    await reopened.flush();
  });
});
