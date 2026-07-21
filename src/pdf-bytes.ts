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

export function pdfBase64ToObjectUrl(base64: string): string {
  return URL.createObjectURL(new Blob([pdfBase64ToBytes(base64)], { type: "application/pdf" }));
}
