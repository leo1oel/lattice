//! Row: one line of a list that is not the Project tree, such as a picker's
//! result, a paper, a history entry or a store item.
//!
//! The app's row contract (`row.ts`, chrome.css `.ui-row`) is a height and
//! nothing else: 32px for a compact list (`--row-height-compact`), 40 for a
//! data row (`--row-height-default`), 44 for a store row
//! (`--row-height-comfortable`). The rest follows the pickers' rows
//! (app-shell.css `.quick-open-list`): 6px over and under, 10px in, on the
//! 6px control corner; a 14px icon in the secondary ink, 8px to the label in
//! the body role; a detail in caption secondary, under the label or at the
//! end; anything trailing (keycaps, a badge, an action) last.
//!
//! States follow the Guidelines: hover is the ink at 5%, pressed 8%, both on
//! the fast tier; the selected row takes the selected-row wash with its label
//! at medium weight; the row the keys reached in a list (`current`) takes the
//! accent wash, its icon stepping up to the primary ink. A clickable row is a
//! tab stop with the one focus ring for keyboard focus.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px, transparent_black,
};

use crate::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::focus_ring,
    icons::ICON,
    interaction::{tab_stop, track_pointer, use_interaction},
    tokens::{
        FONT_WEIGHT_MEDIUM, OPACITY_DISABLED, SPACING_ROW_COMFORTABLE, SPACING_ROW_COMPACT,
        SPACING_ROW_DEFAULT,
    },
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum RowDensity {
    /// 32px: a picker's results, a popover's list.
    Compact,
    /// 40px: a data row.
    #[default]
    Default,
    /// 44px: a store row, with room for a detail under the label.
    Comfortable,
}

/// Where a row's detail goes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum DetailPlacement {
    /// Under the label (a file's folder, a paper's authors).
    #[default]
    Below,
    /// At the end of the line (a command's group), the label taking the
    /// room and the detail at most 45% of it.
    End,
}

#[derive(IntoElement)]
pub struct Row {
    id: ElementId,
    label: SharedString,
    icon: Option<Icon>,
    detail: Option<SharedString>,
    detail_placement: DetailPlacement,
    trailing: Option<AnyElement>,
    density: RowDensity,
    selected: bool,
    current: bool,
    disabled: bool,
    ground: Option<Hsla>,
    on_click: Option<ClickHandler>,
}

impl Row {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            detail: None,
            detail_placement: DetailPlacement::default(),
            trailing: None,
            density: RowDensity::default(),
            selected: false,
            current: false,
            disabled: false,
            ground: None,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn detail(mut self, detail: impl Into<SharedString>, placement: DetailPlacement) -> Self {
        self.detail = Some(detail.into());
        self.detail_placement = placement;
        self
    }

    /// Keycaps, a badge or an action at the end of the row.
    pub fn trailing(mut self, trailing: impl IntoElement) -> Self {
        self.trailing = Some(trailing.into_any_element());
        self
    }

    pub fn density(mut self, density: RowDensity) -> Self {
        self.density = density;
        self
    }

    pub fn compact(self) -> Self {
        self.density(RowDensity::Compact)
    }

    pub fn comfortable(self) -> Self {
        self.density(RowDensity::Comfortable)
    }

    /// The chosen row: the selected-row wash, the label at medium weight.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// The row the arrow keys reached in a list: the accent wash.
    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The surface the row stands on, which shows in the focus ring's gap
    /// (the panel, unless told otherwise).
    pub fn ground(mut self, ground: Hsla) -> Self {
        self.ground = Some(ground);
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RowDensity {
    pub fn min_height(self) -> gpui::Rems {
        match self {
            RowDensity::Compact => SPACING_ROW_COMPACT,
            RowDensity::Default => SPACING_ROW_DEFAULT,
            RowDensity::Comfortable => SPACING_ROW_COMFORTABLE,
        }
    }
}

impl RenderOnce for Row {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (interaction, pointer) = use_interaction(self.id.clone(), window, cx);
        let interactive = self.on_click.is_some() && !self.disabled;
        let rest = if self.current {
            palette.accent_soft
        } else if self.selected {
            palette.row_selected
        } else {
            transparent_black()
        };
        // A selected or current row keeps its wash under the pointer; a
        // plain row takes the hover wash.
        let hover = if self.current || self.selected {
            rest
        } else {
            palette.hover
        };
        let bg = if interactive {
            interaction.wash(rest, hover, palette.pressed)
        } else {
            rest
        };
        let lit = self.current || self.selected || (interactive && interaction.pointer.hovered);
        let icon_ink = if lit {
            palette.text
        } else {
            palette.text_secondary
        };
        let label_ink = if self.selected {
            palette.nav_text_strong
        } else {
            palette.text
        };
        let focus = focus_ring(&palette, self.ground.unwrap_or(palette.panel));
        let detail_end = self.detail_placement == DetailPlacement::End;

        let label = div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .text_color(label_ink)
            .when(self.selected, |this| this.font_weight(FONT_WEIGHT_MEDIUM))
            .when(detail_end, |this| this.flex_1())
            .child(self.label);
        let detail = self.detail.map(|detail| {
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .when(detail_end, |this| this.flex_none().max_w(gpui::relative(0.45)))
                .child(detail)
        });
        let text = div()
            .flex_1()
            .min_w_0()
            .flex()
            .map(|this| {
                if detail_end {
                    this.items_baseline().justify_between().gap(px(16.))
                } else {
                    this.flex_col().gap(px(2.))
                }
            })
            .child(label)
            .children(detail);

        let row = div().id(self.id);
        let row = if interactive {
            track_pointer(tab_stop(row), pointer)
                .cursor_pointer()
                .focus_visible(move |style| style.shadow(focus))
        } else {
            row
        };
        let min_height: Pixels = self.density.min_height().to_pixels(window.rem_size());
        row.flex()
            .items_center()
            .gap(px(8.))
            .min_h(min_height)
            .px(px(10.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(bg)
            .text_role(TextRole::Body, cx)
            .when(self.disabled, |this| this.opacity(OPACITY_DISABLED))
            .when_some(self.icon, |this, icon| {
                this.child(icon.element(ICON, icon_ink))
            })
            .child(text)
            .when_some(self.trailing, |this, trailing| {
                this.child(div().flex_none().child(trailing))
            })
            .when_some(self.on_click.filter(|_| interactive), |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
    }
}
