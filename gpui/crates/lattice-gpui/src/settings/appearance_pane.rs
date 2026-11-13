//! Settings › Appearance (`AppearanceSettingsPane` in settings-dialog.tsx,
//! `editor-font-settings.tsx`, `theme-settings.tsx`,
//! `code-theme-settings.tsx`): the interface's language, size, sounds and
//! notification position; each editor's face, size and line height; the
//! theme (appearance, tint, accent, translucency); the code theme; and the
//! title bar's tools. Every choice applies as it is made.

use gpui::{
    AnyElement, App, ClickEvent, Context, ElementId, IntoElement, ParentElement as _, SharedString,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::{t, tc};
use lattice_settings::{
    Accent as StoredAccent, AccentPreset, Choice as _, CodeTheme as StoredCodeTheme,
    CodeThemeVariant, INTERFACE_SCALE_STEPS, InterfaceLanguage, ThemePreference,
    Tint as StoredTint, TitlebarTool, ToastPosition, Translucency, nearest_interface_step,
};
use lattice_ui::{
    ActiveLattice as _, Appearance, Palette, TextRole, TextRoleStyle as _, TypeScale,
    components::{Segmented, Slider},
};

use super::{
    controls::{self, PageWidth, Row, Wrap},
    dialog::SettingsDialog,
    theme_art,
};

/// A face Settings offers by name: its stored family and the name it shows.
pub type Face = (&'static str, &'static str);

/// The source editor's faces, its own default left out (`SOURCE_FACES`).
pub const SOURCE_FACES: &[Face] = &[
    ("ui-monospace", "SF Mono"),
    ("Menlo", "Menlo"),
    ("Inter Variable", "Inter"),
    ("system-ui", "SF Pro"),
    ("Atkinson Hyperlegible", "Atkinson Hyperlegible"),
    ("OpenDyslexic", "OpenDyslexic"),
];

/// The visual Markdown editor's (`PROSE_FACES`).
pub const PROSE_FACES: &[Face] = &[
    ("system-ui", "SF Pro"),
    ("ui-serif", "New York"),
    ("Georgia", "Georgia"),
    ("Atkinson Hyperlegible", "Atkinson Hyperlegible"),
    ("OpenDyslexic", "OpenDyslexic"),
    ("Ioskeley Mono", "Ioskeley Mono"),
];

pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let groups = vec![
        general(dialog, width, cx),
        fonts(dialog, width, true, window, cx),
        fonts(dialog, width, false, window, cx),
        theme(dialog, width, window, cx),
        code_theme(dialog, width, window, cx),
        titlebar_tools(dialog, width, cx),
    ];
    controls::page(t!("Appearance"), width, groups, cx)
}

/// A row, measured for revealing and washed while revealed.
fn row(dialog: &SettingsDialog, row: Row, width: PageWidth, cx: &App) -> AnyElement {
    let id = row.id;
    div()
        .relative()
        .child(dialog.measure(id))
        .child(row.revealed(dialog.revealed(id)).render(width, cx))
        .into_any_element()
}

fn general(
    dialog: &SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let appearance = super::get(cx).appearance.clone();
    let language = controls::select(
        "interface-language",
        vec![
            (InterfaceLanguage::System, t!("Match system").into()),
            (InterfaceLanguage::En, t!("English").into()),
            (InterfaceLanguage::ZhCn, t!("Simplified Chinese").into()),
        ],
        appearance.interface_language,
        |language, _, cx| super::update_appearance(cx, |a| a.interface_language = language),
    );
    let chosen = nearest_interface_step(appearance.interface_scale);
    let mut size = Segmented::new("interface-size");
    for step in INTERFACE_SCALE_STEPS {
        size = size.label(
            format!("{}%", (step * 100.).round()),
            (step - chosen).abs() < 1e-3,
            move |_, _, cx| super::update_appearance(cx, |a| a.interface_scale = step),
        );
    }
    let toast = controls::select(
        "toast-position",
        vec![
            (ToastPosition::TopRight, t!("Top right").into()),
            (ToastPosition::TopCenter, t!("Top center").into()),
            (ToastPosition::BottomRight, t!("Bottom right").into()),
            (ToastPosition::BottomCenter, t!("Bottom center").into()),
        ],
        appearance.toast_position,
        |position, _, cx| super::update_appearance(cx, |a| a.toast_position = position),
    );
    let sounds = controls::switch(
        "interface-sounds",
        appearance.interface_sounds,
        false,
        |on, _, cx| super::update_appearance(cx, |a| a.interface_sounds = on),
    );
    let rows = vec![
        row(
            dialog,
            Row::new("interface-language", t!("Interface language")).control(language),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("interface-size", t!("Interface size"))
                .control(size)
                .wrap(Wrap::Line),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("interface-sounds", t!("Interface sounds"))
                .control(sounds)
                .wrap(Wrap::Never),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("toast-position", t!("Notification position")).control(toast),
            width,
            cx,
        ),
    ];
    // The page title already names these.
    controls::first_group(None, rows, cx)
}

