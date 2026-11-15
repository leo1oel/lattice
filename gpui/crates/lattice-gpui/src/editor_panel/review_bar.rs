//! The review bar across the top of a source editor in review mode
//! (`src/history/review-mode-bar.tsx`, `review-mode.css`), Word's Review
//! ribbon cut down to what reviewing one's own edits needs: how many changes
//! there are, the previous and next one, accept or reject the one at the
//! caret, accept or reject them all, the PDF with the changes marked, and
//! turning review mode off; under them, a notice when a co-author's edit
//! landed in text the writer had changed.
//!
//! One row that wraps at the group edges when the editor is narrow, so no
//! control is ever squeezed: at 760px or less the text buttons keep their
//! icons (named by tooltip) and lose their words, and at 520px or less the
//! title keeps only its dot (the CSS's container queries on the editor's
//! panels).

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::Selectable as _;
use lattice_editor::remote_cursors::hue_color;
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, IconButton},
    typography::tabular_nums,
};

use super::EditorPanel;
use crate::history::review_mode::{REVIEW_HUE, store};

/// The container widths the bar folds at (`@container editor-panels`).
const ICONS_ONLY: f32 = 760.;
const DOT_ONLY: f32 = 520.;

/// A compact icon button (`IconButton size="compact"`): 24px, a 13px icon.
fn compact(id: &'static str, icon: Icon, label: SharedString) -> IconButton {
    IconButton::new(id, icon)
        .frame(px(24.), px(24.))
        .icon_size(px(13.))
        .tooltip(label)
}

