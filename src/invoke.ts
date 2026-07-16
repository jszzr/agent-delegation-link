import { parseInvitationUrl } from "./capability.js";
import { taskRequestSchema, type StoredTask, type TaskRequest } from "./protocol.js";

export async function submitTask(invitationUrl: string, request: TaskRequest): Promise<{ taskId: string }> {
  const invitation = parseInvitationUrl(invitationUrl);
  const task = taskRequestSchema.parse(request);
  const response = await fetch(new URL(`/v1/grants/${invitation.grantId}/tasks`, invitation.relayOrigin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${invitation.secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(task)
  });
  if (!response.ok) throw new Error(`Task rejected: ${response.status} ${await response.text()}`);
  return (await response.json()) as { taskId: string };
}

export async function getTask(invitationUrl: string, taskId: string): Promise<StoredTask> {
  const invitation = parseInvitationUrl(invitationUrl);
  const response = await fetch(new URL(`/v1/tasks/${taskId}`, invitation.relayOrigin), {
    headers: { authorization: `Bearer ${invitation.secret}` }
  });
  if (!response.ok) throw new Error(`Unable to read task: ${response.status} ${await response.text()}`);
  return (await response.json()) as StoredTask;
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
