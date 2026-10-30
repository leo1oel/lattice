import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { grammarSettingsStore, type GrammarSettings } from "../editor/grammar-settings-store";
import type { GrammarIgnores } from "../editor/harper-spellcheck";
import { useStoreSlice } from "../hooks/use-store-slice";
import { ACADEMIC_RULE_REASONS, grammarRuleLabel } from "./grammar-rule-reasons";
import { SelectRow } from "./settings-controls";
import "./grammar-settings.css";

/** One rule as `harper_rules` lists it (src-tauri/src/harper.rs). */
type HarperRule = { name: string; description: string; defaultOn: boolean; academicOff: boolean };

/** A filter shows at most this many rules; Harper has several hundred. */
const MATCH_LIMIT = 40;

const selectSettings = ({ dialect, profile, rules }: GrammarSettings) => ({ dialect, profile, rules });

type RulesState = { rules: HarperRule[] | null; filter: string };
type RulesAction = { rules: HarperRule[] } | { filter: string };
const rulesReducer = (state: RulesState, action: RulesAction): RulesState => ({ ...state, ...action });

/**
 * The rules a filter finds, or with no filter the ones worth seeing: those
 * the academic profile turns off and those the writer changed.
 */
function shownRules(all: readonly HarperRule[], filter: string, changed: Readonly<Record<string, boolean>>): HarperRule[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return all.filter((rule) => rule.academicOff || rule.name in changed);
  const words = query.split(/\s+/);
  return all.filter((rule) => {
    const haystack = `${rule.name} ${grammarRuleLabel(rule.name)} ${rule.description}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Settings → Editor & builds → Grammar: the dialect, the profile, single
 * rules for every project, and what the open project ignores.
 */
export function GrammarSettingsGroup({ ignores, onIgnoresChange }: {
  /** The open project's ignores; null without a project. */
  ignores: GrammarIgnores | null;
  onIgnoresChange: (ignores: GrammarIgnores) => void;
}) {
  const { t, i18n } = useLingui();
  const settings = useStoreSlice(grammarSettingsStore, selectSettings);
  const [{ rules, filter }, dispatch] = useReducer(rulesReducer, { rules: null, filter: "" });
  useEffect(() => {
    let disposed = false;
    void invoke<HarperRule[]>("harper_rules").then((loaded) => {
      if (!disposed) dispatch({ rules: loaded });
    }, () => undefined);
    return () => { disposed = true; };
  }, []);
  const { setDialect, setProfile, setRule, resetRules } = grammarSettingsStore.getState();
  const shown = rules ? shownRules(rules, filter, settings.rules) : [];
  const changedCount = Object.keys(settings.rules).length;
  // The switch shows what LaTeX is checked with: the profile Automatic picks there.
  const academic = settings.profile !== "standard";
  const describe = (rule: HarperRule) => {
    const reason = ACADEMIC_RULE_REASONS[rule.name];
    if (rule.academicOff && academic && reason) return t`Off for academic writing: ${i18n._(reason)}`;
    return rule.description.replace(/`/g, "");
  };

  return (
    <SettingsGroup title={t`Grammar`}>
      <SelectRow
        data-setting="grammar-dialect"
        label={t`English variant`}
        value={settings.dialect}
        options={{ american: t`American English`, british: t`British English` }}
        onChange={setDialect}
      />
      <SelectRow
        data-setting="grammar-style"
        label={t`Grammar style`}
        description={t`Automatic checks LaTeX as academic writing and other files as everyday prose`}
        value={settings.profile}
        options={{ auto: t`Automatic`, academic: t`Academic`, standard: t`Standard` }}
        onChange={setProfile}
      />
      <SettingsRow
        className="settings-grammar-rules-row"
        data-setting="grammar-rules"
        label={t`Grammar rules`}
        description={changedCount > 0
          ? t`${changedCount} changed from the grammar style`
          : t`Filter to find a rule; these apply to every project`}
      >
        <div className="settings-grammar-rules">
          <div className="settings-grammar-rules-filter">
            <Input
              aria-label={t`Filter grammar rules`}
              placeholder={t`e.g. comma`}
              value={filter}
              onChange={(event) => dispatch({ filter: event.target.value })}
            />
            <Button disabled={changedCount === 0} onClick={resetRules}>{t`Reset`}</Button>
          </div>
        </div>
      </SettingsRow>
      {rules && shown.slice(0, MATCH_LIMIT).map((rule) => {
        const profileOn = rule.defaultOn && !(academic && rule.academicOff);
        return (
          <SwitchField
            key={rule.name}
            className="settings-grammar-rule"
            label={grammarRuleLabel(rule.name)}
            description={describe(rule)}
            checked={settings.rules[rule.name] ?? profileOn}
            onChange={(enabled) => setRule(rule.name, enabled === profileOn ? null : enabled)}
          />
        );
      })}
      {rules && filter.trim() && shown.length === 0 && (
        <p className="settings-grammar-note">{t`No rule matches “${filter.trim()}”`}</p>
      )}
      {shown.length > MATCH_LIMIT && (
        <p className="settings-grammar-note">{t`Showing ${MATCH_LIMIT} of ${shown.length} rules; type more to narrow the list`}</p>
      )}
      <ProjectGrammarIgnores ignores={ignores} onIgnoresChange={onIgnoresChange} />
    </SettingsGroup>
  );
}

function ProjectGrammarIgnores({ ignores, onIgnoresChange }: {
  ignores: GrammarIgnores | null;
  onIgnoresChange: (ignores: GrammarIgnores) => void;
}) {
  const { t } = useLingui();
  const empty = !ignores || (ignores.rules.length === 0 && ignores.sentences.length === 0);
  return (
    <SettingsRow
      className="settings-grammar-rules-row"
      data-setting="grammar-ignored"
      label={t`Ignored in this project`}
      description={!ignores
        ? t`Open a project to ignore rules or sentences`
        : empty ? t`Choose Ignore on a grammar suggestion to add one` : undefined}
    >
      {ignores && !empty && (
        <div className="settings-grammar-ignored">
          {ignores.rules.length > 0 && (
            <div className="settings-project-dictionary-terms" role="list" aria-label={t`Ignored grammar rules`}>
              {ignores.rules.map((rule) => (
                <span className="settings-project-dictionary-term" role="listitem" key={rule}>
                  <span>{grammarRuleLabel(rule)}</span>
                  <button
                    type="button"
                    className="settings-project-dictionary-remove"
                    aria-label={t`Check ${grammarRuleLabel(rule)} again`}
                    onClick={() => onIgnoresChange({ ...ignores, rules: ignores.rules.filter((existing) => existing !== rule) })}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </span>
              ))}
            </div>
          )}
          {ignores.sentences.length > 0 && (
            <ul className="settings-grammar-sentences" aria-label={t`Ignored sentences`}>
              {ignores.sentences.map((sentence) => (
                <li key={sentence}>
                  <span className="settings-grammar-sentence" title={sentence}>{sentence}</span>
                  <button
                    type="button"
                    className="settings-project-dictionary-remove"
                    aria-label={t`Check this sentence again`}
                    onClick={() => onIgnoresChange({ ...ignores, sentences: ignores.sentences.filter((existing) => existing !== sentence) })}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsRow>
  );
}
