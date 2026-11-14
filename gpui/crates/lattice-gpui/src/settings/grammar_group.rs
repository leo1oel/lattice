//! Settings › Editor & builds › Grammar (`grammar-settings.tsx`): the
//! English variant, the grammar style, single rules for every project, and
//! what the open project ignores.
//!
//! The choices are `Settings::grammar`, the Tauri app's `lattice.grammar.v1`
//! (imported from its storage on the first run); every open editor's check
//! reads them and checks again when they change. Harper's rules come from
//! lattice-core (`harper::rules`, the Tauri app's `harper_rules`), listed
//! once per run off the main thread. Without a filter only the rules worth
//! seeing are listed, those the grammar style turns off and those the writer
//! changed; a filter searches every rule, in English and in the interface
//! language, showing at most 40.

use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex, OnceLock, PoisonError},
};

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, IntoElement,
    ParentElement as _, SharedString, Styled as _, Subscription, Task, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::{harper::HarperRuleOut, project as core_project};
use lattice_editor::latex::spelling::{rule_label, rule_text};
use lattice_i18n::t;
use lattice_settings::{GrammarDialect, GrammarProfile};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field, IconButton},
};

use super::{
    controls::{self, PageWidth, Row, Wrap},
    dialog::SettingsDialog,
    editor_pane::row,
};
use crate::project::Project;

/// A filter shows at most this many rules; Harper has several hundred.
const MATCH_LIMIT: usize = 40;

/// Harper's rules, listed once for the run.
static RULES: OnceLock<Arc<Vec<HarperRuleOut>>> = OnceLock::new();

/// A rule's name as a row's `'static` id: rows and their switches are keyed
/// by it, and Harper's rule set is fixed for the run, so each name is
/// interned once.
fn interned(name: &str) -> &'static str {
    static NAMES: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);
    let mut names = NAMES.lock().unwrap_or_else(PoisonError::into_inner);
    let names = names.get_or_insert_with(HashSet::new);
    if let Some(known) = names.get(name) {
        return known;
    }
    let leaked: &'static str = Box::leak(format!("grammar-rule-{name}").into_boxed_str());
    names.insert(leaked);
    leaked
}

/// Why the academic profile turns each rule off (`ACADEMIC_RULE_REASONS`,
/// which lattice-core's `ACADEMIC_OFF` keeps in step).
fn academic_reason(rule: &str) -> Option<SharedString> {
    Some(
        match rule {
            "ExpandMemoryShorthands" => {
                t!("Papers write sizes with unit symbols such as GB and MB.")
            }
            "ExpandMinimum" => {
                t!("In a paper “min” is usually minutes or the minimum operator.")
            }
            "ExpandTimeShorthands" => {
                t!("Papers write durations with unit symbols such as ms and h.")
            }
            "LongSentences" => t!(
                "Academic sentences run long by convention, and hidden citations and math make the word count unreliable."
            ),
            "MoreAdjective" => {
                t!("It flags phrases like “most early in training”, which it says are not errors.")
            }
            "OxfordComma" => t!(
                "The serial comma is a house-style choice that venues and authors set differently."
            ),
            "PhrasalVerbAsCompoundNoun" => {
                t!("Technical writing uses nouns like “setup” and “rollout” on purpose.")
            }
            "SplitWords" => t!("It splits technical terms such as “softmax” and “sublayer”."),
            "ToTwoToo" => t!(
                "It reads ranges and quantities like “from easy to hard” or “sum to one” as a misspelled “too”."
            ),
            _ => return None,
        }
        .into(),
    )
}

