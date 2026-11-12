//! The TeX doctor's report as Settings › TeX doctor shows it in the Tauri
//! app (`src/settings/doctor-settings.tsx`, `src/build/tex-doctor-messages.ts`):
//! a verdict, then one tile per check, the ones that failed across the full
//! width with what is wrong, and the install when something required is
//! missing.

use gpui::{
    AnyElement, App, Hsla, IntoElement, ParentElement as _, Styled as _, div, prelude::*, px,
};
use lattice_core::doctor::{DoctorCheck, DoctorReport};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, tokens::FONT_WEIGHT_SEMIBOLD};

use super::icons;

/// The row title of a check: a tool's own name, or what the check verifies.
pub fn check_label(name: &str) -> &str {
    match name {
        "project-root" => "Root document",
        "bibliography" => "Bibliography",
        "latexmk-version" => "latexmk version",
        "conference-fonts" => "Conference fonts",
        "icml-packages" => "ICML packages",
        "neurips-packages" => "NeurIPS packages",
        "pdf-embedded-fonts" => "PDF embedded fonts",
        name => name,
    }
}

/// A check's detail as the interface words it. The doctor writes its
/// details in the interface's English already, except the root document's,
/// which the Tauri app lists with commas.
pub fn check_detail(check: &DoctorCheck) -> String {
    if check.code == Some("root-document-missing") {
        let param = |name: &str| check.params.get(name).map_or("", String::as_str);
        return format!(
            "Project {}, engine {}, root {} (missing)",
            param("project"),
            param("engine"),
            param("document")
        );
    }
    check.detail.clone()
}

fn mix(color: Hsla, amount: f32, ground: Hsla) -> Hsla {
    // `color-mix(in srgb, color amount%, ground)`, close enough in HSL for a wash.
    let rgb = |c: Hsla| c.to_rgb();
    let (a, b) = (rgb(color), rgb(ground));
    gpui::Rgba {
        r: a.r * amount + b.r * (1. - amount),
        g: a.g * amount + b.g * (1. - amount),
        b: a.b * amount + b.b * (1. - amount),
        a: 1.,
    }
    .into()
}

/// The verdict and the tiles; `install` is the button offered when a
/// required tool is missing.
pub fn report_view(report: &DoctorReport, install: Option<AnyElement>, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let (ink, wash, verdict) = if report.ok {
        (
            palette.success,
            mix(palette.success, 0.14, palette.window),
            "Ready to compile",
        )
    } else {
        (
            palette.danger,
            mix(palette.danger, 0.12, palette.window),
            "Missing required tools",
        )
    };
    let tile = |check: &DoctorCheck| {
        let bad = !check.ok;
        let (icon, icon_ink) = if bad {
            (icons::CIRCLE_X, palette.danger)
        } else {
            (icons::CIRCLE_CHECK_BIG, palette.success)
        };
        let border = if bad {
            mix(palette.danger, 0.22, palette.line)
        } else {
            palette.line
        };
        let ground = if bad {
            mix(palette.danger, 0.05, palette.window)
        } else {
            palette.window
        };
        div()
            .flex()
            .gap(px(6.))
            .min_h(px(32.))
            .py(px(6.))
            .px(px(8.))
            .border_1()
            .border_color(border)
            .rounded(px(6.))
            .bg(ground)
            .flex_1()
            .min_w_0()
            .child(div().pt(px(1.)).child(icon.element(px(15.), icon_ink)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .flex_1()
                    .gap(px(2.))
                    .child(
                        div()
                            .truncate()
                            .text_role(TextRole::Caption, cx)
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .text_color(palette.text)
                            .child(check_label(&check.name).to_string()),
                    )
                    .when(bad, |tile| {
                        tile.child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .line_height(px(16.8))
                                .text_color(palette.text_secondary)
                                .child(check_detail(check)),
                        )
                    }),
            )
            .into_any_element()
    };
    // The checklist's grid: two columns at the sheet's width (170px at the
    // least, as Settings lays them), a check that failed taking a row of
    // its own and the ones after it starting the next.
    let mut rows: Vec<Vec<AnyElement>> = Vec::new();
    let mut row: Vec<AnyElement> = Vec::new();
    for check in &report.checks {
        if !check.ok {
            if !row.is_empty() {
                rows.push(std::mem::take(&mut row));
            }
            rows.push(vec![tile(check)]);
            continue;
        }
        row.push(tile(check));
        if row.len() == 2 {
            rows.push(std::mem::take(&mut row));
        }
    }
    if !row.is_empty() {
        row.push(div().flex_1().into_any_element());
        rows.push(row);
    }
    let tiles = rows
        .into_iter()
        .map(|row| div().flex().gap(px(6.)).children(row));
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .py(px(8.))
                .px(px(10.))
                .rounded(px(6.))
                .bg(wash)
                .text_role(TextRole::BodyCompact, cx)
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .text_color(ink)
                .child(verdict),
        )
        .child(div().flex().flex_col().gap(px(6.)).children(tiles))
        .children(install)
        .into_any_element()
}

/// "Not checked yet", before the first report.
pub fn not_checked(install: AnyElement, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child("Not checked yet"),
        )
        .child(install)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_named_for_what_they_verify_read_as_such() {
        assert_eq!(check_label("conference-fonts"), "Conference fonts");
        assert_eq!(check_label("latexmk"), "latexmk");
    }

    #[test]
    fn a_missing_root_document_is_listed_with_commas() {
        let check = DoctorCheck {
            name: "project-root".into(),
            detail: "Project /p · engine pdf · root main.tex (missing)".into(),
            ok: false,
            code: Some("root-document-missing"),
            params: [
                ("project", "/p".to_string()),
                ("engine", "pdf".to_string()),
                ("document", "main.tex".to_string()),
            ]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            check_detail(&check),
            "Project /p, engine pdf, root main.tex (missing)"
        );
    }
}
