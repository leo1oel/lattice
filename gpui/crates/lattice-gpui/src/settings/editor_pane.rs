//! Settings › Editor & builds (`EditorSettingsPane` in settings-dialog.tsx)
//! and Settings › TeX doctor (`doctor-settings.tsx`).
//!
//! The editor's keymap, the name that signs comments, spell checking and
//! the project's dictionary; the automatic build, cleaning the auxiliary
//! files and, with a project open, its engine, shell escape and whether a
//! build stops at the first error (written to the project's manifest, as the
//! Tauri app writes them); and the app's version. Spell checking itself and
//! the grammar settings arrive with the editor's spelling and grammar.

use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, IntoElement, ParentElement as _, Styled as _,
    Window, div, px,
};
use lattice_core::project::{self, ManifestSettings};
use lattice_i18n::t;
use lattice_settings::{AutoBuildMode, EditorKeymap};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field},
};

use super::{
    controls::{self, PageWidth, Row, Wrap},
    dialog::SettingsDialog,
};
use crate::project::Project;

/// Where every release is published.
const LATEST_RELEASE_URL: &str = "https://github.com/leo1oel/lattice/releases/latest";

fn row(dialog: &SettingsDialog, row: Row, width: PageWidth, cx: &App) -> AnyElement {
    let id = row.id;
    div()
        .relative()
        .child(dialog.measure(id))
        .child(row.revealed(dialog.revealed(id)).render(width, cx))
        .into_any_element()
}

/// Replace the project's dictionary, through lattice-core's manifest.
pub fn set_spelling_words(project: &Entity<Project>, words: Vec<String>, cx: &mut App) {
    let root = project.read(cx).root().to_path_buf();
    match project::set_spelling_words(&root, words) {
        Ok(_) => project.update(cx, |project, cx| project.reload_manifest(cx)),
        Err(error) => crate::notices::error(t!("Could not save the setting"), error, cx),
    }
}

/// Change the project's build settings, through lattice-core's manifest.
fn update_manifest(project: &Entity<Project>, settings: ManifestSettings, cx: &mut App) {
    let root = project.read(cx).root().to_path_buf();
    match project::update_manifest_settings(&root, settings) {
        Ok(_) => project.update(cx, |project, cx| project.reload_manifest(cx)),
        Err(error) => crate::notices::error(t!("Could not save the setting"), error, cx),
    }
}

pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let groups = vec![
        editor(dialog, width, window, cx),
        builds(dialog, width, cx),
        updates(dialog, width, cx),
    ];
    controls::page(t!("Editor & builds"), width, groups, cx)
}

fn editor(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    _window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let settings = super::get(cx).clone();
    let palette = cx.palette().clone();
    let keymap = controls::select(
        "editor-keymap",
        vec![
            (EditorKeymap::Default, t!("Default").into()),
            (EditorKeymap::Vim, "Vim".into()),
            (EditorKeymap::Emacs, "Emacs".into()),
        ],
        settings.appearance.editor_keymap,
        |keymap, _, cx| super::update_appearance(cx, |a| a.editor_keymap = keymap),
    );
    let spellcheck = controls::switch(
        "spellcheck",
        settings.appearance.editor_spellcheck,
        false,
        |on, _, cx| super::update_appearance(cx, |a| a.editor_spellcheck = on),
    );
    let project = dialog.project.clone();
    let words = project
        .as_ref()
        .map(|project| project.read(cx).manifest().spelling_words.clone())
        .unwrap_or_default();
    let draft = dialog
        .fields
        .project_word
        .read(cx)
        .value()
        .trim()
        .to_string();
    let this = cx.entity();
    let add = Button::new("project-dictionary-add", t!("Add"))
        .disabled(project.is_none() || draft.is_empty())
        .on_click(move |_: &ClickEvent, window, cx| {
            this.update(cx, |dialog, cx| dialog.add_project_word_clicked(window, cx))
        });
    let terms = (!words.is_empty()).then(|| {
        div()
            .flex()
            .flex_wrap()
            .gap(px(4.))
            .children(words.iter().map(|word| {
                let project = project.clone();
                let remove = word.clone();
                let others: Vec<String> = words.iter().filter(|w| **w != remove).cloned().collect();
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .h(px(24.))
                    .pl(px(8.))
                    .pr(px(2.))
                    .rounded(px(6.))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.line)
                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                    .text_color(palette.text)
                    .child(word.clone())
                    .child(
                        lattice_ui::components::IconButton::new(
                            gpui::ElementId::Name(format!("project-word-remove-{word}").into()),
                            lattice_ui::Icon::X,
                        )
                        .frame(px(20.), px(20.))
                        .icon_size(px(10.))
                        .tooltip(t!("Remove {word} from project dictionary", word = word))
                        .on_click(move |_, _, cx| {
                            if let Some(project) = &project {
                                set_spelling_words(project, others.clone(), cx);
                            }
                        }),
                    )
            }))
    });
    let dictionary = div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .w(controls::CONTROL_WIDTH)
        .max_w_full()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Field::new(&dialog.fields.project_word).disabled(project.is_none())),
                )
                .child(add),
        )
        .children(terms);
    let mut dictionary_row =
        Row::new("project-dictionary", t!("Project dictionary")).control(dictionary);
    if project.is_none() {
        dictionary_row = dictionary_row.description(t!("Open a project to add terms"), cx);
    }
    let name = div()
        .w(controls::CONTROL_WIDTH)
        .child(Field::new(&dialog.fields.author_name));
    let rows = vec![
        row(
            dialog,
            Row::new("editor-keymap", t!("Editor keymap")).control(keymap),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("author-name", t!("Your name")).control(name),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("spellcheck", t!("Check spelling"))
                .control(spellcheck)
                .wrap(Wrap::Never),
            width,
            cx,
        ),
        row(dialog, dictionary_row, width, cx),
    ];
    controls::first_group(Some(t!("Editor").into()), rows, cx)
}

