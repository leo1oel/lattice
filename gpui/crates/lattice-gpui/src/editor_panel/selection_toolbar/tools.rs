//! The selection toolbar's buttons (`selection_toolbar.rs`): the LaTeX
//! row (`latex-selection-toolbar.tsx`), with the highlighter's split pen
//! and caret, and the Markdown row (`markdown-source-toolbar.tsx`).

use super::*;
use lattice_editor::proofread::Ask;

impl EditorPanel {
    /// The LaTeX toolbar's buttons.
    pub(super) fn latex_tools(&mut self, text: &str, range: Range<usize>, cx: &mut Context<Self>) -> AnyElement {
        let formats = format_toggle::selection_formats(text, range.clone());
        let editable = true;
        let mut bar = div().flex().items_center();
        let inline = [
            (format_toggle::InlineFormat::Bold, Icon::BOLD, t!("Bold")),
            (format_toggle::InlineFormat::Italic, Icon::ITALIC, t!("Italic")),
            (format_toggle::InlineFormat::Underline, Icon::UNDERLINE, t!("Underline")),
            (
                format_toggle::InlineFormat::Strikethrough,
                Icon::STRIKETHROUGH,
                t!("Strikethrough"),
            ),
        ];
        if editable {
            for (index, (format, icon, label)) in inline.into_iter().enumerate() {
                let pressed = formats.inline.contains(&format);
                bar = bar.child(tool(
                    ("latex-format", index),
                    icon,
                    label,
                    Some(pressed),
                    false,
                    cx.listener(move |this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Latex(format), window, cx)
                    }),
                    cx,
                ));
            }
            bar = bar.child(tool(
                "latex-quote",
                Icon::QUOTE,
                t!("Quote"),
                Some(formats.quote),
                false,
                cx.listener(|this, _, window, cx| this.toolbar_action(ToolbarAction::Quote, window, cx)),
                cx,
            ));
        }
        bar = bar.child(tool(
            "latex-annotate",
            Icon::MESSAGE_SQUARE_TEXT,
            t!("Annotate"),
            None,
            editable,
            cx.listener(|this, _, window, cx| this.toolbar_action(ToolbarAction::Annotate, window, cx)),
            cx,
        ));
        // The agent's Proofread and Polish, and Rewrite by an instruction.
        if self.can_proofread(cx) {
            let proofread_keys = if cfg!(target_os = "macos") { "⌘⌥P" } else { "Ctrl+Alt+P" };
            bar = bar
                .child(keyed_tool(
                    "latex-proofread",
                    Icon::SPELL_CHECK,
                    t!("Proofread"),
                    Some(proofread_keys),
                    None,
                    false,
                    cx.listener(|this, _, window, cx| this.start_proofread(Ask::Proofread, window, cx)),
                    cx,
                ))
                .child(tool(
                    "latex-polish",
                    Icon::WAND_SPARKLES,
                    t!("Polish"),
                    None,
                    false,
                    cx.listener(|this, _, window, cx| this.start_proofread(Ask::Polish, window, cx)),
                    cx,
                ))
                .child(tool(
                    "latex-rewrite",
                    Icon::PENCIL_LINE,
                    t!("Rewrite with an instruction"),
                    Some(self.toolbar.menu == Some(Menu::Rewrite)),
                    false,
                    cx.listener(|this, _, window, cx| this.open_menu(Menu::Rewrite, window, cx)),
                    cx,
                ));
        }
        if editable {
            let menu = self.toolbar.menu;
            bar = bar
                .child(tool(
                    "latex-link",
                    Icon::LINK,
                    t!("Link"),
                    Some(formats.link || menu == Some(Menu::Link)),
                    true,
                    cx.listener(|this, _, window, cx| this.open_menu(Menu::Link, window, cx)),
                    cx,
                ))
                .child(tool(
                    "latex-heading",
                    Icon::HEADING,
                    t!("Heading level"),
                    Some(formats.heading.is_some() || menu == Some(Menu::Heading)),
                    false,
                    cx.listener(|this, _, window, cx| this.open_menu(Menu::Heading, window, cx)),
                    cx,
                ))
                .child(self.highlight_split(cx));
        }
        bar.into_any_element()
    }

    /// The highlighter: the pen applies the last highlighter (the bar under
    /// it is its colour), the caret opens the palette.
    pub(super) fn highlight_split(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let last = highlight_palette::prefs(cx).last.clone();
        let last_highlight = highlight_palette::meaning_of_color(&last, cx);
        let label: SharedString =
            t!("Highlight: {lastHighlight}", lastHighlight = last_highlight).into();
        let pen_color = last.clone();
        let open = self.toolbar.menu == Some(Menu::Highlight);
        let pen = div()
            .id("latex-highlight-pen")
            .relative()
            .size(px(BUTTON))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|this| this.bg(palette.accent_soft))
            .child(Icon::HIGHLIGHTER.element(px(14.), palette.text_secondary))
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .right(px(8.))
                    .bottom(px(3.))
                    .h(px(3.))
                    .rounded_full()
                    .bg(highlight_palette::hex_color(&last))
                    .border(px(0.5))
                    .border_color(palette.text.opacity(0.24)),
            )
            .tooltip(move |_, cx| LatticeTooltip::view(label.clone(), None, cx))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.toolbar_action(ToolbarAction::Highlight(pen_color.clone()), window, cx)
            }));
        let caret = div()
            .id("latex-highlight-caret")
            .w(px(16.))
            .h(px(BUTTON))
            .ml(px(-2.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .when(open, |this| this.bg(palette.accent_soft))
            .hover(|this| this.bg(palette.accent_soft))
            .child(Icon::CHEVRON_DOWN.element(px(12.), if open { palette.text } else { palette.text_secondary }))
            .tooltip(|_, cx| LatticeTooltip::view(SharedString::from(t!("Highlight color")), None, cx))
            .on_click(cx.listener(|this, _, window, cx| this.open_menu(Menu::Highlight, window, cx)));
        separated(div().flex().items_center().child(pen).child(caret), &palette).into_any_element()
    }

    /// The Markdown toolbar's buttons.
    pub(super) fn markdown_tools(&mut self, text: &str, range: Range<usize>, cx: &mut Context<Self>) -> AnyElement {
        let format = markdown_format::selection_format(text, range);
        let palette = cx.palette().clone();
        let formats = !format.in_code;
        let current = block_label(format.block);
        let open = self.toolbar.menu == Some(Menu::Block);
        let block = div()
            .id("markdown-block-type")
            .h(px(BUTTON))
            .flex()
            .items_center()
            .gap(px(2.))
            .pl(px(8.))
            .pr(px(6.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_role(TextRole::Body, cx)
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(palette.text)
            .when(open, |this| this.bg(palette.hover))
            .hover(|this| this.bg(palette.hover))
            .child(current)
            .child(Icon::CHEVRON_DOWN.element(px(12.), palette.text.opacity(0.7)))
            .on_click(cx.listener(|this, _, window, cx| this.open_menu(Menu::Block, window, cx)));
        let mut bar = div().flex().flex_wrap().items_center().gap(px(1.)).child(block).child(divider(&palette));
        if formats {
            let marks = [
                (MdFormat::Bold, Icon::BOLD, t!("Bold")),
                (MdFormat::Italic, Icon::ITALIC, t!("Italic")),
                (MdFormat::Underline, Icon::UNDERLINE, t!("Underline")),
                (MdFormat::Strike, Icon::STRIKETHROUGH, t!("Strikethrough")),
                (MdFormat::Code, Icon::CODE, t!("Inline code")),
                (MdFormat::Highlight, Icon::HIGHLIGHTER, t!("Highlight")),
            ];
            for (index, (mark, icon, label)) in marks.into_iter().enumerate() {
                bar = bar.child(md_tool(
                    ("markdown-format", index),
                    icon,
                    label,
                    Some(format.inline.contains(&mark)),
                    cx.listener(move |this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Markdown(mark), window, cx)
                    }),
                    cx,
                ));
            }
            bar = bar
                .child(divider(&palette))
                .child(md_tool(
                    "markdown-link",
                    Icon::LINK,
                    t!("Insert link"),
                    Some(format.inline.contains(&MdFormat::Link)),
                    cx.listener(|this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Markdown(MdFormat::Link), window, cx)
                    }),
                    cx,
                ))
                .child(md_tool(
                    "markdown-math",
                    Icon::RADICAL,
                    t!("Convert selection to inline math"),
                    Some(format.inline.contains(&MdFormat::Math)),
                    cx.listener(|this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Markdown(MdFormat::Math), window, cx)
                    }),
                    cx,
                ))
                .child(divider(&palette));
        }
        bar.child(md_tool(
            "markdown-annotate",
            Icon::MESSAGE_SQUARE_TEXT,
            t!("Annotate"),
            None,
            cx.listener(|this, _, window, cx| this.toolbar_action(ToolbarAction::Annotate, window, cx)),
            cx,
        ))
        .into_any_element()
    }
}

