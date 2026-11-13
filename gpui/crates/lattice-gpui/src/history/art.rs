//! The history's empty states, as the Tauri app draws them (`EmptyState`
//! with `fill`, `ResearchArt` and `DATED_DRAFTS`, `.history-empty`): drafts
//! stacked a little apart with their dated tabs showing, in isometric, over
//! the title in the subtitle role, the whole centred in the room under the
//! toolbar.
//!
//! The drawing is read from the Tauri app's own module
//! (`src/components/ui/research-art-dated-drafts.ts`), so the two apps draw
//! the same lines, and painted as `research-art.css` paints it: paper in the
//! surface it stands on, so it hides the lines behind it; the sides in the
//! tertiary ink at 2.5%, 6% and 9.5%; the lines 1.15px wide whatever the
//! size, the faint ones at 38% and the rest at 65%.

use std::sync::LazyLock;

use gpui::{
    AnyElement, App, Hsla, IntoElement, ParentElement as _, PathBuilder, Pixels, Point,
    SharedString, Styled as _, canvas, div, point, px,
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};
use regex::Regex;

const DATED_DRAFTS_SOURCE: &str =
    include_str!("../../../../../src/components/ui/research-art-dated-drafts.ts");

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

/// The dated drafts, `width` wide, their paper in `paper`.
pub fn dated_drafts(width: Pixels, paper: Hsla, cx: &App) -> AnyElement {
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
            for path in DATED_DRAFTS.iter() {
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

/// `EmptyState fill` with the drawing: the art, then the title, centred in
/// the room left, 16px in (`.history-empty`: 16px over and under, 12px a side).
pub fn empty_state(
    title: impl Into<SharedString>,
    narrow: bool,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .py(px(16.))
        .px(px(12.))
        .child(dated_drafts(
            px(if narrow { 96. } else { 128. }),
            palette.input,
            cx,
        ))
        .child(
            div()
                .text_role(TextRole::Subtitle, cx)
                .text_color(palette.text)
                .text_center()
                .child(title.into()),
        )
        .children(action.map(|action| div().pt(px(6.)).child(action)))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_tauri_drawing() {
        let paths = &*DATED_DRAFTS;
        assert!(
            paths.len() > 50,
            "the drawing has its paths: {}",
            paths.len()
        );
        assert!(paths.iter().all(|path| !path.subpaths.is_empty()));
        assert!(paths.iter().any(|path| path.tone == Tone::Line));
    }
}
