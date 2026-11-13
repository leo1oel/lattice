//! The lint card over a spell or grammar finding (`.cm-tooltip-lint` in the
//! Tauri app), and how a finding is worded in the interface language
//! (`grammar-rule-text.ts`): the hover provider the check puts on its
//! editor, its fixes and the project actions it offers.

use std::{cell::RefCell, collections::HashMap, rc::Rc, sync::LazyLock};

use gpui::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px, relative,
};
use language::{Buffer, BufferSnapshot, ToOffset as _};
use lattice_i18n::{Locale, t};
use lattice_ui::{ActiveLattice as _, Elevation};
use regex::Regex;

use super::{Anchored, Finding, Ignore, Spelling, SpellingEvent, Suggestion};
use crate::{
    hover::{HoverProvider, HoverTarget},
    latex::diagnostics::Severity,
};

/// The lint card over a finding.
pub(super) struct LintCards {
    pub(super) shown: Rc<RefCell<Vec<Anchored>>>,
    pub(super) spelling: WeakEntity<Spelling>,
    pub(super) buffer: gpui::WeakEntity<Buffer>,
}

impl HoverProvider for LintCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, _: &App) -> Option<HoverTarget> {
        let shown = self.shown.borrow();
        let hits: Vec<Anchored> = shown
            .iter()
            .filter(|anchored| {
                let range =
                    anchored.range.start.to_offset(text)..anchored.range.end.to_offset(text);
                offset >= range.start && offset < range.end
            })
            .cloned()
            .collect();
        if hits.is_empty() {
            return None;
        }
        let start = hits
            .iter()
            .map(|hit| hit.range.start.to_offset(text))
            .min()?;
        let end = hits.iter().map(|hit| hit.range.end.to_offset(text)).max()?;
        let spelling = self.spelling.clone();
        let buffer = self.buffer.clone();
        Some(HoverTarget {
            range: start..end,
            id: "spelling",
            card: Rc::new(move |context, _, _| {
                LintCard {
                    hits: hits.clone(),
                    spelling: spelling.clone(),
                    buffer: buffer.clone(),
                    max_width: context.max_width,
                }
                .into_any_element()
            }),
        })
    }
}