/// The rules a filter finds, or with none the ones worth seeing
/// (`shownRules`).
fn shown_rules<'a>(
    all: &'a [HarperRuleOut],
    filter: &str,
    academic: bool,
    changed: &BTreeMap<String, bool>,
) -> Vec<&'a HarperRuleOut> {
    let query = filter.trim().to_lowercase();
    if query.is_empty() {
        return all
            .iter()
            .filter(|rule| (academic && rule.academic_off) || changed.contains_key(&rule.name))
            .collect();
    }
    let words: Vec<&str> = query.split_whitespace().collect();
    all.iter()
        .filter(|rule| {
            let (name, description) = rule_text(&rule.name, "");
            let haystack = format!(
                "{} {} {} {name} {description}",
                rule.name,
                rule_label(&rule.name),
                rule.description
            )
            .to_lowercase();
            words.iter().all(|word| haystack.contains(word))
        })
        .collect()
}

/// The group's own state: its filter, and Harper's rules once listed.
pub struct GrammarRules {
    filter: Entity<InputState>,
    rules: Option<Arc<Vec<HarperRuleOut>>>,
    _task: Option<Task<()>>,
    _subscription: Subscription,
}

impl GrammarRules {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder(t!("e.g. comma")));
        let subscription = cx.subscribe(&filter, |_, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                cx.notify();
            }
        });
        let rules = RULES.get().cloned();
        let task = rules.is_none().then(|| {
            let listed = cx.background_spawn(async { Arc::new(lattice_core::harper::rules()) });
            cx.spawn(async move |this, cx| {
                let rules = listed.await;
                let rules = RULES.get_or_init(|| rules).clone();
                this.update(cx, |this, cx| {
                    this.rules = Some(rules);
                    cx.notify();
                })
                .ok();
            })
        });
        Self {
            filter,
            rules,
            _task: task,
            _subscription: subscription,
        }
    }
}

/// Replace what the project ignores, through lattice-core's manifest.
fn set_ignores(project: &Entity<Project>, rules: Vec<String>, sentences: Vec<String>, cx: &mut App) {
    let root = project.read(cx).root().to_path_buf();
    match core_project::set_grammar_ignores(&root, rules, sentences) {
        Ok(_) => project.update(cx, |project, cx| project.reload_manifest(cx)),
        Err(error) => crate::notices::error(t!("Could not save the setting"), error, cx),
    }
}

/// A caption under the rules (`.settings-grammar-note`): 6px over and under,
/// in the tertiary ink.
fn note(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    controls::block(
        div()
            .py(px(6.))
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .text_color(cx.palette().text_secondary)
            .child(text.into()),
        true,
    )
}

