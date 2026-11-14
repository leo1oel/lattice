//! Add papers' other ways in, under the paste box: by hand, a linked
//! library, Zotero, and the switch for whether the batch saves full text;
//! and the drawing that stands in for the list before anything is pasted.

use gpui::{AnyElement, Context, IntoElement, ParentElement as _, Styled as _, div, px};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{Button, CheckState, Checkbox},
};

use super::{AddPapers, AddPapersEvent};

impl AddPapers {
    /// Enter manually, Linked library…, Zotero… and the full-text switch.
    pub(super) fn tools_row(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex()
            .flex_wrap()
            .gap(px(4.))
            .child(
                Button::new("add-papers-manual", t!("Enter manually"))
                    .compact()
                    .ghost()
                    .icon(Icon::PEN_LINE)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(AddPapersEvent::EnterManually))),
            )
            .child(
                Button::new("add-papers-linked", t!("Linked library…"))
                    .compact()
                    .ghost()
                    .icon(Icon::LINK_2)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(AddPapersEvent::LinkLibrary))),
            )
            .child(
                Button::new("add-papers-zotero", t!("Zotero…"))
                    .compact()
                    .ghost()
                    .icon(Icon::LIBRARY)
                    .on_click(cx.listener(|this, _, window, cx| this.open_zotero(window, cx))),
            )
            // The full-text switch sits at the end of the tools row,
            // the last choice sticking for every window.
            .child(
                div().ml_auto().self_center().child(
                    Checkbox::new(
                        "add-papers-full-text",
                        if crate::settings::get(cx).save_full_text {
                            CheckState::On
                        } else {
                            CheckState::Off
                        },
                    )
                    .quiet()
                    .label(t!("Also save full text (Markdown)"))
                    .on_toggle(|on: &bool, window, cx| {
                        let on = *on;
                        crate::settings::update(cx, |settings| settings.save_full_text = on);
                        window.refresh();
                    }),
                ),
            )
            .into_any_element()
    }

    /// Nothing pasted yet: the catalogue drawer, centred in the room under
    /// the box (`.add-papers-empty`).
    pub(super) fn empty_art(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .pt(px(12.))
            .px(px(8.))
            .pb(px(24.))
            .child(crate::research_art::research_art(
                crate::research_art::Drawing::CatalogueDrawer,
                px(168.),
                palette.raised,
                cx,
            ))
            .into_any_element()
    }
}
