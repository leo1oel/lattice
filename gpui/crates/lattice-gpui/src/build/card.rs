//! The build's diagnostics, drawn as the Tauri app's card over the PDF
//! (`src/build/compile-diagnostics-panel.tsx`, `.compile-diagnostics` in
//! app-shell.css):
//!
//! - Floating, it is 440px wide (less on a narrow panel), 46px from the
//!   panel's top and 8px from its right, a floating-level surface; docked, it
//!   is a strip under the page, at most 240px (40% of the panel) open.
//! - Its bar: the build's headline beside its severity mark, toggling the
//!   list, then Dock/Float and Dismiss.
//! - Open: Messages | Log, the messages gathered under their file, worst
//!   first; an error the build explains opens into a card with its line, the
//!   token underlined, the plain words and its one-click fix. Each message
//!   copies; a missing package installs; an engine switch undoes.

use std::time::Duration;

use gpui::{
    AnyElement, App, Entity, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::*, px, relative,
};
use lattice_core::models::Diagnostic;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, IconButton, Segmented},
    dock::PANEL_RADIUS,
    elevation::{Elevation, ring},
    fluid_hover::{FluidHover, ItemKind},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{
    diagnostics::{self, Severity, group_by_file, install_target, location_label, severity},
    explain::{ExcerptLine, Explained},
    icons,
    outcome::headline,
};
use crate::build_panel::{BuildAction, BuildPanel, LastBuild, OutputTab};

mod log;
use log::{log_lines, log_view};

/// How long a copy button shows its check.
pub const COPIED_FOR: Duration = Duration::from_millis(1500);
/// How far into a failing line its token may start before the line is cut
/// in front of it.
const EXCERPT_LEAD: usize = 24;
/// The copy button of the log, beside the per-message ones.
const LOG_COPY: usize = usize::MAX;

fn tone(last: &LastBuild) -> Severity {
    let counts = diagnostics::summarize(&last.diagnostics);
    if counts.error > 0 || !last.success {
        Severity::Error
    } else if counts.warning > 0 {
        Severity::Warning
    } else {
        Severity::Info
    }
}

/// Errors and warnings differ in shape as well as colour (⊗ and △), so
/// severity reads without telling red from amber.
fn severity_icon(severity: Severity, cx: &App) -> (Icon, Hsla) {
    let palette = cx.palette();
    match severity {
        Severity::Error => (icons::CIRCLE_X, palette.danger),
        Severity::Warning => (icons::TRIANGLE_ALERT, palette.warning),
        Severity::Info => (icons::CIRCLE_HELP, palette.text_secondary),
    }
}

/// The card's own wash on hover: its ink at 8%.
fn tone_hover(cx: &App) -> Hsla {
    cx.palette().text_secondary.opacity(0.08)
}

/// A catalog message's text without its rich-text slots: the Tauri app wraps
/// the replacement in `<0>…</0>` to set it in code; here it reads inline.
fn strip_tags(message: &str) -> String {
    message.replace("<0>", "").replace("</0>", "")
}

fn title(last: &LastBuild) -> String {
    let counts = diagnostics::summarize(&last.diagnostics);
    if last.diagnostics.is_empty() && last.success {
        t!("Build notes").into()
    } else {
        headline(last.success, &counts, last.wrote_pdf)
    }
}

