//! A label's or citation key's occurrences, and renaming one, ported from
//! the Tauri app's `ReferencesPanel` (`src/project/references-panel.tsx`,
//! `.references-panel*` in `editor-workspace.css`) and `RenameDialog`
//! (`src/project/rename-dialog.tsx`), as `use-source-navigation.ts` drives
//! them.
//!
//! Find references (⇧F12) on a `\label`, a `\ref`-like command's label or a
//! citation key in a `.tex` editor opens the bar under the titlebar: what
//! the symbol is, how many definitions and references it has, Rename, and
//! the dismiss button; then each occurrence (its role, `file:line` and the
//! line itself), which opens it there. Rename (F2) asks for the new name,
//! and lattice-core rewrites every occurrence (`project::Symbol::rename`,
//! the `.bib` entry and every `\cite` for a key), after the open edits are
//! saved; the bar then lists the renamed symbol.

use std::path::PathBuf;

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::{models::SymbolOccurrence, project::Symbol};
use lattice_editor::latex::syntax::{citation_target, reference_target};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field, LayerPlacement, ModalLayer},
    interaction::{track_pointer, use_interaction},
    tokens::{FONT_WEIGHT_SEMIBOLD, RADIUS_DIALOG},
};

/// A cross-reference symbol the writer can find and rename.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SymbolKind {
    Label,
    Citation,
}

impl SymbolKind {
    fn core(self) -> Symbol {
        match self {
            SymbolKind::Label => Symbol::Label,
            SymbolKind::Citation => Symbol::Citation,
        }
    }
}

/// The symbol under `position` in a LaTeX source (`symbolAt` in
/// `latex-symbols.ts`): a `\label`'s argument or a `\ref`-like command's
/// label first, then a citation key.
pub fn symbol_at(text: &str, position: usize) -> Option<(SymbolKind, String)> {
    if let Some(label) = label_argument_at(text, position)
        .or_else(|| reference_target(text, position).map(|span| span.key))
    {
        return Some((SymbolKind::Label, label));
    }
    citation_target(text, position).map(|span| (SymbolKind::Citation, span.key))
}

/// The argument of the `\label{…}` the position is in (its braces
/// included), trimmed; none for an empty one.
fn label_argument_at(text: &str, position: usize) -> Option<String> {
    let line_start = text[..position.min(text.len())]
        .rfind('\n')
        .map_or(0, |at| at + 1);
    let line_end = text[line_start..]
        .find('\n')
        .map_or(text.len(), |at| line_start + at);
    let line = &text[line_start..line_end];
    let mut from = 0;
    while let Some(found) = line[from..].find("\\label{") {
        let open = line_start + from + found + "\\label{".len();
        let close = text[open..line_end].find('}').map(|at| open + at)?;
        if (open - 1..=close).contains(&position) {
            let label = text[open..close].trim();
            return (!label.is_empty()).then(|| label.to_string());
        }
        from = close - line_start;
    }
    None
}

/// What the bar asks of the window.
pub enum ReferencesEvent {
    Open { path: String, line: u32 },
    Rename,
    Dismiss,
}

/// The bar under the titlebar: one symbol's occurrences.
pub struct ReferencesBar {
    pub kind: SymbolKind,
    pub symbol: String,
    pub occurrences: Vec<SymbolOccurrence>,
}

impl EventEmitter<ReferencesEvent> for ReferencesBar {}

impl ReferencesBar {
    pub fn new(kind: SymbolKind, symbol: String, occurrences: Vec<SymbolOccurrence>) -> Self {
        Self {
            kind,
            symbol,
            occurrences,
        }
    }

