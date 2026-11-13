//! The expected colours below are worked values from the app: what
//! `codeThemeProperties` (`src/settings/code-themes.ts`) returns for each
//! case, so they hold the Zed themes to the app rather than to this crate's
//! own arithmetic.

use super::*;

/// The Zed theme's style for `theme` in a Graphite app.
fn style_of(theme: CodeTheme, appearance: Appearance) -> Value {
    let palette = Palette::new(appearance, Tint::Graphite, Accent::Graphite);
    zed_theme(theme, &palette)["style"].clone()
}

#[test]
fn the_themes_are_the_apps_in_its_order() {
    let json: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../design-system/code-themes.json"
    )))
    .unwrap();
    let order: Vec<&str> = json["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    let ids: Vec<&str> = CodeTheme::ALL.iter().map(|theme| theme.id()).collect();
    assert_eq!(ids, order);
    for theme in json["themes"].as_array().unwrap() {
        let id = theme["id"].as_str().unwrap();
        let ours = CodeTheme::ALL
            .into_iter()
            .find(|ours| ours.id() == id)
            .unwrap();
        assert_eq!(ours.label(), theme["name"].as_str().unwrap());
    }
    assert_eq!(CodeTheme::WeftAndWarp.label(), "Weft & Warp");
}

#[test]
fn every_theme_has_a_family_with_both_appearances() {
    let families = zed_theme_families(Tint::Graphite, Accent::Graphite);
    assert_eq!(families.len(), CodeTheme::ALL.len());
    for (theme, family) in CodeTheme::ALL.into_iter().zip(&families) {
        let family: Value = serde_json::from_slice(family).unwrap();
        assert_eq!(family["name"], format!("Lattice {}", theme.label()));
        let themes = family["themes"].as_array().unwrap();
        let named: Vec<(&str, &str)> = themes
            .iter()
            .map(|theme| {
                (
                    theme["name"].as_str().unwrap(),
                    theme["appearance"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            named,
            [
                (theme.zed_theme_name(Appearance::Light).as_str(), "light"),
                (theme.zed_theme_name(Appearance::Dark).as_str(), "dark"),
            ]
        );
    }
}

#[test]
fn github_draws_on_the_lattice_sheet_with_its_own_selection_and_line() {
    let palette = Palette::new(Appearance::Light, Tint::Sage, Accent::Graphite);
    let style = &zed_theme(CodeTheme::Github, &palette)["style"];
    assert_eq!(
        hex(ground(CodeTheme::Github, &palette)),
        hex(palette.editor)
    );
    // Zed's editor is clear: the adapter paints the ground and the line.
    assert_eq!(style["editor.background"], "#00000000");
    assert_eq!(style["editor.gutter.background"], "#00000000");
    assert_eq!(style["editor.active_line.background"], "#00000000");
    // #0969da33, and GitHub's ink at 5% (0.05 × 255 rounds to 0x0d).
    assert_eq!(style["players"][0]["selection"], "#0969da33");
    assert_eq!(hex(current_line(CodeTheme::Github, &palette)), "#1f23280d");
    assert_eq!(style["players"][0]["cursor"], "#0969daff");
    assert_eq!(style["editor.line_number"], "#89929cff");
    assert_eq!(style["syntax"]["keyword"]["color"], "#cf222eff");
    // #8250df, fitted to 4.5:1 on every light tint's editor ground.
    assert_eq!(style["syntax"]["function"]["color"], "#804ddcff");
    // Markdown's headings take the function colour at 600, its marks the
    // keyword colour at the text's weight (`markdownHighlightStyle`).
    assert_eq!(style["syntax"]["markup.heading"]["color"], "#804ddcff");
    assert_eq!(style["syntax"]["markup.heading"]["font_weight"], 600);
    assert_eq!(style["syntax"]["markup.meta"]["color"], "#cf222eff");
    assert_eq!(style["syntax"]["markup.meta"]["font_weight"], Value::Null);
    assert_eq!(style["syntax"]["markup.quote"]["font_style"], "italic");

    let dark = style_of(CodeTheme::Github, Appearance::Dark);
    assert_eq!(dark["players"][0]["selection"], "#388bfd33");
    let dark_palette = Palette::new(Appearance::Dark, Tint::Sage, Accent::Graphite);
    assert_eq!(
        hex(current_line(CodeTheme::Github, &dark_palette)),
        "#e6edf30d"
    );
}

#[test]
fn a_selection_keeps_its_alpha_to_the_byte() {
    // Catppuccin Latte's #7c7f9340: 25.1% in the app's color-mix().
    let latte = style_of(CodeTheme::Catppuccin, Appearance::Light);
    assert_eq!(latte["players"][0]["selection"], "#7c7f9340");
    // An opaque selection on the window is the colour at full strength.
    let one = style_of(CodeTheme::One, Appearance::Light);
    assert_eq!(one["players"][0]["selection"], "#e5e5e6ff");
}

#[test]
fn a_dark_only_theme_keeps_its_own_ground_in_a_light_app() {
    let palette = Palette::new(Appearance::Light, Tint::Paper, Accent::Graphite);
    let theme = zed_theme(CodeTheme::Dracula, &palette);
    let style = &theme["style"];
    assert_eq!(theme["appearance"], "light");
    assert_eq!(hex(ground(CodeTheme::Dracula, &palette)), "#282a36ff");
    assert_eq!(hex(current_line(CodeTheme::Dracula, &palette)), "#32343fff");
    assert_eq!(style["players"][0]["selection"], "#44475aff");
    // Fitted on Dracula's own ground and line only: #6272a4 lightened.
    assert_eq!(style["syntax"]["comment"]["color"], "#899bcfff");
    // The chrome around the buffer stays the light app's.
    assert_eq!(style["toolbar.background"], hex(palette.editor));
    // The washes over the buffer are the dark palette's.
    let dark = Palette::new(Appearance::Dark, Tint::Paper, Accent::Graphite);
    assert_eq!(style["editor.indent_guide"], hex(dark.line));
}

#[test]
fn a_dark_only_theme_stands_on_the_window_in_a_dark_app() {
    let palette = Palette::new(Appearance::Dark, Tint::Mist, Accent::Graphite);
    let style = &zed_theme(CodeTheme::Dracula, &palette)["style"];
    assert_eq!(
        hex(ground(CodeTheme::Dracula, &palette)),
        hex(palette.editor)
    );
    assert_eq!(hex(current_line(CodeTheme::Dracula, &palette)), "#f8f8f20d");
    // Fitted on all five dark tints' grounds and lines at once.
    assert_eq!(style["syntax"]["comment"]["color"], "#7e8fc3ff");

    let nord = style_of(CodeTheme::Nord, Appearance::Light);
    let light = Palette::new(Appearance::Light, Tint::Mist, Accent::Graphite);
    assert_eq!(hex(ground(CodeTheme::Nord, &light)), "#2e3440ff");
    assert_eq!(nord["syntax"]["keyword"]["color"], "#89aacaff");
}

#[test]
fn the_roles_beyond_the_ten_have_their_own_colours() {
    // Catppuccin Latte: maths delimiters pink, keys lavender, apart from the
    // teal variables (#179299, #ea76cb and #7287fd, each fitted).
    let latte = &style_of(CodeTheme::Catppuccin, Appearance::Light)["syntax"];
    assert_eq!(latte["variable"]["color"], "#097a80ff");
    assert_eq!(latte["variable.special"]["color"], "#b24297ff");
    assert_eq!(latte["property"]["color"], "#5363d5ff");
}

#[test]
fn weft_and_warp_keeps_the_lattice_palette() {
    for appearance in [Appearance::Light, Appearance::Dark] {
        let palette = Palette::new(appearance, Tint::Dusk, Accent::Blue);
        let style = &zed_theme(CodeTheme::WeftAndWarp, &palette)["style"];
        assert_eq!(
            hex(ground(CodeTheme::WeftAndWarp, &palette)),
            hex(palette.editor)
        );
        assert_eq!(style["players"][0]["selection"], hex(palette.selection));
        assert_eq!(
            hex(current_line(CodeTheme::WeftAndWarp, &palette)),
            hex(palette.current_line)
        );
        assert_eq!(
            style["syntax"]["keyword"]["color"],
            hex(COLOR_SYNTAX_KEYWORD.hsla(appearance))
        );
    }
}
