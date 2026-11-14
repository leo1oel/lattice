//! What a row says about itself beyond its text: the tip naming what a
//! click does, and the wash a just-added row arrives in.

use gpui::{AnyElement, App, ElementId, Hsla, IntoElement, Styled as _, Window, div, px};
use lattice_core::papers::PaperSummary;
use lattice_i18n::t;
use lattice_ui::motion::Motion;

use super::{child_id, model};

/// The accent's wash a just-added row arrives in, which holds a second and
/// fades once on the slow tier (`paper-just-added`): the row says it is new
/// without a badge. It runs from the row's first frame, as the animation
/// does from its mount.
pub(super) fn just_added_wash(
    row_id: &ElementId,
    wash: Hsla,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let started = *window
        .use_keyed_state(child_id(row_id, "wash"), cx, |_, _| {
            std::time::Instant::now()
        })
        .read(cx);
    let elapsed = started.elapsed();
    let fade = Motion::Slow.duration();
    let hold = fade * 4;
    let t = elapsed.checked_sub(hold).map_or(0., |faded| {
        (faded.as_secs_f32() / fade.as_secs_f32()).min(1.)
    });
    if t >= 1. {
        return None;
    }
    window.request_animation_frame();
    Some(
        div()
            .absolute()
            .inset_0()
            .rounded(px(6.))
            .bg(wash)
            .opacity(1. - Motion::Slow.sample(t))
            .into_any_element(),
    )
}

/// The row's tip: its title when it opens to read, else what a click
/// fetches or opens instead (`paper-row.tsx`, `.paper-open`'s title).
pub(super) fn open_tip(paper: &PaperSummary) -> String {
    if model::readable(paper) {
        return paper.title.clone();
    }
    let url = paper.url.as_deref().map_or("", str::trim);
    if model::reading_state(paper) == model::ReadingState::Citation && !url.is_empty() {
        t!("Open source page — no downloadable full text found").to_string()
    } else if !paper.arxiv_id.is_empty() {
        t!("Download arXiv {id}", id = paper.arxiv_id)
    } else if !url.is_empty() {
        t!("Download {url}", url = url)
    } else {
        t!("{title} — no local reading available", title = paper.title)
    }
}