/// One editor's face, size and line height.
fn fonts(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    source: bool,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let appearance = super::get(cx).appearance.clone();
    let (faces, value, other) = if source {
        (
            SOURCE_FACES,
            appearance.source_font.clone(),
            dialog.fields.source_other,
        )
    } else {
        (
            PROSE_FACES,
            appearance.prose_font.clone(),
            dialog.fields.prose_other,
        )
    };
    // "Default", each face, "Other font…": the index the select shows.
    let mut options: Vec<(usize, SharedString)> = vec![(0, t!("Default").into())];
    options.extend(
        faces
            .iter()
            .enumerate()
            .map(|(ix, (_, label))| (ix + 1, SharedString::from(*label))),
    );
    options.push((faces.len() + 1, t!("Other font…").into()));
    let chosen = if other {
        faces.len() + 1
    } else {
        faces
            .iter()
            .position(|(family, _)| *family == value)
            .map_or(0, |ix| ix + 1)
    };
    let name_field = if source {
        dialog.fields.source_font_name.clone()
    } else {
        dialog.fields.prose_font_name.clone()
    };
    let this = cx.entity();
    let pick = move |choice: usize, window: &mut Window, cx: &mut App| {
        let other = choice == faces.len() + 1;
        let typed = name_field.read(cx).value().trim().to_string();
        this.update(cx, |dialog, cx| {
            if source {
                dialog.fields.source_other = other;
            } else {
                dialog.fields.prose_other = other;
            }
            cx.notify();
        });
        if other {
            name_field.update(cx, |input, cx| input.focus(window, cx));
        }
        let family = match choice {
            0 => String::new(),
            _ if other => typed,
            ix => faces[ix - 1].0.to_owned(),
        };
        if other && family.is_empty() {
            return;
        }
        super::update_appearance(cx, |a| {
            if source {
                a.source_font = family;
            } else {
                a.prose_font = family;
            }
        });
    };
    let face = controls::select(
        if source { "source-font" } else { "prose-font" },
        options,
        chosen,
        pick,
    );
    let mut rows = vec![row(
        dialog,
        Row::new(
            if source { "source-font" } else { "prose-font" },
            t!("Font"),
        )
        .control(face),
        width,
        cx,
    )];
    if other {
        let field = if source {
            dialog.fields.source_font_name.clone()
        } else {
            dialog.fields.prose_font_name.clone()
        };
        rows.push(
            Row::new(
                if source {
                    "source-font-name"
                } else {
                    "prose-font-name"
                },
                t!("Font name"),
            )
            .control(
                div()
                    .w(controls::CONTROL_WIDTH)
                    .child(lattice_ui::components::Field::new(&field)),
            )
            .render(width, cx),
        );
    }
    let (size_state, line_state, size_id, line_id) = if source {
        (
            dialog.fields.editor_font_size.clone(),
            dialog.fields.source_line_height.clone(),
            "editor-font-size",
            "source-line-height",
        )
    } else {
        (
            dialog.fields.prose_font_size.clone(),
            dialog.fields.prose_line_height.clone(),
            "prose-font-size",
            "prose-line-height",
        )
    };
    let size = Slider::new(
        ElementId::Name(format!("{size_id}-slider").into()),
        &size_state,
    )
    .label(t!("Font size"))
    .readout(|value| format!("{}px", value.round()).into());
    let line = Slider::new(
        ElementId::Name(format!("{line_id}-slider").into()),
        &line_state,
    )
    .label(t!("Line height"))
    .readout(|value| format!("{value:.2}").into());
    rows.push(row(
        dialog,
        Row::new(size_id, t!("Font size"))
            .control(size)
            .wrap(Wrap::Line),
        width,
        cx,
    ));
    rows.push(row(
        dialog,
        Row::new(line_id, t!("Line height"))
            .control(line)
            .wrap(Wrap::Line),
        width,
        cx,
    ));
    let _ = window;
    controls::group(
        Some(
            if source {
                t!("Source editor")
            } else {
                t!("Visual Markdown editor")
            }
            .into(),
        ),
        rows,
        cx,
    )
}

