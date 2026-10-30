import type { ReleaseNotes } from "./whats-new";

// Every release's notes in one chunk, imported only when the sheet or the
// toast needs them. A lazy glob in whats-new.ts put one loader per release
// into the startup bundle, so each release grew the eager JS budget's count.
// eslint-disable-next-line lingui/no-unlocalized-strings -- a module path
const notesFiles = import.meta.glob<ReleaseNotes>("../release-notes/*.json", { import: "default", eager: true });

export const bundledReleaseNotes: ReleaseNotes[] = Object.values(notesFiles);
