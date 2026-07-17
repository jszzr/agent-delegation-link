import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecret, hashSecret } from "../src/capability.js";
import { deriveEncryptionKey, deriveRelayCredential, encryptJson, requestAad } from "../src/crypto.js";
import { RelayServer } from "../src/relay.js";

describe("relay policy enforcement", () => {
  let relay: RelayServer;
  let origin: string;
  let grantId: string;
  let secret: string;
  let credential: string;

  beforeEach(async () => {
    relay = new RelayServer();
    origin = (await relay.start()).origin;
    grantId = randomUUID();
    secret = createSecret();
    credential = deriveRelayCredential(secret, grantId);
    const response = await fetch(new URL("/v1/grants", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId,
        relayCredentialHash: hashSecret(credential),
        policy: {
          label: "policy-test",
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
    expect(response.status).toBe(201);
  });

  afterEach(async () => relay.stop());

  function submission(requestedPermissions: Array<"read" | "edit">) {
    const clientRequestId = randomUUID();
    const request = {
      goal: "encrypted goal",
      sender: "test",
      requestedPermissions,
      constraints: [],
      acceptanceCriteria: []
    };
    return {
      clientRequestId,
      requestedPermissions,
      envelope: encryptJson(request, deriveEncryptionKey(secret, grantId), requestAad(grantId, clientRequestId))
    };
  }

  it("rejects invalid bearer credentials", async () => {
    const response = await fetch(new URL(`/v1/grants/${grantId}/tasks`, origin), {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify(submission(["read"]))
    });
    expect(response.status).toBe(401);
  });

  it("rejects permissions outside the link scope without decrypting the task", async () => {
    const response = await fetch(new URL(`/v1/grants/${grantId}/tasks`, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(submission(["edit"]))
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("outside the delegation scope");
  });
});
