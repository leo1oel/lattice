/**
 * The one PDF.js runtime setup: the worker URL. Every entry into pdfjs-dist
 * goes through here so a reference preview gets the same runtime as the main
 * viewer. The built-ins PDF.js 6 needs in older WKWebView releases are
 * installed before any module, by public/polyfills.js, in the window and (see
 * ./pdf.worker.ts) in the worker.
 */
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "./pdf.worker.ts?worker&url";

export { getDocument, PDFDataRangeTransport, PDFDateString } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = pdfWorker;
