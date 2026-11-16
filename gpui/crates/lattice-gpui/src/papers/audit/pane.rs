//! The review queue's "Open finding" pane (`.bibliography-audit-pane`): beside
//! the list, over a hairline, the open finding's kind, its title in the
//! reading type, its key, file and line, then the finding itself. With
//! nothing open it says so, centred, as every empty panel does; a settled
//! report opens nothing and shows the research desk's reading glass.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

use super::{Audit, queue::Listing};

impl Audit {
    pub(super) fn pane(
        &self,
        listing: &Listing,
        current: Option<usize>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let pane = div()
            .id("audit-pane")
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_y_scroll()
            .pt(px(4.))
            .pb(px(16.))
            .pl(px(16.))
            .border_l_1()
            .border_color(palette.line);
        let Some(index) = current else {
            if self.entries.is_empty() {
                return pane.into_any_element();
            }
            // Nothing left to act on: the reading glass says the report is done.
            if listing.settled(self.busy) {
                return pane.child(self.clean_note(true, cx)).into_any_element();
            }
            return pane
                .items_center()
                .justify_center()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary.opacity(0.8))
                .child(t!("No reference selected"))
                .into_any_element();
        };
        let entry = &self.entries[index];
        let place = match entry.line {
            Some(line) => format!("{}:{line}", entry.path),
            None => entry.path.clone(),
        };
        pane.child(
            div()
                .mb(px(4.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(listing.buckets[index].label()),
        )
        .child(
            div()
                .font_family(cx.lattice().fonts.ui.clone())
                .text_role(TextRole::Typeset, cx)
                .text_color(palette.text)
                .child(super::entry_title(entry)),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .mt(px(2.))
                .text_role(TextRole::Micro, cx)
                .text_color(palette.text_secondary.opacity(0.8))
                .child(
                    div()
                        .mr(px(6.))
                        .font_family(cx.lattice().fonts.editor.clone())
                        .child(entry.key.clone()),
                )
                .child(place),
        )
        .child(div().mt(px(12.)).child(self.finding(index, listing, cx)))
        .into_any_element()
    }
}
