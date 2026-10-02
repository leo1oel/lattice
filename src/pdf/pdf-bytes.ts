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
