//! A finding's status mark (`.bibliography-audit-mark` in
//! `bibliography-audit.css`), the same in a row, its group's heading and its
//! filter, so the filters read as the key. Shape says the state without the
//! colour: a dashed ring not checked yet, a turning arc while checking, a
//! tick verified (ringed when kept as written), a solid cross for a fix and
//! "!" for a record to read, "?" where the check could not finish. Round,
//! never the checkbox's square.

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, Pixels, Styled as _, div, px,
};
use lattice_ui::{ActiveLattice as _, Icon, tokens::FONT_WEIGHT_BOLD};

use super::Bucket;

/// A row's mark (18px); a filter's and a group heading's are 14px.
pub(super) const ROW: Pixels = px(18.);
pub(super) const SMALL: Pixels = px(14.);

/// `bucket`'s mark at `size`, or the turning arc of a check running on it.
pub(super) fn mark(
    id: impl Into<ElementId>,
    bucket: Bucket,
    checking: bool,
    size: Pixels,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette();
    let base = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(size)
        .rounded_full();
    // The glyph's share of the mark: a letter at 62%, an icon at 64%.
    let icon = |icon: Icon, ink| icon.element(size * 0.64, ink);
    let letter = |letter: &'static str, ink| {
        div()
            .font_family(cx.lattice().fonts.ui.clone())
            .text_size(size * 0.62)
            .line_height(size * 0.62)
            .font_weight(FONT_WEIGHT_BOLD)
            .text_color(ink)
            .child(letter)
    };
    if checking {
        return base
            .child(lattice_ui::loading::loader(id, size, palette.info, cx))
            .into_any_element();
    }
    match bucket {
        Bucket::Verified => base
            .bg(palette.success_soft)
            .child(icon(Icon::CHECK, palette.success)),
        Bucket::Kept => base
            .border(px(1.5))
            .border_color(palette.success)
            .child(icon(Icon::CHECK, palette.success)),
        Bucket::Fix => base.bg(palette.info).child(icon(Icon::X, palette.window)),
        Bucket::Review => base.bg(palette.warning).child(letter("!", palette.window)),
        Bucket::Incomplete => base
            .bg(palette.hover)
            .border_1()
            .border_color(palette.line_strong)
            .child(letter("?", palette.text_secondary)),
        Bucket::Unchecked => base
            .border(px(1.5))
            .border_dashed()
            .border_color(palette.text_secondary.opacity(0.6)),
    }
    .into_any_element()
}