fn builds(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let settings = super::get(cx).clone();
    let auto = controls::select(
        "auto-build",
        vec![
            (AutoBuildMode::Manual, t!("Manual only").into()),
            (AutoBuildMode::Automatic, t!("Automatic").into()),
        ],
        settings.auto_build_mode,
        |mode, _, cx| super::update(cx, |settings| settings.auto_build_mode = mode),
    );
    let (cleaning, building) = dialog.busy(cx);
    let has_project = dialog.project.is_some();
    let this = cx.entity();
    let clean = Button::new(
        "aux-files-clean",
        if cleaning {
            t!("Cleaning…")
        } else {
            t!("Clean")
        },
    )
    .compact()
    .disabled(!has_project || cleaning || building)
    .on_click(move |_, _, cx| this.update(cx, |dialog, cx| dialog.clean(cx)));
    let mut rows = vec![
        row(
            dialog,
            Row::new("auto-build", t!("Automatic build")).control(auto),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("aux-files", t!("Auxiliary files")).control(
                div()
                    .w(controls::CONTROL_WIDTH)
                    .flex()
                    .justify_end()
                    .child(clean),
            ),
            width,
            cx,
        ),
        // Takes effect at the next build, which moves each document's files
        // (lattice-core's `latex::AuxFiles`).
        row(
            dialog,
            Row::new("hidden-build-files", t!("Hide auxiliary files"))
                .control(controls::switch(
                    "hidden-build-files",
                    settings.hidden_build_files,
                    false,
                    |on, _, cx| super::update(cx, |settings| settings.hidden_build_files = on),
                ))
                .description(t!("Keep .aux, .log, SyncTeX and other build files in the project’s hidden .research/build folder. The PDF stays beside the document. A document that fails there because a package ignores TeX’s output directory, such as minted 2.x, builds beside itself instead."), cx),
            width,
            cx,
        ),
    ];
    if let Some(project) = dialog.project.clone() {
        let manifest = project.read(cx).manifest().clone();
        let engine_project = project.clone();
        let engine = controls::select(
            "compile-engine",
            vec![
                ("pdf", "pdfLaTeX".into()),
                ("xelatex", "XeLaTeX".into()),
                ("lualatex", "LuaLaTeX".into()),
            ],
            match manifest.engine.as_str() {
                "xelatex" => "xelatex",
                "lualatex" => "lualatex",
                _ => "pdf",
            },
            move |engine, _, cx| {
                update_manifest(
                    &engine_project,
                    ManifestSettings {
                        engine: Some(engine.to_owned()),
                        ..ManifestSettings::default()
                    },
                    cx,
                )
            },
        );
        let trusted_project = project.clone();
        let shell_escape =
            controls::switch("shell-escape", manifest.trusted, false, move |on, _, cx| {
                update_manifest(
                    &trusted_project,
                    ManifestSettings {
                        trusted: Some(on),
                        ..ManifestSettings::default()
                    },
                    cx,
                )
            });
        let halt_project = project.clone();
        // Off, TeX carries on past errors as Overleaf does: every error is
        // listed and the pages that typeset reach the PDF.
        let halt = controls::switch(
            "stop-on-first-error",
            manifest.stop_on_first_error,
            false,
            move |on, _, cx| {
                update_manifest(
                    &halt_project,
                    ManifestSettings {
                        stop_on_first_error: Some(on),
                        ..ManifestSettings::default()
                    },
                    cx,
                )
            },
        );
        rows.push(row(
            dialog,
            Row::new("compile-engine", t!("Compile engine"))
                .description(t!("A project latexmkrc overrides this"), cx)
                .control(engine),
            width,
            cx,
        ));
        rows.push(row(
            dialog,
            Row::new("shell-escape", t!("Allow shell escape"))
                .control(shell_escape)
                .wrap(Wrap::Never),
            width,
            cx,
        ));
        rows.push(row(
            dialog,
            Row::new("stop-on-first-error", t!("Stop on first error"))
                .control(halt)
                .wrap(Wrap::Never),
            width,
            cx,
        ));
        if let Some(live) = dialog.live_preview() {
            rows.extend(live_preview_rows(dialog, &live, width, cx));
        }
    }
    controls::group(Some(t!("Builds").into()), rows, cx)
}

