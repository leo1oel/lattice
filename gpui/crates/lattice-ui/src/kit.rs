//! GPUI Kit in Lattice's colours.
//!
//! Kit draws its components from `Theme`, whose colours come from a theme file
//! per mode (`ThemeConfig`). This writes one for each appearance from the
//! Lattice palette and installs both, so every Kit component, and Kit's own
//! switch between light and dark, starts from Lattice's colours. Kit's keys
//! name roles of its own (`primary`, `accent`, `list.active`); each is mapped
//! to the Lattice role that plays the same part, with the reason where it is
//! not obvious.

use std::rc::Rc;

use gpui::{App, Hsla, Rgba, transparent_black};
use gpui_kit::component::{Theme, ThemeConfig, ThemeMode};
use serde_json::{Value, json};

use crate::{ActiveLattice as _, Appearance, Palette, fonts::Fonts, tokens::*};

/// Install the Kit theme for the current Lattice theme, in its appearance.
pub fn apply(cx: &mut App) {
    let theme = cx.lattice();
    let fonts = theme.fonts.clone();
    let (tint, accent) = (theme.palette.tint, theme.palette.accent_preset);
    let mode = match theme.palette.appearance {
        Appearance::Light => ThemeMode::Light,
        Appearance::Dark => ThemeMode::Dark,
    };
    let light = Rc::new(config(
        &Palette::new(Appearance::Light, tint, accent),
        &fonts,
    ));
    let dark = Rc::new(config(
        &Palette::new(Appearance::Dark, tint, accent),
        &fonts,
    ));
    Theme::update(cx, |theme| {
        theme.light_theme = light;
        theme.dark_theme = dark;
    });
    // Loads the installed file for `mode`, even when the mode is unchanged.
    Theme::change(mode, None, cx);
    hide_resize_handles(cx);
}

/// Kit paints a dock's resize handle as a 1px line in its border colour. The
/// Tauri app's panels have no dividers, only the 6px gutter between cards, so
/// the handle keeps its hit area and draws nothing. Kit rebuilds this from
/// `Theme` on every change, so it is set again after each one.
fn hide_resize_handles(cx: &mut App) {
    let focus = cx.lattice().palette.focus;
    let base = cx.global_mut::<gpui_kit::base::Theme>();
    base.resizable.handle = Some(transparent_black());
    base.resizable.active_handle = Some(focus);
}

fn config(palette: &Palette, fonts: &Fonts) -> ThemeConfig {
    let mode = if palette.is_dark() { "dark" } else { "light" };
    let value = json!({
        "name": format!("Lattice {}", if palette.is_dark() { "Dark" } else { "Light" }),
        "mode": mode,
        "is_default": false,
        // Kit's Root makes its font size the window's rem size, and every
        // Lattice token is in rems of a 16px root, so this stays 16: the
        // interface size setting scales it, and with it the whole interface.
        "font.size": ROOT_FONT_SIZE,
        "font.family": fonts.ui.as_ref(),
        "mono_font.family": fonts.editor.as_ref(),
        "mono_font.size": px_of(TEXT_CAPTION),
        "radius": px_of(RADIUS_CONTROL) as usize,
        "radius.lg": px_of(RADIUS_PANEL) as usize,
        "shadow": true,
        "colors": colors(palette),
    });
    serde_json::from_value(value).expect("the Lattice Kit theme matches Kit's schema")
}

/// The rem the tokens are written against.
pub const ROOT_FONT_SIZE: f32 = 16.;

fn px_of(rems: gpui::Rems) -> f32 {
    rems.0 * 16.
}

