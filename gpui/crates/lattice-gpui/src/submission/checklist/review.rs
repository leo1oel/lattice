//! The double-blind and font checks under the automatic rows, ported from
//! the Tauri app's `submission-review-state.ts` and `submission-review.tsx`:
//! the anonymity rows under the venue whose template the paper loads (a
//! camera-ready copy keeps only a note), then the PDF's fonts. Each finding
//! is a line under its row: where it is, a way to it, and what it says, cut
//! to one line; past five they are counted.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use lattice_core::latex::{ReviewCheck, ReviewFinding, ReviewMode, SubmissionReview};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, typography::tabular_nums};

use super::{
    ChecklistEvent, ChecklistPanel,
    view::{RowParts, Tone, checklist_row, rows_group, section_title},
};

/// Findings past this many are counted, not listed.
const LISTED_FINDINGS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RowId {
    Authors,
    Acknowledgements,
    Links,
    SelfCitation,
    PdfAuthor,
    Type3,
    Unembedded,
}

/// One review row's result, as the verdict counts it.
pub(super) struct ReviewRow {
    pub id: RowId,
    pub ok: Option<bool>,
    pub findings: Vec<ReviewFinding>,
}

/// The rows a review comes to (`reviewRows`): a camera-ready copy has no
/// anonymity rows; a row about the PDF cannot settle without one (or, for
/// the fonts, without a PDF whose fonts could be read).
pub(super) fn rows(review: Option<&SubmissionReview>) -> Vec<ReviewRow> {
    let Some(review) = review else {
        return Vec::new();
    };
    let row = |id: RowId, checks: &[ReviewCheck], settled: bool| {
        let findings: Vec<ReviewFinding> = review
            .findings
            .iter()
            .filter(|finding| checks.contains(&finding.check))
            .cloned()
            .collect();
        ReviewRow {
            id,
            ok: settled.then_some(findings.is_empty()),
            findings,
        }
    };
    let mut rows = Vec::new();
    if let Some(mode) = review.mode.filter(|mode| *mode != ReviewMode::CameraReady) {
        let mut authors = row(RowId::Authors, &[ReviewCheck::AuthorsShown], true);
        authors.ok = match mode {
            ReviewMode::Anonymous => Some(true),
            ReviewMode::AuthorsShown => Some(false),
            _ => None,
        };
        rows.push(authors);
        rows.push(row(
            RowId::Acknowledgements,
            &[ReviewCheck::Acknowledgements, ReviewCheck::Thanks],
            true,
        ));
        rows.push(row(RowId::Links, &[ReviewCheck::IdentifyingLink], true));
        rows.push(row(RowId::SelfCitation, &[ReviewCheck::SelfCitation], true));
        rows.push(row(RowId::PdfAuthor, &[ReviewCheck::PdfAuthor], review.pdf));
    }
    let fonts = review.pdf && review.fonts_read;
    rows.push(row(RowId::Type3, &[ReviewCheck::Type3Font], fonts));
    rows.push(row(
        RowId::Unembedded,
        &[ReviewCheck::UnembeddedFont],
        fonts,
    ));
    rows
}

fn label(id: RowId) -> &'static str {
    match id {
        RowId::Authors => t!("Author names"),
        RowId::Acknowledgements => t!("Acknowledgements and thanks"),
        RowId::Links => t!("Links to your accounts"),
        RowId::SelfCitation => t!("Self-citing wording"),
        RowId::PdfAuthor => t!("Author in PDF metadata"),
        RowId::Type3 => t!("Type 3 fonts"),
        RowId::Unembedded => t!("Fonts not embedded"),
    }
}

impl ChecklistPanel {
    pub(super) fn render_review(
        &self,
        rows: &[ReviewRow],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let review = self.facts.review.as_ref()?;
        let palette = cx.palette().clone();
        let venue = review.venue.unwrap_or_default();
        let mode = review.mode;
        let mut sections = Vec::new();
        if mode == Some(ReviewMode::CameraReady) {
            sections.push(
                div()
                    .child(section_title(t!("Double-blind review"), cx))
                    .child(
                        div()
                            .mb(px(16.))
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(t!(
                                "{venue} camera-ready copy: anonymity is not checked.",
                                venue = venue
                            )),
                    )
                    .into_any_element(),
            );
        }
        let fonts = |row: &&ReviewRow| matches!(row.id, RowId::Type3 | RowId::Unembedded);
        let blind: Vec<AnyElement> = rows
            .iter()
            .filter(|row| !fonts(row))
            .map(|row| self.review_row(row, mode, window, cx))
            .collect();
        if !blind.is_empty() {
            sections.push(
                div()
                    .child(section_title(
                        t!("Double-blind review for {venue}", venue = venue),
                        cx,
                    ))
                    .child(rows_group(blind, cx))
                    .into_any_element(),
            );
        }
        let font_rows: Vec<AnyElement> = rows
            .iter()
            .filter(fonts)
            .map(|row| self.review_row(row, mode, window, cx))
            .collect();
        sections.push(
            div()
                .child(section_title(t!("PDF fonts"), cx))
                .child(rows_group(font_rows, cx))
                .into_any_element(),
        );
        Some(div().children(sections).into_any_element())
    }

