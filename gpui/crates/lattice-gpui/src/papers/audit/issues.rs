//! What the scan found to tidy in the bibliography files themselves (an
//! empty field, a duplicate DOI, an Overleaf conflict), in the interface
//! language (`audit-messages.ts` `auditIssueText`), and the list the All
//! view shows them in ("N things to tidy in the bibliography").

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
};
use lattice_core::citation_audit::AuditIssue;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, icons::ICON_SMALL, interaction::mix,
};

use super::Audit;

/// The disclosure's name in `Audit::disclosed`, under no reference.
const TIDY: &str = "tidy";

/// A scan finding in the interface language; a code this build does not
/// know keeps lattice-core's English.
pub(super) fn issue_text(issue: &AuditIssue) -> String {
    let param = |name: &str| issue.params.get(name).map_or("", String::as_str);
    let kind = param("type");
    match issue.code {
        "bibliography-conflict" => t!(
            "This bibliography has an unresolved Overleaf sync conflict. Resolve it before checking or updating its references."
        )
        .to_string(),
        "unparsed-constructs" => t!(
            "Could not parse {count} bibliography construct(s).",
            count = param("count")
        ),
        "unclosed-entry" => t!("Unclosed bibliography entry; online check skipped.").to_string(),
        "unknown-entry-type" => t!("Unknown bibliography entry type `{type}`.", type = kind),
        "empty-field" => t!("Empty {field} field.", field = param("field")),
        "repeated-authors" => t!(
            "Repeated author names; verify against the publication's author list before removing duplicates."
        )
        .to_string(),
        "missing-field" => {
            // BibTeX field names, with at most one accepted alternative.
            let requirement = param("requirement");
            let mut names = requirement.splitn(2, " or ");
            let field = names.next().unwrap_or("");
            match names.next() {
                Some(alternative) => t!(
                    "Missing {field} or {alternative} field for {type} entry.",
                    field = field,
                    alternative = alternative,
                    type = kind
                ),
                None => t!(
                    "Missing {field} field for {type} entry.",
                    field = field,
                    type = kind
                ),
            }
        }
        "article-uses-booktitle" => {
            t!("Article entry uses booktitle instead of journal.").to_string()
        }
        "proceedings-uses-journal" if kind == "conference" => {
            t!("Conference entry uses journal instead of booktitle.").to_string()
        }
        "proceedings-uses-journal" => {
            t!("Inproceedings entry uses journal instead of booktitle.").to_string()
        }
        "invalid-year" => t!("Invalid literal year; expected four digits.").to_string(),
        "duplicate-key" => t!("Duplicate citation key across bibliography files.").to_string(),
        "duplicate-doi" => t!("Duplicate DOI across bibliography files.").to_string(),
        "duplicate-title" => t!("Duplicate title across bibliography files.").to_string(),
        _ => issue.message.clone(),
    }
}

impl Audit {
    /// The scan's findings in the files, folded under their count.
    pub(super) fn issues_list(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.issues.is_empty() {
            return None;
        }
        let palette = cx.palette().clone();
        let editor = cx.lattice().fonts.editor.clone();
        let warning = mix(palette.warning, palette.text, 0.22);
        let open = self.disclosed.contains(&(usize::MAX, TIDY));
        let count = self.issues.len();
        let summary = if count == 1 {
            t!("1 thing to tidy in the bibliography").to_string()
        } else {
            t!("{0} things to tidy in the bibliography", count)
        };
        let list =
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .pl(px(19.))
                .children(self.issues.iter().map(|issue| {
                    let place = match &issue.key {
                        Some(key) => format!("{}, {key}", issue.path),
                        None => issue.path.clone(),
                    };
                    div()
                        .flex()
                        .flex_col()
                        .text_role(TextRole::Caption, cx)
                        .child(
                            div()
                                .font_family(editor.clone())
                                .text_size(px(11.))
                                .text_color(palette.text_secondary)
                                .child(place),
                        )
                        .child(div().text_color(palette.text).child(issue_text(issue)))
                }));
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .id("audit-tidy")
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .cursor_pointer()
                        .text_role(TextRole::Caption, cx)
                        .text_color(warning)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.toggle_disclosure(usize::MAX, TIDY, cx)
                        }))
                        .child(Icon::TRIANGLE_ALERT.element(ICON_SMALL, warning))
                        .child(summary)
                        .child(
                            if open {
                                Icon::CHEVRON_DOWN
                            } else {
                                Icon::CHEVRON_RIGHT
                            }
                            .element(ICON_SMALL, palette.text_secondary),
                        ),
                )
                .when(open, |section| section.child(list))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(code: &'static str, params: &[(&'static str, &str)]) -> AuditIssue {
        AuditIssue {
            path: "refs.bib".into(),
            key: None,
            message: "lattice-core's English".into(),
            code,
            params: params
                .iter()
                .map(|(name, value)| (*name, value.to_string()))
                .collect(),
        }
    }

    // Expected texts are `auditIssueText`'s, in audit-messages.ts.
    #[test]
    fn a_missing_field_names_its_alternative_when_it_has_one() {
        assert_eq!(
            issue_text(&issue(
                "missing-field",
                &[("requirement", "journal or booktitle"), ("type", "article")]
            )),
            "Missing journal or booktitle field for article entry."
        );
        assert_eq!(
            issue_text(&issue(
                "missing-field",
                &[("requirement", "title"), ("type", "misc")]
            )),
            "Missing title field for misc entry."
        );
    }

    #[test]
    fn a_proceedings_entry_names_its_own_type() {
        let text = |kind| issue_text(&issue("proceedings-uses-journal", &[("type", kind)]));
        assert_eq!(
            text("conference"),
            "Conference entry uses journal instead of booktitle."
        );
        assert_eq!(
            text("inproceedings"),
            "Inproceedings entry uses journal instead of booktitle."
        );
    }

    #[test]
    fn an_unknown_code_keeps_the_scans_own_words() {
        assert_eq!(
            issue_text(&issue("something-new", &[])),
            "lattice-core's English"
        );
        assert_eq!(
            issue_text(&issue("empty-field", &[("field", "pages")])),
            "Empty pages field."
        );
    }
}
