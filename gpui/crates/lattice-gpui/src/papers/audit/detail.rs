//! A reference's open finding (`bibliography-audit.tsx` `detailFor`): what
//! its bucket asks of the writer and the actions that answer it, the
//! publisher's notice on the work, the evidence under Details, and the
//! entry as written. A fix is drawn by `fix.rs`, an unverified candidate's
//! fields beside the entry's by `compare.rs`; Skip and the "N of M"
//! stepper move on through the review queue (`queue.rs`). A reference not
//! checked yet offers Check this reference. Go to opens the entry only
//! where the scan placed it.

use gpui::{
    AnyElement, App, Context, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _,
    px,
};
use lattice_core::citation_audit::AuditEntry;
use lattice_i18n::{join_list, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::Button, icons::ICON_SMALL,
    interaction::mix,
};

use super::{Audit, Bucket, Finding, queue::Listing, summary};

/// A LaTeX command the copy names; never translated.
pub(super) const BIBITEM: &str = "\\bibitem";

/// "Go to \bibitem in {path}" for an inline reference.
pub(super) fn go_to_bibitem(path: &str) -> String {
    t!("Go to {BIBITEM} in {0}", path).replace("{BIBITEM}", BIBITEM)
}

/// The notice's tone: a retraction in the danger ink, any other notice in
/// the warning one, and a link alone in the secondary one.
fn notice_ink(kind: Option<&str>, cx: &App) -> Hsla {
    let palette = cx.palette();
    match kind {
        Some("retracted") => mix(palette.danger, palette.text, 0.2),
        Some(_) => mix(palette.warning, palette.text, 0.22),
        None => palette.text_secondary,
    }
}

/// "Publisher notice: {kind}", the notice's own type when it names one.
pub(super) fn notice_line(result: &Finding) -> Option<(String, String)> {
    let health = result.health.as_ref().filter(|_| result.has_notice())?;
    let kind = health
        .update_type
        .clone()
        .filter(|kind| !kind.is_empty())
        .unwrap_or_else(|| health.kind.clone());
    Some((
        format!("{}: {kind}", t!("Publisher notice")),
        health.kind.clone(),
    ))
}

/// Each source asked and what it said, in the interface language.
fn source_rows(result: &Finding) -> Vec<(String, String)> {
    result
        .sources
        .iter()
        .map(|source| {
            (
                summary::source_name(&source.source).to_string(),
                super::messages::source_outcome(&result.status, &source.outcome),
            )
        })
        .collect()
}

/// The sources asked, a name over what it said (`sources`); none when no
/// source was.
fn sources_list(rows: Vec<(String, String)>, cx: &App) -> Option<AnyElement> {
    if rows.is_empty() {
        return None;
    }
    let palette = cx.palette();
    Some(
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .text_role(TextRole::Caption, cx)
            .children(rows.into_iter().map(|(name, outcome)| {
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .child(div().text_color(palette.text).child(name))
                    .child(div().text_color(palette.text_secondary).child(outcome))
            }))
            .into_any_element(),
    )
}

impl Audit {
    fn caption(&self, text: String, ink: Hsla, cx: &App) -> AnyElement {
        div()
            .text_role(TextRole::Caption, cx)
            .text_color(ink)
            .child(text)
            .into_any_element()
    }

    /// A note in the secondary ink (`.bibliography-audit-note`).
    pub(super) fn note(&self, text: String, cx: &App) -> AnyElement {
        self.caption(text, cx.palette().text_secondary, cx)
    }

