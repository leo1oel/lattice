//! The label a reference card shows, against the Tauri app's source card
//! (`referenceTooltips`): the label under the pointer alone, even in a
//! `\cref{a,b}`, and no card for a label nothing defines.

use super::*;

fn references() -> Vec<Reference> {
    [
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

/// The span the card at `needle` (one byte in) is for, and its label's title.
fn card_at(needle: &str) -> Option<(String, String)> {
    let known = references();
    let at = DOC.find(needle).unwrap() + 1;
    let (range, reference) = card_label(DOC, at, |label| {
        known
            .iter()
            .find(|reference| reference.label == label)
            .cloned()
    })?;
    Some((DOC[range].to_string(), reference.title))
}

#[test]
fn a_cref_shows_only_the_label_under_the_pointer() {
    assert_eq!(
        card_at("fig:cost}"),
        Some((
            "fig:cost".into(),
            "Inference cost against sequence length".into()
        ))
    );
    assert_eq!(
        card_at("fig:case-failure"),
        Some(("fig:case-failure".into(), "A failure case".into()))
    );
    assert_eq!(
        card_at("tab:main"),
        Some(("tab:main".into(), "Main results".into()))
    );
}

#[test]
fn an_undefined_label_opens_no_card() {
    assert_eq!(card_at("sec:nowhere}."), None);
    assert_eq!(card_at("sec:nowhere} here"), None);
    // Its defined neighbour still has its own card.
    assert_eq!(
        card_at("fig:cost,sec").map(|(span, _)| span),
        Some("fig:cost".into())
    );
    // The command's name is no label.
    assert_eq!(card_at("cref"), None);
}
