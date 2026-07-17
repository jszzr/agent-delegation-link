import { z } from "zod";
import { assertSecureRelayOrigin } from "./capability.js";
import { fetchWithTimeout, readLimitedJson, readLimitedText } from "./http.js";

const accessUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
  maxActiveGrants: z.number().int(),
  maxGrantsPerHour: z.number().int(),
  activeGrants: z.number().int(),
  grantsLastHour: z.number().int()
});

const registrationSchema = z.object({
  apiKey: z.string().regex(/^adl_usr_[A-Za-z0-9_-]{43}$/),
  user: accessUserSchema
});

const invitationSchema = z.object({
  id: z.string().uuid(),
  invitationCode: z.string().regex(/^adl_inv_[A-Za-z0-9_-]{43}$/),
  label: z.string(),
  expiresAt: z.string().datetime(),
  maxActiveGrants: z.number().int(),
  maxGrantsPerHour: z.number().int()
});

export type AccessUserResponse = z.infer<typeof accessUserSchema>;
export type RegistrationResponse = z.infer<typeof registrationSchema>;
export type InvitationResponse = z.infer<typeof invitationSchema>;

export async function registerRelayUser(
  relayOrigin: string,
  invitationCode: string,
  displayName: string
): Promise<RegistrationResponse> {
  return registrationSchema.parse(await relayRequest(relayOrigin, "/v1/access/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitationCode, displayName })
  }));
}

export async function getRelayUser(relayOrigin: string, apiKey: string): Promise<AccessUserResponse> {
  const body = z.object({ user: accessUserSchema }).parse(await relayRequest(relayOrigin, "/v1/access/me", {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` }
  }));
  return body.user;
}

export async function rotateRelayApiKey(relayOrigin: string, apiKey: string): Promise<RegistrationResponse> {
  return registrationSchema.parse(await relayRequest(relayOrigin, "/v1/access/rotate", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` }
  }));
}

export async function createRelayInvitation(
  relayOrigin: string,
  adminToken: string,
  options: {
    label: string;
    expiresInSeconds: number;
    maxActiveGrants: number;
    maxGrantsPerHour: number;
  }
): Promise<InvitationResponse> {
  return invitationSchema.parse(await relayRequest(relayOrigin, "/v1/admin/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(options)
  }));
}

export async function listRelayUsers(relayOrigin: string, adminToken: string): Promise<AccessUserResponse[]> {
  const body = z.object({ users: z.array(accessUserSchema) }).parse(await relayRequest(relayOrigin, "/v1/admin/users", {
    method: "GET",
    headers: { authorization: `Bearer ${adminToken}` }
  }));
  return body.users;
}

export async function revokeRelayUser(
  relayOrigin: string,
  adminToken: string,
  userId: string
): Promise<AccessUserResponse> {
  const body = z.object({ user: accessUserSchema }).parse(await relayRequest(
    relayOrigin,
    `/v1/admin/users/${encodeURIComponent(userId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } }
  ));
  return body.user;
}

async function relayRequest(relayOrigin: string, pathname: string, init: RequestInit): Promise<unknown> {
  assertSecureRelayOrigin(relayOrigin);
  const response = await fetchWithTimeout(new URL(pathname, relayOrigin), init, 15_000);
  if (!response.ok) {
    throw new Error(`Relay request failed: ${response.status} ${await readLimitedText(response, 100_000)}`);
  }
  return await readLimitedJson(response, 100_000);
}