/// Harper's sentence shapes worth translating (`MESSAGE_SHAPES` in
/// `grammar-rule-text.ts`); any other finding keeps Harper's English.
fn translated_detail(message: &str) -> Option<String> {
    type Shape = (&'static str, fn(&regex::Captures) -> String);
    static SHAPES: LazyLock<Vec<(Regex, fn(&regex::Captures) -> String)>> = LazyLock::new(|| {
        let shapes: Vec<Shape> = vec![
            (r"^Did you mean `([^`]+)`\?$", |m| {
                t!("Did you mean “{word}”?", word = &m[1]).to_string()
            }),
            (r"^Did you mean to spell `([^`]+)` this way\?$", |m| {
                t!("Is “{word}” misspelled?", word = &m[1]).to_string()
            }),
            (r"^Did you mean `([^`]+)` or `([^`]+)`\?$", |m| {
                t!(
                    "Did you mean “{first}” or “{second}”?",
                    first = &m[1],
                    second = &m[2]
                )
                .to_string()
            }),
            (r"^Did you mean the closed compound `([^`]+)`\?$", |m| {
                t!("Did you mean the closed compound “{word}”?", word = &m[1]).to_string()
            }),
            (
                r"^It looks like this is a typo, did you mean `([^`]+)`\?$",
                |m| {
                    t!(
                        "This looks like a typo. Did you mean “{word}”?",
                        word = &m[1]
                    )
                    .to_string()
                },
            ),
            (r"^Use `([^`]+)` instead of `([^`]+)`\.?$", |m| {
                t!(
                    "Use “{word}” instead of “{original}”.",
                    word = &m[1],
                    original = &m[2]
                )
                .to_string()
            }),
            (r"^The correct idiom is `([^`]+)`\.$", |m| {
                t!("The correct idiom is “{idiom}”.", idiom = &m[1]).to_string()
            }),
            (r"^The correct plural is `([^`]+)`\.$", |m| {
                t!("The correct plural is “{plural}”.", plural = &m[1]).to_string()
            }),
            (r"^This sentence is (\d+) words long\.$", |m| {
                t!("This sentence is {count} words long.", count = &m[1]).to_string()
            }),
            (r"^Did you mean to repeat this word\?$", |_| {
                t!("Did you mean to repeat this word?").to_string()
            }),
            (r"^Incorrect indefinite article\.$", |_| {
                t!("Incorrect indefinite article.").to_string()
            }),
            (
                r"^This sentence does not start with a capital letter$",
                |_| t!("This sentence does not start with a capital letter.").to_string(),
            ),
        ];
        shapes
            .into_iter()
            .map(|(pattern, describe)| (Regex::new(pattern).unwrap(), describe))
            .collect()
    });
    SHAPES
        .iter()
        .find_map(|(shape, describe)| shape.captures(message).map(|m| describe(&m)))
}

/// A Harper rule's name and description in Simplified Chinese
/// (`src/locales/zh-CN/grammar-rules.json`, which a lattice-core test keeps
/// complete).
fn rule_text_zh(rule: &str) -> Option<(String, String)> {
    static CATALOG: LazyLock<HashMap<String, (String, String)>> = LazyLock::new(|| {
        let json: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../src/locales/zh-CN/grammar-rules.json"
        ))
        .unwrap_or_default();
        json.as_object()
            .map(|rules| {
                rules
                    .iter()
                    .filter_map(|(name, text)| {
                        Some((
                            name.clone(),
                            (
                                text.get("name")?.as_str()?.to_string(),
                                text.get("description")?.as_str()?.to_string(),
                            ),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    CATALOG.get(rule).cloned()
}

/// How a finding reads in the interface language (`grammarFinding`): in
/// English, Harper's sentence; otherwise the rule's name and description,
/// then the sentence translated, or Harper's own with its quotes curled and
/// marked as the original.
struct Wording {
    rule: Option<(String, String)>,
    detail: String,
    original: bool,
}

/// How the lint card words `finding` in the interface language now: the
/// rule's name, when the language translates it, and the finding.
pub fn describe(finding: &Finding) -> (Option<String>, String) {
    let wording = wording(finding);
    (wording.rule.map(|(name, _)| name), wording.detail)
}

fn wording(finding: &Finding) -> Wording {
    let plain = Wording {
        rule: None,
        detail: finding.message.clone(),
        original: false,
    };
    if lattice_i18n::locale() != Locale::ZhCn {
        return plain;
    }
    let Some(rule) = finding.rule.as_deref().and_then(rule_text_zh) else {
        return plain;
    };
    match translated_detail(&finding.message) {
        Some(detail) => Wording {
            rule: Some(rule),
            detail,
            original: false,
        },
        None => {
            static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`]*)`").unwrap());
            Wording {
                rule: Some(rule),
                detail: QUOTED.replace_all(&finding.message, "“$1”").into_owned(),
                original: true,
            }
        }
    }
}

/// CodeMirror's lint tooltip as the Tauri app styles it
/// (`.cm-tooltip-lint` in editor-workspace.css): one row per finding with
/// a 5px edge in its severity's colour, the finding, its actions as small
/// outlined buttons, and what checked it.
#[derive(IntoElement)]
struct LintCard {
    hits: Vec<Anchored>,
    spelling: WeakEntity<Spelling>,
    buffer: gpui::WeakEntity<Buffer>,
    max_width: gpui::Pixels,
}

impl RenderOnce for LintCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let action = |id: SharedString, label: String| {
            div()
                .id(id)
                .min_h(px(24.))
                .px(px(8.))
                .py(px(3.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .border_1()
                .border_color(palette.line_strong)
                .bg(palette.raised)
                .text_color(palette.text_secondary)
                .line_height(relative(1.25))
                .cursor_pointer()
                .hover(|style| style.bg(palette.hover).text_color(palette.text))
                .child(label)
        };
        div()
            .flex()
            .flex_col()
            .max_w(px(440.).min(self.max_width))
            .rounded(px(6.))
            .overflow_hidden()
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .font_family(editor_font)
            .text_size(px(13.))
            .line_height(relative(1.45))
            .children(self.hits.into_iter().enumerate().map(|(ix, hit)| {
                let finding = hit.finding.clone();
                let wording = wording(&finding);
                let mut actions = Vec::new();
                if let Some(suggestion) = finding.suggestion.clone() {
                    let label = match &suggestion {
                        Suggestion::Remove => t!("Remove").to_string(),
                        Suggestion::InsertAfter(text) => {
                            t!("Insert “{replacement}”", replacement = text).to_string()
                        }
                        Suggestion::Replace(text) => {
                            t!("Replace with “{replacement}”", replacement = text).to_string()
                        }
                    };
                    let buffer = self.buffer.clone();
                    let range = hit.range.clone();
                    actions.push(
                        action(format!("spelling-fix-{ix}").into(), label)
                            .on_click(move |_, _, cx| {
                                if let Some(buffer) = buffer.upgrade() {
                                    Spelling::apply(&buffer, range.clone(), &suggestion, cx);
                                }
                            })
                            .into_any_element(),
                    );
                }
                if let Some(word) = finding.project_word.clone() {
                    let spelling = self.spelling.clone();
                    actions.push(
                        action(
                            format!("spelling-add-{ix}").into(),
                            t!(
                                "Add “{projectWord}” to project dictionary",
                                projectWord = word
                            )
                            .to_string(),
                        )
                        .on_click(move |_, _, cx| {
                            spelling
                                .update(cx, |_, cx| cx.emit(SpellingEvent::AddWord(word.clone())))
                                .ok();
                        })
                        .into_any_element(),
                    );
                }
                if finding.severity != Severity::Error {
                    if let Some(sentence) = finding.sentence.clone() {
                        let spelling = self.spelling.clone();
                        actions.push(
                            action(
                                format!("spelling-ignore-sentence-{ix}").into(),
                                t!("Ignore sentence").to_string(),
                            )
                            .on_click(move |_, _, cx| {
                                spelling
                                    .update(cx, |_, cx| {
                                        cx.emit(SpellingEvent::Ignore(Ignore::Sentence(
                                            sentence.clone(),
                                        )))
                                    })
                                    .ok();
                            })
                            .into_any_element(),
                        );
                    }
                    if let Some(rule) = finding.rule.clone() {
                        let spelling = self.spelling.clone();
                        actions.push(
                            action(
                                format!("spelling-ignore-rule-{ix}").into(),
                                t!("Ignore rule in project").to_string(),
                            )
                            .on_click(move |_, _, cx| {
                                spelling
                                    .update(cx, |_, cx| {
                                        cx.emit(SpellingEvent::Ignore(Ignore::Rule(rule.clone())))
                                    })
                                    .ok();
                            })
                            .into_any_element(),
                        );
                    }
                }
                let message = match wording.rule {
                    Some((name, description)) => div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(div().font_weight(gpui::FontWeight::SEMIBOLD).child(name))
                        .child(div().text_color(palette.text_secondary).child(description))
                        .child(
                            div()
                                .when(wording.original, |this| {
                                    this.text_color(palette.text_secondary)
                                        .text_size(px(13. * 0.9))
                                })
                                .child(wording.detail),
                        )
                        .into_any_element(),
                    None => div().child(wording.detail).into_any_element(),
                };
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x(px(4.))
                    .gap_y(px(6.))
                    .py(px(8.))
                    .px(px(10.))
                    .border_l(px(5.))
                    .border_color(finding.severity.edge(cx))
                    .child(div().w_full().child(message))
                    .children(actions)
                    .child(
                        div()
                            .w_full()
                            .text_color(palette.text_secondary)
                            .text_size(px(13. * 0.9))
                            .child(finding.source),
                    )
            }))
    }
}