/// The card over (or under) the page.
pub fn card(
    panel: &BuildPanel,
    build: &Entity<BuildPanel>,
    hover: &FluidHover,
    window: &mut Window,
    cx: &App,
) -> AnyElement {
    let Some(last) = panel.last() else {
        return div().into_any_element();
    };
    let palette = cx.palette().clone();
    let docked = panel.docked();
    let body = panel
        .expanded
        .then(|| body(panel, last, build, docked, hover, window, cx));
    let surface = div()
        .id("compile-diagnostics")
        .occlude()
        .flex()
        .flex_col()
        .overflow_hidden()
        .text_color(palette.text_secondary)
        .child(bar(panel, last, build, docked, cx))
        .children(body);
    if docked {
        surface
            .flex_none()
            .w_full()
            .border_t_1()
            .border_color(palette.line)
            .bg(palette.editor)
            .rounded_b(PANEL_RADIUS)
            .when(panel.expanded, |strip| {
                strip.h(px(240.)).max_h(relative(0.4))
            })
            .into_any_element()
    } else {
        div()
            .absolute()
            .top(px(46.))
            .left(px(8.))
            .right(px(8.))
            .flex()
            .justify_end()
            .child(
                surface
                    .w(px(440.))
                    .max_w_full()
                    .rounded(px(10.))
                    .bg(palette.raised)
                    .shadow(floating(&palette)),
            )
            .into_any_element()
    }
}

/// `0 0 0 1px var(--border-subtle), var(--elevation-floating-shadow)`.
fn floating(palette: &lattice_ui::Palette) -> Vec<gpui::BoxShadow> {
    let mut shadows = vec![ring(palette.line)];
    shadows.extend(Elevation::Floating.shadows(palette).into_iter().skip(1));
    shadows
}

fn bar(
    panel: &BuildPanel,
    last: &LastBuild,
    build: &Entity<BuildPanel>,
    docked: bool,
    cx: &App,
) -> AnyElement {
    let (icon, ink) = severity_icon(tone(last), cx);
    let expanded = panel.expanded;
    let hover = tone_hover(cx);
    let toggle = {
        let build = build.clone();
        div()
            .id("compile-diagnostics-toggle")
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(8.))
            .h(px(28.))
            .px(px(6.))
            .rounded(px(6.))
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .text_role(TextRole::Caption, cx)
            .child(icon.element(px(15.), ink))
            .child(div().flex_1().min_w_0().truncate().child(title(last)))
            .child(
                if expanded {
                    icons::CHEVRON_UP
                } else {
                    icons::CHEVRON_DOWN
                }
                .element(px(13.), cx.palette().text_secondary),
            )
            .on_click(move |_, _, cx| {
                build.update(cx, |build, cx| build.set_expanded(!expanded, cx));
            })
    };
    let dock = {
        let build = build.clone();
        IconButton::new(
            "compile-diagnostics-dock",
            if docked {
                icons::PICTURE_IN_PICTURE
            } else {
                icons::PANEL_BOTTOM
            },
        )
        .frame(px(24.), px(24.))
        .icon_size(px(13.))
        .tooltip(if docked {
            t!("Float over the page")
        } else {
            t!("Dock below the page")
        })
        .on_click(move |_, _, cx| build.update(cx, |build, cx| build.set_docked(!docked, cx)))
    };
    let close = {
        let build = build.clone();
        IconButton::new("compile-diagnostics-dismiss", icons::X)
            .frame(px(24.), px(24.))
            .icon_size(px(14.))
            .tooltip(t!("Dismiss diagnostics"))
            .on_click(move |_, _, cx| build.update(cx, |build, cx| build.dismiss(cx)))
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .min_h(px(34.))
        .pt(px(4.))
        .pb(px(4.))
        .pl(px(8.))
        .pr(px(10.))
        .child(toggle)
        .child(dock)
        .child(close)
        .into_any_element()
}