    fn review_row(
        &self,
        row: &ReviewRow,
        mode: Option<ReviewMode>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let authors = row.id == RowId::Authors;
        let value = if authors {
            match mode {
                Some(ReviewMode::Anonymous) => t!("Hidden").to_string(),
                Some(ReviewMode::AuthorsShown) => t!("Shown").to_string(),
                _ => t!("Unknown").to_string(),
            }
        } else if row.ok.is_none() {
            t!("Build to check").to_string()
        } else if row.findings.is_empty() {
            t!("None").to_string()
        } else {
            row.findings.len().to_string()
        };
        let detail = authors
            .then(|| match mode {
                Some(ReviewMode::AuthorsShown) => Some(t!(
                    "The template's option prints the authors; remove it for review"
                )),
                Some(ReviewMode::Unknown) => Some(t!("The template's options were not found")),
                _ => None,
            })
            .flatten();
        let mut under: Vec<AnyElement> = detail
            .map(|detail| {
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(detail)
                    .into_any_element()
            })
            .into_iter()
            .collect();
        if !row.findings.is_empty() {
            let hidden = row.findings.len().saturating_sub(LISTED_FINDINGS);
            let lines =
                row.findings
                    .iter()
                    .take(LISTED_FINDINGS)
                    .enumerate()
                    .map(|(index, finding)| {
                        let place = finding.file.clone().zip(finding.line);
                        div()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .gap(px(6.))
                            .text_role(TextRole::Caption, cx)
                            .children(place.map(|(file, line)| {
                                let id = SharedString::from(format!(
                                    "review-finding-{:?}-{index}",
                                    row.id
                                ));
                                div()
                                    .id(id)
                                    .flex_none()
                                    .max_w(gpui::relative(0.6))
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .text_color(palette.accent)
                                    .font_features(tabular_nums())
                                    .cursor_pointer()
                                    .child(format!("{file}:{line}"))
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        cx.emit(ChecklistEvent::Open {
                                            path: file.clone(),
                                            line: Some(line),
                                        })
                                    }))
                            }))
                            .child(
                                div()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .text_color(palette.text_secondary)
                                    .child(if finding.text.is_empty() {
                                        t!("Unnamed font").to_string()
                                    } else {
                                        finding.text.clone()
                                    }),
                            )
                            .into_any_element()
                    });
            let more = (hidden > 0).then(|| {
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(if hidden == 1 {
                        t!("1 more").to_string()
                    } else {
                        t!("{hidden} more", hidden = hidden)
                    })
                    .into_any_element()
            });
            under.push(
                div()
                    .mt(px(2.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .children(lines)
                    .children(more)
                    .into_any_element(),
            );
        }
        checklist_row(
            RowParts {
                id: SharedString::from(format!("checklist-review-{:?}", row.id)),
                tone: Tone::of(row.ok),
                mark: None,
                label: label(row.id).into(),
                value: Some(value.into_any_element()),
                under,
                on_click: None,
                chevron: false,
            },
            window,
            cx,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(check: ReviewCheck) -> ReviewFinding {
        ReviewFinding {
            check,
            file: Some("main.tex".into()),
            line: Some(3),
            text: "github.com/someone".into(),
        }
    }

    #[test]
    fn a_review_comes_to_its_rows_as_the_tauri_app_reads_it() {
        let review = SubmissionReview {
            venue: Some("NeurIPS"),
            mode: Some(ReviewMode::Anonymous),
            pdf: false,
            fonts_read: false,
            findings: vec![finding(ReviewCheck::IdentifyingLink)],
        };
        let rows = rows(Some(&review));
        let results: Vec<(RowId, Option<bool>)> = rows.iter().map(|row| (row.id, row.ok)).collect();
        assert_eq!(
            results,
            [
                (RowId::Authors, Some(true)),
                (RowId::Acknowledgements, Some(true)),
                (RowId::Links, Some(false)),
                (RowId::SelfCitation, Some(true)),
                (RowId::PdfAuthor, None),
                (RowId::Type3, None),
                (RowId::Unembedded, None),
            ]
        );
        // A camera-ready copy keeps only the font rows.
        let camera = SubmissionReview {
            mode: Some(ReviewMode::CameraReady),
            pdf: true,
            fonts_read: true,
            ..review
        };
        let ids: Vec<RowId> = super::rows(Some(&camera))
            .iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(ids, [RowId::Type3, RowId::Unembedded]);
    }
}