    fn summary(&self) -> String {
        let definitions = self
            .occurrences
            .iter()
            .filter(|occurrence| occurrence.role == "definition")
            .count();
        let references = self.occurrences.len() - definitions;
        let definition_summary = if definitions == 1 {
            t!("{definitions} definition", definitions = definitions)
        } else {
            t!("{definitions} definitions", definitions = definitions)
        };
        let reference_summary = if references == 1 {
            t!("{references} reference", references = references)
        } else {
            t!("{references} references", references = references)
        };
        match (definitions, references) {
            (0, 0) => t!("No occurrences").to_string(),
            (_, 0) => definition_summary,
            (0, _) => reference_summary,
            _ => t!(
                "{definitionSummary}, {referenceSummary}",
                definitionSummary = definition_summary,
                referenceSummary = reference_summary
            ),
        }
    }
}

/// The bar's two tools (`.references-panel-bar > button`): 24px tall, the
/// soft accent under the pointer.
fn bar_button(
    id: &'static str,
    icon: Icon,
    label: Option<&'static str>,
    tooltip: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let palette = cx.palette().clone();
    let (state, pointer) = use_interaction(id, window, cx);
    let lit = state.hover > 0.5;
    let ink = if lit {
        palette.accent
    } else {
        palette.text_secondary
    };
    let button = div()
        .id(id)
        .flex_none()
        .h(px(24.))
        .when(label.is_none(), |button| button.w(px(24.)).justify_center())
        .when(label.is_some(), |button| button.px(px(8.)))
        .flex()
        .items_center()
        .gap(px(4.))
        .rounded(px(6.))
        .bg(state.wash(
            gpui::transparent_black(),
            palette.accent_soft,
            palette.accent_soft,
        ))
        .text_color(ink)
        .text_size(TextRole::Micro.font_size(TypeScale::Interface, cx))
        .font_weight(FONT_WEIGHT_SEMIBOLD)
        .cursor_pointer()
        .tooltip(move |_, cx| {
            lattice_ui::components::LatticeTooltip::view(SharedString::from(tooltip), None, cx)
        })
        .child(icon.element(px(13.), ink))
        .children(label);
    track_pointer(button, pointer)
}

