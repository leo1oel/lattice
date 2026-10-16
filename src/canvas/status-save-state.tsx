import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { CircleAlert, CloudCheck, CloudOff, HardDrive, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { relativeTime } from "../app-utils";
import type { SaveSlot } from "./save-slot";

/** How often the age ("2m ago") is read again while the slot is on screen. */
const AGE_REFRESH_MS = 30_000;

/** The age of a write, re-read every half minute while shown. */
function useAge(at: number | null): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), AGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [at]);
  return at === null ? null : relativeTime(new Date(at).toISOString());
}

/**
 * The status bar's save slot, after the caret: one quiet line that says the
 * text is on disk ("Saved · just now"), and with a linked Overleaf project,
 * in other words, whether it has reached Overleaf too ("Saved · Synced"),
 * as Pitch keeps "on this computer" apart from "in the cloud". It never
 * alarms about unsaved typing (the tab's dot says that, and autosave follows
 * in a second); working offline is neutral; only a write that failed is red,
 * and its popover says why, that nothing is lost, and how to get the text out.
 */
export function StatusSaveState({ slot, path }: { slot: SaveSlot; path: string }) {
  const { t } = useLingui();
  const { status, overleaf } = slot;
  const age = useAge(status.at);
  const file = (status.path ?? path).slice((status.path ?? path).lastIndexOf("/") + 1);
  const synced = overleaf?.lastSync ? relativeTime(overleaf.lastSync) : null;
  const failed = status.phase === "failed";
  const offline = overleaf?.state === "offline";
  const label = failed ? t`Couldn’t save`
    : status.phase === "saving" ? t`Saving…`
      : offline ? t`Saved on this Mac`
        : overleaf?.state === "live" ? t`Saved · Synced`
          : overleaf?.state === "syncing" || overleaf?.state === "sending" ? t`Saved · Syncing…`
            : t`Saved`;
  // The age is the disk's, so it stays off a label that already speaks of Overleaf.
  const showAge = !failed && status.phase === "saved" && age !== null && (!overleaf || overleaf.state === "manual" || overleaf.state === "paused");
  const icon = failed ? <CircleAlert size={12} aria-hidden="true" />
    : status.phase === "saving" || overleaf?.state === "syncing" || overleaf?.state === "sending" ? <LoaderCircle size={12} aria-hidden="true" className="animate-spin" />
      : offline ? <CloudOff size={12} aria-hidden="true" />
        : overleaf?.state === "live" ? <CloudCheck size={12} aria-hidden="true" />
          : <HardDrive size={12} aria-hidden="true" />;
  const mode = failed ? "error" : offline ? "offline" : "saved";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="status-item status-save"
          data-mode={mode}
          title={t`Save state`}
          aria-label={showAge ? `${label}, ${age}` : label}
        >
          {icon}
          <span className="status-save-label">{label}</span>
          {showAge && <span className="status-save-age">{age}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="word-count-popover save-state-popover" aria-label={t`Save state`}>
        {failed ? (
          <>
            <strong>{t`Lattice couldn’t write ${file}`}</strong>
            {status.error && <p className="save-state-reason">{status.error}</p>}
            <p>{t`Your text is safe in this window; nothing has been lost. Try again, or save a copy somewhere else.`}</p>
            <div className="save-state-actions">
              <Button size="compact" onClick={slot.onRetry}>{t`Try again`}</Button>
              <Button variant="ghost" size="compact" onClick={slot.onSaveCopy}>{t`Save a copy…`}</Button>
            </div>
          </>
        ) : offline ? (
          <>
            <strong>{t`Working offline`}</strong>
            <p>{t`Your changes are saved on this Mac. They’ll sync to Overleaf when the connection is back.`}</p>
            <dl>
              <div><dt>{t`Last synced`}</dt><dd>{synced ?? t`Not yet`}</dd></div>
            </dl>
            <div className="save-state-actions">
              <Button variant="ghost" size="compact" onClick={slot.onSync}><RefreshCw size={12} aria-hidden="true" />{t`Try now`}</Button>
            </div>
          </>
        ) : (
          <>
            <dl>
              <div>
                <dt>{t`On this Mac`}</dt>
                <dd>{status.phase === "saving" ? t`Saving…` : age ? t`Saved ${age}` : t`Saved`}</dd>
                <dd className="word-count-note">{t`${file} · saves a second after you stop typing`}</dd>
              </div>
              {overleaf && (
                <div>
                  <dt>{t`Overleaf`}</dt>
                  <dd>
                    {overleaf.state === "live" ? t`Live`
                      : overleaf.state === "syncing" || overleaf.state === "sending" ? t`Syncing…`
                        : overleaf.state === "paused" ? t`Sync paused`
                          : synced ? t`Synced ${synced}` : t`Not synced yet`}
                  </dd>
                  <dd className="word-count-note">
                    {overleaf.state === "live" || overleaf.state === "sending" ? t`Co-authors see your edits as you type`
                      : overleaf.state === "paused" ? t`Resume the link in Overleaf settings to sync again`
                        : t`Co-authors see your changes once you sync`}
                  </dd>
                </div>
              )}
            </dl>
            {overleaf?.state === "manual" && (
              <div className="save-state-actions">
                <Button variant="ghost" size="compact" onClick={slot.onSync}><RefreshCw size={12} aria-hidden="true" />{t`Sync now`}</Button>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
