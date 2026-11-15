//! The highlighter palette the selection toolbar's caret opens, as the
//! Tauri app has it (`src/editor/latex/highlight-palette.tsx`,
//! `highlighters.ts`, `highlight-palette.css`): the six highlighters by what
//! they mean, each drawn as "Aa" on its tint so the printed result shows
//! before choosing, applied with a click or its digit; the pen's colour
//! marked; a meaning renamed where it sits; the writer's own colours, then
//! "+" for a custom colour; and Remove highlight inside a highlight.
//!
//! A highlighter is a paper colour, printed under black text in the PDF, so
//! every tint keeps `#242426` legible and stays light in the dark theme.
//! The meanings, the pen's colour and the custom colours are the writer's,
//! not a project's: kept in `highlighters.json` in the app's state folder.
//!
//! The custom colour view offers the colours this document uses, the
//! writer's own and the paper tones, and a hex field, with the text set on
//! paper in the chosen colour; a colour too dark for black ink says so.

use std::{
    collections::BTreeMap,
    path::PathBuf,
};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Global, Hsla, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, div, prelude::FluentBuilder as _, px, rgb,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon,
    components::Field,
    tokens::{RADIUS_SURFACE, SPACING_2, SPACING_3},
};
use serde::{Deserialize, Serialize};

use super::{EditorPanel, selection_toolbar::ToolbarAction};

/// The ink a highlight is printed under.
const PAPER_INK: u32 = 0x242426;
/// Black text needs 4.5:1 on a highlight.
const READABLE: f32 = 4.5;
const CUSTOM_MAX: usize = 4;
const SPECIMEN: &str = "Aa";

/// One highlighter: its paper colour, its colour's name, what it means
/// until the writer renames it, and its digit.
pub struct Highlighter {
    pub hex: &'static str,
    pub meaning: &'static str,
    pub key: &'static str,
}

pub fn highlighters() -> [Highlighter; 6] {
    [
        Highlighter { hex: "#FFF1A6", meaning: t!("To check"), key: "1" },
        Highlighter { hex: "#CFEFC6", meaning: t!("Keep"), key: "2" },
        Highlighter { hex: "#D3E4FF", meaning: t!("Needs a citation"), key: "3" },
        Highlighter { hex: "#FFD6E4", meaning: t!("Rewrite"), key: "4" },
        Highlighter { hex: "#FFE2C2", meaning: t!("Question"), key: "5" },
        Highlighter { hex: "#E6DBFF", meaning: t!("Idea"), key: "6" },
    ]
}

/// The paper tones the custom view offers (`PAPER_TONES`).
const PAPER_TONES: [&str; 24] = [
    "#F9F5D6", "#FFF1E5", "#FEF0ED", "#FEEFF4", "#F5F1FE", "#ECF4FE", "#DDF7F5", "#E4FBE3",
    "#F3E9B0", "#FFE0C6", "#FFDDD8", "#FEDBE8", "#EAE0FF", "#D7E8FF", "#C2EEEA", "#CAF3CA",
    "#EAD98A", "#FFCCA1", "#FFC9C1", "#FFC5DA", "#DECEFE", "#BEDAFF", "#9FE2DC", "#B0E9B1",
];

/// The writer's highlighter preferences.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prefs {
    /// Renamed meanings, by highlighter hex.
    #[serde(default)]
    pub meanings: BTreeMap<String, String>,
    /// The colour the toolbar's pen applies.
    pub last: String,
    /// Custom colours, newest first.
    #[serde(default)]
    pub custom: Vec<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            meanings: BTreeMap::new(),
            last: "#FFF1A6".into(),
            custom: Vec::new(),
        }
    }
}

struct PrefsGlobal(Prefs, Option<PathBuf>);

impl Global for PrefsGlobal {}

