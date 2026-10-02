/**
 * The one PDF.js runtime setup: worker URL plus the polyfills PDF.js 6 needs
 * in older WKWebView releases. Every entry into pdfjs-dist goes through here
 * so a reference preview gets the same runtime as the main viewer.
 */
import { GlobalWorkerOptions } from "pdfjs-dist";
// The readable worker build, because patches/pdfjs-dist@*.patch edits it;
// bundling it as a worker minifies it like the rest of the app. The bundle
// drops the module's exports, which only PDF.js's main-thread fallback for a
// worker that cannot start would read; the CSP's worker-src allows this one.
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?worker&url";

export { getDocument, PDFDataRangeTransport } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = pdfWorker;

// PDF.js 6 uses Promise.withResolvers in its viewer code, while macOS 14's
// first WKWebView releases predate that method.
if (!("withResolvers" in Promise)) {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    },
  });
}

// WKWebView 18 does not expose the async iterator that PDF.js 5+ uses while
// streaming text. Supplying the standards-compatible adapter keeps PDFSlick's
// native text selection and search path working without a second PDF.js build.
if (typeof ReadableStream !== "undefined" && !(Symbol.asyncIterator in ReadableStream.prototype)) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    value: async function* streamAsyncIterator<T>(this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}
