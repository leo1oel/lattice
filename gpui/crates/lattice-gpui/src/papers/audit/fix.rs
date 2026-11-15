//! A fix's open finding (`detailFor`'s fix bucket in
//! `bibliography-audit.tsx`): the reference as it prints with the fix marked
//! in place, struck and inserted, each edit tagged with the fields it
//! changes, and "Also changes" for what print does not show; then Apply
//! (A, ⌘↩), Skip (S) and the "N of M" stepper, which move on to the next
//! finding. An inline `\bibitem` is never rewritten: Go to it, or copy the
//! corrected one. "Fields and BibTeX" folds each field's before and after,
//! the proposed record and the entry as written.

use gpui::{
    Action, AnyElement, App, Context, HighlightStyle, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, StrikethroughStyle,
    Styled as _, StyledText, div, prelude::FluentBuilder as _, px,
};
use lattice_core::citation_audit::AuditEntry;
use lattice_i18n::{join_list, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, CopyButton, LatticeTooltip},
};

use super::{
    Audit, Change, Finding, FixGroup,
    detail::BIBITEM,
    queue::{ApplyFixChord, Listing, SkipFinding},
    typeset::{self, TypesetFix, bib_field_name},
};
use crate::editor_panel::proofread::inline_edits::{self, Shown, Status};

/// The keys the keymap gives `action` (the sheet's own, bound in its key
/// context only), as the shortcut sheet writes them.
fn key_label(action: &dyn Action, cx: &App) -> Option<SharedString> {
    let keymap = cx.key_bindings();
    let keymap = keymap.borrow();
    keymap
        .bindings_for_action(action)
        .next_back()
        .map(|binding| crate::shell::commands::keystrokes_label(binding.keystrokes()).into())
}

impl Audit {
    /// The printed reference with its fix marked, and what print does not
    /// show (`typesetCard`).
    fn typeset_card(&self, fix: TypesetFix, cx: &App) -> Vec<AnyElement> {
        let palette = cx.palette();
        let shown: Vec<Shown> = fix
            .edits
            .into_iter()
            .enumerate()
            .map(|(id, edit)| Shown {
                id,
                from: edit.from,
                to: edit.to,
                insert: edit.insert,
                status: Status::Applied,
                tag: Some(edit.tag.into()),
                detail: None,
            })
            .collect();
        let mut out = vec![
            div()
                .px(px(16.))
                .py(px(12.))
                .rounded(px(10.))
                .border_1()
                .border_color(palette.line)
                .child(inline_edits::render(
                    "audit-typeset",
                    &fix.text,
                    &shown,
                    None,
                    cx,
                ))
                .into_any_element(),
        ];
        if !fix.unprinted.is_empty() {
            out.push(self.note(t!("Also changes: {0}", join_list(&fix.unprinted)), cx));
        }
        out
    }

