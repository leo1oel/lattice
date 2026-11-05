/* eslint-disable lingui/no-unlocalized-strings -- bridge protocol keys shared with Tauri */
const IPC_SERIALIZE_KEY = "__TAURI_TO_IPC_KEY__";
const BINARY_MARKER = "__latticeBridgeBinary";
export type BridgeValue = null | boolean | number | string | BridgeValue[] | { [key: string]: BridgeValue };

export function encodeBridgeValue(value: unknown): BridgeValue {
  const encoded = JSON.stringify(value ?? null, (_key, current: unknown) => {
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      const bytes = current instanceof ArrayBuffer
        ? new Uint8Array(current)
        : new Uint8Array(current.buffer, current.byteOffset, current.byteLength);
      return { [BINARY_MARKER]: bytesToBase64(bytes) };
    }
    if (current && typeof current === "object") {
      const serialize = (current as Record<string, unknown>)[IPC_SERIALIZE_KEY];
      if (typeof serialize === "function") return serialize.call(current);
    }
    return current;
  });
  return JSON.parse(encoded) as BridgeValue;
}

export function decodeBridgeValue(value: BridgeValue): unknown {
  if (Array.isArray(value)) return value.map(decodeBridgeValue);
  if (value && typeof value === "object") {
    if (BINARY_MARKER in value && typeof value[BINARY_MARKER] === "string") {
      return Uint8Array.from(atob(value[BINARY_MARKER]), (character) => character.charCodeAt(0)).buffer;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeBridgeValue(child)]),
    );
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 24_576;
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded;
}

