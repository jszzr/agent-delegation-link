import { randomUUID } from "node:crypto";
import { parseInvitationUrl } from "./capability.js";
import { decryptJson, deriveEncryptionKey, deriveRelayCredential, encryptJson, eventAad, requestAad } from "./crypto.js";
import { fetchWithTimeout, readLimitedJson, readLimitedText } from "./http.js";
import {
  encryptedEnvelopeSchema,
  relayStoredTaskSchema,
  taskAcceptedResponseSchema,
  taskRequestSchema,
  taskResultSchema,
  type RelayStoredTask,
  type StoredTask,
  type TaskRequest
} from "./protocol.js";

export interface SubmitTaskResult {
  taskId: string;
  gatewayOnline: boolean;
  deduplicated: boolean;
  clientRequestId: string;
}

export async function submitTask(
  invitationUrl: string,
  request: TaskRequest,
  options: { clientRequestId?: string } = {}
): Promise<SubmitTaskResult> {
  const invitation = parseInvitationUrl(invitationUrl);
  const task = taskRequestSchema.parse(request);
  const clientRequestId = options.clientRequestId ?? randomUUID();
  const key = deriveEncryptionKey(invitation.secret, invitation.grantId);
  const credential = deriveRelayCredential(invitation.secret, invitation.grantId);
  const envelope = encryptJson(task, key, requestAad(invitation.grantId, clientRequestId));
  const response = await fetchWithTimeout(new URL(`/v1/grants/${invitation.grantId}/tasks`, invitation.relayOrigin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ clientRequestId, requestedPermissions: task.requestedPermissions, envelope })
  }, 15_000);
  if (!response.ok) throw new Error(`Task rejected: ${response.status} ${await readLimitedText(response, 100_000)}`);
  const body = taskAcceptedResponseSchema.parse(await readLimitedJson(response, 100_000));
  return { ...body, clientRequestId };
}

export async function getTask(invitationUrl: string, taskId: string): Promise<StoredTask> {
  const invitation = parseInvitationUrl(invitationUrl);
  const credential = deriveRelayCredential(invitation.secret, invitation.grantId);
  const response = await fetchWithTimeout(new URL(`/v1/tasks/${taskId}`, invitation.relayOrigin), {
    headers: { authorization: `Bearer ${credential}` }
  }, 15_000);
  if (!response.ok) throw new Error(`Unable to read task: ${response.status} ${await readLimitedText(response, 100_000)}`);
  const encrypted: RelayStoredTask = relayStoredTaskSchema.parse(await readLimitedJson(response, 30_000_000));
  if (encrypted.id !== taskId || encrypted.grantId !== invitation.grantId) {
    throw new Error("Relay returned a task with mismatched identifiers");
  }
  const key = deriveEncryptionKey(invitation.secret, invitation.grantId);
  const request = taskRequestSchema.parse(
    decryptJson(
      encryptedEnvelopeSchema.parse(encrypted.requestEnvelope),
      key,
      requestAad(invitation.grantId, encrypted.clientRequestId)
    )
  );
  const progress = encrypted.progressEnvelopes.map((envelope) => {
    const value = decryptJson(encryptedEnvelopeSchema.parse(envelope), key, eventAad(invitation.grantId, taskId, "progress"));
    if (typeof value !== "string") throw new Error("Relay returned an invalid encrypted progress event");
    return value;
  });
  const result = encrypted.resultEnvelope === undefined
    ? undefined
    : taskResultSchema.parse(
        decryptJson(encryptedEnvelopeSchema.parse(encrypted.resultEnvelope), key, eventAad(invitation.grantId, taskId, "result"))
      );
  const errorValue = encrypted.errorEnvelope === undefined
    ? undefined
    : decryptJson(encryptedEnvelopeSchema.parse(encrypted.errorEnvelope), key, eventAad(invitation.grantId, taskId, "error"));
  if (errorValue !== undefined && typeof errorValue !== "string") throw new Error("Relay returned an invalid encrypted error");
  if (encrypted.status === "completed" && result === undefined) throw new Error("Relay omitted the encrypted task result");
  if (encrypted.status === "failed" && errorValue === undefined) throw new Error("Relay omitted the encrypted task error");
  return {
    id: encrypted.id,
    grantId: encrypted.grantId,
    clientRequestId: encrypted.clientRequestId,
    request,
    status: encrypted.status,
    createdAt: encrypted.createdAt,
    updatedAt: encrypted.updatedAt,
    gatewayOnlineAtAcceptance: encrypted.gatewayOnlineAtAcceptance,
    progress,
    ...(result === undefined ? {} : { result }),
    ...(errorValue === undefined ? {} : { error: errorValue })
  };
}

export async function waitForTask(
  invitationUrl: string,
  taskId: string,
  options: { timeoutMs?: number; pollMs?: number; onProgress?: (message: string) => void } = {}
): Promise<StoredTask> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let seenProgress = 0;
  while (Date.now() < timeoutAt) {
    const task = await getTask(invitationUrl, taskId);
    for (const message of task.progress.slice(seenProgress)) options.onProgress?.(message);
    seenProgress = task.progress.length;
    if (task.status === "completed" || task.status === "failed") return task;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
  }
  throw new Error("Timed out while waiting for delegated task");
}