    /// Skip, with its key in its tip; none when no other finding is left.
    pub(super) fn skip(
        &self,
        index: usize,
        listing: &Listing,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let next = listing.next_after(index)?;
        let keys = key_label(&SkipFinding, cx);
        Some(
            div()
                .id(("audit-skip-tip", index))
                .tooltip(move |_, cx| {
                    LatticeTooltip::view(t!("Skip to the next finding"), keys.clone(), cx)
                })
                .child(
                    Button::new(("audit-skip", index), t!("Skip"))
                        .compact()
                        .ghost()
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.open_finding(Some(next), cx)),
                        ),
                )
                .into_any_element(),
        )
    }

    /// Where the open finding sits among those like it; choosing it moves
    /// on (`step`). None when it is the only one.
    pub(super) fn step(
        &self,
        index: usize,
        listing: &Listing,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        let (position, count) = listing.step(index)?;
        let next = listing.next_after(index);
        let label = lattice_i18n::fill_named(
            lattice_i18n::tr("{position} of {0}"),
            &[("position", &position), ("0", &count)],
        );
        let ink = palette.text_secondary.opacity(0.8);
        Some(
            div()
                .id(("audit-step", index))
                .ml_auto()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.))
                .h(px(28.))
                .px(px(6.))
                .rounded(px(6.))
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .child(label)
                .child(Icon::ARROW_DOWN.element(px(11.), ink))
                .when_some(next, |step, next| {
                    step.cursor_pointer()
                        .hover(|style| style.bg(palette.hover).text_color(palette.text))
                        .tooltip(|_, cx| LatticeTooltip::view(t!("Next finding"), None, cx))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.open_finding(Some(next), cx)),
                        )
                })
                .into_any_element(),
        )
    }

    /// Each changed field, its value struck, an arrow, and what it becomes.
    fn fields(&self, changes: &[Change], cx: &App) -> AnyElement {
        let palette = cx.palette().clone();
        let or_dash = |value: &str| {
            if value.is_empty() {
                "—".to_string()
            } else {
                value.to_string()
            }
        };
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .children(changes.iter().map(|change| {
                let before = or_dash(&change.before);
                let struck = HighlightStyle {
                    color: Some(palette.text_secondary),
                    strikethrough: Some(StrikethroughStyle {
                        thickness: px(1.),
                        color: Some(palette.danger),
                    }),
                    ..HighlightStyle::default()
                };
                let length = before.len();
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_none()
                            .w(px(84.))
                            .text_color(palette.text_secondary.opacity(0.8))
                            .child(bib_field_name(&change.field).to_string()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .flex_wrap()
                            .items_center()
                            .gap(px(4.))
                            .min_w_0()
                            .child(
                                StyledText::new(SharedString::from(before))
                                    .with_highlights([(0..length, struck)]),
                            )
                            .child(
                                Icon::ARROW_RIGHT
                                    .element(px(11.), palette.text_secondary.opacity(0.8)),
                            )
                            .child(div().text_color(palette.text).child(or_dash(&change.after))),
                    )
            }))
            .into_any_element()
    }

    /// The fix bucket's finding.
    pub(super) fn fix_finding(
        &self,
        index: usize,
        entry: &AuditEntry,
        result: &Finding,
        listing: &Listing,
        written: (String, String),
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let after = result.after.clone().unwrap_or_default();
        let mut out = Vec::new();
        let mut actions = self.actions();
        match &entry.inline {
            None => {
                if super::fix_group(&result.changes) == FixGroup::Disputed {
                    out.push(self.note(
                        t!("Your entry and the source give different values, and either may be right, so Apply all leaves this one to you.").into(),
                        cx,
                    ));
                }
                out.extend(self.typeset_card(
                    typeset::typeset_bib_fix(&entry.bibtex, &after, &result.changes),
                    cx,
                ));
                let mut apply = Button::new(("audit-apply", index), t!("Apply"))
                    .tinted()
                    .compact()
                    .icon(if self.applying {
                        Icon::LOADER
                    } else {
                        Icon::CHECK
                    })
                    .disabled(!self.can_apply(index))
                    .on_click(cx.listener(move |this, _, _, cx| this.apply_and_advance(index, cx)));
                if let Some(keys) = key_label(&ApplyFixChord, cx) {
                    apply = apply.keys(keys);
                }
                actions = actions.child(apply);
            }
            Some(inline) => {
                out.extend(
                    self.typeset_card(typeset::typeset_inline_fix(inline, &result.changes), cx),
                );
                out.push(self.note(
                    t!(
                        "{0} keeps its own reference list. Lattice compares it with the verified record but never edits it",
                        entry.path
                    ),
                    cx,
                ));
                let copy = t!("Copy corrected {BIBITEM}").replace("{BIBITEM}", BIBITEM);
                actions = actions
                    .children(self.go_to(
                        index,
                        entry,
                        super::detail::go_to_bibitem(&entry.path),
                        true,
                        cx,
                    ))
                    .child(
                        CopyButton::new(
                            ("audit-copy-bibitem", index),
                            typeset::corrected_bibitem(&entry.key, inline, &after, &result.changes),
                        )
                        .label(copy)
                        .ghost(),
                    );
            }
        }
        out.push(
            actions
                .children(self.skip(index, listing, cx))
                .children(self.step(index, listing, cx))
                .into_any_element(),
        );
        let proposed: String = if entry.inline.is_some() {
            t!("Verified record (BibTeX)").into()
        } else {
            t!("Proposed BibTeX").into()
        };
        let changes = result.changes.clone();
        let (written_label, written_text) = written;
        out.push(self.disclosure(
            index,
            "fields",
            t!("Fields and BibTeX").into(),
            move |this, cx| {
                this.more_body(cx)
                    .child(this.fields(&changes, cx))
                    .child(this.bibtex(Some(proposed), after, cx))
                    .child(this.bibtex(Some(written_label), written_text, cx))
                    .into_any_element()
            },
            cx,
        ));
        out
    }
}