fn tint_name(tint: StoredTint) -> &'static str {
    match tint {
        StoredTint::Graphite => t!("Graphite"),
        StoredTint::Paper => tc!("theme tint", "Paper"),
        StoredTint::Sage => t!("Sage"),
        StoredTint::Mist => t!("Mist"),
        StoredTint::Dusk => t!("Dusk"),
    }
}

fn accent_name(accent: AccentPreset) -> &'static str {
    match accent {
        AccentPreset::Graphite => t!("Graphite"),
        AccentPreset::Blue => t!("Blue"),
        AccentPreset::Purple => t!("Purple"),
        AccentPreset::Pink => t!("Pink"),
        AccentPreset::Orange => t!("Orange"),
        AccentPreset::Green => t!("Green"),
        AccentPreset::Teal => t!("Teal"),
    }
}

fn theme(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let settings = super::get(cx).clone();
    let appearance = &settings.appearance;
    let tint = super::tint(appearance.tint);
    let wraps = width.wraps();

    let modes = [
        (ThemePreference::System, t!("Match system"), None),
        (ThemePreference::Light, t!("Light"), Some(Appearance::Light)),
        (ThemePreference::Dark, t!("Dark"), Some(Appearance::Dark)),
    ];
    let mode_tiles: Vec<AnyElement> = modes
        .into_iter()
        .map(|(preference, name, kind)| {
            theme_art::tile(
                ElementId::Name(format!("theme-mode-{}", preference.tag()).into()),
                name,
                (!wraps).then_some(px(88.)),
                theme_art::window_art(kind, tint, cx),
                settings.theme_preference == preference,
                move |_: &ClickEvent, _, cx| {
                    super::update(cx, |settings| settings.theme_preference = preference)
                },
                window,
                cx,
            )
        })
        .collect();
    let tint_tiles: Vec<AnyElement> = StoredTint::ALL
        .iter()
        .copied()
        .map(|choice| {
            theme_art::tile(
                ElementId::Name(format!("theme-tint-{}", choice.tag()).into()),
                tint_name(choice),
                (!wraps).then_some(px(56.)),
                theme_art::tint_art(super::tint(choice), cx),
                appearance.tint == choice,
                move |_: &ClickEvent, _, cx| super::update_appearance(cx, |a| a.tint = choice),
                window,
                cx,
            )
        })
        .collect();
    let tiles = |gap: f32, tiles: Vec<AnyElement>| {
        div()
            .flex()
            .when(!wraps, |this| this.justify_end())
            .when(wraps, |this| this.w_full())
            .gap(px(gap))
            .children(tiles)
    };

    let palette = cx.palette().clone();
    let custom = appearance.accent.custom_rgb();
    let mut swatches: Vec<AnyElement> = AccentPreset::ALL
        .iter()
        .copied()
        .map(|preset| {
            let color = Palette::new(
                palette.appearance,
                palette.tint,
                super::accent(&StoredAccent::Preset(preset)),
            )
            .accent;
            let contrast = palette.accent_contrast;
            theme_art::swatch(
                ElementId::Name(format!("theme-accent-{}", preset.tag()).into()),
                color,
                appearance.accent == StoredAccent::Preset(preset),
                color,
                contrast,
                false,
                std::rc::Rc::new(move |_, _, cx| {
                    super::update_appearance(cx, |a| a.accent = StoredAccent::Preset(preset))
                }),
                window,
                cx,
            )
        })
        .collect();
    let this = cx.entity();
    let custom_color = match custom {
        Some(_) => palette.accent,
        // The picker opens on the editor's selection blue until a colour is chosen.
        None => gpui::rgb(0xc06a54).into(),
    };
    swatches.push(
        div()
            .ml(px(4.))
            .child(theme_art::swatch(
                "theme-accent-custom".into(),
                custom_color,
                custom.is_some(),
                palette.accent,
                palette.accent_contrast,
                custom.is_none(),
                std::rc::Rc::new(move |_, window, cx| {
                    this.update(cx, |dialog, cx| {
                        dialog.fields.custom_accent_open = !dialog.fields.custom_accent_open;
                        if dialog.fields.custom_accent_open {
                            dialog
                                .fields
                                .custom_accent
                                .update(cx, |input, cx| input.focus(window, cx));
                        }
                        cx.notify();
                    })
                }),
                window,
                cx,
            ))
            .into_any_element(),
    );
    let accent_note: SharedString = match &appearance.accent {
        StoredAccent::Preset(preset) => accent_name(*preset).into(),
        StoredAccent::Custom(hex) => t!("Custom {0}", hex.to_uppercase()).into(),
    };
    let mut accent_row = Row::new("theme-accent", t!("Accent"))
        .description(accent_note, cx)
        .control(div().flex().items_center().gap(px(2.)).children(swatches));
    if dialog.fields.custom_accent_open {
        accent_row = accent_row.wrap(Wrap::Line);
    }

    let mut translucency = Segmented::new("translucency");
    for (level, label) in [
        (Translucency::Off, t!("Off")),
        (Translucency::Subtle, t!("Subtle")),
        (Translucency::Strong, t!("Strong")),
    ] {
        translucency =
            translucency.label(label, appearance.translucency == level, move |_, _, cx| {
                super::update_appearance(cx, |a| a.translucency = level)
            });
    }
    // GPUI draws the window opaque for now, as the Tauri app does where
    // vibrancy is unavailable; the choice is kept for when it is not.
    let translucency_note = if cfg!(target_os = "macos") {
        t!("Off while Reduce transparency is on in System Settings")
    } else {
        t!("Only in the Lattice window on macOS")
    };
    let _ = translucency_note;

    let mut rows = vec![
        row(
            dialog,
            Row::new("color-theme", t!("Color theme"))
                .control(tiles(12., mode_tiles))
                .wrap(Wrap::Line)
                .roomy(),
            width,
            cx,
        ),
        row(
            dialog,
            Row::new("theme-tint", t!("Tint"))
                .control(tiles(10., tint_tiles))
                .wrap(Wrap::Line)
                .roomy(),
            width,
            cx,
        ),
        row(dialog, accent_row, width, cx),
    ];
    if dialog.fields.custom_accent_open {
        rows.push(custom_accent(dialog, width, cx));
    }
    rows.push(row(
        dialog,
        Row::new("translucency", t!("Translucency"))
            .control(translucency)
            .wrap(Wrap::Line),
        width,
        cx,
    ));
    controls::group(Some(t!("Theme").into()), rows, cx)
}

