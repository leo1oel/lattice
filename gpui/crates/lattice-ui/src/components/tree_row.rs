//! A Project tree row, drawn as the content of GPUI Kit's tree item.
//!
//! Measured on the Main window: rows 28px tall with control corners (6px);
//! a file's 14px glyph 8px in, 6px to its 13px label in secondary ink; a
//! folder's 12px filled chevron 9.5px in, 6.5px to its glyph, so a file's
//! glyph at the top level stands in the chevron's column. The open file's
//! row is the selected-row wash with its label a step under the primary ink
//! at medium weight.

use gpui::{
    App, ElementId, ParentElement as _, SharedString, Styled as _, Transformation, div,
    prelude::FluentBuilder as _, px, radians, svg,
};
use gpui_kit::component::list::ListItem;

use crate::{
    ActiveLattice as _, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    icons::{ICON, ICON_SMALL, file_glyph},
    parity,
    tokens::FONT_WEIGHT_MEDIUM,
};

/// How far each level of nesting moves a row in.
const INDENT: f32 = 14.;

pub struct TreeRow {
    id: ElementId,
    name: SharedString,
    depth: usize,
    /// `Some(expanded)` for a folder.
    folder: Option<bool>,
    selected: bool,
    parity: Option<SharedString>,
}

impl TreeRow {
    pub fn file(id: impl Into<ElementId>, name: impl Into<SharedString>, depth: usize) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            depth,
            folder: None,
            selected: false,
            parity: None,
        }
    }

    pub fn folder(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        depth: usize,
        expanded: bool,
    ) -> Self {
        Self {
            folder: Some(expanded),
            ..Self::file(id, name, depth)
        }
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// Name this row as a parity-harness region (`crate::parity`): its
    /// bounds and its label's text style are recorded under `name`.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    /// The Kit list item the tree draws, with this row as its content.
    pub fn into_list_item(self, cx: &App) -> ListItem {
        let palette = cx.palette().clone();
        let indent = px(self.depth as f32 * INDENT);
        let label_ink = if self.selected {
            palette.nav_text_strong
        } else {
            palette.text_secondary
        };
        let lead = match self.folder {
            Some(expanded) => div()
                .flex()
                .items_center()
                .pl(px(9.5) + indent)
                .child(
                    svg()
                        .path(Icon::DISCLOSURE.path())
                        .size(ICON_SMALL)
                        .flex_none()
                        .text_color(palette.text_secondary)
                        .when(!expanded, |chevron| {
                            chevron.with_transformation(Transformation::rotate(radians(
                                -std::f32::consts::FRAC_PI_2,
                            )))
                        }),
                )
                .child(
                    div()
                        .ml(px(6.5))
                        .child(file_glyph(GlyphKind::Folder, ICON, &palette)),
                ),
            None => div().pl(px(8.) + indent).child(file_glyph(
                GlyphKind::for_name(&self.name),
                ICON,
                &palette,
            )),
        };
        // Kit's tree marks its own keyboard selection on the item after this
        // returns, so the open file's wash is set as the item's background.
        ListItem::new(self.id)
            .h(px(28.))
            .py_0()
            .px_0()
            .pr(px(8.))
            .rounded(px(6.))
            .when(self.selected, |item| item.bg(palette.row_selected))
            .children(self.parity.clone().and_then(parity::probe))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .child(lead)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_role(TextRole::Body, cx)
                            .line_height(px(28.))
                            .text_color(label_ink)
                            .when(self.selected, |label| label.font_weight(FONT_WEIGHT_MEDIUM))
                            .children(
                                self.parity.and_then(|name| {
                                    parity::text_probe(name, 0, self.name.clone())
                                }),
                            )
                            .child(self.name),
                    ),
            )
    }
}
