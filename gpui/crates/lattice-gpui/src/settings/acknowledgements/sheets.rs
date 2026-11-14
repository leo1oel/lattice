//! The sheets Acknowledgements opens over Settings: a package's license
//! texts as the notices reproduce them, or that whole file (`NoticesDialog`),
//! and the Timeless license exactly as it came with the fonts, in the app's
//! own PDF viewer (`FontLicenseDialog`).
//!
//! The whole file is about 1.3 MB, so it is drawn as a list of chunks of
//! lines, only those near the view laid out.

use gpui::{
    AnyElement, App, AppContext as _, Entity, IntoElement, ListAlignment, ListState,
    ParentElement as _, SharedString, Styled as _, Window, div, list, px,
};
use lattice_i18n::{join_phrases, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Sheet as SheetSurface},
};

use super::{
    closure_label, credits,
    notices::{self, Package},
};
use crate::{pdf::PdfView, settings::controls};

/// Lines per drawn chunk of the whole file.
const CHUNK_LINES: usize = 40;

#[derive(Clone)]
pub enum Sheet {
    /// One package's texts, or with none the whole notices file.
    Notices {
        package: Option<Package>,
        list: ListState,
    },
    FontLicense(Entity<PdfView>),
}

/// The whole file in chunks of lines, cut once.
fn chunks() -> &'static [String] {
    static CHUNKS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
        let lines: Vec<&str> = notices::TEXT.lines().collect();
        lines.chunks(CHUNK_LINES).map(|chunk| chunk.join("\n")).collect()
    });
    &CHUNKS
}

impl Sheet {
    pub fn notices(package: Option<Package>, _: &mut Window, _: &mut App) -> Sheet {
        let count = if package.is_some() { 0 } else { chunks().len() };
        Sheet::Notices {
            package,
            list: ListState::new(count, ListAlignment::Top, px(600.)),
        }
    }

    /// The license PDF, written where the viewer can open it; none in a
    /// build without the fonts, or when it could not be written.
    pub fn font_license(window: &mut Window, cx: &mut App) -> Option<Sheet> {
        let bytes = lattice_ui::fonts::font_license()?;
        let path = std::env::temp_dir().join("lattice-gpui-timeless-license.pdf");
        std::fs::write(&path, bytes).ok()?;
        let view = cx.new(|cx| {
            let mut view = PdfView::new(window, cx);
            view.open(path, window, cx);
            view
        });
        Some(Sheet::FontLicense(view))
    }

    /// The sheet's surface; `close` takes it down.
    pub fn render(
        &self,
        close: impl Fn(&mut Window, &mut App) + 'static,
        cx: &mut App,
    ) -> AnyElement {
        match self {
            Sheet::FontLicense(view) => SheetSurface::new("acknowledgements-license", credits::TIMELESS_LICENSE)
                .on_close(close)
                .child(div().flex_1().min_h_0().h(px(560.)).child(view.clone()))
                .into_any_element(),
            Sheet::Notices { package, list: state } => {
                let title: SharedString = match package {
                    Some(package) => format!("{} {}", package.name, package.version).into(),
                    None => t!("Third-party notices").into(),
                };
                let mut sheet = SheetSurface::new("acknowledgements-notices", title).on_close(close);
                match package {
                    None => {
                        let font = cx.lattice().fonts.editor.clone();
                        let palette = cx.palette().clone();
                        sheet = sheet.child(
                            div().h(px(560.)).w_full().child(
                                list(state.clone(), move |ix, _, cx| {
                                    div()
                                        .font_family(font.clone())
                                        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                                        .text_color(palette.text_secondary)
                                        .child(chunks()[ix].clone())
                                        .into_any_element()
                                })
                                .size_full(),
                            ),
                        );
                    }
                    Some(package) => sheet = package_texts(sheet, package, cx),
                }
                sheet.into_any_element()
            }
        }
    }
}

/// A package's license, where it comes from, and the texts that govern it.
fn package_texts(mut sheet: SheetSurface, package: &Package, cx: &mut App) -> SheetSurface {
    let palette = cx.palette().clone();
    let font = cx.lattice().fonts.editor.clone();
    let registry = notices::registry_url(package);
    let host = registry
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_string();
    let license = if package.license.is_empty() {
        t!("No license declared").to_string()
    } else {
        package.license.clone()
    };
    sheet = sheet.child(
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                    .text_color(palette.text_secondary)
                    .child(join_phrases(&[license, closure_label(package.closure).to_string()])),
            )
            .child(
                Button::new("acknowledgements-registry", host)
                    .compact()
                    .ghost()
                    .trailing_icon(Icon::EXTERNAL_LINK)
                    .on_click(move |_, _, cx| cx.open_url(&registry)),
            ),
    );
    let groups = notices::groups_for(notices::shipped(), package);
    if groups.is_empty() {
        sheet = sheet.child(controls::inline_message(
            controls::Level::Warning,
            t!("This package ships no license text of its own"),
            cx,
        ));
    }
    let text = |body: &str, cx: &App| {
        div()
            .mb(px(6.))
            .font_family(font.clone())
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .text_color(palette.text_secondary)
            .child(body.to_string())
    };
    let heading = |label: SharedString, cx: &App| {
        div()
            .mb(px(2.))
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .text_color(palette.text_secondary)
            .child(label)
    };
    for group in groups {
        sheet = sheet.child(
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .mb(px(4.))
                        .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                        .text_color(palette.text)
                        .child(group.title.clone()),
                )
                .child(heading(t!("License text").into(), cx))
                .child(text(&group.text, cx))
                // The generator collects the notices of every package sharing
                // the text in one list, and does not say whose line is whose.
                .children(group.copyrights.as_ref().map(|copyrights| {
                    div()
                        .flex()
                        .flex_col()
                        .child(heading(t!("Copyright notices").into(), cx))
                        .child(text(copyrights, cx))
                })),
        );
    }
    sheet
}