    /// A finding's actions, in a wrapping row (`-detail-actions`).
    pub(super) fn actions(&self) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .min_w_0()
    }

    /// An opened disclosure's body (`.bibliography-audit-more-body`).
    pub(super) fn more_body(&self, cx: &App) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .text_role(TextRole::Caption, cx)
            .text_color(cx.palette().text_secondary)
    }

    /// A BibTeX record as it is written, under its label
    /// (`.bibliography-audit-source`): the input's surface, the diff's code
    /// type in the secondary ink, scrolling past 200px.
    pub(super) fn bibtex(&self, label: Option<String>, text: String, cx: &App) -> AnyElement {
        let palette = cx.palette();
        // Its scroll is its own: keyed by what it shows, as two records of
        // one finding differ.
        let id = {
            use std::hash::{Hash as _, Hasher as _};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (&label, &text).hash(&mut hasher);
            SharedString::from(format!("audit-bibtex-{:x}", hasher.finish()))
        };
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .children(label.map(|label| {
                div()
                    .text_role(TextRole::Micro, cx)
                    .text_color(palette.text_secondary.opacity(0.8))
                    .child(label)
            }))
            .child(
                div()
                    .id(id)
                    .max_h(px(200.))
                    .overflow_y_scroll()
                    .p(px(10.))
                    .rounded(px(6.))
                    .bg(palette.input)
                    .font_family(cx.lattice().fonts.editor.clone())
                    .text_size(px(11.))
                    .line_height(px(17.))
                    .text_color(palette.text_secondary)
                    .child(text),
            )
            .into_any_element()
    }

    /// A fold the writer opens (`Disclosure`): its summary in the caption's
    /// secondary ink with a chevron that turns, lighting under the pointer,
    /// and its body 8px under it once open.
    pub(super) fn disclosure(
        &self,
        index: usize,
        name: &'static str,
        summary: String,
        body: impl FnOnce(&Self, &App) -> AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let open = self.disclosed.contains(&(index, name));
        let chevron = Icon::CHEVRON_RIGHT.element(ICON_SMALL, palette.text_secondary.opacity(0.8));
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .id(SharedString::from(format!("audit-{name}-{index}")))
                    .flex()
                    .flex_none()
                    .self_start()
                    .items_center()
                    .gap(px(6.))
                    .px(px(4.))
                    .py(px(2.))
                    .ml(px(-4.))
                    .rounded(px(4.))
                    .cursor_pointer()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .hover(|style| style.text_color(palette.text).bg(palette.hover))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.toggle_disclosure(index, name, cx)),
                    )
                    .child(if open {
                        chevron
                            .with_transformation(gpui::Transformation::rotate(gpui::percentage(
                                0.25,
                            )))
                            .into_any_element()
                    } else {
                        chevron.into_any_element()
                    })
                    .child(summary),
            )
            .when(open, |fold| fold.child(body(self, cx)))
            .into_any_element()
    }

    /// The publisher's notice on the work, and its link (`healthNotice`).
    fn health_notice(&self, result: &Finding, cx: &mut Context<Self>) -> Option<AnyElement> {
        let health = result.health.as_ref()?;
        let line = notice_line(result);
        let link = health.link.clone().filter(|link| {
            let lower = link.to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        });
        if line.is_none() && link.is_none() {
            return None;
        }
        let ink = notice_ink(line.as_ref().map(|(_, kind)| kind.as_str()), cx);
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .when_some(line, |notice, (line, _)| {
                    notice.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .child(Icon::TRIANGLE_ALERT.element(ICON_SMALL, ink))
                            .child(line),
                    )
                })
                .when_some(link, |notice, link| {
                    notice.child(
                        Button::new("audit-open-notice", t!("Open notice"))
                            .compact()
                            .ghost()
                            .icon(Icon::EXTERNAL_LINK)
                            .on_click(move |_, _, cx| cx.open_url(&link)),
                    )
                })
                .into_any_element(),
        )
    }

    /// Go to the entry, where the scan placed it; none otherwise.
    pub(super) fn go_to(
        &self,
        index: usize,
        entry: &AuditEntry,
        label: String,
        tinted: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        entry.line?;
        let button = Button::new(("audit-source", index), label)
            .compact()
            .disabled(self.applying);
        let button = if tinted {
            button.tinted()
        } else {
            button.ghost()
        };
        Some(
            button
                .on_click(cx.listener(move |this, _, _, cx| this.open_source(index, cx)))
                .into_any_element(),
        )
    }

    fn recheck(&self, index: usize, label: &'static str, cx: &mut Context<Self>) -> AnyElement {
        Button::new(("audit-again", index), label)
            .compact()
            .ghost()
            .icon(Icon::ROTATE_CCW)
            .disabled(self.busy || self.applying)
            .on_click(cx.listener(move |this, _, _, cx| this.check(Some(vec![index]), cx)))
            .into_any_element()
    }

    /// The verdict's reasoning (`details`): what the check said, unless the
    /// finding already says it, the sources asked and what they said, where
    /// they disagree, and when the work's health and the reference were
    /// checked.
    fn details(
        &self,
        index: usize,
        result: &Finding,
        message: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let note = message
            .then(|| {
                super::messages::publication_message(
                    &result.message,
                    result.publication_reason.as_deref(),
                )
            })
            .flatten();
        let disagreements: Vec<String> = result
            .disagreements
            .iter()
            .map(|field| summary::field_label(field))
            .collect();
        let sources = source_rows(result);
        let health = result.health.as_ref().and_then(|health| {
            let at = super::messages::checked_time(&health.checked_at)?;
            let stale = if health.stale {
                t!(" (Stale result)")
            } else {
                ""
            };
            Some(format!("{}: {at}{stale}", t!("Health checked at")))
        });
        let checked = result
            .checked_at
            .as_deref()
            .and_then(super::messages::checked_time)
            .map(|at| format!("{}: {at}", t!("Last checked")));
        self.disclosure(
            index,
            "details",
            t!("Details").into(),
            move |this, cx| {
                let ink = cx.palette().text_secondary;
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .children(note.map(|note| this.caption(note, ink, cx)))
                    .children(sources_list(sources, cx))
                    .when(!disagreements.is_empty(), |details| {
                        details.child(this.caption(
                            t!(
                                "The conference's own citation export and Crossref disagree on: {0}. The conference export is kept.",
                                disagreements.join(", ")
                            ),
                            ink,
                            cx,
                        ))
                    })
                    .children(health.map(|line| this.caption(line, ink, cx)))
                    .children(checked.map(|line| this.caption(line, ink, cx)))
                    .into_any_element()
            },
            cx,
        )
    }
}

