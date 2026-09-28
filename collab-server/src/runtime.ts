/** Plumbing shared by the collab and literature Workers and their Durable Objects. */

export const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
export const typedError = (status: number, error: string): Response => json({ protocol: 2, error }, status);
export const logEvent = (event: string, fields: object, level: "info" | "warn" | "error" = "info"): void => console[level](JSON.stringify({ event, ...fields }));
export const retryDelay = (attempts: number): number => Math.min(5 * 60_000, 2_000 * (2 ** Math.min(8, Math.max(0, attempts - 1))));

/** Reads a whole stream, or returns `null` (after cancelling it) once it exceeds `limit`. A missing stream is empty. */
export async function readBounded(stream: ReadableStream<Uint8Array> | null | undefined, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let item = await reader.read(); !item.done; item = await reader.read()) {
    size += item.value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(item.value);
  }
  return concatBytes(chunks);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
