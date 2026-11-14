//! The selection toolbar's menus (`selection_toolbar.rs`): Link's URL
//! field, the heading levels, the highlighter palette and the Markdown
//! block types, each on the popover surface 8px clear of the toolbar.

use super::*;
use super::tools::{BLOCKS, block_label};

impl EditorPanel {
    /// The open menu: the link field, the heading levels, the highlight
    /// palette or the block types.
    pub(super) fn toolbar_menu(
        &mut self,
        menu: Menu,
        text: &str,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let surface = |content: AnyElement, width: Option<f32>| {
            div()
                .occlude()
                .when_some(width, |this, width| this.w(px(width)))
                .p(px(5.))
                .rounded(RADIUS_PANEL)
                .bg(palette.raised)
                .shadow(Elevation::Popover.shadows(&palette))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(content)
                .into_any_element()
        };
        match menu {
            Menu::Link => {
                let Some((field, _)) = &self.toolbar.link else {
                    return div().into_any_element();
                };
                let filled = !field.read(cx).value().trim().is_empty();
                let field = field.clone();
                let apply_field = field.clone();
                let content = div()
                    .flex()
                    .items_end()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(SPACING_2)
                            .text_size(px(11.))
                            .text_color(palette.text_secondary.opacity(0.8))
                            .child(t!("Link URL"))
                            .child(Field::new(&field).compact()),
                    )
                    .child(
                        div()
                            .id("latex-link-apply")
                            .h(px(28.))
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .rounded(px(6.))
                            .text_size(px(11.))
                            .text_color(if filled { palette.text } else { palette.disabled_ink })
                            .bg(if filled { palette.tinted } else { palette.disabled_surface })
                            .when(filled, |this| {
                                this.cursor_pointer().hover(|this| this.bg(palette.tinted_hover))
                            })
                            .child(t!("Apply"))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let url = apply_field.read(cx).value().trim().to_string();
                                if !url.is_empty() {
                                    this.toolbar_action(ToolbarAction::Link(url), window, cx);
                                }
                            })),
                    )
                    .into_any_element();
                surface(content, Some(250.))
            }
            Menu::Heading => {
                let current = format_toggle::selection_formats(text, range).heading;
                let levels = [
                    ("part", t!("Part")),
                    ("chapter", t!("Chapter")),
                    ("section", t!("Section")),
                    ("subsection", t!("Subsection")),
                    ("subsubsection", t!("Subsubsection")),
                ];
                let rows = levels.into_iter().enumerate().map(|(index, (command, label))| {
                    let on = current.as_deref() == Some(command);
                    div()
                        .id(("latex-heading-level", index))
                        .h(px(28.))
                        .px(SPACING_3)
                        .flex()
                        .items_center()
                        .justify_between()
                        .rounded(px(6.))
                        .text_size(px(11.))
                        .cursor_pointer()
                        .text_color(if on { palette.text } else { palette.text_secondary })
                        .when(on, |this| this.bg(palette.toolbar_active))
                        .hover(|this| this.bg(palette.accent_soft).text_color(palette.text))
                        .child(label)
                        .child(
                            div()
                                .font_family(cx.lattice().fonts.editor.clone())
                                .text_color(palette.text_secondary.opacity(0.8))
                                .child(format!("\\{command}")),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.toolbar_action(ToolbarAction::Heading(command), window, cx)
                        }))
                });
                surface(div().flex().flex_col().children(rows).into_any_element(), Some(180.))
            }
            Menu::Highlight => {
                let around = highlights::highlight_around(text, range.clone())
                    .map(|highlight| highlight.color.unwrap_or_default());
                let sample = text[range].split_whitespace().collect::<Vec<_>>().join(" ");
                let colors = highlights::document_colors(text);
                highlight_palette::palette(self, around, sample, colors, window, cx)
            }
            Menu::Block => {
                let current = markdown_format::selection_format(text, range).block;
                let mut list = div().flex().flex_col().min_w(px(180.));
                for (index, (block, separated)) in BLOCKS.iter().enumerate() {
                    if *separated {
                        list = list.child(div().my(px(4.)).h(px(1.)).bg(palette.line));
                    }
                    let block = *block;
                    let on = block == current;
                    list = list.child(
                        div()
                            .id(("markdown-block", index))
                            .h(px(28.))
                            .px(SPACING_3)
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .text_role(TextRole::Body, cx)
                            .text_color(palette.text)
                            .hover(|this| this.bg(palette.hover))
                            .child(
                                div()
                                    .w(px(14.))
                                    .flex()
                                    .justify_center()
                                    .when(on, |this| this.child(Icon::CHECK.element(px(13.), palette.text))),
                            )
                            .child(block_label(block))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.toolbar_action(ToolbarAction::Block(block), window, cx)
                            })),
                    );
                }
                surface(list.into_any_element(), None)
            }
        }
    }
}
