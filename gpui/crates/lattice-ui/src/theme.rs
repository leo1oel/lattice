//! The app-wide look: the palette, the fonts and the code theme, kept in one
//! GPUI global and pushed to GPUI Kit whenever it changes.

use std::sync::Arc;

use gpui::{App, Global, WindowAppearance};
use lattice_theme::ThemeFile;

use crate::{Accent, Appearance, Glass, Palette, Tint, editor_theme::CodeTheme, fonts::Fonts, kit};

pub struct LatticeTheme {
    pub palette: Palette,
    pub fonts: Fonts,
    pub code_theme: CodeTheme,
}

impl Global for LatticeTheme {}

/// `cx.lattice()` from any context that derefs to `App`.
pub trait ActiveLattice {
    fn lattice(&self) -> &LatticeTheme;

    fn palette(&self) -> &Palette {
        &self.lattice().palette
    }
}

impl ActiveLattice for App {
    fn lattice(&self) -> &LatticeTheme {
        self.global::<LatticeTheme>()
    }
}

impl From<WindowAppearance> for Appearance {
    fn from(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Appearance::Light,
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Appearance::Dark,
        }
    }
}

impl LatticeTheme {
    /// Load the fonts and install the theme in the system's appearance, after
    /// `gpui_kit::init`, which installs the Kit theme this replaces.
    pub fn init(appearance: Option<Appearance>, cx: &mut App) {
        let fonts = Fonts::load(cx);
        let appearance = appearance.unwrap_or_else(|| cx.window_appearance().into());
        cx.set_global(LatticeTheme {
            palette: Palette::new(appearance, Tint::default(), Accent::default()),
            fonts,
            code_theme: CodeTheme::default(),
        });
        kit::apply(cx);
    }

    pub fn appearance(cx: &App) -> Appearance {
        cx.lattice().palette.appearance
    }

    pub fn set_appearance(appearance: Appearance, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette = rebuilt(
                &theme.palette,
                appearance,
                theme.palette.tint,
                theme.palette.accent_preset,
                theme.palette.theme.clone(),
            )
        });
    }

    pub fn set_tint(tint: Tint, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette = rebuilt(
                &theme.palette,
                theme.palette.appearance,
                tint,
                theme.palette.accent_preset,
                theme.palette.theme.clone(),
            )
        });
    }

    pub fn set_accent(accent: Accent, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette = rebuilt(
                &theme.palette,
                theme.palette.appearance,
                theme.palette.tint,
                accent,
                theme.palette.theme.clone(),
            )
        });
    }

    /// Choose a theme (`docs/themes.md`), or none.
    pub fn set_theme(file: Option<Arc<ThemeFile>>, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette = rebuilt(
                &theme.palette,
                theme.palette.appearance,
                theme.palette.tint,
                theme.palette.accent_preset,
                file,
            )
        });
    }

    /// Lay the palette over the window material at `glass`, or make it
    /// opaque again (`Glass::Off`).
    pub fn set_glass(glass: Glass, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette = theme.palette.clone().with_glass(glass)
        });
    }

    pub fn set_code_theme(code_theme: CodeTheme, cx: &mut App) {
        Self::update(cx, |theme| theme.code_theme = code_theme);
    }

    /// Change the look, then bring GPUI Kit along and redraw every window.
    /// Observers of the global (the Zed editor theme, in the app) run after.
    fn update(cx: &mut App, edit: impl FnOnce(&mut LatticeTheme)) {
        let before = (cx.lattice().palette.clone(), cx.lattice().code_theme);
        edit(cx.global_mut::<LatticeTheme>());
        if (cx.lattice().palette.clone(), cx.lattice().code_theme) == before {
            return;
        }
        kit::apply(cx);
        cx.refresh_windows();
    }
}

/// The palette for these choices, keeping `current`'s window material.
fn rebuilt(
    current: &Palette,
    appearance: Appearance,
    tint: Tint,
    accent: Accent,
    theme: Option<Arc<ThemeFile>>,
) -> Palette {
    Palette::new(appearance, tint, accent)
        .with_theme(theme)
        .with_glass(current.glass)
}
