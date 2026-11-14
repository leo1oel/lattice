//! Per-spot conflict resolution, ported from the Tauri app's
//! `ConflictResolverDialog` (`src/history/conflict-resolver.tsx`,
//! `conflict-resolver.css`).
//!
//! When a merge cannot decide, the file keeps standard `<<<<<<<` markers.
//! This turns each of those spots into an explicit choice (keep the current
//! text, keep the other side, or keep both), so resolving never means
//! editing around markers by hand. Each side is shown under its own name and
//! is itself the choice that keeps it, with the words the two sides disagree
//! on washed in both; 1, 2 and 3 choose while a spot has the keyboard.
//! Anything left undecided keeps its markers, so saving halfway is safe.
//! "Edit before saving" opens the resolved text to touch up by hand.
//!
//! A conflict comes from Git (a merge or a pull that stopped): the current
//! text is the side Git calls ours, the other is named as Git names it in the
//! marker (`>>>>>>> feature`); or from an Overleaf sync, which puts this
//! computer's text against Overleaf's, and names the sides so. The Tauri
//! app's Agent Undo conflicts have no counterpart here yet.
//!
//! Saving writes through lattice-core's editor transaction, only over the
//! exact text the choices were made against: a file rewritten while the
//! dialog stood open is not overwritten with stale text, and the dialog says
//! so and offers to read it again.

use std::{collections::HashMap, path::PathBuf};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, HighlightStyle,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement as _, Styled as _, StyledText, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::TextareaState;
use lattice_i18n::{locale, t};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Badge, BadgeTone, Button, LayerPlacement, ModalLayer, Textarea, rise_in},
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    scrollbar::FluidScrollbar,
    tokens::{
        FONT_WEIGHT_SEMIBOLD, RADIUS_COMPACT, RADIUS_CONTROL, RADIUS_DIALOG, RADIUS_PANEL,
        RADIUS_PILL,
    },
};

use super::{
    conflicts::{ConflictChoice, ConflictHunk, conflict_hunks, resolve_conflicts},
    widgets::inline_message,
    words::phrase_hunks,
};

/// What the dialog tells the window.
pub enum ConflictEvent {
    /// The file was written; the editor reloads it and the build runs.
    Resolved(String),
    Closed,
}

impl EventEmitter<ConflictEvent> for ConflictResolver {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Resolve,
    Edit,
}

pub struct ConflictResolver {
    root: PathBuf,
    path: String,
    /// The file as read: what the choices are made against.
    content: String,
    hunks: Vec<ConflictHunk>,
    /// The other side's name, as Git wrote it after `>>>>>>>`.
    theirs_name: Option<String>,
    choices: HashMap<usize, ConflictChoice>,
    stage: Stage,
    editor: Option<Entity<TextareaState>>,
    loading: bool,
    saving: bool,
    error: Option<String>,
    changed_on_disk: bool,
    /// The markers are an Overleaf sync's: this computer against Overleaf.
    overleaf: bool,
    load_version: usize,
    focus: FocusHandle,
    scroll: ScrollHandle,
}

impl ConflictResolver {
    pub fn new(root: PathBuf, path: String, cx: &mut Context<Self>) -> Self {
        let mut resolver = Self {
            root,
            path,
            content: String::new(),
            hunks: Vec::new(),
            theirs_name: None,
            choices: HashMap::new(),
            stage: Stage::Resolve,
            editor: None,
            loading: true,
            saving: false,
            error: None,
            changed_on_disk: false,
            overleaf: false,
            load_version: 0,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
        };
        resolver.load(cx);
        resolver
    }

    /// Name the sides as an Overleaf sync's: this computer and Overleaf.
    pub fn overleaf_sides(mut self, overleaf: bool) -> Self {
        self.overleaf = overleaf;
        self
    }

    /// Whether the sides are named as an Overleaf sync's, for a scenario.
    pub fn is_overleaf(&self) -> bool {
        self.overleaf
    }

    /// How many spots are left to decide, for a scenario.
    pub fn spots(&self) -> usize {
        self.hunks.len()
    }

