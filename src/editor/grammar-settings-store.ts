import { createStore } from "zustand/vanilla";
import { persistSetting } from "../settings/app-settings";

const GRAMMAR_SETTINGS_KEY = "lattice.grammar.v1";

export type GrammarDialect = "american" | "british";
/** Which rule set Harper checks with; `auto` is academic for LaTeX, standard elsewhere. */
export type GrammarProfileChoice = "auto" | "academic" | "standard";

/** The writer's grammar choices, for every project (Settings → Editor & builds). */
export type GrammarSettings = {
  dialect: GrammarDialect;
  profile: GrammarProfileChoice;
  /** Rules switched on or off over the profile, by Harper rule name. */
  rules: Readonly<Record<string, boolean>>;
};

type GrammarSettingsActions = {
  setDialect: (dialect: GrammarDialect) => void;
  setProfile: (profile: GrammarProfileChoice) => void;
  /** `null` gives the rule back to the profile. */
  setRule: (name: string, enabled: boolean | null) => void;
  resetRules: () => void;
};

const DEFAULTS: GrammarSettings = { dialect: "american", profile: "auto", rules: {} };

function loadGrammarSettings(): GrammarSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(GRAMMAR_SETTINGS_KEY) ?? "null") as Partial<GrammarSettings> | null;
    const rules = stored?.rules && typeof stored.rules === "object" && !Array.isArray(stored.rules)
      ? Object.fromEntries(Object.entries(stored.rules).filter(([, value]) => typeof value === "boolean"))
      : {};
    return {
      dialect: stored?.dialect === "british" ? "british" : DEFAULTS.dialect,
      profile: stored?.profile === "academic" || stored?.profile === "standard" ? stored.profile : DEFAULTS.profile,
      rules,
    };
  } catch {
    // A preference: unreadable storage falls back to the defaults.
    return DEFAULTS;
  }
}

/**
 * Held outside React because every open editor's Harper linter reads it at
 * lint time and re-lints when it changes (harper-spellcheck.ts), with no
 * component in between to hand it down.
 */
export const grammarSettingsStore = createStore<GrammarSettings & GrammarSettingsActions>()((set, get) => {
  const update = (patch: Partial<GrammarSettings>) => {
    set(patch);
    const { dialect, profile, rules } = get();
    persistSetting(GRAMMAR_SETTINGS_KEY, JSON.stringify({ dialect, profile, rules }));
  };
  return {
    ...loadGrammarSettings(),
    setDialect: (dialect) => update({ dialect }),
    setProfile: (profile) => update({ profile }),
    setRule: (name, enabled) => {
      const { [name]: _previous, ...rules } = get().rules;
      update({ rules: enabled === null ? rules : { ...rules, [name]: enabled } });
    },
    resetRules: () => update({ rules: {} }),
  };
});