fn is_hex(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn ensure(cx: &mut App) {
    if cx.has_global::<PrefsGlobal>() {
        return;
    }
    let file = crate::shell::workspaces::state_dir(crate::settings::scripted(cx))
        .map(|dir| dir.join("highlighters.json"));
    let prefs = file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<Prefs>(&text).ok())
        .map(|mut prefs| {
            prefs.custom.retain(|hex| is_hex(hex));
            prefs.custom.truncate(CUSTOM_MAX);
            if !is_hex(&prefs.last) {
                prefs.last = Prefs::default().last;
            }
            prefs
        })
        .unwrap_or_default();
    cx.set_global(PrefsGlobal(prefs, file));
}

/// The writer's preferences.
pub fn prefs(cx: &mut App) -> &Prefs {
    ensure(cx);
    &cx.global::<PrefsGlobal>().0
}

fn update(cx: &mut App, change: impl FnOnce(&mut Prefs)) {
    ensure(cx);
    let global = cx.global_mut::<PrefsGlobal>();
    change(&mut global.0);
    if let Some(file) = &global.1 {
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&global.0) {
            let _ = std::fs::write(file, text);
        }
    }
}

/// Remember `color` as the pen's, and among the custom colours when it is
/// not a highlighter (`rememberHighlight`).
pub fn remember(color: &str, cx: &mut App) {
    let hex = color.to_ascii_uppercase();
    if !is_hex(&hex) {
        return;
    }
    let highlighter = highlighters().iter().any(|item| item.hex == hex);
    update(cx, |prefs| {
        prefs.last = hex.clone();
        if !highlighter {
            prefs.custom.retain(|item| *item != hex);
            prefs.custom.insert(0, hex);
            prefs.custom.truncate(CUSTOM_MAX);
        }
    });
}

/// A highlighter's meaning, as renamed or by default.
fn meaning(item: &Highlighter, prefs: &Prefs) -> String {
    prefs
        .meanings
        .get(item.hex)
        .cloned()
        .unwrap_or_else(|| item.meaning.to_string())
}

/// What the pen's colour means: a highlighter's meaning, else the colour.
pub fn meaning_of_color(hex: &str, cx: &mut App) -> String {
    let prefs = prefs(cx).clone();
    highlighters()
        .iter()
        .find(|item| item.hex.eq_ignore_ascii_case(hex))
        .map_or_else(|| hex.to_string(), |item| meaning(item, &prefs))
}

pub fn hex_color(hex: &str) -> Hsla {
    u32::from_str_radix(hex.trim_start_matches('#'), 16)
        .map(|value| rgb(value).into())
        .unwrap_or_else(|_| rgb(0xFFF1A6).into())
}