fn colors(p: &Palette) -> Value {
    let text_12 = with_alpha(p.text, 0.12);
    let text_16 = with_alpha(p.text, 0.16);
    json!({
        "background": hex(p.panel),
        "foreground": hex(p.text),
        "border": hex(p.line),
        "window.border": hex(p.line),
        "ring": hex(p.focus),
        "caret": hex(p.text),
        "selection.background": hex(p.selection),
        "overlay": hex(p.scrim),
        "drag_border": hex(p.focus),
        "drop_target.background": hex(p.drop_target),

        // Kit's `accent` is the highlight of a hovered menu item or list row,
        // which Lattice draws as the accent wash.
        "accent.background": hex(p.accent_soft),
        "accent.foreground": hex(p.text),
        "muted.background": hex(p.hover),
        "muted.foreground": hex(p.text_secondary),

        // `primary` is Kit's filled button: Lattice's primary Button, the
        // accent slab with its contrasting ink.
        "primary.background": hex(p.accent),
        "primary.foreground": hex(p.accent_contrast),
        "primary.hover.background": hex(p.primary_hover),
        "primary.active.background": hex(p.primary_pressed),
        // `secondary` is Kit's quiet filled button: the tinted Button.
        "secondary.background": hex(p.tinted),
        "secondary.foreground": hex(p.text),
        "secondary.hover.background": hex(p.tinted_hover),
        "secondary.active.background": hex(p.tinted_pressed),

        "danger.background": hex(p.danger),
        "danger.foreground": hex(p.accent_contrast),
        "success.background": hex(p.success),
        "success.foreground": hex(p.accent_contrast),
        "warning.background": hex(p.warning),
        "warning.foreground": hex(p.accent_contrast),
        "info.background": hex(p.info),
        "info.foreground": hex(p.accent_contrast),

        "input.border": hex(p.field_border),
        "popover.background": hex(p.raised),
        "popover.foreground": hex(p.text),
        "link.foreground": hex(p.accent),
        "link.hover.foreground": hex(p.text),
        "link.active.foreground": hex(p.accent),

        "list.background": hex(p.panel),
        "list.even.background": hex(p.panel),
        "list.head.background": hex(p.panel),
        "list.hover.background": hex(p.hover),
        // A selected row is a fill, never an outline.
        "list.active.background": hex(p.row_selected),
        "list.active.border": hex(transparent_black()),
        "table.background": hex(p.panel),
        "table.even.background": hex(p.panel),
        "table.head.background": hex(p.panel),
        "table.head.foreground": hex(p.text_secondary),
        "table.hover.background": hex(p.hover),
        "table.active.background": hex(p.row_selected),
        "table.active.border": hex(transparent_black()),
        "table.row.border": hex(p.line),

        "tab.background": hex(transparent_black()),
        "tab.foreground": hex(p.text_secondary),
        "tab.active.background": hex(p.tab_selected_on(p.panel_srgb)),
        "tab.active.foreground": hex(p.text),
        "tab_bar.background": hex(transparent_black()),
        "tab_bar.segmented.background": hex(p.hover),

        "title_bar.background": hex(p.titlebar),
        "title_bar.border": hex(p.line),
        "status_bar.background": hex(p.panel),
        "status_bar.border": hex(p.line),
        "sidebar.background": hex(p.chrome),
        "sidebar.foreground": hex(p.text),
        "sidebar.border": hex(p.line),
        "sidebar.accent.background": hex(p.row_selected),
        "sidebar.accent.foreground": hex(p.nav_text_strong),
        "sidebar.primary.background": hex(p.accent),
        "sidebar.primary.foreground": hex(p.accent_contrast),
        "group_box.background": hex(p.raised),
        "group_box.foreground": hex(p.text),
        "accordion.background": hex(p.panel),
        "description_list_label.foreground": hex(p.text_secondary),

        // Lattice's scrollbar: a 12% ink thumb on no track, 16% while held.
        "scrollbar.background": hex(transparent_black()),
        "scrollbar.thumb.background": hex(text_12),
        "scrollbar.thumb.hover.background": hex(text_16),
        "switch.background": hex(p.line_strong),
        "slider.bar.background": hex(p.accent),
        "slider.thumb.background": hex(p.raised),
        "progress_bar.background": hex(p.accent),
        "skeleton.background": hex(p.hover),
    })
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla {
        a: color.a * alpha,
        ..color
    }
}

/// `#RRGGBBAA`, the form Kit's theme files read.
pub(crate) fn hex(color: Hsla) -> String {
    let Rgba { r, g, b, a } = color.into();
    let byte = |channel: f32| (channel.clamp(0., 1.) * 255.).round() as u8;
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        byte(r),
        byte(g),
        byte(b),
        byte(a)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Accent, Tint};

    #[test]
    fn both_appearances_parse_as_kit_themes() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let palette = Palette::new(appearance, Tint::Paper, Accent::Blue);
            let config = config(&palette, &Fonts::open());
            assert_eq!(config.mode.is_dark(), appearance == Appearance::Dark);
            // Kit turns its font size into the window's rem, which every
            // token is measured in; anything else shrinks the whole interface.
            assert_eq!(config.font_size, Some(ROOT_FONT_SIZE));
        }
    }

    #[test]
    fn hex_keeps_the_alpha() {
        let line = Palette::new(Appearance::Light, Tint::Graphite, Accent::Graphite).line;
        // rgb(28 28 31 / 9%): 0.09 × 255 = 22.95.
        assert_eq!(hex(line), "#1c1c1f17");
    }
}
