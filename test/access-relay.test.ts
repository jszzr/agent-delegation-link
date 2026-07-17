import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRelayInvitation,
  getRelayUser,
  registerRelayUser,
  revokeRelayUser
} from "../src/access-client.js";
import { createSecret, hashSecret } from "../src/capability.js";
import { RelayServer } from "../src/relay.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Relay user access API", () => {
  it("separates administrator and user credentials and revokes active grants", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adl-access-relay-"));
    cleanup.push(directory);
    const relay = new RelayServer();
    const adminToken = createSecret();
    const origin = (await relay.start({
      adminToken,
      accessFile: path.join(directory, "access.json")
    })).origin;
    try {
      const invitation = await createRelayInvitation(origin, adminToken, {
        label: "integration user",
        expiresInSeconds: 3_600,
        maxActiveGrants: 1,
        maxGrantsPerHour: 2
      });
      const registration = await registerRelayUser(origin, invitation.invitationCode, "Integration user");
      expect((await getRelayUser(origin, registration.apiKey)).id).toBe(registration.user.id);

      const denied = await createGrant(origin, randomUUID(), adminToken);
      expect(denied.response.status).toBe(401);

      const grantId = randomUUID();
      const created = await createGrant(origin, grantId, registration.apiKey);
      expect(created.response.status).toBe(201);
      await revokeRelayUser(origin, adminToken, registration.user.id);
      await expect(getRelayUser(origin, registration.apiKey)).rejects.toThrow("401");

      const revokedGrant = await fetch(new URL(`/v1/grants/${grantId}/tasks`, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${created.credential}`, "content-type": "application/json" },
        body: "{}"
      });
      expect(revokedGrant.status).toBe(410);
      expect((await createGrant(origin, randomUUID(), registration.apiKey)).response.status).toBe(401);
    } finally {
      await relay.stop();
    }
  });
});

async function createGrant(
  origin: string,
  grantId: string,
  bearer: string
): Promise<{ response: Response; credential: string }> {
  const credential = createSecret();
  const response = await fetch(new URL("/v1/grants", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      grantId,
      relayCredentialHash: hashSecret(credential),
      policy: {
        label: "access-test",
        agent: "fake",
        permissions: ["read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxTasks: 1,
        approval: "auto_within_scope",
        maxTaskDurationSeconds: 60,
        maxArtifactBytes: 1_000_000
      }
    })
  });
  return { response, credential };
}