/// The block types the Markdown toolbar's menu offers, and whether a rule
/// goes before each (`TOOLBAR_BLOCK_TYPES`).
pub(super) const BLOCKS: [(BlockType, bool); 12] = [
    (BlockType::Text, false),
    (BlockType::Heading(1), true),
    (BlockType::Heading(2), false),
    (BlockType::Heading(3), false),
    (BlockType::Heading(4), false),
    (BlockType::Heading(5), false),
    (BlockType::Heading(6), false),
    (BlockType::BulletList, true),
    (BlockType::OrderedList, false),
    (BlockType::TaskList, false),
    (BlockType::Quote, true),
    (BlockType::CodeBlock, false),
];

pub(super) fn block_label(block: BlockType) -> SharedString {
    match block {
        BlockType::Text => t!("Text").into(),
        BlockType::Heading(1) => t!("Heading 1").into(),
        BlockType::Heading(2) => t!("Heading 2").into(),
        BlockType::Heading(3) => t!("Heading 3").into(),
        BlockType::Heading(4) => t!("Heading 4").into(),
        BlockType::Heading(5) => t!("Heading 5").into(),
        BlockType::Heading(_) => t!("Heading 6").into(),
        BlockType::BulletList => t!("Bullet List").into(),
        BlockType::OrderedList => t!("Ordered List").into(),
        BlockType::TaskList => t!("Task List").into(),
        BlockType::Quote => t!("Quote").into(),
        BlockType::CodeBlock => t!("Code Block").into(),
    }
}