    /// Keep the current text in every spot and save, for a scenario.
    pub fn choose_and_save_for_scenario(&mut self, cx: &mut Context<Self>) {
        for hunk in self.hunks.clone() {
            self.choose(hunk.index, ConflictChoice::Ours, cx);
        }
        self.save(cx);
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.error = None;
        self.changed_on_disk = false;
        self.stage = Stage::Resolve;
        self.editor = None;
        let (root, path) = (self.root.clone(), self.path.clone());
        let read = cx
            .background_executor()
            .spawn(async move { lattice_core::project::read_file(&root, &path) });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(content) => {
                        this.hunks = conflict_hunks(&content);
                        this.theirs_name = content
                            .lines()
                            .find_map(|line| line.strip_prefix(">>>>>>> "))
                            .map(|name| name.trim().to_string())
                            .filter(|name| !name.is_empty());
                        this.content = content;
                        this.choices.clear();
                        this.load_version += 1;
                        // Nothing left to decide (edited, or resolved since).
                        if this.hunks.is_empty() {
                            cx.emit(ConflictEvent::Closed);
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn choose(&mut self, index: usize, choice: ConflictChoice, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.choices.insert(index, choice);
        cx.notify();
    }

    fn resolved(&self) -> String {
        resolve_conflicts(&self.content, &self.choices)
    }

    fn edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let resolved = self.resolved();
        let editor = cx.new(|cx| TextareaState::new(window, cx).default_value(resolved));
        self.editor = Some(editor);
        self.stage = Stage::Edit;
        cx.notify();
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        let text = match (&self.stage, &self.editor) {
            (Stage::Edit, Some(editor)) => editor.read(cx).value().to_string(),
            _ => self.resolved(),
        };
        self.saving = true;
        cx.notify();
        let (root, path, expected) = (self.root.clone(), self.path.clone(), self.content.clone());
        let write = cx.background_executor().spawn(async move {
            let written = lattice_core::project::apply_editor_transaction(
                &root,
                path.clone(),
                text,
                None,
                Some(expected.clone()),
            );
            match written {
                Ok(_) => Ok(()),
                // Read it again: did it change under the dialog?
                Err(error) => match lattice_core::project::read_file(&root, &path) {
                    Ok(now) if now != expected => Err(None),
                    _ => Err(Some(error)),
                },
            }
        });
        cx.spawn(async move |this, cx| {
            let outcome = write.await;
            this.update(cx, |this, cx| {
                this.saving = false;
                match outcome {
                    Ok(()) => cx.emit(ConflictEvent::Resolved(this.path.clone())),
                    Err(None) => this.changed_on_disk = true,
                    Err(Some(error)) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if !self.saving {
            cx.emit(ConflictEvent::Closed);
        }
    }
}

/// `text` with the words that differ from `other` washed; a side the other
/// one removed has nothing to compare against and is left plain.
fn marked_side(text: &str, other: &str, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let marks: Vec<(std::ops::Range<usize>, HighlightStyle)> = if other.trim().is_empty() {
        Vec::new()
    } else {
        phrase_hunks(text, other)
            .into_iter()
            .filter(|hunk| hunk.to > hunk.from)
            .map(|hunk| {
                (
                    hunk.from..hunk.to,
                    HighlightStyle {
                        background_color: Some(palette.warning.opacity(0.22)),
                        ..HighlightStyle::default()
                    },
                )
            })
            .collect()
    };
    StyledText::new(SharedString::from(text.to_string()))
        .with_highlights(marks)
        .into_any_element()
}

/// A keycap beside a choice: `1`, `2`, `3`.
fn kbd(key: &'static str, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex_none()
        .ml_auto()
        .min_w(px(18.))
        .px(px(4.))
        .rounded(RADIUS_COMPACT)
        .bg(palette.hover)
        .text_role(TextRole::Micro, cx)
        .text_color(palette.text_secondary)
        .flex()
        .justify_center()
        .child(key)
        .into_any_element()
}

struct Words {
    ours: SharedString,
    keeping_ours: SharedString,
    ours_empty: SharedString,
    theirs: SharedString,
    keeping_theirs: SharedString,
    theirs_empty: SharedString,
}

impl ConflictResolver {
    fn words(&self) -> Words {
        if self.overleaf {
            return Words {
                ours: t!("This computer").into(),
                keeping_ours: t!("Keeping this computer's").into(),
                ours_empty: t!("This computer removed this part.").into(),
                theirs: t!("Overleaf").into(),
                keeping_theirs: t!("Keeping Overleaf's").into(),
                theirs_empty: t!("Overleaf removed this part.").into(),
            };
        }
        let theirs = self
            .theirs_name
            .clone()
            .unwrap_or_else(|| t!("Incoming text").to_string());
        Words {
            ours: t!("Current text").into(),
            keeping_ours: t!("Keeping the current text").into(),
            ours_empty: t!("The current text removed this part.").into(),
            keeping_theirs: t!("Keeping {name}", name = &theirs).into(),
            theirs_empty: t!("{name} removed this part.", name = &theirs).into(),
            theirs: theirs.into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn side(
        &self,
        id: SharedString,
        label: SharedString,
        key: &'static str,
        text: String,
        other: String,
        checked: bool,
        dropped: bool,
        empty: SharedString,
        on_choose: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(id.clone(), window, cx);
        let text_id = id.clone();
        let border = if checked {
            palette.text
        } else {
            mix(
                palette.line_strong,
                palette.text_secondary,
                interaction.hover,
            )
        };
        let radio = div()
            .flex_none()
            .size(px(16.))
            .rounded(RADIUS_PILL)
            .flex()
            .items_center()
            .justify_center()
            .map(|this| {
                if checked {
                    this.bg(palette.text)
                        .child(Icon::CHECK.element(px(10.), palette.raised))
                } else {
                    this.border(px(1.5)).border_color(palette.line_strong)
                }
            });
        let element = track_pointer(tab_stop(div().id(id)), pointer)
            .cursor_pointer()
            .on_click(on_choose)
            .flex()
            .flex_col()
            .gap(px(6.))
            .flex_1()
            .min_w(px(220.).min(px(10_000.)))
            .pt(px(8.))
            .px(px(10.))
            .pb(px(10.))
            .border(if checked { px(2.) } else { px(1.) })
            .border_color(border)
            .rounded(RADIUS_CONTROL)
            .bg(palette.raised)
            .text_color(if dropped {
                palette.text_secondary
            } else {
                palette.text
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .min_w_0()
                    .text_role(TextRole::Caption, cx)
                    .child(radio)
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .child(label),
                    )
                    .child(kbd(key, cx)),
            )
            .child(if text.is_empty() {
                div()
                    .text_role(TextRole::Caption, cx)
                    .italic()
                    .text_color(palette.text_secondary)
                    .child(empty)
                    .into_any_element()
            } else {
                div()
                    .id(SharedString::from(format!("{text_id}-text")))
                    .max_h(px(360.))
                    .overflow_y_scroll()
                    .text_role(TextRole::Typeset, cx)
                    .whitespace_normal()
                    .child(marked_side(&text, &other, cx))
                    .into_any_element()
            });
        element.into_any_element()
    }

    fn spot(
        &self,
        position: usize,
        hunk: &ConflictHunk,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let words = self.words();
        let total = self.hunks.len();
        let choice = self.choices.get(&hunk.index).copied();
        let keeps = |side| choice == Some(side) || choice == Some(ConflictChoice::Both);
        let ours = hunk.ours.join("\n");
        let theirs = hunk.theirs.join("\n");
        let index = hunk.index;
        let badge = match choice {
            Some(ConflictChoice::Ours) => {
                Badge::new(words.keeping_ours.clone()).tone(BadgeTone::Success)
            }
            Some(ConflictChoice::Theirs) => {
                Badge::new(words.keeping_theirs.clone()).tone(BadgeTone::Success)
            }
            Some(ConflictChoice::Both) => Badge::new(t!("Keeping both")).tone(BadgeTone::Success),
            None => Badge::new(t!("Needs a decision")).tone(BadgeTone::Warning),
        }
        .compact();
        let both_on = choice == Some(ConflictChoice::Both);
        let (both, both_pointer) = use_interaction(
            SharedString::from(format!("conflict-both-{index}")),
            window,
            cx,
        );
        let both_button = track_pointer(
            tab_stop(div().id(SharedString::from(format!("conflict-both-{index}")))),
            both_pointer,
        )
        .cursor_pointer()
        .on_click(cx.listener(move |this, _, _, cx| this.choose(index, ConflictChoice::Both, cx)))
        .flex()
        .items_center()
        .gap(px(6.))
        .h(px(28.))
        .px(px(8.))
        .rounded(RADIUS_CONTROL)
        .bg(if both_on {
            palette.hover
        } else {
            both.wash(gpui::transparent_black(), palette.hover, palette.pressed)
        })
        .text_role(TextRole::Caption, cx)
        .text_color(if both_on {
            palette.text
        } else {
            mix(palette.text_secondary, palette.text, both.hover)
        })
        .when(both_on, |this| {
            this.child(Icon::CHECK.element(px(12.), palette.text))
        })
        .child(t!("Keep both, yours first"))
        .child(div().ml(px(4.)).child(kbd("3", cx)));
        let sides = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .child(self.side(
                SharedString::from(format!("conflict-ours-{index}")),
                words.ours.clone(),
                "1",
                ours.clone(),
                theirs.clone(),
                keeps(ConflictChoice::Ours),
                choice == Some(ConflictChoice::Theirs),
                words.ours_empty.clone(),
                cx.listener(move |this, _, _, cx| this.choose(index, ConflictChoice::Ours, cx)),
                window,
                cx,
            ))
            .child(self.side(
                SharedString::from(format!("conflict-theirs-{index}")),
                words.theirs.clone(),
                "2",
                theirs,
                ours,
                keeps(ConflictChoice::Theirs),
                choice == Some(ConflictChoice::Ours),
                words.theirs_empty.clone(),
                cx.listener(move |this, _, _, cx| this.choose(index, ConflictChoice::Theirs, cx)),
                window,
                cx,
            ));
        let undecided = choice.is_none();
        div()
            .id(SharedString::from(format!("conflict-spot-{index}")))
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(12.))
            .border_1()
            .border_color(if undecided {
                mix(palette.line, palette.warning, 0.45)
            } else {
                palette.line
            })
            .rounded(RADIUS_PANEL)
            .bg(palette.panel)
            // 1, 2 and 3 choose while focus is anywhere in the spot.
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                let modifiers = event.keystroke.modifiers;
                if modifiers.platform || modifiers.control || modifiers.alt {
                    return;
                }
                let choice = match event.keystroke.key.as_str() {
                    "1" => ConflictChoice::Ours,
                    "2" => ConflictChoice::Theirs,
                    "3" => ConflictChoice::Both,
                    _ => return,
                };
                cx.stop_propagation();
                this.choose(index, choice, cx);
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(8.))
                            .min_w_0()
                            .child(
                                div()
                                    .text_role(TextRole::Subtitle, cx)
                                    .text_color(palette.text)
                                    .child(t!("Spot {0} of {1}", position, total)),
                            )
                            .child(
                                div()
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .child(t!("Line {0}", hunk.line)),
                            ),
                    )
                    .child(badge),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(sides)
                    .child(div().flex().child(both_button)),
            )
            .into_any_element()
    }
}

impl gpui::Focusable for ConflictResolver {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ConflictResolver {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = px(960.).min(viewport.width - px(48.));
        let height = px(760.).min(viewport.height - px(64.));
        let total = self.hunks.len();
        let decided = self
            .hunks
            .iter()
            .filter(|hunk| self.choices.contains_key(&hunk.index))
            .count();
        let remaining = total - decided;
        let progress: SharedString = if self.loading || total == 0 || self.stage == Stage::Edit {
            "".into()
        } else if remaining == 0 {
            t!("Every spot decided").into()
        } else {
            t!(
                "{decided} of {total} decided",
                decided = decided,
                total = total
            )
            .into()
        };
        let _ = locale();
        let head = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex_none()
                    .size(px(36.))
                    .rounded(px(10.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(palette.warning_soft)
                    .child(Icon::TRIANGLE_ALERT.element(px(18.), palette.warning)),
            )
            .child(
                div()
                    .min_w_0()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(t!("Resolve changes to {path}", path = &self.path)),
            );
        let mut card = div()
            .w(width)
            .max_h(height)
            .flex()
            .flex_col()
            .gap(px(12.))
            .py(px(20.))
            .px(px(24.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .child(head);
        if let Some(error) = &self.error {
            card = card.child(
                div()
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_CONTROL)
                    .bg(palette.danger.opacity(0.12))
                    .child(inline_message(error.clone(), true, cx)),
            );
        }
        if self.changed_on_disk {
            card = card.child(inline_message(
                t!(
                    "{path} changed while this dialog was open, so nothing was saved. Reload to resolve it against the new text; choices and edits made here are cleared.",
                    path = &self.path
                ),
                false,
                cx,
            ));
        }
        let body: AnyElement = if self.loading {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .text_role(TextRole::BodyCompact, cx)
                .text_color(palette.text_secondary)
                .child(crate::build::chip_mark::infinity_loader(
                    "conflict-loading",
                    px(16.),
                    &palette,
                ))
                .child(t!("Reading the file…"))
                .into_any_element()
        } else if let (Stage::Edit, Some(editor)) = (self.stage, &self.editor) {
            div()
                .flex_1()
                .min_h(px(240.))
                .font_family(cx.lattice().fonts.editor.clone())
                .child(Textarea::new(editor).height(height - px(200.)))
                .into_any_element()
        } else {
            let spots: Vec<AnyElement> = self
                .hunks
                .clone()
                .iter()
                .enumerate()
                .map(|(position, hunk)| self.spot(position + 1, hunk, window, cx))
                .collect();
            div()
                .relative()
                .flex_1()
                .min_h_0()
                .border_1()
                .border_color(palette.line)
                .rounded(RADIUS_PANEL)
                .bg(palette.window)
                .overflow_hidden()
                .child(
                    div()
                        .id("conflict-spots")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(12.))
                                .pt(px(12.))
                                .pb(px(12.))
                                .pl(px(12.))
                                .pr(px(16.))
                                .children(spots),
                        ),
                )
                // The bar is how someone knows there is more to review: it stays.
                .child(FluidScrollbar::vertical(
                    "conflict-spots-scrollbar",
                    &self.scroll,
                ))
                .into_any_element()
        };
        let saving = self.saving;
        let edit_button = if self.stage == Stage::Edit {
            Button::new("conflict-back", t!("Back to choices"))
                .icon(Icon::ARROW_LEFT)
                .disabled(saving)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.stage = Stage::Resolve;
                    cx.notify();
                }))
        } else {
            Button::new("conflict-edit", t!("Edit before saving"))
                .icon(Icon::PENCIL_LINE)
                .disabled(saving || self.loading || total == 0)
                .on_click(cx.listener(|this, _, window, cx| this.edit(window, cx)))
        };
        let primary = if self.changed_on_disk {
            Button::new("conflict-reload", t!("Reload conflicts"))
                .primary()
                .on_click(cx.listener(|this, _, _, cx| this.load(cx)))
        } else {
            let label = if saving {
                t!("Saving…")
            } else if self.stage == Stage::Edit || remaining == 0 {
                t!("Save")
            } else {
                t!("Save decided spots")
            };
            Button::new("conflict-save", label)
                .primary()
                .disabled(saving || self.loading || (self.stage == Stage::Resolve && decided == 0))
                .on_click(cx.listener(|this, _, _, cx| this.save(cx)))
        };
        let actions = div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(8.))
            .child(
                div()
                    .mr_auto()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(progress),
            )
            .child(
                Button::new("conflict-cancel", t!("Cancel"))
                    .disabled(saving)
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
            )
            .child(edit_button)
            .child(primary);
        let card = card.child(body).child(actions);
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "conflict-resolver",
            LayerPlacement::Center,
            rise_in("conflict-resolver-card", card),
            move |_, cx| {
                this.update(cx, |this, cx| this.close(cx)).ok();
            },
        )
        .closable_by_scrim(false)
        .into_any_element()
    }
}
