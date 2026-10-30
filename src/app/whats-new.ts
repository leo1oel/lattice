/**
 * What's new, quietly: the notes each release carries (src/release-notes,
 * written from the release's lead by scripts/release-notes.mjs), and whether
 * this launch is the first on a newer version. Like Linear and Notion, an
 * update never opens anything by itself: the first launch after one raises a
 * toast, and the sheet is a click from it, the palette and Help.
 */
import { msg } from "@lingui/core/macro";
import { version } from "../../package.json";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";

export type BilingualText = { en: string; zh: string };

export type ReleaseNotes = {
  version: string;
  /** YYYY-MM-DD, the day the release was cut. */
  date: string;
  /** `icon` names one of the sheet's glyphs (whats-new-dialog.tsx); without one it draws a sparkle. */
  highlights: Array<{ icon?: string; title: BilingualText; body?: BilingualText }>;
  fixes: BilingualText[];
};

/** The version running now, as bump-version.mjs keeps it in step everywhere. */
export const RUNNING_VERSION: string = version;

const LAST_RUN_KEY = "lattice.last-run-version.v1";

/** Compare two x.y.z versions numerically. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Every bundled release's notes up to the running version, newest first. */
export async function loadReleaseNotes(running = RUNNING_VERSION): Promise<ReleaseNotes[]> {
  // Read only when the sheet or the toast needs them: none of it belongs at startup.
  const { bundledReleaseNotes } = await import("./release-notes-bundle");
  return bundledReleaseNotes
    .filter((notes) => compareVersions(notes.version, running) <= 0)
    .sort((left, right) => compareVersions(right.version, left.version));
}

/**
 * The version this window last launched on, when it is older than the one
 * running now (the first launch after an update); null otherwise, including
 * the very first launch, which has nothing to compare with. Records the
 * running version either way, so the next launch says nothing.
 */
export function takeUpdatedFrom(running = RUNNING_VERSION): string | null {
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(LAST_RUN_KEY);
    localStorage.setItem(LAST_RUN_KEY, running);
  } catch {
    // Unavailable storage only means no notice this launch.
  }
  return previous && compareVersions(running, previous) > 0 ? previous : null;
}

/** A note's text in the interface language; Chinese falls back to English while untranslated. */
export const inLocale = (text: BilingualText, locale: string) => (locale.startsWith("zh") && text.zh ? text.zh : text.en);

/**
 * On the first launch after an update, one toast: the version now running,
 * its first highlights in a line, and "See what's new" (`open`). Returns a
 * cancel for a window that goes away before the notes load.
 */
export function announceUpdate(open: () => void): () => void {
  if (!takeUpdatedFrom()) return () => {};
  let cancelled = false;
  void loadReleaseNotes().then(([latest]) => {
    if (cancelled) return;
    const running = RUNNING_VERSION;
    const titles = latest?.version === running
      ? latest.highlights.slice(0, 3).map((note) => inLocale(note.title, i18n.locale))
      : [];
    notifyInfo(i18n._(msg`Lattice`), i18n._(msg`Updated to Lattice ${running}`), {
      ...(titles.length ? { detail: `${new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(titles)}${i18n._(msg({ message: ".", comment: "Ends the sentence listing a release's highlights" }))}` } : {}),
      timeoutMs: 0,
      dedupeKey: "whats-new",
      primaryAction: { label: i18n._(msg`See what’s new`), onClick: open },
    });
  });
  return () => { cancelled = true; };
}
