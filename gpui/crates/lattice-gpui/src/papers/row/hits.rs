//! A search's matching lines under a paper's row (`paper-text-hits.tsx`):
//! each opens the paper at that line, three at once and the rest on request.

use gpui::{
    AnyElement, Context, ElementId, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::papers::PaperSummary;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    interaction::{mix, track_pointer, use_interaction},
};

use super::{PapersPanel, inside_row, marked, model};

impl PapersPanel {
    /// The lines of a paper that matched a search, best first: each opens
    /// the paper at that line. Three show at once; the rest the index
    /// returned come on request.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn render_hits(
        &self,
        key: &str,
        paper: &PaperSummary,
        hits: Vec<model::LineHit>,
        expanded: bool,
        table: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        const SHOWN: usize = crate::papers::keys::HITS_SHOWN;
        let palette = cx.palette().clone();
        let reading = cx.lattice().fonts.ui.clone();
        let more = if expanded {
            0
        } else {
            hits.len().saturating_sub(SHOWN)
        };
        let shown = if expanded {
            hits.len()
        } else {
            hits.len().min(SHOWN)
        };
        let view = cx.entity().downgrade();
        let mut list = div()
            .flex()
            .flex_col()
            .min_w_0()
            .mt(px(2.))
            .pl(px(if table { 22. } else { 16. }));
        let ring = lattice_ui::components::focus_ring(&palette, palette.chrome);
        for (ix, hit) in hits.into_iter().take(shown).enumerate() {
            let id: ElementId = SharedString::from(format!("paper-hit:{key}:{ix}")).into();
            let (interaction, pointer) = use_interaction(id.clone(), window, cx);
            let (view, paper, open) = (view.clone(), paper.clone(), hit.clone());
            let at = key.to_string();
            list = list.child(
                inside_row(track_pointer(div().id(id), pointer))
                    .relative()
                    .when(self.rings(key, ix + 1, window), |hit| {
                        hit.shadow(ring.clone())
                    })
                    .children(self.reveal_probe(key, ix + 1, cx))
                    .min_w_0()
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .px(px(6.))
                    .rounded(px(4.))
                    .bg(mix(
                        Hsla::transparent_black(),
                        palette.text_secondary.opacity(0.08),
                        interaction.hover,
                    ))
                    .cursor_pointer()
                    .on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        view.update(cx, |this, cx| {
                            this.point_at(&at, ix + 1);
                            this.activate(&paper, Some(&open), window, cx)
                        })
                        .ok();
                    })
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_family(reading.clone())
                            .italic()
                            .text_role(TextRole::Caption, cx)
                            .text_color(mix(
                                palette.text_secondary,
                                palette.text,
                                interaction.hover,
                            ))
                            .child(marked(&hit.text, &hit.highlights, &palette)),
                    ),
            );
        }
        if more > 0 {
            let id: ElementId = SharedString::from(format!("paper-hits-more:{key}")).into();
            let (interaction, pointer) = use_interaction(id.clone(), window, cx);
            let expand = key.to_string();
            let view = cx.entity().downgrade();
            list = list.child(
                inside_row(track_pointer(div().id(id), pointer))
                    .relative()
                    .when(self.rings(key, shown + 1, window), |more| {
                        more.shadow(ring.clone())
                    })
                    .children(self.reveal_probe(key, shown + 1, cx))
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .px(px(6.))
                    .rounded(px(4.))
                    .bg(mix(
                        Hsla::transparent_black(),
                        palette.text_secondary.opacity(0.08),
                        interaction.hover,
                    ))
                    .cursor_pointer()
                    .text_role(TextRole::Caption, cx)
                    .text_color(mix(palette.text_secondary, palette.text, interaction.hover))
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        view.update(cx, |this, cx| {
                            this.point_at(&expand, shown + 1);
                            this.expanded_hits.insert(expand.clone());
                            cx.notify();
                        })
                        .ok();
                    })
                    .child(t!("{count} more", count = more)),
            );
        }
        list.into_any_element()
    }
}
