import { msg } from "@lingui/core/macro";
import { i18n } from "../../i18n";

export async function fileToBase64(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function clipboardImageFileName(mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const extension = /jpe?g/.test(mimeType) ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  return `clipboard-${stamp}.${extension}`;
}

/** Encode a Tauri clipboard Image (RGBA) into a PNG data URL via canvas. */
export async function rgbaImageToPngBase64(
  rgba: Uint8Array | ArrayBuffer,
  width: number,
  height: number,
): Promise<string> {
  const bytes = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- canvas context id
  const context = canvas.getContext("2d");
  if (!context) throw new Error(i18n._(msg`Could not encode the clipboard image.`));
  const imageData = new ImageData(new Uint8ClampedArray(bytes), width, height);
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error(i18n._(msg`Could not encode PNG.`)))), "image/png");
  });
  return fileToBase64(blob);
}
