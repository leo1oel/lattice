import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

/** A Harper rule as the interface names and explains it. */
export type GrammarRuleText = { name: string; description: string };
type GrammarRuleCatalog = Readonly<Record<string, GrammarRuleText>>;

/**
 * Harper names and describes its ~800 rules in English only, so each other
 * interface language keeps a table of every rule beside its Lingui catalog.
 * A table is loaded on first use and never in the eager bundle. A test in
 * src-tauri/src/harper.rs fails when Harper has a rule a table lacks, so a
 * Harper upgrade surfaces its new rules for translation.
 */
const catalogLoaders: Readonly<Record<string, () => Promise<{ default: GrammarRuleCatalog }>>> = {
  "zh-CN": () => import("../locales/zh-CN/grammar-rules.json"),
};
const catalogs = new Map<string, GrammarRuleCatalog>();
const pendingCatalogs = new Map<string, Promise<void>>();

/** Loads the rule table for `locale`, if it has one; resolves once it is ready. */
export function loadGrammarRuleCatalog(locale: string = i18n.locale): Promise<void> {
  const load = catalogLoaders[locale];
  if (!load || catalogs.has(locale)) return Promise.resolve();
  let pending = pendingCatalogs.get(locale);
  if (!pending) {
    pending = load().then(({ default: catalog }) => {
      catalogs.set(locale, catalog);
    }, () => {
      // English stays on screen; the next caller tries again.
      pendingCatalogs.delete(locale);
    });
    pendingCatalogs.set(locale, pending);
  }
  return pending;
}

/** Harper's own rule name made readable: "PhrasalVerbAsCompoundNoun" → "Phrasal verb as compound noun". */
export function grammarRuleLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return words.charAt(0) + words.slice(1).toLowerCase();
}

/**
 * A rule's name and description in `locale` once its table is loaded, else
 * in English from Harper's name and Markdown description.
 */
export function grammarRuleText(rule: string, englishDescription = "", locale: string = i18n.locale): GrammarRuleText {
  return catalogs.get(locale)?.[rule]
    ?? { name: grammarRuleLabel(rule), description: englishDescription.replace(/`/g, "") };
}

/**
 * Harper words each finding itself, mostly from a handful of sentence
 * shapes around the words it quotes. These are the shapes worth
 * translating; any other finding keeps Harper's English sentence.
 */
const MESSAGE_SHAPES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => MessageDescriptor]> = [
  [/^Did you mean `([^`]+)`\?$/, ([, word]) => msg`Did you mean “${word}”?`],
  [/^Did you mean to spell `([^`]+)` this way\?$/, ([, word]) => msg`Is “${word}” misspelled?`],
  [/^Did you mean `([^`]+)` or `([^`]+)`\?$/, ([, first, second]) => msg`Did you mean “${first}” or “${second}”?`],
  [/^Did you mean the closed compound `([^`]+)`\?$/, ([, word]) => msg`Did you mean the closed compound “${word}”?`],
  [/^It looks like this is a typo, did you mean `([^`]+)`\?$/, ([, word]) => msg`This looks like a typo. Did you mean “${word}”?`],
  [/^Use `([^`]+)` instead of `([^`]+)`\.?$/, ([, word, original]) => msg`Use “${word}” instead of “${original}”.`],
  [/^The correct idiom is `([^`]+)`\.$/, ([, idiom]) => msg`The correct idiom is “${idiom}”.`],
  [/^The correct plural is `([^`]+)`\.$/, ([, plural]) => msg`The correct plural is “${plural}”.`],
  [/^This sentence is (\d+) words long\.$/, ([, count]) => msg`This sentence is ${count} words long.`],
  [/^Did you mean to repeat this word\?$/, () => msg`Did you mean to repeat this word?`],
  [/^Incorrect indefinite article\.$/, () => msg`Incorrect indefinite article.`],
  [/^This sentence does not start with a capital letter$/, () => msg`This sentence does not start with a capital letter.`],
];

/**
 * A grammar or spelling finding as a non-English interface shows it: the
 * rule's translated name and description, then Harper's own sentence,
 * translated when it has one of the shapes above and otherwise kept in
 * English (`translated: false`) rather than guessed at. Null in English or
 * before the language's table has loaded: Harper's sentence alone says it.
 */
export function grammarFinding(rule: string, message: string, locale: string = i18n.locale):
  (GrammarRuleText & { detail: string; translated: boolean }) | null {
  const text = catalogs.get(locale)?.[rule];
  if (!text) return null;
  for (const [shape, describe] of MESSAGE_SHAPES) {
    const match = shape.exec(message);
    if (match) return { ...text, detail: i18n._(describe(match)), translated: true };
  }
  return { ...text, detail: message.replace(/`([^`]*)`/g, "“$1”"), translated: false };
}
