//! The Tauri app's research desk drawings (`ResearchArt`,
//! `src/components/ui/research-art.tsx`), the isometric line art its empty
//! states stand on.
//!
//! Each drawing is read from the Tauri app's own module
//! (`src/components/ui/research-art-*.ts`), so the two apps draw the same
//! lines, and painted as `research-art.css` paints it: paper in the surface
//! it stands on, so it hides the lines behind it; the sides in the tertiary
//! ink at 2.5%, 6% and 9.5%; the lines 1.15px wide whatever the size, the
//! faint ones at 38% and the rest at 65%.

use std::sync::LazyLock;

use gpui::{
    AnyElement, App, Hsla, IntoElement, PathBuilder, Pixels, Point, Styled as _, canvas, point, px,
};
use lattice_ui::ActiveLattice as _;
use regex::Regex;

const DATED_DRAFTS_SOURCE: &str =
    include_str!("../../../../src/components/ui/research-art-dated-drafts.ts");
const NOTE_SPIKE_SOURCE: &str =
    include_str!("../../../../src/components/ui/research-art-note-spike.ts");
const MARGIN_NOTES_SOURCE: &str =
    include_str!("../../../../src/components/ui/research-art-margin-notes.ts");
const PROOF_MARKS_SOURCE: &str =
    include_str!("../../../../src/components/ui/research-art-proof-marks.ts");
const LETTER_RACK_SOURCE: &str =
    include_str!("../../../../src/components/ui/research-art-letter-rack.ts");

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    Paper,
    Shade,
    ShadeMid,
    ShadeDeep,
    Faint,
    Line,
    Dot,
}

/// One path of the drawing: its tone and its subpaths, each a list of
/// points on the 160 × 124 grid and whether it closes.
struct ArtPath {
    tone: Tone,
    subpaths: Vec<(Vec<Point<f32>>, bool)>,
}

static DATED_DRAFTS: LazyLock<Vec<ArtPath>> = LazyLock::new(|| parse(DATED_DRAFTS_SOURCE));
static NOTE_SPIKE: LazyLock<Vec<ArtPath>> = LazyLock::new(|| parse(NOTE_SPIKE_SOURCE));
static MARGIN_NOTES: LazyLock<Vec<ArtPath>> = LazyLock::new(|| parse(MARGIN_NOTES_SOURCE));
static PROOF_MARKS: LazyLock<Vec<ArtPath>> = LazyLock::new(|| parse(PROOF_MARKS_SOURCE));
static LETTER_RACK: LazyLock<Vec<ArtPath>> = LazyLock::new(|| parse(LETTER_RACK_SOURCE));

/// The drawings ported so far, each read from the Tauri app's own module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drawing {
    /// `DATED_DRAFTS`: the history's empty states.
    DatedDrafts,
    /// `NOTE_SPIKE`: nothing left to do (the TODOs' empty state).
    NoteSpike,
    /// `MARGIN_NOTES`: no comments (Overleaf's comments).
    MarginNotes,
    /// `PROOF_MARKS`: no suggestions (Overleaf's suggestions).
    ProofMarks,
    /// `LETTER_RACK`: no messages (Overleaf's chat).
    LetterRack,
}

impl Drawing {
    fn paths(self) -> &'static [ArtPath] {
        match self {
            Drawing::DatedDrafts => &DATED_DRAFTS,
            Drawing::NoteSpike => &NOTE_SPIKE,
            Drawing::MarginNotes => &MARGIN_NOTES,
            Drawing::ProofMarks => &PROOF_MARKS,
            Drawing::LetterRack => &LETTER_RACK,
        }
    }
}

fn parse(source: &str) -> Vec<ArtPath> {
    let entry =
        Regex::new(r#"\["([a-z-]+)",\s*"([^"]+)"\]"#).expect("the art entry pattern compiles");
    let command = Regex::new(r"([MLZ])\s*([-0-9.\s]*)").expect("the path command pattern compiles");
    entry
        .captures_iter(source)
        .filter_map(|captures| {
            let tone = match &captures[1] {
                "paper" => Tone::Paper,
                "shade" => Tone::Shade,
                "shade-mid" => Tone::ShadeMid,
                "shade-deep" => Tone::ShadeDeep,
                "faint" => Tone::Faint,
                "line" => Tone::Line,
                "dot" => Tone::Dot,
                _ => return None,
            };
            let mut subpaths: Vec<(Vec<Point<f32>>, bool)> = Vec::new();
            for step in command.captures_iter(&captures[2]) {
                let numbers: Vec<f32> = step[2]
                    .split_whitespace()
                    .filter_map(|number| number.parse().ok())
                    .collect();
                match &step[1] {
                    "M" => subpaths.push((Vec::new(), false)),
                    "Z" => {
                        if let Some(last) = subpaths.last_mut() {
                            last.1 = true;
                        }
                        continue;
                    }
                    _ => {}
                }
                if let Some(last) = subpaths.last_mut() {
                    last.0.extend(
                        numbers
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|[x, y]| point(*x, *y)),
                    );
                }
            }
            Some(ArtPath { tone, subpaths })
        })
        .collect()
}

/// `drawing`, `width` wide, its paper in `paper` (the surface it stands on).
pub fn research_art(drawing: Drawing, width: Pixels, paper: Hsla, cx: &App) -> AnyElement {
    let ink = cx.palette().text_secondary;
    let height = width * (124. / 160.);
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let scale = bounds.size.width / px(160.);
            let at = |p: Point<f32>| {
                point(
                    bounds.origin.x + px(p.x) * scale,
                    bounds.origin.y + px(p.y) * scale,
                )
            };
            for path in drawing.paths() {
                let (stroked, color) = match path.tone {
                    Tone::Paper => (false, paper),
                    Tone::Shade => (false, ink.opacity(0.025)),
                    Tone::ShadeMid => (false, ink.opacity(0.06)),
                    Tone::ShadeDeep => (false, ink.opacity(0.095)),
                    Tone::Faint => (true, ink.opacity(0.38)),
                    Tone::Line => (true, ink.opacity(0.65)),
                    Tone::Dot => (false, ink.opacity(0.6)),
                };
                for (points, closed) in &path.subpaths {
                    if points.len() < 2 {
                        continue;
                    }
                    let mut builder = if stroked {
                        PathBuilder::stroke(px(1.15))
                    } else {
                        PathBuilder::fill()
                    };
                    builder.move_to(at(points[0]));
                    for &p in &points[1..] {
                        builder.line_to(at(p));
                    }
                    if *closed {
                        builder.close();
                    }
                    if let Ok(built) = builder.build() {
                        window.paint_path(built, color);
                    }
                }
            }
        },
    )
    .w(width)
    .h(height)
    .flex_none()
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_tauri_drawings() {
        for drawing in [
            Drawing::DatedDrafts,
            Drawing::NoteSpike,
            Drawing::MarginNotes,
            Drawing::ProofMarks,
            Drawing::LetterRack,
        ] {
            let paths = drawing.paths();
            assert!(
                paths.len() > 20,
                "{drawing:?} has its paths: {}",
                paths.len()
            );
            assert!(paths.iter().all(|path| !path.subpaths.is_empty()));
            assert!(paths.iter().any(|path| path.tone == Tone::Line));
        }
    }
}
