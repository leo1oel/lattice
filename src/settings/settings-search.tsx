import { type Ref, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { SearchField } from "../components/ui/search-field";
import { useCompositionGuard } from "../project/use-composition-guard";
import { searchSettings, settingsEntryKey, type SettingsSearchEntry } from "./settings-search-index";

/**
 * The search at the top of the Settings sidebar. While it holds a query its
 * results take the place of the page list; Up/Down move through them and
 * Enter opens one, as a click does.
 */
export function SettingsSearch({ inputRef, ...props }: {
  inputRef?: Ref<HTMLInputElement>;
  /** Settings opens here, as typing is how most people look for a setting: unless it opens covered. */
  autoFocus?: boolean;
  entries: readonly SettingsSearchEntry[];
  query: string;
  onQueryChange: (query: string) => void;
  /** The key of the entry last opened, marked among the results. */
  current: string | null;
  onOpen: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useLingui();
  const [active, setActive] = useState(0);
  const { compositionProps, isComposing } = useCompositionGuard();
  const results = searchSettings(props.entries, props.query);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const searching = props.query.trim().length > 0;
  return (
    <>
      <SearchField
        ref={inputRef}
        autoFocus={props.autoFocus ?? true}
        controlSize="compact"
        containerClassName="settings-search"
        aria-label={t`Search settings`}
        placeholder={t`Search`}
        value={props.query}
        aria-controls={searching ? "settings-search-results" : undefined}
        aria-activedescendant={searching && results.length ? `settings-search-result-${activeIndex}` : undefined}
        onChange={(event) => {
          setActive(0);
          props.onQueryChange(event.target.value);
        }}
        onClear={() => props.onQueryChange("")}
        {...compositionProps}
        onKeyDown={(event) => {
          if (isComposing(event) || !results.length) return;
          if (event.key === "ArrowDown") setActive(Math.min(activeIndex + 1, results.length - 1));
          else if (event.key === "ArrowUp") setActive(Math.max(activeIndex - 1, 0));
          else if (event.key === "Enter") props.onOpen(results[activeIndex]);
          else return;
          event.preventDefault();
        }}
      />
      {searching && (
        <div className="settings-search-results" id="settings-search-results" role="listbox" aria-label={t`Matching settings`}>
          {results.map((entry, index) => (
            <button
              key={settingsEntryKey(entry)}
              id={`settings-search-result-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              aria-current={settingsEntryKey(entry) === props.current ? "true" : undefined}
              className={index === activeIndex ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => props.onOpen(entry)}
            >
              <span className="settings-search-result-label">{entry.label}</span>
              <span className="settings-search-result-place">{entry.place}</span>
            </button>
          ))}
          {!results.length && <p className="settings-search-empty">{t`No matching settings`}</p>}
        </div>
      )}
    </>
  );
}
