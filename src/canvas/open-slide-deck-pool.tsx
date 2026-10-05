/**
 * Every open Open Slide deck keeps its editor frame for as long as its tab is
 * open in the project, not only while it is the active document. Each deck
 * renders into its own host (TrellisController.deckHost), which its document
 * panel adopts whether or not the deck is active, so switching to another
 * document — in the same panel or beside it — leaves the deck loaded, on the
 * page and with the panels it had open.
 *
 * Only the active deck streams Open Slide's events (its mutations, its
 * context) and refreshes from disk; an inactive one keeps its frame and its
 * runtime lease, and resumes after the shared event cursor when it becomes
 * active again (see OpenSlideWorkspace). A deck is released when its tab
 * closes, when the project changes, and while its panel has been off screen
 * long enough to hibernate (`sleeping`); it remounts on the page it last
 * reported.
 */
import { Suspense, useState, useSyncExternalStore, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import type { FileViewState } from "../app-types";
import { OpenSlideWorkspace } from "./canvas-lazy-editors";

type DeckProps = ComponentProps<typeof OpenSlideWorkspace>;

/** The active deck's own props; an inactive deck keeps the ones it was last handed. */
export type ActiveDeck = Pick<DeckProps, "path" | "source" | "editable">;

/** What every deck shares with the app: its settings follow it, and its callbacks act only while it is active. */
export type SharedDeckProps = Pick<DeckProps, "projectRoot" | "locale" | "theme" | "onMutation" | "onContext" | "onError">;

/** The decks to keep: every still-open one, the active one with its current props. */
function reconcileDecks(
  current: ReadonlyMap<string, ActiveDeck>,
  active: ActiveDeck | null,
  openPaths: readonly string[],
): Map<string, ActiveDeck> {
  const next = new Map<string, ActiveDeck>();
  for (const path of openPaths) {
    const retained = current.get(path);
    if (retained) next.set(path, retained);
  }
  if (active) next.set(active.path, active);
  return next;
}

/** Where each deck renders, and which decks sleep: their panel has been off screen long enough to unmount. */
export type DeckHosts = {
  host: (path: string) => HTMLElement;
  subscribe: (listener: () => void) => () => void;
  sleeping: () => readonly string[];
};

export function OpenSlideDeckPool({ shared, active, openPaths, hosts, getFileViewState, onFileViewState }: {
  shared: SharedDeckProps;
  active: ActiveDeck | null;
  /** The project's open tabs; the decks among them are kept. */
  openPaths: readonly string[];
  hosts: DeckHosts;
  getFileViewState?: (path: string) => FileViewState | undefined;
  onFileViewState?: (path: string, update: Partial<FileViewState>) => void;
}) {
  const { t } = useLingui();
  const sleeping = useSyncExternalStore(hosts.subscribe, hosts.sleeping);
  const { projectRoot } = shared;
  // Derived during render, as the earlier tab pool did, so a deck that was
  // closed or left behind by a project switch never renders once more.
  const [cache, setCache] = useState(() => ({ projectRoot, active, openPaths, decks: reconcileDecks(new Map(), active, openPaths) }));
  let decks = cache.decks;
  if (cache.projectRoot !== projectRoot || cache.active !== active || cache.openPaths !== openPaths) {
    decks = reconcileDecks(cache.projectRoot === projectRoot ? cache.decks : new Map(), active, openPaths);
    setCache({ projectRoot, active, openPaths, decks });
  }
  return (
    <>
      {Array.from(decks.values(), (deck) => {
        if (sleeping.includes(deck.path)) return null;
        const isActive = deck.path === active?.path;
        const key = `${projectRoot}\n${deck.path}`;
        return createPortal(
          <Suspense key={key} fallback={isActive && <div className="open-slide-status" aria-busy="true" aria-label={t`Starting Open Slide`} data-tour="open-slide-workspace" />}>
            <OpenSlideWorkspace
              {...shared}
              {...deck}
              active={isActive}
              // Read at mount only: a deck that remounts after hibernating returns to its page.
              initialViewState={getFileViewState?.(deck.path)?.openSlide}
              onViewState={(openSlide) => onFileViewState?.(deck.path, { openSlide })}
            />
          </Suspense>,
          hosts.host(deck.path),
          key,
        );
      })}
    </>
  );
}
