//! The TeX doctor's report as Settings › TeX doctor shows it in the Tauri
//! app (`src/settings/doctor-settings.tsx`, `src/build/tex-doctor-messages.ts`):
//! a verdict, then one tile per check, the ones that failed across the full
//! width with what is wrong, and the install when something required is
//! missing.

use gpui::{AnyElement, App, Hsla, IntoElement, ParentElement as _, Styled as _, div, px};
use lattice_core::doctor::{DoctorCheck, DoctorReport};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, tokens::FONT_WEIGHT_SEMIBOLD};

use lattice_i18n::t;

use super::icons;

/// The row title of a check: a tool's own name, or what the check verifies.
pub fn check_label(name: &str) -> &str {
    match name {
        "project-root" => t!("Root document"),
        "bibliography" => t!("Bibliography"),
        "latexmk-version" => t!("latexmk version"),
        "conference-fonts" => t!("Conference fonts"),
        "icml-packages" => t!("ICML packages"),
        "neurips-packages" => t!("NeurIPS packages"),
        "pdf-embedded-fonts" => t!("PDF embedded fonts"),
        name => name,
    }
}

/// What each tool the doctor probes is for, by check name (doctor.rs).
fn tool_description(name: &str) -> Option<&'static str> {
    Some(match name {
        "latexmk" => t!("LaTeX build driver"),
        "pdflatex" => t!("pdfLaTeX engine"),
        "xelatex" => t!("XeLaTeX engine"),
        "lualatex" => t!("LuaLaTeX engine"),
        "synctex" => t!("SyncTeX bidirectional search"),
        "bibtex" => t!("BibTeX bibliography processor"),
        "biber" => t!("Biber bibliography processor"),
        "texlab" => t!("TexLab language server (optional editor diagnostics)"),
        "git" => t!("Git (optional project status / commit panel)"),
        "texcount" => t!("TeXcount body word counts (optional status bar)"),
        "uv" => t!("Python tooling used for literature and bibliography tools"),
        "uvx" => t!("Runner used for Lattice's pinned literature tools"),
        _ => return None,
    })
}

fn missing_files_text(name: &str, files: &str) -> Option<String> {
    Some(match name {
        "conference-fonts" => t!(
            "Missing {files} — PDF text will look wrong even if .tfm exists. Click Install BasicTeX in Lattice (watch Terminal for FONTS OK), then Shift-click Build.",
            files = files
        ),
        "icml-packages" => t!(
            "Missing {files} — ICML Build will Emergency stop. In Terminal: sudo tlmgr install algorithms   (or click Install BasicTeX in Lattice).",
            files = files
        ),
        "neurips-packages" => t!(
            "Missing {files} — NeurIPS Build will Emergency stop. In Terminal: sudo tlmgr install collection-latexextra   (or click Install BasicTeX in Lattice).",
            files = files
        ),
        _ => return None,
    })
}

fn kpsewhich_missing_text(name: &str) -> Option<&'static str> {
    Some(match name {
        "conference-fonts" => {
            t!("Cannot verify fonts (kpsewhich missing). Install BasicTeX from Lattice.")
        }
        "icml-packages" => {
            t!("Cannot verify ICML packages (kpsewhich missing). Install BasicTeX from Lattice.")
        }
        "neurips-packages" => {
            t!("Cannot verify NeurIPS packages (kpsewhich missing). Install BasicTeX from Lattice.")
        }
        _ => return None,
    })
}

/// A conference PDF typeset in the wrong fonts and what replaced Times
/// (`pdfFontsText` in the Tauri app's `build-log-messages.ts`).
fn pdf_fonts_text(venue: &str, fonts: &str, cause: &str) -> String {
    let problem = if fonts.is_empty() {
        t!(
            "PDF fonts are not the Times that {venue} requires.",
            venue = venue
        )
    } else {
        t!(
            "PDF fonts are not the Times that {venue} requires ({fonts}).",
            venue = venue,
            fonts = fonts
        )
    };
    // The LaTeX goes in as a value: its braces would read as placeholders.
    let fix = match cause {
        "lmodern" => t!(
            "The document loads lmodern after Times, which replaces it with Latin Modern: remove {command}, then Build.",
            command = "\\usepackage{lmodern}"
        ),
        "fontspec" => t!(
            "The document loads fontspec, which makes Latin Modern the main font: add {command} after it, or build with pdfLaTeX.",
            command = "\\setmainfont{Times New Roman}"
        ),
        "unicode-encoding" => t!(
            "XeLaTeX and LuaLaTeX have no Times in their default encoding, so LaTeX fell back to Latin Modern: add {command} after the template, or build with pdfLaTeX.",
            command = "\\usepackage[T1]{fontenc}"
        ),
        "fonts-missing" => t!(
            "Times is not installed, so LaTeX fell back to Computer Modern: click Install required tools in the TeX doctor, then Shift-click Build."
        )
        .to_string(),
        "not-loaded" => t!(
            "The document never loads Times: add {command} after the template, then Build.",
            command = "\\usepackage{times}"
        ),
        _ => t!("Expected NimbusRomNo9L-*.").to_string(),
    };
    format!("{problem} {fix}")
}

