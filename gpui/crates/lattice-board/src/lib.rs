// Lattice's native whiteboard: quiet.md's GPUI port of Excalidraw
// (https://github.com/s1dashu/quiet-md, MIT, Copyright (c) 2026 s1dashu;
// Excalidraw https://github.com/excalidraw/excalidraw @ 3a317b5, MIT,
// Copyright (c) 2020 Excalidraw), adapted to Lattice's host. See
// THIRD_PARTY_NOTICES.md.

//! The `.excalidraw` whiteboard as a GPUI view (`board::BoardView`), over
//! `lattice-board-core`'s model. The host (`lattice-gpui`'s structured
//! documents) owns the file's text: it hands the view the text, takes the
//! serialized scene back when the view says it changed, and keeps the
//! reader's camera.

// The ported functions keep Excalidraw's signatures and shapes, so each
// stays traceable to its upstream counterpart.
#![allow(
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::large_enum_variant
)]

pub mod assets;
pub mod board;
pub mod text_field;

pub use lattice_board_core::whiteboard;

/// Registers the board's fonts (once, at startup).
pub fn load_fonts(cx: &gpui::App) {
    board::fonts::load(cx);
}

/// Binds the board's keys (with the app's, whenever those are bound again).
pub fn bind_keys(cx: &mut gpui::App) {
    board::bind_keys(cx);
    text_field::bind_keys(cx);
}

/// The look the board draws in, as the host's theme has it.
pub mod theme {
    use gpui::{Font, Hsla, SharedString, font};
    use lattice_ui::Palette;
    use std::cell::{Cell, RefCell};

    thread_local! {
        static DARK: Cell<bool> = const { Cell::new(false) };
        static UI: RefCell<SharedString> = const { RefCell::new(SharedString::new_static("Inter")) };
        static PALETTE: RefCell<Option<Palette>> = const { RefCell::new(None) };
    }

    /// Reads the app's palette as the board last rendered with it: the chrome
    /// wears Lattice's tokens, as the Tauri app's restyled Excalidraw does
    /// (its \`.board-editor-root .excalidraw\` variables).
    pub fn palette<T>(read: impl FnOnce(&Palette) -> T) -> T {
        PALETTE.with(|p| match p.borrow().as_ref() {
            Some(palette) => read(palette),
            None => read(&Palette::new(
                if dark() {
                    lattice_ui::Appearance::Dark
                } else {
                    lattice_ui::Appearance::Light
                },
                Default::default(),
                Default::default(),
            )),
        })
    }

    pub(crate) fn set_palette(palette: &Palette) {
        PALETTE.with(|p| {
            if p.borrow().as_ref() != Some(palette) {
                *p.borrow_mut() = Some(palette.clone());
            }
        });
    }

    /// The canvas ground: the board draws on a transparent background over
    /// the editor sheet (\`--board-canvas-surface\` → \`--editor-bg\`), whatever
    /// \`viewBackgroundColor\` the file holds.
    pub fn canvas() -> Hsla {
        palette(|p| p.editor)
    }

    /// The board is drawn in the dark theme (Excalidraw's `theme === "dark"`).
    pub fn dark() -> bool {
        DARK.with(Cell::get)
    }

    pub(crate) fn set_dark(dark: bool) {
        DARK.with(|d| d.set(dark));
    }

    /// The interface's family (the chrome's labels).
    pub fn ui_family() -> SharedString {
        UI.with(|u| u.borrow().clone())
    }

    pub(crate) fn set_ui_family(family: SharedString) {
        UI.with(|u| *u.borrow_mut() = family);
    }

    pub fn ui_font() -> Font {
        font(ui_family())
    }

    /// The chrome's monospace family (key hints, the hex field).
    pub const MONO_FONT: &str = "Ioskeley Mono";
}

/// The interface language: Excalidraw's English and Simplified Chinese.
pub mod settings {
    /// `zh` in Chinese, `en` otherwise.
    pub fn tr(zh: &'static str, en: &'static str) -> &'static str {
        if lattice_i18n::locale().is_chinese() {
            zh
        } else {
            en
        }
    }
}
