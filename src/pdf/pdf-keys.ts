/**
 * Forward SyncTeX's key, ⌘⇧J: App binds it, and the PDF toolbar and the PDF
 * panel's menu show it. Dependency-free so App can read it without loading
 * the viewer.
 */
export const REVEAL_IN_PDF_KEY = { key: "j", shift: true } as const;