/// A check's detail in the interface language, from its code and values as
/// the Tauri app words it (`doctorCheckDetail`); an uncoded detail stays as
/// the doctor wrote it.
pub fn check_detail(check: &DoctorCheck) -> String {
    let param = |name: &str| check.params.get(name).map_or("", String::as_str);
    let description = tool_description(&check.name);
    let coded = match check.code {
        Some("tool-not-found") => description.map(|description| {
            t!(
                "{description}: not found on PATH",
                description = description
            )
        }),
        Some("tool-failed") => description.map(|description| {
            t!(
                "{description}: {path} could not run: {error}",
                description = description,
                path = param("path"),
                error = param("error")
            )
        }),
        Some("managed-tool-failed") => description.map(|description| {
            t!(
                "{description}: {error}",
                description = description,
                error = param("error")
            )
        }),
        Some("root-document-missing") => Some(t!(
            "Project {project}, engine {engine}, root {document} (missing)",
            project = param("project"),
            engine = param("engine"),
            document = param("document")
        )),
        Some("bibliography-missing") => Some(t!(
            "Primary bibliography {file} (missing)",
            file = param("file")
        )),
        Some("kpsewhich-missing") => kpsewhich_missing_text(&check.name).map(str::to_string),
        Some("files-missing") => missing_files_text(&check.name, param("files")),
        Some("pdf-fonts-not-times") => Some(pdf_fonts_text(
            param("venue"),
            param("fonts"),
            param("cause"),
        )),
        Some("pdf-unreadable") => Some(t!(
            "Could not read {path}: {error}",
            path = param("path"),
            error = param("error")
        )),
        _ => None,
    };
    coded.unwrap_or_else(|| check.detail.clone())
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

/// How a tile in the checklist reads.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TileState {
    Ready,
    /// Something to act on that does not stop a build (package updates).
    Warn,
    Unavailable,
}

/// One check: its state, its name and, for one that is not ready, what is
/// wrong (and what to do).
pub struct Tile {
    pub state: TileState,
    pub label: String,
    pub details: Vec<String>,
}

impl Tile {
    fn of(check: &DoctorCheck) -> Self {
        let state = if check.ok {
            TileState::Ready
        } else {
            TileState::Unavailable
        };
        Self {
            state,
            label: check_label(&check.name).to_string(),
            details: (!check.ok)
                .then(|| check_detail(check))
                .into_iter()
                .collect(),
        }
    }
}

fn tile(tile: Tile, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let (icon, ink, border, ground) = match tile.state {
        TileState::Ready => (
            icons::CIRCLE_CHECK_BIG,
            palette.success,
            palette.line,
            palette.window,
        ),
        // The hairline is a translucent ink: the hue is laid over it.
        TileState::Warn => (
            icons::CIRCLE_ALERT,
            palette.warning,
            palette.warning.opacity(0.26),
            mix(palette.warning, 0.06, palette.window),
        ),
        TileState::Unavailable => (
            icons::CIRCLE_X,
            palette.danger,
            palette.danger.opacity(0.22),
            mix(palette.danger, 0.05, palette.window),
        ),
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
        .child(div().pt(px(1.)).child(icon.element(px(15.), ink)))
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
                        .child(tile.label),
                )
                .children(tile.details.into_iter().map(|detail| {
                    div()
                        .text_role(TextRole::Caption, cx)
                        .line_height(px(16.8))
                        .text_color(palette.text_secondary)
                        .child(detail)
                })),
        )
        .into_any_element()
}

/// The verdict and the tiles, `extra` (the package-update check) last;
/// `actions` go under them: the install when a required tool is missing,
/// the package update.
pub fn report_view(
    report: &DoctorReport,
    extra: Option<Tile>,
    actions: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let (ink, wash, verdict) = if report.ok {
        (
            palette.success,
            mix(palette.success, 0.14, palette.window),
            t!("Ready to compile"),
        )
    } else {
        (
            palette.danger,
            mix(palette.danger, 0.12, palette.window),
            t!("Missing required tools"),
        )
    };
    // The checklist's grid: two columns at the sheet's width (170px at the
    // least, as Settings lays them), a check that is not ready taking a row
    // of its own and the ones after it starting the next.
    let mut rows: Vec<Vec<AnyElement>> = Vec::new();
    let mut row: Vec<AnyElement> = Vec::new();
    for item in report.checks.iter().map(Tile::of).chain(extra) {
        if item.state != TileState::Ready {
            if !row.is_empty() {
                rows.push(std::mem::take(&mut row));
            }
            rows.push(vec![tile(item, cx)]);
            continue;
        }
        row.push(tile(item, cx));
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
        .children(actions)
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
                .child(t!("Not checked yet")),
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