/// A rule before a group of tools (`.latex-selection-tool.separated`).
pub(super) fn separated(element: gpui::Div, palette: &lattice_ui::palette::Palette) -> gpui::Div {
    element
        .ml(px(3.))
        .pl(px(3.))
        .border_l_1()
        .border_color(palette.line)
}

pub(super) fn divider(palette: &lattice_ui::palette::Palette) -> AnyElement {
    div().w(px(1.)).h(px(16.)).mx(px(2.)).bg(palette.line).into_any_element()
}

/// One LaTeX tool: a 28px button with its 14px icon, a tooltip, pressed
/// when the selection already has its format.
pub(super) fn tool(
    id: impl Into<gpui::ElementId>,
    icon: Icon,
    label: &'static str,
    pressed: Option<bool>,
    separated_before: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    keyed_tool(id, icon, label, None, pressed, separated_before, on_click, cx)
}

/// A [`tool`] whose tooltip names its keys too.
#[allow(clippy::too_many_arguments)]
pub(super) fn keyed_tool(
    id: impl Into<gpui::ElementId>,
    icon: Icon,
    label: &'static str,
    keys: Option<&'static str>,
    pressed: Option<bool>,
    separated_before: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let on = pressed == Some(true);
    let button = div()
        .id(id.into())
        .size(px(BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |this| this.bg(palette.toolbar_active))
        .hover(|this| this.bg(palette.accent_soft))
        .child(icon.element(px(14.), if on { palette.text } else { palette.text_secondary }))
        .tooltip(move |_, cx| {
            LatticeTooltip::view(SharedString::from(label), keys.map(SharedString::from), cx)
        })
        .on_click(on_click);
    let wrap = div().flex();
    if separated_before {
        separated(wrap, &palette).child(button).into_any_element()
    } else {
        wrap.child(button).into_any_element()
    }
}

/// One Markdown tool (`.lx-md-toolbar-button`): 15px icons, the hover fill.
pub(super) fn md_tool(
    id: impl Into<gpui::ElementId>,
    icon: Icon,
    label: &'static str,
    pressed: Option<bool>,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let on = pressed == Some(true);
    div()
        .id(id.into())
        .h(px(BUTTON))
        .min_w(px(BUTTON))
        .px(px(4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |this| this.bg(palette.toolbar_active))
        .hover(|this| this.bg(palette.hover))
        .child(icon.element(px(15.), if on { palette.text } else { palette.text_secondary }))
        .tooltip(move |_, cx| LatticeTooltip::view(SharedString::from(label), None, cx))
        .on_click(on_click)
        .into_any_element()
}
