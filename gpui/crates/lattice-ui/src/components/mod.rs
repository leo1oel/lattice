//! Lattice's controls, each matching its board on Paper's Components page
//! and the running app's Main window.
//!
//! The interaction rules are the Guidelines': hover is 5% of the ink (6% on
//! the darker chrome), pressed 8%, a selected row 8% with medium weight; one
//! 2px focus ring at a 2px offset, for keyboard focus only.

mod badge;
mod button;
mod chrome;
mod field;
mod form;
mod icon_button;
mod menu;
mod overlays;
mod popover;
mod row;
mod select;
mod sheet;
mod slider;
mod status_item;
mod surfaces;
mod tab;
mod textarea;
mod toolbar_button;
mod tree_row;

pub use badge::{Badge, BadgeTone};
pub use button::{Button, ButtonSize, ButtonVariant};
pub use chrome::{Keycap, SearchField, Segmented};
pub use field::Field;
pub use form::{CheckState, Checkbox, Switch};
pub use icon_button::IconButton;
pub use menu::{
    MENU_INSET, MENU_OFFSET, MenuItem, MenuLabel, MenuSeparator, MenuSurface, Step,
    step_highlight,
};
pub use overlays::{DialogCard, LatticeTooltip, PopFrom, Toast, ToastLevel, pop_in};
pub use popover::{Menu, MenuAction, MenuPopover, Popover, PopoverCard};
pub use row::{DetailPlacement, Row, RowDensity};
pub use select::{Select, SelectTrigger};
pub use sheet::{
    DRAWER_INSET, DRAWER_MIN_WIDTH, DRAWER_WIDTH, Drawer, LayerPlacement, ModalLayer, Sheet,
};
pub use slider::{Slider, key_delta};
pub use status_item::StatusItem;
pub use surfaces::{
    EmptyState, ErrorState, LOADING_REVEAL, LoadingState, PanelHeader, SettingsCard, SettingsRow,
};
pub use tab::{PanelTab, TAB_RADIUS};
pub use textarea::{TEXTAREA_MIN_HEIGHT, Textarea};
pub use toolbar_button::ToolbarButton;
pub use tree_row::TreeRow;

use gpui::{BoxShadow, Hsla, px};

use crate::{Palette, elevation::ring};

/// Which ground a control stands on, which decides its hover wash.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Surface {
    /// The chrome: titlebar gutters, the Project and Papers panels.
    Chrome,
    /// A sheet: the editor, the PDF, tool panels, fields.
    #[default]
    Sheet,
}

impl Surface {
    pub fn hover(self, palette: &Palette) -> Hsla {
        match self {
            Surface::Chrome => palette.chrome_hover,
            Surface::Sheet => palette.hover,
        }
    }
}

/// The keyboard focus ring: 2px of the focus colour, 2px off the control, so
/// a gap of `ground` shows between them.
pub fn focus_ring(palette: &Palette, ground: Hsla) -> Vec<BoxShadow> {
    let mut outer = ring(palette.focus);
    outer.spread_radius = px(4.);
    let mut gap = ring(ground);
    gap.spread_radius = px(2.);
    vec![outer, gap]
}