impl EditorPanel {
    /// The bar, while review mode is on for this file.
    pub(super) fn render_review_bar(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let state = self.review_bar_state(cx)?;
        let root = self.project_root(cx);
        let (marked, notice) = store::try_store(cx).map_or((false, None), |store| {
            let store = store.read(cx);
            (store.marked(&root), store.notice(&root))
        });
        let palette = cx.palette().clone();
        let width = self.editor_width.get().map_or(f32::MAX, f32::from);
        let icons_only = width <= ICONS_ONLY;
        let dot_only = width <= DOT_ONLY;
        let none = state.count == 0;
        let at_change = state.index.is_some();
        let this = cx.entity().downgrade();
        let act = move |run: fn(&mut EditorPanel, &mut Window, &mut Context<EditorPanel>)| -> Click {
            let this = this.clone();
            Box::new(move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut gpui::App| {
                this.update(cx, |panel, cx| run(panel, window, cx)).ok();
            })
        };
        // A text button (`.review-bar-text`): 28px, its icon and its words,
        // or in a narrow editor its icon alone; named by a tooltip either way.
        let text_button = |id: &'static str,
                           icon: Icon,
                           label: SharedString,
                           disabled: bool,
                           on_click: Click|
         -> AnyElement {
            if icons_only {
                let pad = if dot_only { 4. } else { 6. };
                IconButton::new(id, icon)
                    .frame(px(13. + pad * 2.), px(28.))
                    .icon_size(px(13.))
                    .tooltip(label)
                    .disabled(disabled)
                    .on_click(on_click)
                    .into_any_element()
            } else {
                Button::new(id, label.clone())
                    .ghost()
                    .compact()
                    .icon(icon)
                    .tooltip(label)
                    .disabled(disabled)
                    .on_click(on_click)
                    .into_any_element()
            }
        };
        let count = if none {
            SharedString::from(t!("No changes"))
        } else if let Some(index) = state.index {
            tc!(
                "the tracked change at the caret, of all of them",
                "{0} of {1}",
                index + 1,
                state.count
            )
            .into()
        } else {
            tc!("tracked changes waiting for review", "{0} changes", state.count).into()
        };
        let group = |gap: f32| div().flex().items_center().gap(px(if dot_only { 0. } else { gap }));
        let stop_label: SharedString = t!("Stop tracking").into();
        let pdf_label: SharedString = if marked {
            t!("Show the PDF without changes").into()
        } else {
            t!("Show changes in the PDF").into()
        };
        let bar = div()
            .id("review-bar")
            .flex()
            .flex_wrap()
            .items_center()
            .gap_y(px(4.))
            .gap_x(px(if dot_only { 4. } else { 8. }))
            .pt(px(4.))
            .pb(px(4.))
            .pl(px(if dot_only { 6. } else { 10. }))
            .pr(px(if dot_only { 4. } else { 8. }))
            .min_w_0()
            .bg(palette.raised)
            .border_b_1()
            .border_color(palette.line)
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .children(lattice_ui::parity::probe("review-bar"))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_color(palette.text)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .whitespace_nowrap()
                    .child(div().size(px(8.)).rounded_full().flex_none().bg(hue_color(REVIEW_HUE)))
                    .when(!dot_only, |title| title.child(t!("Tracking changes"))),
            )
            .child(
                div()
                    .min_w_0()
                    .text_role(TextRole::Micro, cx)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .font_features(tabular_nums())
                    .whitespace_nowrap()
                    .child(count),
            )
            .child(
                group(2.)
                    .child(
                        compact("review-previous", Icon::CHEVRON_UP, t!("Previous change").into())
                            .disabled(none)
                            .on_click(act(|panel, window, cx| panel.review_step(false, window, cx))),
                    )
                    .child(
                        compact("review-next", Icon::CHEVRON_DOWN, t!("Next change").into())
                            .disabled(none)
                            .on_click(act(|panel, window, cx| panel.review_step(true, window, cx))),
                    ),
            )
            .child(
                group(2.)
                    .child(
                        compact("review-accept", Icon::CHECK, t!("Accept").into())
                            .disabled(!at_change)
                            .on_click(act(|panel, window, cx| {
                                panel.review_decide_at_caret(true, window, cx)
                            })),
                    )
                    .child(
                        compact("review-reject", Icon::X, t!("Reject").into())
                            .disabled(!at_change)
                            .on_click(act(|panel, window, cx| {
                                panel.review_decide_at_caret(false, window, cx)
                            })),
                    ),
            )
            .child(
                group(2.)
                    .child(text_button(
                        "review-accept-all",
                        Icon::LIST_CHECKS,
                        t!("Accept all").into(),
                        none,
                        act(|panel, _, cx| panel.review_accept_all(cx)),
                    ))
                    .child(text_button(
                        "review-reject-all",
                        Icon::LIST_X,
                        t!("Reject all").into(),
                        none,
                        act(|panel, _, cx| panel.review_reject_all(cx)),
                    )),
            )
            .child(
                group(4.)
                    .ml_auto()
                    .child({
                        let root = root.clone();
                        compact("review-marked-pdf", Icon::FILE_DIFF, pdf_label)
                            .selected(marked)
                            .on_click(move |_, _, cx| {
                                let store = store::store(cx);
                                store.update(cx, |store, cx| store.set_marked(&root, !marked, cx));
                            })
                    })
                    .child({
                        let root = root.clone();
                        let pending = state.count > 0;
                        text_button(
                            "review-stop",
                            Icon::PEN_OFF,
                            stop_label,
                            false,
                            Box::new(move |_, _, cx| {
                                if pending {
                                    store::confirm_stop(root.clone(), cx);
                                } else {
                                    let store = store::store(cx);
                                    store.update(cx, |store, cx| store.stop(&root, cx));
                                }
                            }),
                        )
                    }),
            )
            .children(notice.map(|notice| {
                let root = root.clone();
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .w_full()
                    .min_w_0()
                    .text_color(palette.text)
                    .child(div().min_w_0().whitespace_normal().child(notice))
                    .child(compact("review-notice-dismiss", Icon::X, t!("Dismiss").into()).on_click(
                        move |_, _, cx| {
                            let store = store::store(cx);
                            store.update(cx, |store, cx| store.set_notice(&root, None, cx));
                        },
                    ))
            }));
        Some(bar.into_any_element())
    }
}

/// A button's click handler.
type Click = Box<dyn Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static>;
