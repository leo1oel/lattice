/**
 * Project PDFs, read a range at a time. `read_project_asset` reports a PDF's
 * length and version instead of its bytes, so a 1 GB scan opens as fast as a
 * short paper and is never held in memory whole. Each range comes from the
 * exact file version the backend checked: through raw IPC in a native window,
 * and straight from the browser host (not over its base64 bridge) in a
 * browser-hosted one.
 */
import { invoke } from "@tauri-apps/api/core";
import { isBrowserHosted, readBrowserHostAsset } from "../platform/browser-runtime";
import { PDFDataRangeTransport } from "./pdfjs-runtime";

export type ProjectPdfFile = { path: string; length: number; version: string };

/** The backend reads at most 16 MiB per request; ask in halves of that. */
const READ_BYTES = 8 * 1024 * 1024;

async function readPiece(file: ProjectPdfFile, start: number, end: number): Promise<Uint8Array> {
  const range = { path: file.path, version: file.version, start, end };
  const bytes = isBrowserHosted()
    ? await readBrowserHostAsset(range)
    : await invoke<ArrayBuffer>("read_project_asset_range", range);
  return new Uint8Array(bytes);
}

/** Bytes `[start, end)` of `file`, the whole file by default. */
export async function readProjectPdf(file: ProjectPdfFile, start = 0, end = file.length): Promise<Uint8Array<ArrayBuffer>> {
  const pieces: Promise<Uint8Array>[] = [];
  for (let offset = start; offset < end; offset += READ_BYTES) {
    pieces.push(readPiece(file, offset, Math.min(end, offset + READ_BYTES)));
  }
  const bytes = new Uint8Array(end - start);
  let offset = 0;
  for (const piece of await Promise.all(pieces)) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return bytes;
}

/** The project PDF at `path` as it is on disk now. */
export async function currentProjectPdf(path: string): Promise<ProjectPdfFile> {
  // `read_project_asset` reports every project PDF as ranges, never inline.
  const { ranges } = await invoke<{ ranges: Omit<ProjectPdfFile, "path"> }>("read_project_asset", { path });
  return { path, ...ranges };
}

/**
 * A PDF.js range transport over `file`. PDF.js's transport has no error
 * channel, so a failed read is reported to `onError` and left unanswered:
 * bytes that are not the file's must never reach the document. The owner
 * ends the load, or replaces the document once the file has a new version.
 */
export function projectPdfTransport(file: ProjectPdfFile, onError: (reason: unknown) => void): PDFDataRangeTransport {
  class ProjectPdfTransport extends PDFDataRangeTransport {
    private aborted = false;

    requestDataRange(begin: number, end: number) {
      readProjectPdf(file, begin, end).then(
        (bytes) => {
          if (!this.aborted) this.onDataRange(begin, bytes);
        },
        (reason: unknown) => {
          if (!this.aborted) onError(reason);
        },
      );
    }

    abort() {
      this.aborted = true;
    }
  }
  return new ProjectPdfTransport(file.length, null);
}
