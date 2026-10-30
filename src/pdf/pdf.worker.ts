/**
 * PDF.js's worker entry. A worker shares none of the window's globals, so the
 * compatibility polyfills index.html runs before the app run here again,
 * ahead of PDF.js: the worker evaluates `Iterator.prototype` at its top level
 * and calls Promise.try, Promise.withResolvers and Math.sumPrecise, which the
 * oldest supported WKWebView (macOS 14) lacks. Imports evaluate in order, so
 * the polyfills install before the first line of PDF.js runs.
 *
 * The readable worker build, because patches/pdfjs-dist@*.patch edits it;
 * bundling it as a worker minifies it like the rest of the app. The bundle
 * drops the module's exports, which only PDF.js's main-thread fallback for a
 * worker that cannot start would read; the CSP's worker-src allows this one.
 */
// public/polyfills.js, through vite.config.ts.
import "virtual:webkit-polyfills";
import "pdfjs-dist/build/pdf.worker.mjs";
