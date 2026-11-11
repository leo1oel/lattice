//! The app-wide look: the palette, the fonts and the code theme, kept in one
//! GPUI global and pushed to GPUI Kit whenever it changes.

use gpui::{App, Global, WindowAppearance};

use crate::{Accent, Appearance, Palette, Tint, editor_theme::CodeTheme, fonts::Fonts, kit};

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
            theme.palette =
                Palette::new(appearance, theme.palette.tint, theme.palette.accent_preset)
        });
    }

    pub fn set_tint(tint: Tint, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette =
                Palette::new(theme.palette.appearance, tint, theme.palette.accent_preset)
        });
    }

    pub fn set_accent(accent: Accent, cx: &mut App) {
        Self::update(cx, |theme| {
            theme.palette = Palette::new(theme.palette.appearance, theme.palette.tint, accent)
        });
    }

    pub fn set_code_theme(code_theme: CodeTheme, cx: &mut App) {
        Self::update(cx, |theme| theme.code_theme = code_theme);
    }

    /// Change the theme, then bring GPUI Kit along and redraw every window.
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