/// A term with its remove button, as the project dictionary draws one.
fn chip(
    id: String,
    label: SharedString,
    tooltip: SharedString,
    on_remove: impl Fn(&mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex()
        .items_center()
        .gap(px(2.))
        .min_h(px(24.))
        .pl(px(8.))
        .pr(px(2.))
        .rounded(px(6.))
        .bg(palette.input)
        .border_1()
        .border_color(palette.line)
        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
        .text_color(palette.text)
        .child(div().min_w_0().child(label))
        .child(
            IconButton::new(ElementId::Name(id.into()), Icon::X)
                .frame(px(20.), px(20.))
                .icon_size(px(10.))
                .tooltip(tooltip)
                .on_click(move |_, _, cx| on_remove(cx)),
        )
        .into_any_element()
}

pub fn group(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let grammar = super::get(cx).grammar.clone();
    let state = dialog
        .pages
        .grammar
        .get_or_insert_with(|| cx.new(|cx| GrammarRules::new(window, cx)))
        .clone();
    let (filter_input, rules) = {
        let state = state.read(cx);
        (state.filter.clone(), state.rules.clone())
    };
    let filter = filter_input.read(cx).value().to_string();
    // The switch shows what LaTeX is checked with: the profile Automatic
    // picks there.
    let academic = grammar.profile != GrammarProfile::Standard;
    let changed = grammar.rules.len();

    let dialect = controls::select(
        "grammar-dialect",
        vec![
            (GrammarDialect::American, t!("American English").into()),
            (GrammarDialect::British, t!("British English").into()),
        ],
        grammar.dialect,
        |dialect, _, cx| super::update(cx, |settings| settings.grammar.dialect = dialect),
    );
    let style = controls::select(
        "grammar-style",
        vec![
            (GrammarProfile::Auto, t!("Automatic").into()),
            (GrammarProfile::Academic, t!("Academic").into()),
            (GrammarProfile::Standard, t!("Standard").into()),
        ],
        grammar.profile,
        |profile, _, cx| super::update(cx, |settings| settings.grammar.profile = profile),
    );
    let reset = Button::new("grammar-rules-reset", t!("Reset"))
        .disabled(changed == 0)
        .on_click(|_, _, cx| super::update(cx, |settings| settings.grammar.rules.clear()));
    let filter_control = div()
        .w(controls::CONTROL_WIDTH)
        .max_w_full()
        .flex()
        .items_center()
        .gap(px(4.))
        .child(div().flex_1().min_w_0().child(Field::new(&filter_input)))
        .child(reset);

    let mut rows = vec![
        row(
            dialog,
            Row::new("grammar-dialect", t!("English variant")).control(dialect),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("grammar-style", t!("Grammar style"))
                .description(
                    t!("Automatic checks LaTeX as academic writing and other files as everyday prose"),
                    cx,
                )
                .control(style),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("grammar-rules", t!("Grammar rules"))
                .description(
                    if changed > 0 {
                        t!("{changedCount} changed from the grammar style", changedCount = changed)
                    } else {
                        t!("Filter to find a rule; these apply to every project").to_string()
                    },
                    cx,
                )
                .control(filter_control),
            width,
            cx,
        ),
    ];
    if let Some(all) = &rules {
        let shown = shown_rules(all, &filter, academic, &grammar.rules);
        for rule in shown.iter().take(MATCH_LIMIT) {
            let profile_on = rule.default_on && !(academic && rule.academic_off);
            let on = grammar.rules.get(&rule.name).copied().unwrap_or(profile_on);
            let (name, description) = rule_text(&rule.name, &rule.description);
            let description = match academic_reason(&rule.name) {
                Some(reason) if rule.academic_off && academic => {
                    t!("Off for academic writing: {0}", reason).into()
                }
                _ => description,
            };
            let rule_name = rule.name.clone();
            let id = interned(&rule.name);
            rows.push(
                Row::new(id, name)
                    .description(description, cx)
                    .control(controls::switch(id, on, false, move |enabled, _, cx| {
                        let rule_name = rule_name.clone();
                        super::update(cx, move |settings| {
                            if enabled == profile_on {
                                settings.grammar.rules.remove(&rule_name);
                            } else {
                                settings.grammar.rules.insert(rule_name, enabled);
                            }
                        })
                    }))
                    .wrap(Wrap::Never)
                    .render(width, cx),
            );
        }
        let query = filter.trim();
        if query.is_empty() {
            rows.push(note(
                t!(
                    "Only rules the grammar style or you changed are listed. There are {ruleCount} rules in all; type in the filter to search every one.",
                    ruleCount = all.len()
                ),
                cx,
            ));
        } else if shown.is_empty() {
            rows.push(note(t!("No rule matches “{0}”", query), cx));
        }
        if shown.len() > MATCH_LIMIT {
            rows.push(note(
                // Lingui names one placeholder and numbers the other.
                lattice_i18n::fill_named(
                    lattice_i18n::tr(
                        "Showing {MATCH_LIMIT} of {0} rules; type more to narrow the list",
                    ),
                    &[("MATCH_LIMIT", &MATCH_LIMIT), ("0", &shown.len())],
                ),
                cx,
            ));
        }
    }
    rows.push(ignored_row(dialog, width, cx));
    controls::group(Some(t!("Grammar").into()), rows, cx)
}

/// What the open project ignores (`ProjectGrammarIgnores`): its rules as
/// chips, its sentences as a list, each with a way to check it again.
fn ignored_row(
    dialog: &SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let project = dialog.project.clone();
    let (rules, sentences) = project
        .as_ref()
        .map(|project| {
            let manifest = project.read(cx).manifest();
            (
                manifest.grammar_ignored_rules.clone(),
                manifest.grammar_ignored_sentences.clone(),
            )
        })
        .unwrap_or_default();
    let empty = rules.is_empty() && sentences.is_empty();
    let mut ignored = Row::new("grammar-ignored", t!("Ignored in this project"));
    let Some(project) = project else {
        return row(
            dialog,
            ignored.description(t!("Open a project to ignore rules or sentences"), cx),
            width,
            cx,
        );
    };
    if empty {
        ignored = ignored.description(t!("Choose Ignore on a grammar suggestion to add one"), cx);
        return row(dialog, ignored, width, cx);
    }
    let rule_chips = (!rules.is_empty()).then(|| {
        div()
            .flex()
            .flex_wrap()
            .gap(px(4.))
            .children(rules.iter().map(|rule| {
                let (name, _) = rule_text(rule, "");
                let project = project.clone();
                let others: Vec<String> = rules.iter().filter(|r| *r != rule).cloned().collect();
                let sentences = sentences.clone();
                chip(
                    format!("grammar-ignored-rule-{rule}"),
                    name.clone().into(),
                    t!("Check {0} again", name).into(),
                    move |cx| set_ignores(&project, others.clone(), sentences.clone(), cx),
                    cx,
                )
            }))
    });
    let sentence_list = (!sentences.is_empty()).then(|| {
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .children(sentences.iter().enumerate().map(|(index, sentence)| {
                let project = project.clone();
                let rules = rules.clone();
                let others: Vec<String> =
                    sentences.iter().filter(|s| *s != sentence).cloned().collect();
                div()
                    .min_w_0()
                    .flex()
                    .items_start()
                    .gap(px(4.))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .line_clamp(2)
                            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                            .text_color(palette.text_secondary)
                            .child(sentence.clone()),
                    )
                    .child(
                        IconButton::new(
                            ElementId::Name(format!("grammar-ignored-sentence-{index}").into()),
                            Icon::X,
                        )
                        .frame(px(20.), px(20.))
                        .icon_size(px(10.))
                        .tooltip(t!("Check this sentence again"))
                        .on_click(move |_, _, cx| {
                            set_ignores(&project, rules.clone(), others.clone(), cx)
                        }),
                    )
            }))
    });
    let control = div()
        .w(controls::CONTROL_WIDTH)
        .max_w_full()
        .flex()
        .flex_col()
        .gap(px(8.))
        .children(rule_chips)
        .children(sentence_list);
    row(dialog, ignored.control(control), width, cx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, academic_off: bool) -> HarperRuleOut {
        HarperRuleOut {
            name: name.into(),
            description: format!("Checks `{name}`."),
            default_on: true,
            academic_off,
        }
    }

    #[test]
    fn without_a_filter_only_the_rules_worth_seeing_are_listed() {
        let all = vec![rule("OxfordComma", true), rule("RepeatedWords", false), rule("Spaces", false)];
        let changed = BTreeMap::from([("Spaces".to_string(), false)]);
        let names = |shown: Vec<&HarperRuleOut>| -> Vec<String> {
            shown.into_iter().map(|rule| rule.name.clone()).collect()
        };
        assert_eq!(names(shown_rules(&all, "", true, &changed)), ["OxfordComma", "Spaces"]);
        assert_eq!(names(shown_rules(&all, "", false, &changed)), ["Spaces"]);
        assert_eq!(names(shown_rules(&all, "repeated", false, &changed)), ["RepeatedWords"]);
        assert_eq!(names(shown_rules(&all, "oxford comma", false, &changed)), ["OxfordComma"]);
    }

    #[test]
    fn a_rule_is_interned_once() {
        assert!(std::ptr::eq(interned("OxfordComma"), interned("OxfordComma")));
    }
}
