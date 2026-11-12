//! The Lucide icons the build's surfaces draw, as the Tauri app imports them
//! from `lucide-react`. They are paths into GPUI Kit's Lucide set, except
//! `copy`, whose name Zed's own icon set shadows, so lattice-ui bundles
//! Lucide's file under `lattice/`.

use lattice_ui::Icon;

pub const CIRCLE_X: Icon = Icon("icons/circle-x.svg");
pub const CIRCLE_HELP: Icon = Icon("icons/circle-question-mark.svg");
pub const CIRCLE_CHECK_BIG: Icon = Icon("icons/circle-check-big.svg");
pub const TRIANGLE_ALERT: Icon = Icon("icons/triangle-alert.svg");
pub const X: Icon = Icon("icons/x.svg");
pub const MINUS: Icon = Icon("icons/minus.svg");
pub const CHEVRON_UP: Icon = Icon("icons/chevron-up.svg");
pub const CHEVRON_DOWN: Icon = Icon("icons/chevron-down.svg");
pub const CHEVRON_RIGHT: Icon = Icon("icons/chevron-right.svg");
pub const PANEL_BOTTOM: Icon = Icon("icons/panel-bottom.svg");
pub const PICTURE_IN_PICTURE: Icon = Icon("icons/picture-in-picture-2.svg");
pub const LOADER: Icon = Icon("icons/loader-circle.svg");
pub const REFRESH: Icon = Icon("icons/refresh-cw.svg");
pub const COPY: Icon = Icon("lattice/copy.svg");

#[cfg(test)]
mod tests {
    use gpui::AssetSource as _;

    use super::*;

    #[test]
    fn every_icon_draws_lucides_file() {
        let kit = gpui_kit::assets::AllAssets::new("");
        for (icon, name) in [
            (CIRCLE_X, "circle-x"),
            (CIRCLE_HELP, "circle-question-mark"),
            (CIRCLE_CHECK_BIG, "circle-check-big"),
            (TRIANGLE_ALERT, "triangle-alert"),
            (X, "x"),
            (MINUS, "minus"),
            (CHEVRON_UP, "chevron-up"),
            (CHEVRON_DOWN, "chevron-down"),
            (CHEVRON_RIGHT, "chevron-right"),
            (PANEL_BOTTOM, "panel-bottom"),
            (PICTURE_IN_PICTURE, "picture-in-picture-2"),
            (LOADER, "loader-circle"),
            (REFRESH, "refresh-cw"),
            (COPY, "copy"),
        ] {
            let lucide = format!("icons/{name}.svg");
            let expected = kit.load(&lucide).unwrap().expect(&lucide);
            let loaded = crate::assets::Assets.load(icon.0).unwrap().expect(icon.0);
            assert!(
                loaded == expected,
                "{} does not draw Lucide's {name}.svg",
                icon.0
            );
        }
    }
}
