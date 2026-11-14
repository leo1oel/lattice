//! The window's parts: a feature's own state, panels, command handlers and
//! palette rows, registered from the feature's own module.
//!
//! A module under `shell/` that holds a `pub(super) const PART: Part` is a
//! part, without a line kept by hand (`build.rs` lists them, by file name).
//! Its state lives in [`Shell::parts`], keyed by its type, instead of in a
//! field of `Shell`; its singleton views are drawn and sized from its
//! [`View`]s instead of the match arms in `views.rs`; its actions are
//! registered by its `actions` beside the command table's (`actions.rs`);
//! and its palette rows are added by its `commands`, after the table's own
//! in each section. So a new panel is its own module and its `mod` line in
//! `shell.rs`, and adding one does not add fields, initializers or match
//! arms to `shell.rs`, `views.rs` and `actions.rs`.
//!
//! The shell's older parts are still its fields; Get started
//! (`get_started_flow`) is the first registered this way.

use std::{
    any::{Any, TypeId, type_name},
    collections::HashMap,
    sync::Arc,
};

use gpui::{Context, Div, Stateful, Window};
use gpui_kit::component::dock::BasePanelView;

use super::{
    Shell,
    commands::{Command, CommandContext},
};

/// One part's registration (its module's `PART`).
pub(crate) struct Part {
    /// Its state for a new window, made at the end of `Shell::new`, before
    /// the window's first layout is installed.
    pub install: fn(&mut Window, &mut Context<Shell>) -> Box<dyn Any>,
    /// The singleton views it draws.
    pub views: &'static [View],
    /// Its actions' handlers on the shell's root element.
    pub actions: fn(Stateful<Div>, &mut Context<Shell>) -> Stateful<Div>,
    /// Its rows in the command palette and the shortcut sheet, for the
    /// window as `CommandContext` describes it.
    pub commands: fn(&CommandContext, &mut Vec<Command>),
}

/// A singleton view a part draws, under its own id.
pub(crate) struct View {
    pub kind: &'static str,
    /// Its minimum width and height, which no layout scales it below.
    pub min: (f64, f64),
    /// Its panel, made once per window from the part's state.
    pub panel: fn(&Shell) -> Arc<dyn BasePanelView>,
}

/// No palette rows of its own.
pub(crate) fn no_commands(_: &CommandContext, _: &mut Vec<Command>) {}

// `PARTS`, every module's `PART`, by file name.
include!(concat!(env!("OUT_DIR"), "/window_parts.rs"));

/// The registered views, every part's.
pub(crate) fn views() -> impl Iterator<Item = &'static View> {
    PARTS.iter().flat_map(|part| part.views)
}

/// The window's parts' state, one value per part, by its type.
#[derive(Default)]
pub(crate) struct Parts(HashMap<TypeId, Box<dyn Any>>);

impl Parts {
    /// Every part's state, for a new window.
    pub(super) fn install(window: &mut Window, cx: &mut Context<Shell>) -> Self {
        let mut parts = HashMap::new();
        for part in PARTS {
            let state = (part.install)(window, cx);
            // The boxed value's own type, not the box's.
            parts.insert(state.as_ref().type_id(), state);
        }
        Self(parts)
    }

    /// The part `T`'s state. A part's own module asks only for its own,
    /// which its `install` made, so a miss is a registration mistake.
    pub(crate) fn get<T: 'static>(&self) -> &T {
        self.0
            .get(&TypeId::of::<T>())
            .and_then(|state| state.downcast_ref())
            .unwrap_or_else(|| panic!("{} is no window part's state", type_name::<T>()))
    }

    pub(crate) fn get_mut<T: 'static>(&mut self) -> &mut T {
        self.0
            .get_mut(&TypeId::of::<T>())
            .and_then(|state| state.downcast_mut())
            .unwrap_or_else(|| panic!("{} is no window part's state", type_name::<T>()))
    }
}

impl Shell {
    /// The panel of the part view `kind`, when a part draws it.
    pub(super) fn part_panel(&self, kind: &str) -> Option<Arc<dyn BasePanelView>> {
        views()
            .find(|view| view.kind == kind)
            .map(|view| (view.panel)(self))
    }

    /// Every part's actions' handlers on the shell's root element.
    pub(super) fn register_part_actions(
        element: Stateful<Div>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        PARTS
            .iter()
            .fold(element, |element, part| (part.actions)(element, cx))
    }
}

/// Every part's palette rows, after the table's own.
pub(super) fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    for part in PARTS {
        (part.commands)(context, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_views_are_unique_and_not_the_shells_own() {
        let mut kinds: Vec<_> = views().map(|view| view.kind).collect();
        let count = kinds.len();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), count, "two parts draw one view kind");
        for kind in kinds {
            assert!(
                !super::super::views::SINGLETONS.contains(&kind),
                "{kind} is both a part's view and in views::SINGLETONS"
            );
        }
    }
}
