import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import { notifyInfo, notifySuccess, notifyWarning } from "../telemetry/app-notify";

/**
 * A LaTeX document's language when it is not English, from
 * `spelling_document_language` (src-tauri/lattice-core/src/spelling.rs): the language its
 * babel or polyglossia options name, read from the compile root's preamble.
 * Such a document is checked for spelling with that language's dictionary
 * and never with Harper, whose English lints would flag every word.
 */
export type SpellingLanguage = {
  /** A BCP 47 tag ("fr", "de-CH"), or the option as written when it has no dictionary. */
  code: string;
  dictionary: "installed" | "missing" | "unavailable";
  license?: string | null;
  sizeKib?: number | null;
};

const isSpellingLanguage = (value: unknown): value is SpellingLanguage =>
  typeof value === "object" && value !== null && typeof (value as SpellingLanguage).code === "string";

/** `path`'s language in the project at `projectRoot`; null for English, which Harper checks. */
export async function documentSpellingLanguage(projectRoot: string, path: string): Promise<SpellingLanguage | null> {
  try {
    const language = await invoke<unknown>("spelling_document_language", { projectRoot, path });
    return isSpellingLanguage(language) ? language : null;
  } catch {
    // The project changed under the request; the next pass asks again.
    return null;
  }
}

/** The language's name in the interface language ("French", "法语"), else its code. */
export function spellingLanguageName(code: string): string {
  try {
    return new Intl.DisplayNames([i18n.locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const installed = new Set<() => void>();

/** Calls `listener` whenever a dictionary finishes downloading; returns the unsubscribe. */
export function onDictionaryInstalled(listener: () => void): () => void {
  installed.add(listener);
  return () => installed.delete(listener);
}

/** One attempt per language per session: a failed download is not retried on every lint pass. */
const installs = new Map<string, Promise<boolean>>();

/**
 * Download `language`'s dictionary the first time a document needs it,
 * telling the writer what is fetched and under which licence. A failure
 * (offline, say) leaves that language unchecked with a warning, and never
 * blocks the editor.
 */
export function installDictionary(language: SpellingLanguage): Promise<boolean> {
  const pending = installs.get(language.code);
  if (pending) return pending;
  const source = i18n._(msg`Spelling`);
  const name = spellingLanguageName(language.code);
  const dedupeKey = `spelling-dictionary:${language.code}`;
  const megabytes = ((language.sizeKib ?? 0) / 1024).toFixed(1);
  const license = language.license ?? "";
  notifyInfo(source, i18n._(msg`Downloading the ${name} spelling dictionary`), {
    detail: i18n._(msg`${megabytes} MB from wooorm/dictionaries, licensed ${license}. Until it arrives, spelling in this document isn't checked.`),
    progress: "indeterminate",
    dedupeKey,
  });
  const run = invoke("spelling_install_dictionary", { code: language.code }).then(() => {
    notifySuccess(source, i18n._(msg`${name} spelling is now checked`), {
      detail: i18n._(msg`The dictionary is licensed ${license}.`),
      dedupeKey,
    });
    for (const listener of installed) listener();
    return true;
  }, (reason: unknown) => {
    const error = String(reason);
    notifyWarning(source, i18n._(msg`Couldn't download the ${name} spelling dictionary`), {
      detail: i18n._(msg`Spelling in ${name} isn't checked. Lattice tries again the next time it opens. ${error}`),
      dedupeKey,
    });
    return false;
  });
  installs.set(language.code, run);
  return run;
}

const unavailableReported = new Set<string>();

/** Says once per session that a document's language has no dictionary, so its silence is explained. */
export function reportUnavailableLanguage(language: SpellingLanguage): void {
  if (unavailableReported.has(language.code)) return;
  unavailableReported.add(language.code);
  const name = language.code;
  notifyInfo(i18n._(msg`Spelling`), i18n._(msg`No spelling dictionary for “${name}”`), {
    detail: i18n._(msg`This document's babel or polyglossia language has no dictionary in Lattice, so its spelling isn't checked.`),
    dedupeKey: `spelling-unavailable:${name}`,
  });
}

/** Every dictionary Lattice can download, for Settings. */
export type SpellingDictionary = { code: string; license: string; installed: boolean };

export async function spellingDictionaries(): Promise<SpellingDictionary[]> {
  try {
    const list = await invoke<unknown>("spelling_dictionaries");
    return Array.isArray(list) ? list as SpellingDictionary[] : [];
  } catch {
    return [];
  }
}
