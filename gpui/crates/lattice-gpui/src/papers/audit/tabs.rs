//! The filters (`SlidingTabs` as `.bibliography-audit-tabs` draws it): All,
//! then a tab per kind of finding the report holds, each its mark, name and
//! count. Each tab is 28px on the pill corner, 10px in, in the caption's
//! secondary ink, the primary under the pointer and when chosen; the chosen
//! one stands on a raised plate ringed in the subtle hairline, which slides
//! to a newly chosen tab on the moderate tier (`SlidingPlate`), at once
//! under reduced motion. The strip wraps, as the sheet narrows.

use gpui::{
    AnyElement, Context, InteractiveElement as _, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, sliding::SlidingPlate};

use super::{Audit, Bucket, mark, queue::Listing};

impl Audit {
    pub(super) fn tabs(
        &self,
        listing: &Listing,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let mut tabs: Vec<(Option<Bucket>, String, usize)> =
            vec![(None, t!("All").into(), self.entries.len())];
        tabs.extend(
            Bucket::ORDER
                .iter()
                .map(|bucket| {
                    (
                        Some(*bucket),
                        bucket.label().to_string(),
                        listing.count(*bucket),
                    )
                })
                .filter(|(_, _, count)| *count > 0),
        );
        let chosen = tabs.iter().position(|(view, _, _)| *view == listing.view);
        let plate = SlidingPlate::new("audit-tabs-plate", chosen, window, cx);
        let drawn = plate.is_drawn(cx);
        let items = tabs
            .into_iter()
            .enumerate()
            .map(|(at, (view, label, count))| {
                let on = Some(at) == chosen;
                let tab = div()
                    .id(SharedString::from(format!("audit-tab-{view:?}")))
                    .relative()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .px(px(10.))
                    .rounded_full()
                    .cursor_pointer()
                    .whitespace_nowrap()
                    .text_role(TextRole::Caption, cx)
                    .text_color(if on {
                        palette.text
                    } else {
                        palette.text_secondary
                    })
                    .hover(|style| style.text_color(palette.text))
                    // Until the plate has been measured the chosen tab draws its own.
                    .when(on && !drawn, |tab| {
                        tab.bg(palette.raised).border_1().border_color(palette.line)
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.set_view(view, cx)))
                    .children(view.map(|bucket| {
                        mark::mark(
                            SharedString::from(format!("audit-tab-mark-{bucket:?}")),
                            bucket,
                            false,
                            mark::SMALL,
                            cx,
                        )
                    }))
                    .child(label)
                    .child(
                        div()
                            .text_color(palette.text_secondary)
                            .child(count.to_string()),
                    );
                plate.item(at, tab)
            });
        plate.strip(
            div()
                .relative()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(2.))
                .min_w_0()
                .children(plate.plate(
                    |plate| {
                        plate
                            .rounded_full()
                            .bg(palette.raised)
                            .border_1()
                            .border_color(palette.line)
                    },
                    cx,
                ))
                .children(items),
        )
    }
}