/// The custom accent: the colour typed as hex and, when the theme had to
/// adjust it to read as text, the colour in use and why (`fitAccent`).
fn custom_accent(
    dialog: &SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let appearance = super::get(cx).appearance.clone();
    let rgb = appearance.accent.custom_rgb();
    let mut note = div().flex().flex_col().gap(px(4.));
    if let Some([r, g, b]) = rgb {
        let picked = u32::from(r) << 16 | u32::from(g) << 8 | u32::from(b);
        let applied = lattice_ui::accent_fit::fit_accent(picked, palette.appearance);
        if applied != picked {
            let ratio = lattice_ui::accent_fit::accent_contrast(applied, palette.appearance);
            let chip = |label: &'static str, color: u32| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .h(px(24.))
                    .pl(px(4.))
                    .pr(px(6.))
                    .rounded(px(6.))
                    .bg(palette.input)
                    .text_role_in(TextRole::Micro, TypeScale::Settings, cx)
                    .text_color(palette.text_secondary)
                    .child(div().size(px(14.)).rounded(px(4.)).bg(gpui::rgb(color)))
                    .child(label)
                    .child(
                        div()
                            .text_color(palette.text)
                            .font_family(cx.lattice().fonts.editor.clone())
                            .child(format!("#{color:06X}")),
                    )
            };
            note = note
                .child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .child(chip(t!("Picked"), picked))
                        .child(chip(t!("In use"), applied)),
                )
                .child(
                    div()
                        .text_role_in(TextRole::Micro, TypeScale::Settings, cx)
                        .text_color(palette.text)
                        .child(t!(
                            "Adjusted so links and selected text read at {ratio}:1",
                            ratio = format!("{ratio:.1}")
                        )),
                );
        }
    }
    let _ = dialog;
    Row::new("custom-accent", t!("Custom accent"))
        .description_element(note)
        .control(
            div()
                .w(controls::CONTROL_WIDTH)
                .child(lattice_ui::components::Field::new(
                    &dialog.fields.custom_accent,
                )),
        )
        .render(width, cx)
}