/// The LuaLaTeX live preview switch, for a LuaLaTeX project only, and
/// removing the rtex it downloaded (`live-preview-settings.tsx`). It is on
/// by default, so this is also where a Mac that cannot run it, or a download
/// that failed, is explained: the PDF panel shows neither.
fn live_preview_rows(
    dialog: &SettingsDialog,
    live: &Entity<crate::live_preview::LivePreview>,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> Vec<AnyElement> {
    use crate::live_preview::State;
    let preview = live.read(cx);
    let install = preview.install_status();
    let unavailable = match install {
        Some(install) if !install.supported() => Some(t!("Live preview needs a Mac").to_string()),
        Some(install) if !install.lualatex() => Some(
            t!("Live preview needs LuaLaTeX, and Lattice could not run it. Install TeX Live or BasicTeX, then open the project again")
                .to_string(),
        ),
        _ => None,
    };
    let state = preview.state().clone();
    let message = match &state {
        State::Failed(message) | State::DownloadFailed(message) => message.clone(),
        _ => String::new(),
    };
    // Only state: why it cannot run, its download, a failure. The first
    // download's size is told where it starts (the PDF's pill).
    let description = unavailable.clone().or_else(|| match &state {
        State::Downloading(progress) => Some(
            t!(
                "Downloading rtex… {percent}%",
                percent = (progress * 100.).round() as u32
            )
            .to_string(),
        ),
        State::Failed(_) => {
            Some(t!("Could not start: {message}", message = message.clone()).to_string())
        }
        _ => None,
    });
    let mut rows = Vec::new();
    if preview.available() {
        let switch_live = live.clone();
        let mut switch_row = Row::new("live-preview", t!("Live preview"))
            .control(controls::switch(
                "live-preview",
                preview.enabled() && unavailable.is_none(),
                unavailable.is_some(),
                move |on, _, cx| switch_live.update(cx, |live, cx| live.set_enabled(on, cx)),
            ))
            .wrap(Wrap::Never);
        if let Some(description) = description {
            switch_row = switch_row.description(description, cx);
        }
        rows.push(row(dialog, switch_row, width, cx));
        if let State::DownloadFailed(_) = &state {
            let retry_live = live.clone();
            let retry = Button::new("live-preview-retry", t!("Retry"))
                .compact()
                .on_click(move |_, _, cx| retry_live.update(cx, |live, cx| live.retry(cx)));
            rows.push(row(
                dialog,
                Row::new("live-preview-engine", t!("Live preview engine"))
                    .description(message.clone(), cx)
                    .control(retry),
                width,
                cx,
            ));
        }
    }
    if let Some(install) = install.filter(|install| install.installed()) {
        let removing = preview.removing();
        let description = preview.remove_error().map(str::to_string).unwrap_or_else(|| {
            t!(
                "rtex {version} is downloaded. Removing it turns live preview off in every project.",
                version = install.version()
            )
            .to_string()
        });
        let remove_live = live.clone();
        let remove = Button::new(
            "live-preview-remove",
            if removing {
                t!("Removing…")
            } else {
                t!("Remove")
            },
        )
        .compact()
        .disabled(removing)
        .on_click(move |_, _, cx| remove_live.update(cx, |live, cx| live.remove(cx)));
        rows.push(row(
            dialog,
            Row::new("live-preview-engine", t!("Live preview engine"))
                .description(description, cx)
                .control(remove),
            width,
            cx,
        ));
    }
    rows
}

fn updates(
    dialog: &SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    // The GPUI preview does not update itself yet; each release is on
    // GitHub, as the Tauri app says where it cannot update itself.
    let releases = Button::new("github-releases", t!("GitHub Releases"))
        .ghost()
        .compact()
        .icon(lattice_ui::Icon::ARROW_RIGHT)
        .on_click(|_, _, cx| cx.open_url(LATEST_RELEASE_URL));
    let rows = vec![row(
        dialog,
        Row::new("version", t!("Version"))
            .description(t!("Version {version}", version = lattice_core::VERSION), cx)
            .control(releases),
        width,
        cx,
    )];
    controls::group(Some(t!("App updates").into()), rows, cx)
}

/// Settings › TeX doctor: the doctor's report, as its sheet shows it.
pub fn doctor(width: PageWidth, cx: &mut Context<SettingsDialog>) -> AnyElement {
    let center = crate::build::tex_setup::center::center(cx);
    let body = center
        .as_ref()
        .map(|center| center.read(cx).doctor_page(center, cx))
        .unwrap_or_else(|| div().into_any_element());
    controls::page(t!("TeX doctor"), width, vec![body], cx)
}
