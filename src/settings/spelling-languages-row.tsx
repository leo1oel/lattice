import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { SettingsRow } from "../components/ui/settings-row";
import { spellingDictionaries, spellingLanguageName, type SpellingDictionary } from "../editor/document-spelling";

const replace = (_: SpellingDictionary[] | null, next: SpellingDictionary[]) => next;

/**
 * Settings → Editor: how a document in another language is checked, and the
 * dictionaries downloaded so far with the licence each came under.
 */
export function SpellingLanguagesRow() {
  const { t } = useLingui();
  const [dictionaries, setDictionaries] = useReducer(replace, null);
  useEffect(() => {
    let disposed = false;
    void spellingDictionaries().then((list) => {
      if (!disposed) setDictionaries(list);
    });
    return () => { disposed = true; };
  }, []);
  const downloaded = dictionaries?.filter((dictionary) => dictionary.installed) ?? [];
  return (
    <SettingsRow
      className="settings-project-dictionary-row"
      data-setting="spelling-languages"
      label={t`Other languages`}
      description={t`A document whose babel or polyglossia language isn't English is checked for spelling in that language. Its dictionary downloads from wooorm/dictionaries the first time it's needed.`}
    >
      {dictionaries && (
        <div className="settings-project-dictionary">
          {downloaded.length === 0 ? t`No dictionary downloaded yet` : (
            <div className="settings-project-dictionary-terms" role="list" aria-label={t`Downloaded dictionaries`}>
              {downloaded.map((dictionary) => {
                const name = spellingLanguageName(dictionary.code);
                const license = dictionary.license;
                return (
                  <span className="settings-project-dictionary-term" role="listitem" key={dictionary.code}>
                    {t`${name}, licensed ${license}`}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </SettingsRow>
  );
}