fn luminance(hex: &str) -> f32 {
    let value = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0xffffff);
    let channel = |shift: u32| {
        let c = ((value >> shift) & 0xff) as f32 / 255.;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

/// The contrast between `hex` and the paper's ink.
fn contrast(hex: &str) -> f32 {
    let (a, b) = (luminance(hex), luminance(&format!("#{PAPER_INK:06X}")));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

/// Which view the palette shows, and what is being typed in it.
#[derive(Default)]
pub(super) struct PaletteState {
    /// The palette takes the keys while it is open, so a digit applies its
    /// highlighter rather than typing.
    pub(super) focus: Option<gpui::FocusHandle>,
    custom: bool,
    renaming: Option<(&'static str, Entity<InputState>, Subscription)>,
    hex: Option<(Entity<InputState>, Subscription)>,
}

impl EditorPanel {
    fn rename_highlighter(&mut self, hex: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let prefs = prefs(cx).clone();
        let renamed = prefs.meanings.get(hex).cloned().unwrap_or_default();
        let placeholder = highlighters()
            .iter()
            .find(|item| item.hex == hex)
            .map_or("", |item| item.meaning);
        let field = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(placeholder)
                .default_value(renamed)
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let sub = cx.subscribe_in(&field, window, move |this, field, event, window, cx| match event {
            InputEvent::PressEnter { .. } | InputEvent::Blur => {
                let value = field.read(cx).value().trim().chars().take(40).collect::<String>();
                update(cx, |prefs| {
                    if value.is_empty() {
                        prefs.meanings.remove(hex);
                    } else {
                        prefs.meanings.insert(hex.to_string(), value);
                    }
                });
                this.toolbar.palette.renaming = None;
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.refocus_palette(window, cx);
                }
                cx.notify();
            }
            _ => {}
        });
        self.toolbar.palette.renaming = Some((hex, field, sub));
        cx.notify();
    }

    /// Give the palette its digit keys back from a field it opened.
    fn refocus_palette(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = &self.toolbar.palette.focus {
            window.focus(focus, cx);
        }
    }

    fn open_custom(&mut self, current: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let start = current
            .filter(|hex| is_hex(hex))
            .unwrap_or_else(|| prefs(cx).last.clone());
        let field = cx.new(|cx| InputState::new(window, cx).default_value(start));
        let sub = cx.subscribe_in(&field, window, |this, field, event, window, cx| match event {
            InputEvent::PressEnter { .. } => {
                let hex = normalize_hex(&field.read(cx).value());
                if let Some(hex) = hex.filter(|hex| contrast(hex) >= READABLE) {
                    this.toolbar_action(ToolbarAction::Highlight(hex), window, cx);
                }
            }
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        self.toolbar.palette.custom = true;
        self.toolbar.palette.hex = Some((field, sub));
        cx.notify();
    }
}

fn normalize_hex(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches('#');
    (trimmed.len() == 6 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("#{}", trimmed.to_ascii_uppercase()))
}

/// The palette, for the highlight around the selection (`current`: its
/// colour, "" for an uncoloured one), the selected text (`sample`) and the
/// colours the document uses.
pub(super) fn palette(
    panel: &mut EditorPanel,
    current: Option<String>,
    sample: String,
    document: Vec<String>,
    window: &mut Window,
    cx: &mut Context<EditorPanel>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let prefs = prefs(cx).clone();
    let current_hex = current.as_ref().map(|color| color.to_ascii_uppercase());
    let surface = div()
        .id("highlight-palette")
        .when_some(panel.toolbar.palette.focus.clone(), |this, focus| this.track_focus(&focus))
        .occlude()
        .w(px(212.))
        .p(px(4.))
        .rounded(RADIUS_SURFACE)
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .text_color(palette.text)
        .flex()
        .flex_col()
        .gap(px(2.))
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());
    let row_text = |cx: &App| cx.lattice().fonts.ui.clone();
    if panel.toolbar.palette.custom {
        let Some((field, _)) = &panel.toolbar.palette.hex else {
            return surface.into_any_element();
        };
        let field = field.clone();
        let typed = normalize_hex(&field.read(cx).value());
        let readable = typed.as_ref().is_some_and(|hex| contrast(hex) >= READABLE);
        let sample = if sample.is_empty() {
            t!("Highlighted text").to_string()
        } else {
            sample.chars().take(64).collect()
        };
        let swatches = |label: &'static str, colors: Vec<String>, cx: &mut Context<EditorPanel>| {
            (!colors.is_empty()).then(|| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(palette.text_secondary)
                            .child(label),
                    )
                    .child(div().flex().flex_wrap().gap(px(4.)).children(
                        colors.into_iter().enumerate().map(|(index, hex)| {
                            let chosen = hex.clone();
                            let field = field.clone();
                            div()
                                .id(SharedString::from(format!("swatch-{label}-{index}")))
                                .size(px(18.))
                                .rounded(px(4.))
                                .bg(hex_color(&hex))
                                .border_1()
                                .border_color(gpui::black().opacity(0.18))
                                .cursor_pointer()
                                .on_click(cx.listener(move |_, _, window, cx| {
                                    field.update(cx, |field, cx| {
                                        field.set_value(chosen.clone(), window, cx)
                                    });
                                    cx.notify();
                                }))
                        }),
                    ))
            })
        };
        let document = document.into_iter().take(8).collect();
        let tones = PAPER_TONES.iter().map(|hex| hex.to_string()).collect();
        let back = div()
            .id("highlight-back")
            .h(px(28.))
            .px(SPACING_2)
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_size(px(12.))
            .text_color(palette.text_secondary)
            .hover(|this| this.bg(palette.accent_soft).text_color(palette.text))
            .child(Icon::CHEVRON_LEFT.element(px(14.), palette.text_secondary))
            .child(t!("Highlighters"))
            .on_click(cx.listener(|this, _, window, cx| {
                this.toolbar.palette.custom = false;
                this.refocus_palette(window, cx);
                cx.notify();
            }));
        let apply = typed.clone();
        let content = div()
            .flex()
            .flex_col()
            .gap(SPACING_3)
            .p(px(4.))
            .child(
                div()
                    .p(px(10.))
                    .rounded(px(6.))
                    .bg(rgb(0xffffff))
                    .text_size(px(13.))
                    .text_color(rgb(PAPER_INK))
                    .child(
                        div()
                            .px(px(2.))
                            .rounded(px(2.))
                            .bg(typed.as_deref().map_or(rgb(0xffffff).into(), hex_color))
                            .child(sample),
                    ),
            )
            .child(Field::new(&field).compact())
            .when(typed.is_some() && !readable, |this| {
                this.child(
                    div()
                        .text_size(px(11.))
                        .text_color(palette.warning)
                        .child(t!("Too dark for black text")),
                )
            })
            .children(swatches(t!("In this document"), document, cx))
            .children(swatches(t!("Your colours"), prefs.custom.clone(), cx))
            .children(swatches(t!("Paper tones"), tones, cx))
            .child(
                div()
                    .id("highlight-custom-apply")
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .text_size(px(12.))
                    .bg(if readable { palette.tinted } else { palette.disabled_surface })
                    .text_color(if readable { palette.text } else { palette.disabled_ink })
                    .when(readable, |this| this.cursor_pointer().hover(|this| this.bg(palette.tinted_hover)))
                    .child(t!("Highlight"))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(hex) = apply.clone().filter(|hex| contrast(hex) >= READABLE) {
                            this.toolbar_action(ToolbarAction::Highlight(hex), window, cx);
                        }
                    })),
            );
        return surface.child(back).child(content).into_any_element();
    }
    let font = row_text(cx);
    let mut list = div().flex().flex_col().gap(px(1.));
    for item in highlighters() {
        let hex = item.hex;
        let on = current_hex.as_deref() == Some(hex);
        let pen = !on && prefs.last == hex;
        let chip = div()
            .flex_none()
            .px(px(5.))
            .h(px(18.))
            .flex()
            .items_center()
            .rounded(px(4.))
            .bg(hex_color(hex))
            .text_color(rgb(PAPER_INK))
            .text_size(px(11.))
            .font_weight(gpui::FontWeight::MEDIUM)
            .child(SPECIMEN);
        if let Some((renaming, field, _)) = &panel.toolbar.palette.renaming
            && *renaming == hex
        {
            let field = field.clone();
            list = list.child(
                div()
                    .h(px(28.))
                    .pl(px(4.))
                    .pr(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                        if event.keystroke.key == "escape" {
                            cx.stop_propagation();
                            this.toolbar.palette.renaming = None;
                            this.refocus_palette(window, cx);
                            cx.notify();
                        }
                    }))
                    .child(chip)
                    .child(div().flex_1().min_w_0().child(Field::new(&field).compact()))
                    .child(div().text_color(palette.text_secondary.opacity(0.7)).child("↩")),
            );
            continue;
        }
        let label = meaning(&item, &prefs);
        list = list.child(
            div()
                .id(SharedString::from(format!("highlighter-{}", item.key)))
                .group(SharedString::from(format!("highlighter-{}", item.key)))
                .relative()
                .h(px(28.))
                .pl(px(4.))
                .pr(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .font_family(font.clone())
                .text_size(px(12.))
                .when(on, |this| this.bg(palette.accent_soft))
                .hover(|this| this.bg(palette.accent_soft))
                .child(chip)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .when(on, |this| this.font_weight(gpui::FontWeight::MEDIUM))
                        .child(label),
                )
                .child(div().w(px(14.)).flex().justify_center().map(|this| {
                    if on {
                        this.child(Icon::CHECK.element(px(14.), palette.text))
                    } else if pen {
                        this.child(Icon::HIGHLIGHTER.element(px(12.), palette.text_secondary.opacity(0.7)))
                    } else {
                        this
                    }
                }))
                .child(
                    div()
                        .min_w(px(8.))
                        .text_color(palette.text_secondary.opacity(0.7))
                        .child(item.key)
                        .group_hover(SharedString::from(format!("highlighter-{}", item.key)), |style| {
                            style.opacity(0.)
                        }),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("highlighter-rename-{}", item.key)))
                        .absolute()
                        .right(px(2.))
                        .top(px(3.))
                        .size(px(22.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.))
                        .bg(palette.raised)
                        .invisible()
                        .group_hover(SharedString::from(format!("highlighter-{}", item.key)), |style| {
                            style.visible()
                        })
                        .hover(|this| this.bg(palette.hover))
                        .child(Icon::PENCIL_LINE.element(px(12.), palette.text_secondary))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.rename_highlighter(hex, window, cx)
                        })),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.toolbar_action(ToolbarAction::Highlight(hex.to_string()), window, cx)
                })),
        );
    }
    let custom_current = current.clone();
    let yours = div()
        .px(px(4.))
        .py(px(4.))
        .flex()
        .flex_wrap()
        .gap(px(6.))
        .children(prefs.custom.iter().enumerate().map(|(index, hex)| {
            let chosen = hex.clone();
            div()
                .id(("highlight-custom", index))
                .size(px(18.))
                .rounded_full()
                .bg(hex_color(hex))
                .border_1()
                .border_color(if current_hex.as_deref() == Some(hex.as_str()) {
                    palette.text
                } else {
                    gpui::black().opacity(0.18)
                })
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.toolbar_action(ToolbarAction::Highlight(chosen.clone()), window, cx)
                }))
        }))
        .child(
            div()
                .id("highlight-custom-add")
                .size(px(18.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .border_1()
                .border_color(palette.line_strong)
                .cursor_pointer()
                .hover(|this| this.bg(palette.hover))
                .child(Icon::PLUS.element(px(12.), palette.text_secondary))
                .tooltip(|_, cx| {
                    lattice_ui::components::LatticeTooltip::view(SharedString::from(t!("Custom colour…")), None, cx)
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_custom(custom_current.clone(), window, cx)
                })),
        );
    let remove = current.is_some().then(|| {
        div()
            .pt(px(2.))
            .border_t_1()
            .border_color(palette.line)
            .child(
                div()
                    .id("highlight-remove")
                    .h(px(28.))
                    .pl(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .text_color(palette.text_secondary)
                    .hover(|this| this.bg(palette.accent_soft).text_color(palette.text))
                    .child(div().w(px(28.)).flex().justify_center().child(Icon::ERASER.element(px(14.), palette.text_secondary)))
                    .child(t!("Remove highlight"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Unhighlight, window, cx)
                    })),
            )
    });
    let _ = window;
    surface
        // The digits apply their highlighter while the palette is open.
        .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
            if this.toolbar.palette.renaming.is_some() || this.toolbar.palette.custom {
                return;
            }
            let keys = &event.keystroke;
            if keys.modifiers.platform || keys.modifiers.control || keys.modifiers.alt {
                return;
            }
            if let Some(item) = highlighters().into_iter().find(|item| item.key == keys.key) {
                cx.stop_propagation();
                this.toolbar_action(ToolbarAction::Highlight(item.hex.to_string()), window, cx);
            }
        }))
        .child(list)
        .child(yours)
        .children(remove)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_highlighter_and_paper_tone_keeps_black_ink_legible() {
        for item in highlighters() {
            assert!(contrast(item.hex) >= 11., "{} is too dark", item.hex);
        }
        for tone in PAPER_TONES {
            assert!(contrast(tone) >= 10.5, "{tone} is too dark");
        }
        assert!(contrast("#333333") < READABLE);
        assert_eq!(normalize_hex(" fff1a6"), Some("#FFF1A6".into()));
        assert_eq!(normalize_hex("#12"), None);
    }
}
