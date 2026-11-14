//! A reference's open finding (`bibliography-audit.tsx` `detailFor`): what
//! its bucket asks of the writer and the actions that answer it, the
//! publisher's notice on the work, the evidence under Details, and the
//! entry as written. A reference not checked yet offers Check this
//! reference. Go to opens the entry only where the scan placed it.

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

use super::{Audit, Bucket, Change, Finding, FixGroup, summary};

/// A LaTeX command the copy names; never translated.
const BIBITEM: &str = "\\bibitem";

/// A field's name where the reference itself is shown (`bibFieldName`):
/// English, as the `.bib` file and the printed bibliography are.
pub(super) fn bib_field_name(field: &str) -> &str {
    match field {
        "title" => "Title",
        "author" => "Authors",
        "year" => "Year",
        "journal" => "Journal",
        "booktitle" => "Booktitle",
        "publisher" => "Publisher",
        "volume" => "Volume",
        "number" => "Number",
        "pages" => "Pages",
        "doi" => "DOI",
        "url" => "URL",
        "ENTRYTYPE" => "Entry type",
        "venue" => "Venue",
        other => other,
    }
}

/// "Go to \bibitem in {path}" for an inline reference.
fn go_to_bibitem(path: &str) -> String {
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

    /// A BibTeX record as it is written, under its label.
    fn bibtex(&self, label: Option<String>, text: String, cx: &App) -> AnyElement {
        let palette = cx.palette();
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .children(label.map(|label| self.caption(label, palette.text_secondary, cx)))
            .child(
                div()
                    .p(px(8.))
                    .rounded(px(6.))
                    .bg(palette.text.opacity(0.03))
                    .font_family(cx.lattice().fonts.editor.clone())
                    .text_size(px(11.))
                    .text_color(palette.text)
                    .child(text),
            )
            .into_any_element()
    }

    /// A fold the writer opens: its summary, and its body once open.
    fn disclosure(
        &self,
        index: usize,
        name: &'static str,
        summary: String,
        body: impl FnOnce(&Self, &App) -> AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let open = self.disclosed.contains(&(index, name));
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .id(SharedString::from(format!("audit-{name}-{index}")))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .cursor_pointer()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .hover(|style| style.text_color(palette.text))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.toggle_disclosure(index, name, cx)),
                    )
                    .child(
                        if open {
                            Icon::CHEVRON_DOWN
                        } else {
                            Icon::CHEVRON_RIGHT
                        }
                        .element(ICON_SMALL, palette.text_secondary),
                    )
                    .child(summary),
            )
            .when(open, |fold| fold.child(body(self, cx)))
            .into_any_element()
    }

    /// The fields a fix or a candidate changes, each struck and replaced.
    fn changes(&self, changes: &[Change], label: impl Fn(&str) -> String, cx: &App) -> AnyElement {
        let palette = cx.palette();
        let editor = cx.lattice().fonts.editor.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .p(px(8.))
            .rounded(px(6.))
            .bg(palette.text.opacity(0.03))
            .children(changes.iter().map(|change| {
                div()
                    .flex()
                    .gap(px(8.))
                    .text_role(TextRole::Caption, cx)
                    .child(
                        div()
                            .flex_none()
                            .w(px(96.))
                            .truncate()
                            .font_family(editor.clone())
                            .text_size(px(11.))
                            .text_color(palette.text_secondary)
                            .child(label(&change.field)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_color(mix(palette.danger, palette.text, 0.25))
                                    .line_through()
                                    .child(if change.before.is_empty() {
                                        "—".to_string()
                                    } else {
                                        change.before.clone()
                                    }),
                            )
                            .child(
                                div()
                                    .text_color(mix(palette.success, palette.text, 0.2))
                                    .child(if change.after.is_empty() {
                                        "—".to_string()
                                    } else {
                                        change.after.clone()
                                    }),
                            ),
                    )
            }))
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
    fn go_to(
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
            .icon(Icon::EXTERNAL_LINK)
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

    /// The open finding: what to do about it, and the evidence.
    pub(super) fn finding(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
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
        let mut body = div().flex().flex_col().gap(px(8.)).px(px(12.)).pb(px(12.));
        let actions = || div().flex().flex_wrap().gap(px(6.));
        let Some(result) = result else {
            return body
                .child(actions().child(self.recheck(index, t!("Check this reference"), cx)))
                .child(written(self, cx))
                .into_any_element();
        };
        let note_ink = palette.text;
        let has_candidate = result.candidate.is_some();
        let inline = entry.inline.is_some();
        if bucket == Bucket::Fix {
            if !inline && super::fix_group(&result.changes) == FixGroup::Disputed {
                body = body.child(self.caption(
                    t!("Your entry and the source give different values, and either may be right, so Apply all leaves this one to you.").into(),
                    note_ink,
                    cx,
                ));
            }
            body =
                body.child(self.changes(&result.changes, |field| bib_field_name(field).into(), cx));
            if inline {
                body = body
                    .child(self.caption(
                        t!(
                            "{0} keeps its own reference list. Lattice compares it with the verified record but never edits it",
                            entry.path
                        ),
                        note_ink,
                        cx,
                    ))
                    .children(self.go_to(index, &entry, go_to_bibitem(&entry.path), true, cx));
            } else {
                body = body.child(
                    actions().child(
                        Button::new(("audit-apply", index), t!("Apply"))
                            .tinted()
                            .compact()
                            .icon(Icon::CHECK)
                            .disabled(self.applying || self.busy || result.after.is_none())
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.apply(vec![index], cx)),
                            ),
                    ),
                );
            }
            let proposed: String = if inline {
                t!("Verified record (BibTeX)").into()
            } else {
                t!("Proposed BibTeX").into()
            };
            let (after, written_label, written_text) = (
                result.after.clone().unwrap_or_default(),
                written_label.clone(),
                written_text.clone(),
            );
            body = body.child(self.disclosure(
                index,
                "fields",
                t!("Fields and BibTeX").into(),
                move |this, cx| {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(this.bibtex(Some(proposed), after, cx))
                        .child(this.bibtex(Some(written_label), written_text, cx))
                        .into_any_element()
                },
                cx,
            ));
        }
        if matches!(bucket, Bucket::Review | Bucket::Kept) {
            // The bucket and the comparison say the rest; a notice not yet
            // read is the one thing to warn about.
            if bucket == Bucket::Review && !has_candidate {
                body = body.child(self.caption(
                    t!("The publisher has issued a notice about this paper. Read it before you keep citing it.").into(),
                    note_ink,
                    cx,
                ));
            }
            if !has_candidate {
                body = body.children(self.health_notice(&result, cx));
            }
            if let Some(candidate) = &result.candidate {
                if !candidate.changes.is_empty() {
                    body = body.child(self.changes(&candidate.changes, summary::field_label, cx));
                }
                if !candidate.reasons.is_empty() {
                    let reasons: Vec<String> = candidate
                        .reasons
                        .iter()
                        .map(|reason| summary::reason_label(reason))
                        .collect();
                    body = body.child(self.caption(
                        format!(
                            "{}: {}",
                            t!("Conflicting or insufficient fields"),
                            join_list(&reasons)
                        ),
                        palette.text_secondary,
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
            body = body.child(
                actions()
                    .child(keep)
                    .children(self.go_to(index, &entry, go_to, false, cx)),
            );
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
                .children(note.map(|note| self.caption(note, note_ink, cx)))
                .when(bucket == Bucket::Incomplete, |body| {
                    body.children(sources_list(source_rows(&result), cx))
                })
                .child(actions().child(self.recheck(index, t!("Check again"), cx)));
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

    #[test]
    fn a_field_reads_by_its_bibtex_name() {
        assert_eq!(bib_field_name("ENTRYTYPE"), "Entry type");
        assert_eq!(bib_field_name("booktitle"), "Booktitle");
        assert_eq!(bib_field_name("howpublished"), "howpublished");
    }
}
