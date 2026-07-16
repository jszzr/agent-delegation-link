import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecret, hashSecret } from "../src/capability.js";
import { RelayServer } from "../src/relay.js";

describe("relay policy enforcement", () => {
  let relay: RelayServer;
  let origin: string;
  let grantId: string;
  let secret: string;

  beforeEach(async () => {
    relay = new RelayServer();
    origin = (await relay.start()).origin;
    grantId = randomUUID();
    secret = createSecret();
    const response = await fetch(new URL("/v1/grants", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId,
        secretHash: hashSecret(secret),
        policy: {
          label: "policy-test",
          agent: "fake",
          permissions: ["read"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          maxTasks: 1,
          approval: "auto_within_scope"
        }
      })
    });
    expect(response.status).toBe(201);
  });

  afterEach(async () => relay.stop());

  it("rejects invalid bearer secrets", async () => {
    const response = await fetch(new URL(`/v1/grants/${grantId}/tasks`, origin), {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ goal: "inspect", requestedPermissions: ["read"] })
    });
    expect(response.status).toBe(401);
  });

  it("rejects permissions outside the link scope", async () => {
    const response = await fetch(new URL(`/v1/grants/${grantId}/tasks`, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ goal: "edit", requestedPermissions: ["edit"] })
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("outside the delegation scope");
  });
});
