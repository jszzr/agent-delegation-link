export async function fetchWithTimeout(input: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Relay response exceeds the ${maxBytes} byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Relay response exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readLimitedText(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Relay returned invalid JSON");
  }
}