impl Render for ReferencesBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let ground = palette.accent_soft.opacity(0.55);
        let (prefix, suffix) = symbol_title(self.kind);
        let title = div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .text_role(TextRole::Caption, cx)
            .font_weight(gpui::FontWeight(650.))
            .text_color(palette.text_secondary)
            .child(Icon::LINK_2.element(px(13.), palette.text_secondary))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_baseline()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(prefix)
                    .child(
                        div()
                            .text_color(palette.accent)
                            .font_family(editor_font.clone())
                            .child(self.symbol.clone()),
                    )
                    .child(suffix),
            )
            .child(
                div()
                    .flex_none()
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .text_size(TextRole::Micro.font_size(TypeScale::Interface, cx))
                    .child(self.summary()),
            );
        let rename = bar_button(
            "references-rename",
            Icon::PENCIL,
            Some(t!("Rename")),
            t!("Rename symbol"),
            window,
            cx,
        )
        .on_click(cx.listener(|_, _, _, cx| cx.emit(ReferencesEvent::Rename)));
        let dismiss = bar_button(
            "references-dismiss",
            Icon::X,
            None,
            t!("Dismiss references"),
            window,
            cx,
        )
        .on_click(cx.listener(|_, _, _, cx| cx.emit(ReferencesEvent::Dismiss)));
        let bar = div()
            .min_h(px(34.))
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .py(px(4.))
            .children(lattice_ui::parity::probe("references/bar"))
            .child(title)
            .child(rename)
            .child(dismiss);
        // With none, the bar's own summary ("No occurrences") is the whole answer.
        let list = (!self.occurrences.is_empty()).then(|| {
            let items = self
                .occurrences
                .iter()
                .enumerate()
                .map(|(index, occurrence)| {
                    let id = SharedString::from(format!("references-item-{index}"));
                    let (state, pointer) = use_interaction(id.clone(), window, cx);
                    let lit = state.hover > 0.5;
                    let definition = occurrence.role == "definition";
                    let role = match occurrence.role.as_str() {
                        "definition" => t!("definition").to_string(),
                        "reference" => t!("reference").to_string(),
                        other => other.to_string(),
                    };
                    let location = format!("{}:{}", occurrence.path, occurrence.line);
                    let (path, line) = (occurrence.path.clone(), occurrence.line);
                    let item = div()
                        .id(id)
                        .min_h(px(30.))
                        .flex()
                        .items_start()
                        .gap(px(8.))
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(if lit {
                            palette.control_active_border
                        } else {
                            palette.line
                        })
                        .bg(if lit {
                            palette.raised
                        } else {
                            palette.raised.opacity(0.88)
                        })
                        .text_role(TextRole::Caption, cx)
                        .cursor_pointer()
                        .when(index == 0, |item| {
                            item.children(lattice_ui::parity::probe("references/item"))
                        })
                        .tooltip({
                            let title = t!("Go to {location}", location = location.clone());
                            move |_, cx| {
                                lattice_ui::components::LatticeTooltip::view(
                                    SharedString::from(title.clone()),
                                    None,
                                    cx,
                                )
                            }
                        })
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(ReferencesEvent::Open {
                                path: path.clone(),
                                line,
                            })
                        }))
                        .child(
                            div()
                                .flex_none()
                                .text_size(TextRole::Micro.font_size(TypeScale::Interface, cx))
                                .font_weight(gpui::FontWeight(650.))
                                .text_color(if definition {
                                    palette.success
                                } else {
                                    palette.accent
                                })
                                .child(capitalized(&role)),
                        )
                        .child(
                            div()
                                .flex_none()
                                .font_weight(gpui::FontWeight(650.))
                                .text_color(palette.text_secondary)
                                .whitespace_nowrap()
                                .child(location),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_color(palette.text)
                                .child(occurrence.snippet.clone()),
                        );
                    track_pointer(item, pointer)
                });
            div()
                .id("references-list")
                .max_h(px(168.))
                .overflow_y_scroll()
                .px(px(8.))
                .pb(px(8.))
                .flex()
                .flex_col()
                .gap(px(4.))
                .children(items.collect::<Vec<_>>())
        });
        div()
            .flex_none()
            .border_b_1()
            .border_color(palette.line)
            .bg(gpui::Hsla::blend(palette.panel, ground))
            .text_color(palette.text)
            .child(bar)
            .children(list)
    }
}

/// `text-transform: capitalize` on the role.
fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The title's words around the symbol (`<Trans>Label <code>…</code></Trans>`),
/// split where the catalog's `<0>…</0>` stands.
fn symbol_title(kind: SymbolKind) -> (String, String) {
    let message = match kind {
        SymbolKind::Label => t!("Label <0>{symbol}</0>"),
        SymbolKind::Citation => t!("Citation <0>{symbol}</0>"),
    };
    match (message.find("<0>"), message.find("</0>")) {
        (Some(open), Some(close)) => (
            message[..open].to_string(),
            message[close + 4..].to_string(),
        ),
        _ => (message.replace("{symbol}", ""), String::new()),
    }
}

/// What the rename dialog asks of the window.
pub enum RenameEvent {
    /// Rename to the name given; the window saves, renames and answers.
    Submit(String),
    Close,
}

/// The rename dialog (`.modal.rename-modal`): the title, what else it
/// edits, the name, an error, Cancel and Rename.
pub struct RenameSymbolDialog {
    pub kind: SymbolKind,
    pub old: String,
    field: Entity<InputState>,
    pub error: Option<String>,
    pub busy: bool,
    _field: Subscription,
}

impl EventEmitter<RenameEvent> for RenameSymbolDialog {}

impl RenameSymbolDialog {
    pub fn new(kind: SymbolKind, old: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = cx.new(|cx| InputState::new(window, cx).default_value(old.clone()));
        let subscription = cx.subscribe(&field, |this, _, event, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.submit(cx);
            }
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        Self {
            kind,
            old,
            field,
            error: None,
            busy: false,
            _field: subscription,
        }
    }

