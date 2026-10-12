import { pdfBytesFingerprint } from "../pdf/pdf-bytes";
import { loadRecentProjects, type RecentProject } from "../settings/app-settings";

/**
 * The first page of each recent project, as the welcome screen's desk shows
 * it: page 1 of the last PDF a build wrote, rendered small, with the venue
 * whose template that build typeset.
 *
 * Rendered once a burst of builds settles, never while the desk is drawn, so
 * the welcome screen only reads a few small images back. Kept in IndexedDB,
 * which every window of the app shares and which holds images without
 * inflating them to text, for the recent projects only: the list's newest
 * eight and the project that just built.
 */
export type FirstPage = {
  image: Blob;
  /** The conference template ("NeurIPS"), or null for a document that loads none. */
  venue: string | null;
  /**
   * When a build last wrote a PDF that differed from the stored one, which is
   * when the paper last changed. Null until a second PDF is seen: a project's
   * first page is stored the first time it builds, opened or not.
   */
  editedAt: number | null;
};

type StoredFirstPage = FirstPage & { fingerprint: string };

/** The desk holds three pages, one for each of ⌘1 to ⌘3. */
const WELCOME_DESK_SIZE = 3;

/** The recent projects the welcome screen's desk shows, in order: never the one launch could not reopen. */
export function welcomeDeskProjects(recents: readonly RecentProject[], unopenedPath: string | null | undefined) {
  return recents.filter((item) => item.path !== unopenedPath).slice(0, WELCOME_DESK_SIZE);
}

const DATABASE = "lattice.first-pages";
const STORE = "pages";
/** Twice the desk card's width, so the page stays sharp on a Retina screen. */
const RENDER_WIDTH = 480;
/** The paper colour the PDF preview draws pages on (`--pdf-page-surface`). */
const PAPER = "#F9F9FA";
/** Autosave builds after every pause in typing; the burst is rendered once, after it settles. */
const SETTLE_MS = 4000;

const pending = new Map<string, number>();

function request<T>(action: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    action.onsuccess = () => resolve(action.result);
    action.onerror = () => reject(action.error);
  });
}

/** The store, or null where there is no IndexedDB (tests, a locked-down web view): the desk then shows no pages. */
async function openStore(mode: IDBTransactionMode): Promise<{ store: IDBObjectStore; done: Promise<void> } | null> {
  if (typeof indexedDB === "undefined") return null;
  const opening = indexedDB.open(DATABASE, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  const database = await request(opening);
  const transaction = database.transaction(STORE, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }).finally(() => database.close());
  return { store: transaction.objectStore(STORE), done };
}

/** The stored first pages of `paths`; a project without one is absent. */
export async function loadFirstPages(paths: readonly string[]): Promise<Map<string, FirstPage>> {
  const pages = new Map<string, FirstPage>();
  const opened = await openStore("readonly").catch(() => null);
  if (!opened) return pages;
  const found = await Promise.all(paths.map((path) => request<StoredFirstPage | undefined>(opened.store.get(path)).catch(() => undefined)));
  await opened.done.catch(() => undefined);
  found.forEach((page, index) => {
    if (page?.image instanceof Blob) pages.set(paths[index], { image: page.image, venue: page.venue ?? null, editedAt: page.editedAt ?? null });
  });
  return pages;
}

/**
 * Remember `pdf` as the first page of the project at `root`, once its builds
 * settle. Called with every PDF a build writes; the copy is this module's, so
 * the preview may do as it likes with the original meanwhile.
 */
export function scheduleFirstPage(root: string, pdf: ArrayBuffer, venue: string | null) {
  window.clearTimeout(pending.get(root));
  const bytes = pdf.slice(0);
  pending.set(root, window.setTimeout(() => {
    pending.delete(root);
    void rememberFirstPage(root, bytes, venue).catch(() => undefined);
  }, SETTLE_MS));
}

export async function rememberFirstPage(root: string, pdf: ArrayBuffer, venue: string | null) {
  const fingerprint = pdfBytesFingerprint(pdf);
  const reading = await openStore("readonly");
  if (!reading) return;
  const stored = await request<StoredFirstPage | undefined>(reading.store.get(root));
  await reading.done;
  // An up-to-date rebuild (latexmk's "Nothing to do") hands back the same PDF.
  if (stored?.fingerprint === fingerprint && stored.venue === venue) return;
  const image = await renderFirstPage(pdf);
  if (!image) return;
  const editedAt = !stored ? null : stored.fingerprint === fingerprint ? stored.editedAt : Date.now();
  const writing = await openStore("readwrite");
  if (!writing) return;
  writing.store.put({ image, venue, editedAt, fingerprint } satisfies StoredFirstPage, root);
  // Only the projects the welcome screen can show keep a page.
  const keep = new Set([root, ...loadRecentProjects().map((item) => item.path)]);
  const keys = writing.store.getAllKeys();
  // In the success handler itself, while the transaction is still open for more requests.
  keys.onsuccess = () => {
    for (const key of keys.result) if (typeof key !== "string" || !keep.has(key)) writing.store.delete(key);
  };
  await writing.done;
}

async function renderFirstPage(pdf: ArrayBuffer): Promise<Blob | null> {
  // PDF.js stays out of startup: a build has already loaded it for the preview.
  const [{ getDocument }, { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL }] = await Promise.all([
    import("../pdf/pdfjs-runtime"),
    import("../pdf/pdf-viewer-utils"),
  ]);
  const loadingTask = getDocument({
    data: new Uint8Array(pdf),
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
    // As the main viewer: WKWebView can paint embedded Type 1 FontFace glyphs blank.
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const page = await (await loadingTask.promise).getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: RENDER_WIDTH / Math.max(1, natural.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport, background: PAPER }).promise;
    // A page of text on paper: a JPEG is a fraction of a PNG's size and reads the same at this scale.
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  } finally {
    await loadingTask.destroy();
  }
}