fn body(
    panel: &BuildPanel,
    last: &LastBuild,
    build: &Entity<BuildPanel>,
    docked: bool,
    hover: &FluidHover,
    window: &mut Window,
    cx: &App,
) -> AnyElement {
    let has_log = !last.log.trim().is_empty();
    let has_messages = !last.diagnostics.is_empty();
    let on_log = panel.tab == OutputTab::Log || !has_messages;
    let switch = (has_log && (has_messages || panel.tab == OutputTab::Log)).then(|| {
        let tabs = has_messages.then(|| {
            let (to_messages, to_log) = (build.clone(), build.clone());
            Segmented::new("compile-diagnostics-tabs")
                .label(
                    t!("Messages"),
                    panel.tab == OutputTab::Messages,
                    move |_, _, cx| {
                        to_messages.update(cx, |build, cx| build.set_tab(OutputTab::Messages, cx));
                    },
                )
                .label(t!("Log"), panel.tab == OutputTab::Log, move |_, _, cx| {
                    to_log.update(cx, |build, cx| build.set_tab(OutputTab::Log, cx));
                })
        });
        let copy = on_log.then(|| {
            let (build, log) = (build.clone(), last.log.clone());
            let copied = panel.copied.is_some_and(|(slot, _)| slot == LOG_COPY);
            Button::new("compile-log-copy", t!("Copy log"))
                .ghost()
                .compact()
                .icon(if copied {
                    Icon::CHECK_HEAVY
                } else {
                    icons::COPY
                })
                .on_click(move |_, _, cx| {
                    let log = log.clone();
                    build.update(cx, |build, cx| build.copy(LOG_COPY, log, cx));
                })
        });
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .min_h(px(28.))
            .children(tabs)
            .child(div().flex_1())
            .children(copy)
    });
    let list =
        (!on_log || !has_log).then(|| messages(panel, last, build, docked, hover, window, cx));
    let log = (on_log && has_log).then(|| log_view(panel, last, docked, cx));
    let empty = (!last.success && !has_messages && !has_log).then(|| {
        div()
            .px(px(8.))
            .text_role(TextRole::Caption, cx)
            .child(t!("Build failed without a captured log"))
    });
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .px(px(8.))
        .pb(px(8.))
        .when(docked, |body| body.flex_1().min_h(px(80.)))
        .children(switch)
        .children(list)
        .children(log)
        .children(empty)
        .into_any_element()
}

