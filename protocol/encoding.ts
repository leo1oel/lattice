/**
 * Encoding helpers shared by the app and the collab Worker. Both runtimes
 * provide Web Crypto, `btoa`/`atob` and `TextEncoder`, so these are plain
 * functions of the platform with no dependencies.
 */

/** Unpadded URL-safe base64, the encoding of every secret, ticket and state vector on the wire. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (char) => char.charCodeAt(0));
}

/** 32 random bytes, base64url-encoded: guest secrets, salts and credentials. */
export function randomSecret(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** Lowercase hex SHA-256 of UTF-8 text or of raw bytes. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every depth, so equal values hash equally on client and server. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
