//! Where the manuscript cites the reference in front (`bib-entry-detail.tsx`'s
//! usages): each use by file and line, a click opening it in its source.

use gpui::{
    AnyElement, ClickEvent, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, interaction::mix};

use super::super::BibEditor;

impl BibEditor {
    pub(super) fn usages_section(&self, key: &str, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let mut section = div()
            .flex()
            .flex_col()
            .child(Self::section_title(t!("Cited in"), cx));
        let quiet = |text: String, ink: gpui::Hsla, cx: &Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .child(text)
        };
        let Some(usages) = &self.usages else {
            return section
                .child(quiet(
                    t!("Looking through the manuscript…").into(),
                    palette.text_secondary,
                    cx,
                ))
                .into_any_element();
        };
        let list = usages.of(key);
        if list.is_empty() {
            let text = if usages.everything {
                t!(
                    "Not cited by key, but {nociteAll} includes every entry",
                    nociteAll = "\\nocite{*}"
                )
            } else {
                t!("Not cited in any .tex file").to_string()
            };
            return section
                .child(quiet(text, mix(palette.warning, palette.text, 0.3), cx))
                .into_any_element();
        }
        for (at, usage) in list.iter().enumerate() {
            let (path, line) = (usage.path.clone(), usage.line);
            section = section.child(
                div()
                    .id(("bib-usage", at))
                    .flex()
                    .items_baseline()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.hover))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.open_line(path.clone(), line, cx)
                    }))
                    .child(
                        div()
                            .flex_none()
                            .max_w(px(200.))
                            .truncate()
                            .px(px(4.))
                            .rounded(px(4.))
                            .bg(palette.hover)
                            .text_role(TextRole::Micro, cx)
                            .text_color(palette.text)
                            .child(format!("{}:{}", usage.path, usage.line)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .font_family(editor_font.clone())
                            .text_size(px(12.))
                            .line_height(px(18.))
                            .text_color(palette.text_secondary)
                            .child(usage.snippet.trim().to_string()),
                    ),
            );
        }
        section.into_any_element()
    }
}