/// The panel in the dock: the headline over the same messages and log,
/// at full height.
pub fn panel(
    panel: &BuildPanel,
    build: &Entity<BuildPanel>,
    hover: &FluidHover,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let Some(last) = panel.last() else {
        let text = match panel.document() {
            Some(document) => t!("Building {document}…", document = document),
            None => t!(
                "Not built yet. Press {0} to build",
                crate::shell::BUILD_SHORTCUT_LABEL
            ),
        };
        return div()
            .p(px(14.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(text)
            .into_any_element();
    };
    let (icon, ink) = severity_icon(tone(last), cx);
    let has_messages = !last.diagnostics.is_empty();
    let on_log = panel.tab == OutputTab::Log || !has_messages;
    let tabs = has_messages.then(|| {
        let (to_messages, to_log) = (build.clone(), build.clone());
        Segmented::new("build-panel-tabs")
            .label(t!("Messages"), !on_log, move |_, _, cx| {
                to_messages.update(cx, |build, cx| build.set_tab(OutputTab::Messages, cx));
            })
            .label(t!("Log"), on_log, move |_, _, cx| {
                to_log.update(cx, |build, cx| build.set_tab(OutputTab::Log, cx));
            })
    });
    let content = if on_log {
        log_lines(&panel.panel_log, last, cx)
            .flex_1()
            .min_h_0()
            .into_any_element()
    } else {
        message_list(panel, last, build, hover, cx)
            .flex_1()
            .min_h_0()
            .into_any_element()
    };
    div()
        .size_full()
        .flex()
        .flex_col()
        .gap(px(6.))
        .px(px(8.))
        .pb(px(8.))
        .text_color(palette.text_secondary)
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .h(px(34.))
                .px(px(6.))
                .text_role(TextRole::Caption, cx)
                .child(icon.element(px(15.), ink))
                .child(div().flex_1().min_w_0().truncate().child(title(last)))
                .children(tabs),
        )
        .child(content)
        .into_any_element()
}

fn messages(
    panel: &BuildPanel,
    last: &LastBuild,
    build: &Entity<BuildPanel>,
    docked: bool,
    hover: &FluidHover,
    _: &mut Window,
    cx: &App,
) -> AnyElement {
    let explained = last
        .explained
        .iter()
        .zip(&last.diagnostics)
        .any(|(explained, diagnostic)| {
            explained.is_some() && severity(&diagnostic.level) == Severity::Error
        });
    let list = message_list(panel, last, build, hover, cx);
    if docked {
        list.flex_1().min_h_0().into_any_element()
    } else {
        list.max_h(px(if explained { 320. } else { 168. }))
            .into_any_element()
    }
}

/// The messages' one gliding fill: the rows a click takes somewhere join
/// it, one section per file, so the fill fades across a file's heading.
pub fn diagnostics_hover(id: &'static str, window: &mut Window, cx: &mut App) -> FluidHover {
    let fill = tone_hover(cx);
    FluidHover::new(id, window, cx).fill(fill).radius(px(6.))
}

fn message_list(
    panel: &BuildPanel,
    last: &LastBuild,
    build: &Entity<BuildPanel>,
    hover: &FluidHover,
    cx: &App,
) -> gpui::Stateful<gpui::Div> {
    let palette = cx.palette().clone();
    // Each message's place in the sorted list, which is what the panel's
    // actions name it by.
    let index_of = |diagnostic: &Diagnostic| {
        last.diagnostics
            .iter()
            .position(|item| std::ptr::eq(item, diagnostic))
            .unwrap_or(0)
    };
    let groups = group_by_file(&last.diagnostics)
        .into_iter()
        .enumerate()
        .map(|(section, group)| {
            let count = group.diagnostics.len();
            let header = div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .px(px(8.))
                .text_role(TextRole::Micro, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child(group.file.clone().unwrap_or_else(|| t!("Build log").into()))
                .when(count > 1, |header| {
                    header.child(
                        div()
                            .font_weight(FontWeight::NORMAL)
                            .opacity(0.8)
                            .child(count.to_string()),
                    )
                });
            let rows = group.diagnostics.iter().map(|diagnostic| {
                let glide = Glide { hover, section };
                row(
                    panel,
                    last,
                    index_of(diagnostic),
                    diagnostic,
                    build,
                    glide,
                    cx,
                )
            });
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .min_w_0()
                .child(header)
                .child(div().flex().flex_col().children(rows))
        });
    div()
        .id("compile-diagnostics-list")
        .relative()
        .flex()
        .flex_col()
        .gap(px(8.))
        .overflow_y_scroll()
        .child(hover.highlight())
        .children(groups)
}

/// A row's place in the messages' fluid hover.
#[derive(Clone, Copy)]
struct Glide<'a> {
    hover: &'a FluidHover,
    section: usize,
}

fn line_label(diagnostic: &Diagnostic, cx: &App) -> Option<AnyElement> {
    diagnostic.line.filter(|line| *line > 0).map(|line| {
        div()
            .flex_none()
            .whitespace_nowrap()
            .text_role(TextRole::Micro, cx)
            .line_height(px(17.6))
            .text_color(cx.palette().text_secondary)
            .child(t!("line {line}", line = line))
            .into_any_element()
    })
}

/// What a row's button shows: the message, its weight, its severity mark,
/// and what its tooltip says.
struct ItemLook {
    message: String,
    weight: FontWeight,
    mark: (Icon, Hsla),
    tooltip: Option<String>,
}

/// The row's button: its mark, the message and its line; a click goes there.
fn item(
    ix: usize,
    diagnostic: &Diagnostic,
    look: ItemLook,
    build: &Entity<BuildPanel>,
    glide: Glide<'_>,
    cx: &App,
) -> AnyElement {
    let ItemLook {
        message,
        weight,
        mark,
        tooltip,
    } = look;
    let navigable = diagnostic.file.is_some() || diagnostic.line.is_some();
    let palette = cx.palette().clone();
    let build = build.clone();
    let item = div()
        .id(("compile-diagnostic", ix))
        .flex()
        .flex_1()
        .min_w_0()
        .items_start()
        .gap(px(8.))
        .min_h(px(30.))
        .py(px(6.))
        .px(px(8.))
        .rounded(px(6.))
        .text_role(TextRole::Caption, cx)
        .child(div().pt(px(1.)).child(mark.0.element(px(15.), mark.1)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .line_height(px(17.4))
                .font_weight(weight)
                .text_color(palette.text)
                .child(message),
        )
        .children(line_label(diagnostic, cx))
        .when(navigable, |item| {
            item.cursor_pointer()
                .on_click(move |_, _, cx| build.update(cx, |build, cx| build.select(ix, cx)))
        })
        .when(!navigable, |item| item.opacity(0.88))
        .when_some(tooltip, |item, tooltip| {
            item.tooltip(move |_, cx| {
                lattice_ui::components::LatticeTooltip::view(tooltip.clone(), None, cx)
            })
        });
    // Only a row a click takes somewhere joins the glide: lighting one that
    // goes nowhere would promise a click with nowhere to land.
    if navigable {
        glide
            .hover
            .item_as(ix, ItemKind::target().section(glide.section), item)
    } else {
        item.into_any_element()
    }
}

fn copy_button(
    panel: &BuildPanel,
    ix: usize,
    text: String,
    build: &Entity<BuildPanel>,
) -> AnyElement {
    let copied = panel.copied.is_some_and(|(slot, _)| slot == ix);
    let build = build.clone();
    IconButton::new(
        ("compile-diagnostic-copy", ix),
        if copied {
            Icon::CHECK_HEAVY
        } else {
            icons::COPY
        },
    )
    .frame(px(24.), px(24.))
    .icon_size(px(12.))
    .tooltip(t!("Copy error message"))
    .on_click(move |_, _, cx| {
        let text = text.clone();
        build.update(cx, |build, cx| build.copy(ix, text, cx));
    })
    .into_any_element()
}

fn row(
    panel: &BuildPanel,
    last: &LastBuild,
    ix: usize,
    diagnostic: &Diagnostic,
    build: &Entity<BuildPanel>,
    glide: Glide<'_>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let level = severity(&diagnostic.level);
    let location = location_label(diagnostic);
    let copy = copy_button(
        panel,
        ix,
        format!("{location} {}", diagnostic.message),
        build,
    );
    let explained = last.explained.get(ix).and_then(Option::as_ref);
    if let Some(replacement) = panel.replaced.get(&ix) {
        let headline = explained.map_or_else(|| diagnostic.message.clone(), |e| e.headline.clone());
        return div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .pb(px(6.))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .min_h(px(30.))
                    .py(px(6.))
                    .px(px(8.))
                    .text_role(TextRole::Caption, cx)
                    .child(
                        div()
                            .pt(px(1.))
                            .child(Icon::CHECK_HEAVY.element(px(15.), palette.success)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .line_through()
                            .text_decoration_color(palette.text_secondary)
                            .text_color(palette.text_secondary)
                            .child(headline),
                    )
                    .children(line_label(diagnostic, cx)),
            )
            .child(
                div()
                    .px(px(8.))
                    .text_role(TextRole::Caption, cx)
                    .line_height(px(18.))
                    .text_color(palette.text_secondary)
                    .child(strip_tags(&t!(
                        "Replaced with <0>{replacement}</0>. Building again to confirm the fix.",
                        replacement = replacement
                    ))),
            )
            .into_any_element();
    }
    if let Some(explained) = explained.filter(|_| level == Severity::Error) {
        return explained_row(panel, ix, diagnostic, explained, copy, build, glide, cx);
    }
    let shown = explained.map_or_else(|| diagnostic.message.clone(), |e| e.headline.clone());
    let tooltip = Some(match explained {
        Some(explained) => format!(
            "{}\n\n{}",
            explained.explanation,
            t!("TeX: {0}", diagnostic.message)
        ),
        None => diagnostic.message.clone(),
    });
    let install = install_target(diagnostic).map(|file| {
        let build = build.clone();
        Button::new(("compile-diagnostic-install", ix), t!("Install"))
            .ghost()
            .compact()
            .on_click(move |_, _, cx| {
                let file = file.clone();
                build.update(cx, |build, cx| build.act(BuildAction::Install(file), cx));
            })
    });
    let switch = (diagnostic.code == Some("pdftex-only-command")).then(|| {
        let build = build.clone();
        Button::new(
            ("compile-diagnostic-pdflatex", ix),
            t!("Switch to pdfLaTeX"),
        )
        .ghost()
        .compact()
        .on_click(move |_, _, cx| {
            build.update(cx, |build, cx| {
                let action = BuildAction::SwitchEngine {
                    engine: "pdf".into(),
                    keep: false,
                };
                build.act(action, cx);
            });
        })
    });
    // `lineno-outdated`: only an update fixes it, the doctor's, behind the
    // same administrator prompt, so either place shows its progress.
    let update = (diagnostic.code == Some("lineno-outdated"))
        .then(|| package_update(ix, cx))
        .flatten();
    let undo = (diagnostic.code == Some("engine-switched"))
        .then(|| diagnostic.params.get("previous").cloned())
        .flatten()
        .map(|previous| {
            let build = build.clone();
            Button::new(("compile-diagnostic-undo", ix), t!("Undo"))
                .ghost()
                .compact()
                .on_click(move |_, _, cx| {
                    let engine = previous.clone();
                    build.update(cx, |build, cx| {
                        build.act(BuildAction::SwitchEngine { engine, keep: true }, cx);
                    });
                })
        });
    div()
        .flex()
        .items_center()
        .gap(px(2.))
        .min_w_0()
        .child(item(
            ix,
            diagnostic,
            ItemLook {
                message: shown,
                weight: FontWeight::NORMAL,
                mark: severity_icon(level, cx),
                tooltip,
            },
            build,
            glide,
            cx,
        ))
        .children(install)
        .children(switch)
        .children(update)
        .children(undo)
        .child(copy)
        .into_any_element()
}

/// A build notice's way to the TeX doctor's package update: its progress
/// while it runs, its result after, else the button.
fn package_update(ix: usize, cx: &App) -> Option<AnyElement> {
    let center = crate::build::tex_setup::center::center(cx)?;
    let palette = cx.palette().clone();
    let status = |text: String, ink: Hsla| {
        div()
            .flex_initial()
            .max_w(relative(0.45))
            .text_role(TextRole::Micro, cx)
            .line_height(px(16.))
            .text_color(ink)
            .child(text)
            .into_any_element()
    };
    let run = center.read(cx).packages().run.clone();
    Some(match run {
        Some(run) if run.running => {
            let waiting = run.progress.stage == "authorizing";
            let what = if waiting {
                t!("Waiting for administrator approval…")
            } else {
                t!("Updating LaTeX packages…")
            };
            status(
                format!("{what} {}%", run.progress.percent()),
                palette.text_secondary,
            )
        }
        Some(run) if run.error.is_none() => status(
            t!("TeX packages updated. Build again to use them.").into(),
            palette.text_secondary,
        ),
        run => {
            let failure = run
                .and_then(|run| run.error)
                .map(|error| crate::build::tex_setup::package_updates::update_failure(&error).0);
            div()
                .flex()
                .items_center()
                .gap(px(2.))
                .children(failure.map(|failure| status(failure, palette.danger)))
                .child(
                    Button::new(("compile-diagnostic-update", ix), t!("Update TeX packages"))
                        .ghost()
                        .compact()
                        .on_click(move |_, _, cx| {
                            center.update(cx, |center, cx| center.update_packages(cx));
                        }),
                )
                .into_any_element()
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn explained_row(
    _: &BuildPanel,
    ix: usize,
    diagnostic: &Diagnostic,
    explained: &Explained,
    copy: AnyElement,
    build: &Entity<BuildPanel>,
    glide: Glide<'_>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let replace = explained
        .suggestion
        .clone()
        .filter(|_| explained.token.is_some())
        .map(|suggestion| {
            let build = build.clone();
            Button::new(
                ("compile-explained-replace", ix),
                strip_tags(&t!(
                    "Replace with <0>{suggestion}</0>",
                    suggestion = suggestion
                )),
            )
            .compact()
            .on_click(move |_, _, cx| build.update(cx, |build, cx| build.replace(ix, cx)))
        });
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .pb(px(6.))
        .child(item(
            ix,
            diagnostic,
            ItemLook {
                message: explained.headline.clone(),
                weight: FONT_WEIGHT_MEDIUM,
                mark: severity_icon(Severity::Error, cx),
                // TeX's own words stay a hover away (and in the row's Copy).
                tooltip: Some(t!("TeX: {0}", diagnostic.message)),
            },
            build,
            glide,
            cx,
        ))
        .when(!explained.excerpt.is_empty(), |row| {
            row.child(excerpt(&explained.excerpt, cx))
        })
        .child(
            div()
                .px(px(8.))
                .text_role(TextRole::Caption, cx)
                .line_height(px(18.))
                .text_color(palette.text)
                .child(explained.explanation.clone()),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .pl(px(8.))
                .children(replace)
                .child(div().flex_1())
                .child(copy),
        )
        .into_any_element()
}

/// The failing line and one either side, numbered, the failing one tinted
/// and its token underlined. The token stays in view however narrow the
/// card: a long line is cut a little before it.
fn excerpt(lines: &[ExcerptLine], cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let font = cx.lattice().fonts.editor.clone();
    let rows = lines.iter().map(|line| {
        let text: AnyElement = match line.token {
            Some((start, end)) => {
                let cut = if start > EXCERPT_LEAD {
                    floor_char(&line.text, start - EXCERPT_LEAD + 4)
                } else {
                    0
                };
                let lead = format!(
                    "{}{}",
                    if cut > 0 { "…" } else { "" },
                    &line.text[cut..start]
                );
                div()
                    .flex()
                    .min_w_0()
                    .overflow_hidden()
                    .child(div().flex_none().child(SharedString::from(lead)))
                    .child(
                        div()
                            .flex_none()
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .text_color(palette.danger)
                            .underline()
                            .text_decoration_wavy()
                            .text_decoration_1()
                            .text_decoration_color(palette.danger)
                            .child(SharedString::from(line.text[start..end].to_string())),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(SharedString::from(line.text[end..].to_string())),
                    )
                    .into_any_element()
            }
            None => div()
                .min_w_0()
                .truncate()
                .child(SharedString::from(line.text.clone()))
                .into_any_element(),
        };
        div()
            .flex()
            .pr(px(8.))
            .whitespace_nowrap()
            .when(line.failing, |row| {
                row.bg(palette.danger.opacity(0.07))
                    .border_l_2()
                    .border_color(palette.danger)
                    .text_color(palette.text)
            })
            .child(
                div()
                    .flex_none()
                    .w(px(30.))
                    .pr(px(8.))
                    .text_right()
                    .text_color(palette.text_secondary)
                    .child(line.number.to_string()),
            )
            .child(div().flex_1().min_w_0().child(text))
    });
    div()
        .mx(px(8.))
        .py(px(6.))
        .rounded(px(6.))
        .overflow_hidden()
        .bg(palette.editor)
        .shadow(vec![gpui::BoxShadow {
            inset: true,
            ..ring(palette.line)
        }])
        .font_family(font)
        .text_size(px(11.))
        .line_height(px(20.))
        .text_color(palette.text_secondary)
        .children(rows)
        .into_any_element()
}

/// The char boundary at or before `at`.
fn floor_char(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}
