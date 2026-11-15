//! "Why cited" (`citation-reason-editor.ts` and the `.citation-reason-*`
//! rules in `editor-workspace.css`): the popover over a cite key, opened
//! from its citation card or by right-clicking the key, with the key, the
//! five roles as one choice (the arrows move it) that wraps in a narrow
//! editor, an optional note, and Remove (for a reason already filed),
//! Cancel and Save, which waits for a role. Enter in the note saves; Esc,
//! Cancel or a press outside put it away. It follows its key through
//! edits, and closes if the key is gone.

use std::ops::Range;

use gpui::{
    AnyElement, AppContext as _, Context, FocusHandle, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, canvas, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use language::{Anchor, ToOffset as _};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Button, Field, PopFrom, pop_in},
};

use super::reasons;
use crate::{annotations::store, editor_panel::EditorPanel};

/// The popover's width at most, and its margin inside the editor.
const WIDTH: f32 = 320.;
const MARGIN: f32 = 8.;

/// The popover's cite and what it says so far.
pub(in crate::editor_panel) struct ReasonDraft {
    key: String,
    range: Range<Anchor>,
    /// The reason it edits, if one was filed on this cite.
    reason: Option<String>,
    role: Option<&'static str>,
    note: gpui::Entity<InputState>,
    roles: FocusHandle,
    /// The popover's height as last drawn.
    height: std::rc::Rc<std::cell::Cell<gpui::Pixels>>,
    view: std::rc::Rc<std::cell::Cell<Option<gpui::Bounds<gpui::Pixels>>>>,
    _note: Subscription,
}

/// The chip that holds the roles' tab stop: the chosen one, else the first.
fn chosen_index(role: Option<&'static str>) -> usize {
    role.and_then(|role| reasons::ROLES.iter().position(|item| *item == role))
        .unwrap_or(0)
}

