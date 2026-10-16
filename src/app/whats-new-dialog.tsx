import { useEffect, useState, type ComponentType } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Bot, ChevronLeft, ChevronRight, ExternalLink, Feather, Gauge, GitBranch, Menu, MessageSquareText, Plug, Shapes, Sparkles, Undo2, Wrench,
} from "lucide-react";
import { ModalDialog } from "../components/ui/modal-dialog";
import { Button } from "../components/ui/button";
import { inLocale, loadReleaseNotes, RUNNING_VERSION, type ReleaseNotes } from "./whats-new";

/** The glyphs a highlight may name; anything else draws the sparkle. */
const ICONS: Record<string, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  bot: Bot, feather: Feather, gauge: Gauge, git: GitBranch, menu: Menu, message: MessageSquareText, plug: Plug,
  shapes: Shapes, sparkles: Sparkles, undo: Undo2,
};

/** Where a release's full notes live: the generated list under its lead. */
const releaseUrl = (version: string) => `https://github.com/leo1oel/lattice/releases/tag/v${version}`;

/** Unmounted while closed, so each opening starts at the running version. */
export function WhatsNewDialog({ open, ...props }: { open: boolean; onClose: () => void; onOpenUrl: (url: string) => void }) {
  return open ? <WhatsNewSheet {...props} /> : null;
}

/**
 * A dated sheet, not a slideshow: the running version's highlights, each a
 * glyph and a sentence, then its fixes and the full notes. A stepper pages
 * back through the releases bundled with this one (Raycast's), for a writer
 * who skipped some.
 */
function WhatsNewSheet({ onClose, onOpenUrl }: { onClose: () => void; onOpenUrl: (url: string) => void }) {
  const { t, i18n } = useLingui();
  const [releases, setReleases] = useState<ReleaseNotes[] | null>(null);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadReleaseNotes().then((notes) => {
      if (!cancelled) setReleases(notes);
    });
    return () => { cancelled = true; };
  }, []);
  const release = releases?.[index] ?? null;
  const date = release
    // eslint-disable-next-line lingui/no-unlocalized-strings -- an ISO time, not copy
    ? new Date(`${release.date}T12:00:00`).toLocaleDateString(i18n.locale, { year: "numeric", month: "long", day: "numeric" })
    : "";
  const shownVersion = release?.version ?? RUNNING_VERSION;
  return (
    <ModalDialog label={t`What’s new`} onClose={onClose}>
      <div className="modal whats-new-modal">
        <header className="whats-new-header">
          <h2>{t`What’s new`}</h2>
          <div className="whats-new-version" role="group" aria-label={t`Release`}>
            <button type="button" aria-label={t`Newer release`} title={t`Newer release`} disabled={index === 0} onClick={() => setIndex(index - 1)}>
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span aria-live="polite">
              <b>{shownVersion}</b>
              {shownVersion === RUNNING_VERSION && <em>{t`Running now`}</em>}
            </span>
            <button type="button" aria-label={t`Older release`} title={t`Older release`}
              disabled={!releases || index >= releases.length - 1} onClick={() => setIndex(index + 1)}>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </header>
        {release ? (
          <>
            <p className="whats-new-date">{date}</p>
            <div className="whats-new-body">
              <ol className="whats-new-list">
                {release.highlights.map((note) => {
                  const Icon = ICONS[note.icon ?? ""] ?? Sparkles;
                  return (
                    <li key={note.title.en}>
                      <span className="whats-new-icon" aria-hidden="true"><Icon size={15} aria-hidden /></span>
                      <div>
                        <strong>{inLocale(note.title, i18n.locale)}</strong>
                        {note.body && <p>{inLocale(note.body, i18n.locale)}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {release.fixes.length > 0 && (
                <section className="whats-new-fixes">
                  <h3><Wrench size={12} aria-hidden="true" />{t`Fixed`}</h3>
                  <ul>{release.fixes.map((fix) => <li key={fix.en}>{inLocale(fix, i18n.locale)}</li>)}</ul>
                </section>
              )}
            </div>
          </>
        ) : releases && <p className="whats-new-date">{t`No notes came with this version.`}</p>}
        <div className="modal-actions whats-new-actions">
          <Button variant="ghost" size="compact" className="whats-new-link" onClick={() => onOpenUrl(releaseUrl(shownVersion))}>
            {t`Full release notes`}<ExternalLink size={12} aria-hidden="true" />
          </Button>
          <Button variant="primary" onClick={onClose} autoFocus>{t`Done`}</Button>
        </div>
      </div>
    </ModalDialog>
  );
}
