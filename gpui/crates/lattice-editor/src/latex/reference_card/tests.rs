//! The labels a reference card shows, against the Tauri app's Visual mode
//! test (`visual-hover.test.ts`: "shows what each label names, with Go to
//! across files, and an undefined label as such") and its source card
//! (`referenceTooltips` opens nothing for an undefined label).

use super::*;

fn references() -> Vec<Reference> {
    [
        ("sec:method", "section", "Method", "main.tex", 9),
        (
            "fig:case-failure",
            "figure",
            "A failure case",
            "main.tex",
            21,
        ),
        (
            "fig:cost",
            "figure",
            "Inference cost against sequence length",
            "main.tex",
            27,
        ),
        (
            "tab:main",
            "table",
            "Main results",
            "sections/results.tex",
            5,
        ),
    ]
    .into_iter()
    .map(|(label, kind, title, path, line)| Reference {
        label: label.into(),
        kind: kind.into(),
        title: title.into(),
        path: path.into(),
        line,
        ..Reference::default()
    })
    .collect()
}

const DOC: &str = r"See \cref{fig:case-failure,fig:cost}, \autoref{tab:main} and \ref{sec:nowhere}.
Both \Cref{fig:cost,sec:nowhere} here.";

/// The span the card is for, and each label with its title, if defined.
type Shown = (String, Vec<(String, Option<String>)>);

fn labels_at(needle: &str) -> Option<Shown> {
    let known = references();
    let at = DOC.find(needle).unwrap() + 1;
    let (range, labels) = card_labels(DOC, at, |label| {
        known
            .iter()
            .find(|reference| reference.label == label)
            .cloned()
    })?;
    Some((
        DOC[range].to_string(),
        labels
            .into_iter()
            .map(|(label, reference)| (label, reference.map(|reference| reference.title)))
            .collect(),
    ))
}

#[test]
fn a_cref_shows_each_label_it_names_in_order() {
    let (span, labels) = labels_at("fig:cost}").expect("a card");
    assert_eq!(span, "fig:cost");
    assert_eq!(
        labels,
        [
            (
                "fig:case-failure".to_string(),
                Some("A failure case".to_string())
            ),
            (
                "fig:cost".to_string(),
                Some("Inference cost against sequence length".to_string())
            ),
        ]
    );
}

#[test]
fn a_single_label_has_one_section() {
    let (_, labels) = labels_at("tab:main").expect("a card");
    assert_eq!(
        labels,
        [("tab:main".to_string(), Some("Main results".to_string()))]
    );
}

#[test]
fn an_undefined_label_is_a_section_of_its_own_but_opens_no_card() {
    // Resting on the defined label: the undefined one says so in its section.
    let (_, labels) = labels_at("fig:cost,sec").expect("a card");
    assert_eq!(labels[1], ("sec:nowhere".to_string(), None));
    // Resting on an undefined label, its lint card speaks for it.
    assert!(labels_at("sec:nowhere}.").is_none());
    assert!(labels_at("sec:nowhere} here").is_none());
}