fn code_theme(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let appearance = super::get(cx).appearance.clone();
    let chosen = super::code_theme(appearance.code_theme);
    let kinds = chosen.kinds();
    let name_of = |theme: lattice_ui::CodeTheme| -> SharedString {
        match theme {
            lattice_ui::CodeTheme::WeftAndWarp => t!("Weft & Warp").into(),
            theme => theme.label().into(),
        }
    };
    let only = (kinds.len() == 1).then(|| kinds[0]);
    let mut variant = Segmented::new("code-theme-variant");
    for (choice, label) in [
        (CodeThemeVariant::Auto, t!("Match app")),
        (CodeThemeVariant::Light, t!("Light")),
        (CodeThemeVariant::Dark, t!("Dark")),
    ] {
        variant = variant.label(
            label,
            appearance.code_theme_variant == choice,
            move |_, _, cx| super::update_appearance(cx, |a| a.code_theme_variant = choice),
        );
    }
    let mut variant_row = Row::new("code-theme-variant", t!("Light or dark"))
        .control(variant)
        .wrap(Wrap::Line);
    match only {
        Some(Appearance::Dark) => {
            variant_row = variant_row.description(t!("{0} comes in dark only", name_of(chosen)), cx)
        }
        Some(Appearance::Light) => {
            variant_row =
                variant_row.description(t!("{0} comes in light only", name_of(chosen)), cx)
        }
        None => {}
    }
    let fixed = super::code_theme_variant(appearance.code_theme_variant);
    let app = cx.palette().appearance;
    let cards: Vec<AnyElement> = StoredCodeTheme::ALL
        .iter()
        .copied()
        .map(|stored| {
            let theme = super::code_theme(stored);
            theme_art::code_theme_card(
                theme,
                name_of(theme),
                stored == appearance.code_theme,
                Some(fixed.unwrap_or(app)),
                move |_: &ClickEvent, _, cx| {
                    super::update_appearance(cx, |a| a.code_theme = stored)
                },
                window,
                cx,
            )
        })
        .collect();
    // As many 176px columns as fit, sharing the room.
    let room = width.inner() - px(32.);
    let columns = ((room + px(8.)) / px(184.)).floor().max(1.) as usize;
    let mut grid = div().flex().flex_col().gap(px(16.));
    let mut cards = cards.into_iter().peekable();
    while cards.peek().is_some() {
        let line: Vec<AnyElement> = cards.by_ref().take(columns).collect();
        let missing = columns - line.len();
        grid = grid.child(
            div()
                .flex()
                .gap(px(8.))
                .children(
                    line.into_iter()
                        .map(|card| div().flex_1().min_w_0().child(card)),
                )
                .children((0..missing).map(|_| div().flex_1())),
        );
    }
    let rows = vec![
        row(dialog, variant_row, width, cx),
        div()
            .relative()
            .px(px(16.))
            .py(px(12.))
            .child(dialog.measure("code-theme"))
            .child(grid)
            .into_any_element(),
    ];
    controls::group(Some(t!("Code theme").into()), rows, cx)
}

fn titlebar_tools(
    dialog: &SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let hidden = super::get(cx).appearance.hidden_titlebar_tools.clone();
    let tools = [
        (TitlebarTool::Comments, t!("Annotations")),
        (TitlebarTool::Overleaf, t!("Overleaf")),
        (TitlebarTool::Git, t!("Git status and commit")),
        (TitlebarTool::History, t!("Project history")),
        (TitlebarTool::Browser, t!("Open in browser")),
    ];
    let rows = tools
        .into_iter()
        .map(|(tool, label)| {
            let shown = !hidden.contains(&tool);
            Row::new(
                match tool {
                    TitlebarTool::Comments => "titlebar-comments",
                    TitlebarTool::Overleaf => "titlebar-overleaf",
                    TitlebarTool::Git => "titlebar-git",
                    TitlebarTool::History => "titlebar-history",
                    TitlebarTool::Browser => "titlebar-browser",
                },
                label,
            )
            .control(controls::switch(
                tool.tag(),
                shown,
                false,
                move |on, _, cx| {
                    super::update_appearance(cx, |a| {
                        a.hidden_titlebar_tools.retain(|item| *item != tool);
                        if !on {
                            a.hidden_titlebar_tools.push(tool);
                        }
                    })
                },
            ))
            .wrap(Wrap::Never)
            .render(width, cx)
        })
        .collect();
    div()
        .relative()
        .child(dialog.measure("titlebar-tools"))
        .child(controls::group(
            Some(t!("Title bar tools").into()),
            rows,
            cx,
        ))
        .into_any_element()
}
