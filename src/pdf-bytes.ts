/** Cheap fingerprint so identical rebuilds do not thrash the PDF viewer. */
export function pdfBase64Fingerprint(base64: string): string {
  const trimmed = base64.trim();
  if (!trimmed) return "";
  const head = trimmed.slice(0, 48);
  const tail = trimmed.slice(-48);
  return `${trimmed.length}:${head}:${tail}`;
}

export function pdfBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Cheap fingerprint so identical binary rebuilds do not reload pdf.js. */
export function pdfBytesFingerprint(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const head = bytes.subarray(0, 48);
  const tail = bytes.subarray(Math.max(0, bytes.length - 48));
  return `${bytes.length}:${Array.from(head).join(",")}:${Array.from(tail).join(",")}`;
}

export function pdfBytesToObjectUrl(buffer: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
