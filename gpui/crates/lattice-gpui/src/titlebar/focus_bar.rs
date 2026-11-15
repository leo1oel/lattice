//! The title bar in focus mode (`src/app/focus-mode-bar.tsx`): the
//! document's name, quiet in the middle of the window, and what focus mode
//! keeps of the chrome, at the end: a Markdown, HTML or bibliography
//! document's Edit, Split and Preview, the PDF beside the editor, and Exit
//! focus with its key (Escape, which leaves focus mode as the key's last
//! meaning, `shell/focus_escape.rs`). The bar fades in on the fast tier
//! (`focus-bar-in`).

use gpui::{
    Animation, AnimationExt as _, AnyElement, Context, Div, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, Stateful, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Keycap, LatticeTooltip, Segmented},
    interaction::hover_wash,
    motion::Motion,
    parity,
    tokens::FONT_WEIGHT_SEMIBOLD,
};

use super::controls;
use crate::{
    editor_panel::views::DocumentView,
    shell::{
        Shell,
        commands::{ToggleFocusMode, keys_label},
        workspaces::Workspaces,
    },
};

/// The title bar `bar` (the window's width) in focus mode: the title over
/// its middle, and the controls at its end.
pub(super) fn focus_bar(
    bar: Stateful<Div>,
    shell: &Shell,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let title = shell
        .active_document(cx)
        .map(|key| shell.document_title(key, cx))
        .unwrap_or_else(|| shell.project_name(cx).to_string());
    let width = window.viewport_size().width;
    let pdf = Workspaces::global(cx).focus_pdf();

    // A document with views keeps its switch here: its panel's header is
    // gone in focus mode.
    let views = shell.active_editor().and_then(|editor| {
        let current = editor.read(cx).document_view()?;
        let mut switch = Segmented::new("focus-bar-views").parity("focus-bar/views");
        for view in DocumentView::ALL {
            let editor = editor.downgrade();
            switch = switch.icon_choice(
                view.icon(),
                lattice_i18n::tr(view.label()),
                view == current,
                move |_, window, cx| {
                    editor
                        .update(cx, |panel, cx| panel.set_document_view(view, window, cx))
                        .ok();
                },
            );
        }
        Some(switch)
    });

    let pdf_label: SharedString = if pdf {
        t!("Hide the PDF").into()
    } else {
        t!("Show the PDF").into()
    };
    let pdf_toggle = div()
        .id("focus-bar-pdf")
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(24.))
        .px(px(8.))
        .rounded(px(6.))
        .border_1()
        .cursor_pointer()
        .text_role(TextRole::Micro, cx)
        .font_weight(FONT_WEIGHT_SEMIBOLD)
        .map(|button| {
            if pdf {
                // `aria-pressed`: the active control's border, wash and ink.
                button
                    .border_color(palette.control_active_border)
                    .bg(palette.toolbar_active)
                    .text_color(palette.accent)
            } else {
                let hover_border = palette.line_strong;
                let hover = palette.hover;
                let ink = palette.text;
                button
                    .border_color(palette.line)
                    .text_color(palette.text_secondary)
                    .hover(move |style| style.border_color(hover_border).bg(hover).text_color(ink))
            }
        })
        .tooltip({
            let label = pdf_label.clone();
            move |_, cx| LatticeTooltip::view(label.clone(), None, cx)
        })
        .on_click(cx.listener(move |shell, _, window, cx| shell.set_focus_pdf(!pdf, window, cx)))
        .child(Icon::FILE_TEXT.element(
            FOCUS_ICON,
            if pdf {
                palette.accent
            } else {
                palette.text_secondary
            },
        ))
        .child(t!("PDF"))
        .children(parity::bordered_probe(
            "focus-bar/pdf",
            gpui::Edges::all(px(1.)),
        ));

    let exit_keys = keys_label(&ToggleFocusMode, window);
    let exit = hover_wash(
        div().id("leave-focus-mode"),
        "leave-focus-mode-wash",
        gpui::transparent_black(),
        palette.chrome_hover,
        window,
        cx,
    )
    .flex()
    .items_center()
    .gap(px(6.))
    .h(px(24.))
    .px(px(8.))
    .rounded(px(6.))
    .cursor_pointer()
    .text_role(TextRole::Caption, cx)
    .text_color(palette.text_secondary)
    .tooltip(move |_, cx| LatticeTooltip::view(t!("Exit focus"), exit_keys.clone(), cx))
    .on_click(cx.listener(|shell, _, window, cx| shell.set_focus_mode(false, window, cx)))
    .child(Icon::MINIMIZE.element(FOCUS_ICON, palette.text_secondary))
    .child(t!("Exit focus"))
    .child(div().ml(px(4.)).child(Keycap::new("⎋")))
    .children(parity::probe("focus-bar/exit"));

    let title = div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(
            // Centred on the window, whatever the window's controls take.
            div()
                .absolute()
                .top_0()
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .left(width * 0.5 - title_width(width) * 0.5)
                .w(title_width(width))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text_secondary)
                        .children(parity::probe("focus-bar/title"))
                        .child(title),
                ),
        )
        .with_animation(
            "focus-bar-title-in",
            Animation::new(Motion::Fast.duration()),
            |title, t| title.opacity(Motion::Fast.sample(t)),
        );
    let actions = div()
        .id("focus-bar")
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .justify_end()
        .h_full()
        .px(px(16.))
        .child(controls(
            div()
                .relative()
                .flex()
                .items_center()
                .gap(px(8.))
                .children(views)
                .child(pdf_toggle)
                .child(exit),
        ))
        .with_animation(
            "focus-bar-in",
            Animation::new(Motion::Fast.duration()),
            |bar, t| bar.opacity(Motion::Fast.sample(t)),
        );
    bar.child(title).child(actions).into_any_element()
}

/// The bar's icons' 13px (`size={13}`).
const FOCUS_ICON: gpui::Pixels = px(13.);

/// The title's room: `max-width: min(40%, 420px)`.
fn title_width(width: gpui::Pixels) -> gpui::Pixels {
    (width * 0.4).min(px(420.))
}