impl EditorPanel {
    /// Open "Why cited" on the key at bytes `range`.
    pub(in crate::editor_panel) fn open_why_cited(
        &mut self,
        key: &str,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let root = self.project_root(cx);
        let text = self.buffer.read(cx).text();
        let existing = store::try_store(cx).and_then(|store| {
            let notes = store.read(cx).notes(&root)?;
            let (_, placed) = reasons::placed(&text, &self.relative, &notes.annotations);
            notes
                .annotations
                .iter()
                .find(|reason| placed.get(&reason.id) == Some(&range))
                .cloned()
        });
        let role = existing
            .as_ref()
            .and_then(|reason| reason.citation.as_ref())
            .and_then(|citation| {
                reasons::ROLES
                    .iter()
                    .copied()
                    .find(|role| *role == citation.role)
            });
        let body = existing
            .as_ref()
            .map(|reason| reason.body.clone())
            .unwrap_or_default();
        let note = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(t!("Add a note"));
            state.set_value(body, window, cx);
            state
        });
        let subscription = cx.subscribe_in(&note, window, |this, _, event, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.save_reason(window, cx);
            }
        });
        let snapshot = self.buffer.read(cx).snapshot();
        let roles = cx.focus_handle();
        self.citations.draft = Some(ReasonDraft {
            key: key.to_string(),
            range: snapshot.anchor_after(range.start)..snapshot.anchor_before(range.end),
            reason: existing.map(|reason| reason.id),
            role,
            note: note.clone(),
            roles: roles.clone(),
            height: Default::default(),
            view: Default::default(),
            _note: subscription,
        });
        self.citations.editing.set(true);
        // The pointer that right-clicked the key still rests on it, and its
        // card stacked over the popover would push it off the editor.
        self.lattice
            .update(cx, |lattice, cx| lattice.dismiss_hover(cx));
        if role.is_some() {
            window.focus(&note.focus_handle(cx), cx);
        } else {
            window.focus(&roles, cx);
        }
        cx.notify();
    }

    /// Put "Why cited" away; the editor takes the keyboard back unless the
    /// press that closed it went elsewhere.
    fn close_why_cited(&mut self, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.citations.draft.take().is_none() {
            return;
        }
        self.citations.editing.set(false);
        if refocus {
            let editor = self.editor.focus_handle(cx);
            window.focus(&editor, cx);
        }
        cx.notify();
    }

    fn step_role(&mut self, step: isize, cx: &mut Context<Self>) {
        let Some(draft) = &mut self.citations.draft else {
            return;
        };
        let at = draft
            .role
            .and_then(|role| reasons::ROLES.iter().position(|item| *item == role))
            .map_or(if step > 0 { -1 } else { 0 }, |at| at as isize);
        let count = reasons::ROLES.len() as isize;
        draft.role = Some(reasons::ROLES[((at + step).rem_euclid(count)) as usize]);
        cx.notify();
    }

    /// File the reason, or replace the one this cite has (`commit`).
    fn save_reason(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = &self.citations.draft else {
            return;
        };
        let Some(role) = draft.role else {
            return;
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let range = draft.range.start.to_offset(&snapshot)..draft.range.end.to_offset(&snapshot);
        let text = snapshot.text();
        let key = draft.key.clone();
        // The key was edited away meanwhile: nothing to file it on.
        if !text
            .get(range.clone())
            .is_some_and(|written| written.eq_ignore_ascii_case(&key))
        {
            return self.close_why_cited(true, window, cx);
        }
        let body = draft.note.read(cx).value().trim().to_string();
        let root = self.project_root(cx);
        let path = self.relative.clone();
        let reason_id = draft.reason.clone();
        let author = store::author(&root, cx);
        if let Some(store) = store::try_store(cx) {
            store.update(cx, |store, cx| match reason_id {
                Some(id) => {
                    store.update(
                        &root,
                        &id,
                        |reason| {
                            if let Some(next) = reasons::reanchored(&text, reason, range.clone()) {
                                reason.from = next.from;
                                reason.to = next.to;
                                reason.quote = next.quote;
                                reason.prefix = next.prefix;
                                reason.suffix = next.suffix;
                            }
                            reason.body = body;
                            reason.citation = Some(lattice_core::project::CitationReason {
                                key: key.clone(),
                                role: role.to_string(),
                            });
                        },
                        cx,
                    );
                }
                None => {
                    if let Some(reason) =
                        reasons::new_reason(&path, &text, range, &key, role, &body, &author)
                    {
                        store.commit(
                            &root,
                            |notes| {
                                notes.annotations.push(reason);
                                true
                            },
                            cx,
                        );
                    }
                }
            });
        }
        self.close_why_cited(true, window, cx);
    }

    fn remove_reason(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self
            .citations
            .draft
            .as_ref()
            .and_then(|draft| draft.reason.clone())
        else {
            return;
        };
        let root = self.project_root(cx);
        if let Some(store) = store::try_store(cx) {
            store.update(cx, |store, cx| store.delete(&root, &id, cx));
        }
        self.close_why_cited(true, window, cx);
    }

    /// The popover over its key; none while it is closed or its key is off
    /// screen (or gone, which closes it).
    pub(in crate::editor_panel) fn why_cited_popover(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let draft = self.citations.draft.as_ref()?;
        let view_cell = draft.view.clone();
        let tracker = canvas(
            move |bounds, _, _| view_cell.set(Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element();
        let snapshot = self.buffer.read(cx).snapshot();
        let (start, end) = (
            draft.range.start.to_offset(&snapshot),
            draft.range.end.to_offset(&snapshot),
        );
        if end <= start {
            // A collaborator's edit took the key: the draft goes with it.
            self.citations.draft = None;
            self.citations.editing.set(false);
            return None;
        }
        let (Some(view), Some(editor)) = (draft.view.get(), self.lattice.read(cx).painted().bounds)
        else {
            cx.on_next_frame(window, |_, _, cx| cx.notify());
            return Some(tracker);
        };
        let anchor = self
            .lattice
            .update(cx, |lattice, cx| lattice.offset_bounds(start, window, cx));
        let draft = self.citations.draft.as_ref()?;
        let top_edge = view.top().max(editor.top());
        let bottom_edge = view.bottom().min(editor.bottom());
        let Some(anchor) =
            anchor.filter(|anchor| anchor.bottom() > top_edge && anchor.top() < bottom_edge)
        else {
            return Some(tracker);
        };
        // No wider than the editor, as the citation card.
        let width = px(WIDTH).min((view.size.width - px(16.)).max(px(200.)));
        let height = draft.height.get().max(px(140.));
        // Above its key, as CodeMirror places the tooltip, unless there is
        // no room there.
        let above = anchor.top() - top_edge >= height + px(MARGIN);
        let left = (anchor.left() - view.left())
            .max(px(MARGIN))
            .min((view.size.width - width - px(MARGIN)).max(px(MARGIN)));
        let top = if above {
            anchor.top() - px(MARGIN) - height - view.top()
        } else {
            anchor.bottom() + px(MARGIN) - view.top()
        };
        let body = self.why_cited_body(draft, window, cx);
        let height_cell = draft.height.clone();
        let palette = cx.palette().clone();
        let popup = div()
            .id("citation-reason-popover")
            .w(width)
            .px(px(12.))
            .py(px(10.))
            .rounded(px(10.))
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .text_role(TextRole::Body, cx)
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(
                cx.listener(|this, _, window, cx| this.close_why_cited(false, window, cx)),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.close_why_cited(true, window, cx);
                }
            }))
            .child(body)
            .child(
                canvas(
                    move |bounds, _, _| height_cell.set(bounds.size.height),
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        let from = if above {
            PopFrom::Above
        } else {
            PopFrom::Below
        };
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(tracker)
                .child(div().absolute().left(left).top(top).child(pop_in(
                    "citation-reason-in",
                    from,
                    popup,
                )))
                .into_any_element(),
        )
    }

    fn why_cited_body(
        &self,
        draft: &ReasonDraft,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        // One stop in the tab order, on the chosen role or else the first,
        // ringed while the roles hold the keyboard.
        let ringed = draft
            .roles
            .is_focused(window)
            .then(|| chosen_index(draft.role));
        let editor_font = cx.lattice().fonts.editor.clone();
        let chosen = draft.role;
        let chips = reasons::ROLES.iter().enumerate().map(|(at, role)| {
            let checked = chosen == Some(*role);
            let ring = ringed == Some(at);
            let label = crate::papers::role_label(role).unwrap_or(role);
            div()
                .id(("citation-role-chip", at))
                .flex_none()
                .px(px(8.))
                .py(px(1.))
                .rounded(px(4.))
                .border_1()
                .border_color(if checked {
                    palette.accent
                } else {
                    palette.line
                })
                .when(checked, |chip| {
                    chip.bg(palette.accent_soft).text_color(palette.accent)
                })
                .when(ring, |chip| chip.border_color(palette.focus))
                .text_role(TextRole::Caption, cx)
                .cursor_pointer()
                .hover(|style| style.bg(palette.hover))
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(draft) = &mut this.citations.draft {
                        draft.role = Some(reasons::ROLES[at]);
                        let note = draft.note.focus_handle(cx);
                        window.focus(&note, cx);
                    }
                    cx.notify();
                }))
                .child(label)
        });
        let roles = div()
            .id("citation-reason-roles")
            .track_focus(&draft.roles)
            .flex()
            .flex_wrap()
            .gap(px(4.))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                let step = match event.keystroke.key.as_str() {
                    "right" | "down" => 1,
                    "left" | "up" => -1,
                    _ => return,
                };
                cx.stop_propagation();
                this.step_role(step, cx);
            }))
            .children(chips);
        let existing = draft.reason.is_some();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap(px(6.))
                    .min_w_0()
                    .child(
                        div()
                            .flex_none()
                            .font_weight(lattice_ui::tokens::FONT_WEIGHT_MEDIUM)
                            .child(t!("Why cited")),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(4.))
                            .bg(palette.hover)
                            .font_family(editor_font)
                            .text_size(lattice_ui::tokens::TEXT_MICRO)
                            .line_height(lattice_ui::tokens::LEADING_MICRO)
                            .truncate()
                            .child(draft.key.clone()),
                    ),
            )
            .child(roles)
            .child(Field::new(&draft.note).compact())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .when(existing, |bar| {
                        bar.child(
                            Button::new("citation-reason-remove", t!("Remove"))
                                .ghost_danger()
                                .compact()
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.remove_reason(window, cx)
                                })),
                        )
                    })
                    .child(div().flex_1())
                    .child(
                        Button::new("citation-reason-cancel", t!("Cancel"))
                            .ghost()
                            .compact()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_why_cited(true, window, cx)
                            })),
                    )
                    .child(
                        Button::new("citation-reason-save", t!("Save"))
                            .tinted()
                            .compact()
                            .disabled(chosen.is_none())
                            .on_click(
                                cx.listener(|this, _, window, cx| this.save_reason(window, cx)),
                            ),
                    ),
            )
            .into_any_element()
    }
}

impl EditorPanel {
    /// The key "Why cited" is open on, for scripted checks.
    pub fn why_cited_key(&self) -> Option<String> {
        self.citations.draft.as_ref().map(|draft| draft.key.clone())
    }

    /// Put "Why cited" away as Esc does, for scripted checks.
    pub fn close_why_cited_for_scenario(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_why_cited(true, window, cx);
    }

    /// Choose `role`, write `note` and Save, as the writer does, for
    /// scripted checks.
    pub fn file_reason_for_scenario(
        &mut self,
        role: &'static str,
        note: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(draft) = &mut self.citations.draft else {
            return;
        };
        draft.role = Some(role);
        let field = draft.note.clone();
        field.update(cx, |field, cx| {
            field.set_value(note.to_string(), window, cx)
        });
        self.save_reason(window, cx);
    }
}