    fn name(&self, cx: &App) -> String {
        self.field.read(cx).value().trim().to_string()
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let name = self.name(cx);
        if name.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        cx.emit(RenameEvent::Submit(name));
        cx.notify();
    }

    /// The rename failed: say why (unless a notice already did), and let
    /// the name be edited again.
    pub fn failed(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.busy = false;
        self.error = error;
        cx.notify();
    }
}

impl Render for RenameSymbolDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(420.).min(window.viewport_size().width - px(40.));
        let (title, copy) = match self.kind {
            SymbolKind::Label => (t!("Rename label"), t!("Updates every \\ref to it")),
            SymbolKind::Citation => (
                t!("Rename citation key"),
                t!("Updates the .bib entry and every \\cite"),
            ),
        };
        let busy = self.busy;
        let empty = self.name(cx).is_empty();
        let card = div()
            .w(width)
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .children(lattice_ui::parity::probe("rename/modal"))
            .child(
                div()
                    .mb(px(4.))
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(title),
            )
            .child(
                div()
                    .mb(px(20.))
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .child(copy),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(lattice_ui::tokens::FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text)
                    .child(t!("Name"))
                    .child(Field::new(&self.field).disabled(busy)),
            )
            .children(self.error.clone().map(|error| {
                div()
                    .mt(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(error)
            }))
            .child(
                div()
                    .mt(px(24.))
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        Button::new("rename-cancel", t!("Cancel"))
                            .ghost()
                            .disabled(busy)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(RenameEvent::Close))),
                    )
                    .child(
                        Button::new(
                            "rename-submit",
                            if busy {
                                t!("Renaming…")
                            } else {
                                t!("Rename")
                            },
                        )
                        .primary()
                        .disabled(busy || empty)
                        .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
                    ),
            );
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "rename-symbol",
            LayerPlacement::UpperThird,
            lattice_ui::components::rise_in("rename-symbol-rise", card),
            move |_, cx| {
                this.update(cx, |dialog, cx| {
                    if !dialog.busy {
                        cx.emit(RenameEvent::Close);
                    }
                })
                .ok();
            },
        )
        .closable_by_scrim(!busy)
    }
}

/// Every occurrence of `symbol`, read off the main thread.
pub fn find_occurrences(
    root: PathBuf,
    kind: SymbolKind,
    symbol: String,
    cx: &mut App,
) -> Task<Result<Vec<SymbolOccurrence>, String>> {
    cx.background_spawn(async move { kind.core().occurrences(&root, &symbol) })
}

/// Rename `old` to `new` everywhere, off the main thread.
pub fn rename(
    root: PathBuf,
    kind: SymbolKind,
    old: String,
    new: String,
    cx: &mut App,
) -> Task<Result<(), String>> {
    cx.background_spawn(async move { kind.core().rename(&root, &old, &new).map(|_| ()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_symbol_under_the_caret() {
        let text = "See \\ref{sec:intro} and \\cite{knuth84,lamport}.\n\\section{Intro}\\label{ sec:intro }\n";
        let at = |needle: &str| text.find(needle).unwrap() + 1;
        assert_eq!(
            symbol_at(text, at("sec:intro}")),
            Some((SymbolKind::Label, "sec:intro".into()))
        );
        assert_eq!(
            symbol_at(text, at("lamport")),
            Some((SymbolKind::Citation, "lamport".into()))
        );
        assert_eq!(
            symbol_at(text, at(" sec:intro ")),
            Some((SymbolKind::Label, "sec:intro".into()))
        );
        assert_eq!(symbol_at(text, at("Intro}")), None);
    }

    #[test]
    fn splits_the_title_around_the_symbol() {
        assert_eq!(
            symbol_title(SymbolKind::Label),
            ("Label ".to_string(), String::new())
        );
        assert_eq!(capitalized("definition"), "Definition");
    }
}