impl Audit {
    /// The open finding: what to do about it, and the evidence. Under its
    /// row or in the queue's pane, the caller places it.
    pub(super) fn finding(
        &self,
        index: usize,
        listing: &Listing,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entry = self.entries[index].clone();
        let bucket = self.bucket(index);
        let applied = self.applied.contains(&index);
        let result = self.results.get(&index).cloned();
        // The scan is the source of truth until an accepted fix is written;
        // a candidate record never displaces it.
        let current = match &result {
            Some(result) if applied && result.candidate.is_none() => {
                result.after.clone().unwrap_or_else(|| entry.bibtex.clone())
            }
            _ => entry.bibtex.clone(),
        };
        let written_label: String = if entry.inline.is_some() {
            t!("Reference as written").into()
        } else {
            t!("Current BibTeX").into()
        };
        let written_text = entry.inline.clone().unwrap_or(current);
        let written = |this: &Self, cx: &mut Context<Self>| {
            let text = written_text.clone();
            this.disclosure(
                index,
                "written",
                written_label.clone(),
                move |this, cx| this.bibtex(None, text, cx),
                cx,
            )
        };
        let mut body = div().flex().flex_col().gap(px(10.)).min_w_0();
        let Some(result) = result else {
            return body
                .child(
                    self.actions()
                        .child(self.recheck(index, t!("Check this reference"), cx)),
                )
                .child(written(self, cx))
                .into_any_element();
        };
        let has_candidate = result.candidate.is_some();
        let inline = entry.inline.is_some();
        if bucket == Bucket::Fix {
            body = body.children(self.fix_finding(
                index,
                &entry,
                &result,
                listing,
                (written_label.clone(), written_text.clone()),
                cx,
            ));
        }
        if matches!(bucket, Bucket::Review | Bucket::Kept) {
            // The bucket and the comparison say the rest; a notice not yet
            // read is the one thing to warn about.
            if bucket == Bucket::Review && !has_candidate {
                body = body.child(self.note(
                    t!("The publisher has issued a notice about this paper. Read it before you keep citing it.").into(),
                    cx,
                ));
            }
            if !has_candidate {
                body = body.children(self.health_notice(&result, cx));
            }
            if let Some(candidate) = &result.candidate {
                body = body.children(super::compare::compare(&result, &candidate.changes, cx));
                if !candidate.reasons.is_empty() {
                    let reasons: Vec<String> = candidate
                        .reasons
                        .iter()
                        .map(|reason| summary::reason_label(reason))
                        .collect();
                    body = body.child(self.note(
                        format!(
                            "{}: {}",
                            t!("Conflicting or insufficient fields"),
                            join_list(&reasons)
                        ),
                        cx,
                    ));
                }
            }
            let keep = if bucket == Bucket::Review {
                Button::new(("audit-keep", index), t!("Keep mine"))
                    .tinted()
                    .compact()
                    .icon(Icon::CHECK)
                    .disabled(self.busy)
                    .on_click(cx.listener(move |this, _, _, cx| this.keep(index, true, cx)))
            } else {
                Button::new(("audit-review-again", index), t!("Review again"))
                    .compact()
                    .ghost()
                    .disabled(self.busy)
                    .on_click(cx.listener(move |this, _, _, cx| this.keep(index, false, cx)))
            };
            let go_to = if inline {
                go_to_bibitem(&entry.path)
            } else {
                t!("Open entry").into()
            };
            let mut actions = self
                .actions()
                .child(keep)
                .children(self.go_to(index, &entry, go_to, false, cx));
            if bucket == Bucket::Review {
                actions = actions
                    .children(self.skip(index, listing, cx))
                    .children(self.step(index, listing, cx));
            }
            body = body.child(actions);
            if let Some(bibtex) = result
                .candidate
                .as_ref()
                .map(|candidate| candidate.bibtex.clone())
                .filter(|bibtex| !bibtex.is_empty())
            {
                body = body.child(self.disclosure(
                    index,
                    "candidate",
                    t!("Unverified candidate BibTeX").into(),
                    move |this, cx| this.bibtex(None, bibtex, cx),
                    cx,
                ));
            }
        }
        if matches!(bucket, Bucket::Incomplete | Bucket::Verified) {
            let note = if bucket == Bucket::Verified && applied {
                Some(t!("Applied. The entry now matches the verified record.").to_string())
            } else {
                super::messages::publication_message(
                    &result.message,
                    result.publication_reason.as_deref(),
                )
            };
            body = body
                .children(note.map(|note| self.note(note, cx)))
                .when(bucket == Bucket::Incomplete, |body| {
                    body.children(sources_list(source_rows(&result), cx))
                })
                .child(
                    self.actions()
                        .child(self.recheck(index, t!("Check again"), cx)),
                );
        }
        if !(matches!(bucket, Bucket::Review | Bucket::Kept) && !has_candidate) {
            body = body.children(self.health_notice(&result, cx));
        }
        if bucket != Bucket::Incomplete {
            body = body.child(self.details(index, &result, bucket != Bucket::Verified, cx));
        }
        if bucket != Bucket::Fix {
            body = body.child(written(self, cx));
        }
        body.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_core::citation_health::CitationHealth;

    fn health(kind: &str, update_type: Option<&str>) -> Finding {
        Finding {
            status: "checked".into(),
            health: Some(CitationHealth {
                kind: kind.into(),
                update_type: update_type.map(Into::into),
                source: None,
                date: None,
                link: None,
                checked_at: String::new(),
                stale: false,
            }),
            ..Default::default()
        }
    }

    // `healthNotice` and the row's tag: "Publisher notice: {updateType || kind}".
    #[test]
    fn a_notice_reads_by_its_own_type_else_its_kind() {
        assert_eq!(
            notice_line(&health("retracted", None)),
            Some(("Publisher notice: retracted".into(), "retracted".into()))
        );
        assert_eq!(
            notice_line(&health("corrected", Some("erratum"))).map(|(line, _)| line),
            Some("Publisher notice: erratum".into())
        );
        assert_eq!(notice_line(&health("unknown", Some("x"))), None);
    }
}
