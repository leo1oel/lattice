//! The checklist panel (`get-started-panel.tsx`, `get-started.css`): a
//! Trellis tool panel on the input surface, the Submission checklist's
//! summary (a serif verdict on a raised plate, a segmented track and the
//! count), then the steps as one raised, hairline-divided list. A row is
//! its mark (a tick done, a dash skipped, else its number, inked on the
//! current step), its title and how it stands; the current step's row is
//! open, with its why (keys drawn as keys), what else it needs and its
//! actions. A row opened by hand stays open until another step gets done.
//!
//! Nothing dims or blocks the window and nothing listens for Escape: the
//! writer works in the real workspace with the list beside it. Setup is a
//! step, not a dialog over the list: installing LaTeX is the first step's
//! action, and a missing TeX found while the list is shown is that step's
//! to report (`Shell::missing_tex`).

use gpui::{
    AnyElement, App, Context, EventEmitter, FocusHandle, Focusable, HighlightStyle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_i18n::t;
use lattice_settings::SettingsTab;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::Button,
    interaction::{track_pointer, use_interaction},
    scrollbar::FluidScrollbar,
    shape::RADIUS_SURFACE,
    tokens::{
        FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR, FONT_WEIGHT_SEMIBOLD, RADIUS_CONTROL, RADIUS_PILL,
    },
    typography::tabular_nums,
};

use super::{Host, Keys, Step, StepText, fill, progress, split_keys, steps};
use crate::build::tex_setup::{self, center};
use crate::submission::checklist::view::{Tone, mark_disc, status_mark};

const CLAUDE_CODE_URL: &str = "https://github.com/anthropics/claude-code";
const CODEX_URL: &str = "https://github.com/openai/codex";

/// What the checklist asks of the window.
pub enum GetStartedEvent {
    /// Bring up the place `step` is about and ring it.
    ShowMe(Step),
    InstallLatex,
    NewProject,
    OpenFolder,
    FromOverleaf,
    OpenSettings(SettingsTab),
}

pub struct GetStartedPanel {
    focus_handle: FocusHandle,
    scroll: ScrollHandle,
    host: Host,
    /// The row opened by hand (`None`: the open one closed), and how many
    /// steps were done then.
    open: Option<(Option<Step>, usize)>,
    /// Whether "How to connect Claude Code or Codex" is unfolded.
    connect_open: bool,
    /// Whether the panel asked for a check of its own, once.
    asked: bool,
    _progress: Subscription,
    _tex: Option<Subscription>,
}

impl EventEmitter<GetStartedEvent> for GetStartedPanel {}
impl EventEmitter<PanelEvent> for GetStartedPanel {}

/// How the toolchain stands, as the first step reads it.
struct Tex {
    ready: bool,
    missing: bool,
    checking: bool,
    paper_tools_missing: bool,
}

fn tex(cx: &App) -> Tex {
    let center = center::center(cx);
    let center = center.as_ref().map(|center| center.read(cx));
    let report = center.and_then(|center| center.report());
    Tex {
        ready: report.is_some_and(|report| !tex_setup::compile_setup_missing(Some(report))),
        missing: report.is_some_and(|report| tex_setup::compile_setup_missing(Some(report))),
        checking: center.is_some_and(|center| center.busy()),
        paper_tools_missing: !tex_setup::missing_paper_tools(report).is_empty(),
    }
}

/// The checklist as it stands: which steps are done, the one to do next.
pub struct Standing {
    pub done: Vec<Step>,
    pub skipped: Vec<Step>,
    pub current: Option<Step>,
}

impl Standing {
    pub fn read(steps: &[StepText], cx: &App) -> Standing {
        let tex = tex(cx);
        let progress = progress::global_read(cx);
        let mut done: Vec<Step> = steps
            .iter()
            .map(|step| step.step)
            .filter(|step| progress.is_some_and(|progress| progress.is_done(*step)))
            .collect();
        // LaTeX stands as the last check found it, whatever was stored.
        if tex.ready && !done.contains(&Step::Latex) {
            done.insert(0, Step::Latex);
        } else if tex.missing {
            done.retain(|step| *step != Step::Latex);
        }
        let skipped: Vec<Step> = steps
            .iter()
            .map(|step| step.step)
            .filter(|step| progress.is_some_and(|progress| progress.is_skipped(*step)))
            .collect();
        let current = steps
            .iter()
            .map(|step| step.step)
            .find(|step| !done.contains(step) && !skipped.contains(step));
        Standing {
            done,
            skipped,
            current,
        }
    }
}

impl GetStartedPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let progress = progress::global(cx);
        let tex = center::center(cx).map(|center| {
            cx.observe(&center, |this, _, cx| {
                this.mark_latex(cx);
                cx.notify();
            })
        });
        Self {
            focus_handle: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            host: Host::current(),
            open: None,
            connect_open: false,
            asked: false,
            _progress: cx.observe(&progress, |_, _, cx| cx.notify()),
            _tex: tex,
        }
    }

    /// A check that found the toolchain marks the first step.
    fn mark_latex(&mut self, cx: &mut Context<Self>) {
        if tex(cx).ready {
            progress::mark(Step::Latex, cx);
        }
    }

    /// The panel came on screen: a check is asked for, once, when the
    /// launch's never ran.
    pub fn shown(&mut self, cx: &mut Context<Self>) {
        self.mark_latex(cx);
        let Some(center) = center::center(cx) else {
            return;
        };
        let idle = {
            let center = center.read(cx);
            center.report().is_none() && !center.busy()
        };
        if !self.asked && idle {
            self.asked = true;
            center.update(cx, |center, cx| center.run_doctor(false, cx).detach());
        }
    }

    fn value_of(&self, step: Step, standing: &Standing, tex: &Tex) -> Option<String> {
        if step == Step::Latex {
            return if tex.ready {
                Some(t!("Ready").into())
            } else if tex.checking {
                Some(t!("Checking…").into())
            } else if tex.missing {
                Some(t!("Not installed").into())
            } else {
                None
            };
        }
        if standing.done.contains(&step) {
            Some(t!("Done").into())
        } else if standing.skipped.contains(&step) {
            Some(t!("Skipped").into())
        } else {
            None
        }
    }

    fn actions_of(
        &self,
        step: &StepText,
        standing: &Standing,
        tex: &Tex,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let id = step.step;
        let button = |name: &'static str, label: SharedString| {
            Button::new(
                SharedString::from(format!("get-started-{}-{name}", id.id())),
                label,
            )
            .compact()
        };
        match id {
            Step::Latex => {
                // Without a report (a check that could not run), setup
                // checks again itself.
                if tex.ready || tex.checking {
                    return vec![];
                }
                // Linux has no one-click install: the step says to install
                // TeX Live from the distribution, and Recheck looks again.
                if self.host == Host::Linux {
                    return vec![
                        button("recheck", t!("Recheck").into())
                            .primary()
                            .on_click(cx.listener(|_, _, _, cx| {
                                if let Some(center) = center::center(cx) {
                                    center.update(cx, |center, cx| {
                                        center.run_doctor(false, cx).detach()
                                    });
                                }
                            }))
                            .into_any_element(),
                    ];
                }
                vec![
                    button("install", t!("Install LaTeX").into())
                        .primary()
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(GetStartedEvent::InstallLatex)))
                        .into_any_element(),
                ]
            }
            Step::Own => vec![
                button("new", t!("New project").into())
                    .primary()
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(GetStartedEvent::NewProject)))
                    .into_any_element(),
                button("folder", t!("Open folder").into())
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(GetStartedEvent::OpenFolder)))
                    .into_any_element(),
                button("overleaf", t!("From Overleaf").into())
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(GetStartedEvent::FromOverleaf)))
                    .into_any_element(),
            ],
            _ => {
                let mut actions = Vec::new();
                if step.hint.is_some() {
                    actions.push(
                        button("show", t!("Show me").into())
                            .primary()
                            .on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(GetStartedEvent::ShowMe(id))
                                }),
                            )
                            .into_any_element(),
                    );
                }
                if !standing.done.contains(&id) && !standing.skipped.contains(&id) {
                    actions.push(
                        button("skip", t!("Skip").into())
                            .ghost()
                            .on_click(move |_, _, cx| progress::skip(id, cx))
                            .into_any_element(),
                    );
                }
                actions
            }
        }
    }

    /// What a step needs besides its actions: the paper tools where citing
    /// needs them, and how to connect an agent.
    fn extra_of(
        &self,
        step: Step,
        tex: &Tex,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let palette = cx.palette().clone();
        let aside = || {
            div()
                .mt(px(10.))
                .p(px(10.))
                .rounded(RADIUS_CONTROL)
                .bg(palette.text.opacity(0.04))
                .flex()
                .flex_col()
        };
        let line = |text: SharedString, cx: &App| {
            div()
                .text_role(TextRole::BodyCompact, cx)
                .text_color(palette.text_secondary)
                .child(text)
        };
        let actions = || div().mt(px(8.)).flex().flex_wrap().gap(px(6.));
        match step {
            Step::Cite if tex.paper_tools_missing => vec![
                aside()
                    .child(line(
                        t!("Adding papers needs the paper tools, about 45 MB.").into(),
                        cx,
                    ))
                    .child(
                        actions().child(
                            Button::new("get-started-paper-tools", t!("Install paper tools"))
                                .compact()
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(GetStartedEvent::InstallLatex)
                                })),
                        ),
                    )
                    .into_any_element(),
            ],
            Step::Agent => {
                let open = self.connect_open;
                let (_, pointer) = use_interaction("get-started-connect", window, cx);
                let summary = track_pointer(
                    div()
                        .id("get-started-connect")
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .cursor_pointer()
                        .text_role(TextRole::BodyCompact, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .child(
                            if open {
                                Icon::CHEVRON_DOWN
                            } else {
                                Icon::CHEVRON_RIGHT
                            }
                            .element(px(12.), palette.text_secondary),
                        )
                        .child(t!("How to connect Claude Code or Codex"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.connect_open = !this.connect_open;
                            cx.notify();
                        })),
                    pointer,
                );
                let link = |id: &'static str, label: &'static str, url: &'static str| {
                    Button::new(id, label)
                        .compact()
                        .trailing_icon(Icon::ARROW_UP_RIGHT)
                        .on_click(move |_, _, cx| cx.open_url(url))
                };
                let numbered = |n: usize, body: AnyElement, cx: &App| {
                    div()
                        .flex()
                        .gap(px(6.))
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text_secondary)
                        .child(div().flex_none().w(px(10.)).child(format!("{n}.")))
                        .child(div().flex_1().min_w_0().child(body))
                };
                let sign_in = t!("Sign in once: run <0>claude</0> or <1>codex</1> in Terminal.");
                let connect = aside().child(summary).when(open, |aside| {
                    aside
                        .child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(numbered(
                                    1,
                                    div()
                                        .flex()
                                        .flex_col()
                                        .child(t!("Install one of them."))
                                        .child(
                                            div()
                                                .mt(px(4.))
                                                .flex()
                                                .flex_wrap()
                                                .gap(px(4.))
                                                .child(link("get-started-claude-code", "Claude Code", CLAUDE_CODE_URL))
                                                .child(link("get-started-codex", "Codex", CODEX_URL)),
                                        )
                                        .into_any_element(),
                                    cx,
                                ))
                                .child(numbered(2, tagged_code(sign_in, palette.text), cx))
                                .child(numbered(
                                    3,
                                    div()
                                        .child(t!(
                                            "Lattice runs the one it finds on your PATH, the way Terminal does. Installed somewhere else? Set its path in Settings › Providers."
                                        ))
                                        .into_any_element(),
                                    cx,
                                )),
                        )
                        .child(actions().child(
                            Button::new("get-started-providers", t!("Provider settings"))
                                .compact()
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(GetStartedEvent::OpenSettings(SettingsTab::Agent))
                                })),
                        ))
                });
                vec![
                    connect.into_any_element(),
                    aside()
                        .child(line(
                            t!(
                                "Or connect a model endpoint: your own API address, key and model name, with no command-line tool to install."
                            )
                            .into(),
                            cx,
                        ))
                        .child(actions().child(
                            Button::new("get-started-endpoint", t!("Connect a model endpoint"))
                                .compact()
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(GetStartedEvent::OpenSettings(SettingsTab::ModelEndpoint))
                                })),
                        ))
                        .into_any_element(),
                ]
            }
            _ => vec![],
        }
    }
}

/// A sentence with `<0>…</0>` and `<1>…</1>` around commands, the commands
/// inked as code is.
fn tagged_code(text: &str, ink: gpui::Hsla) -> AnyElement {
    let mut plain = String::new();
    let mut highlights = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let tag = &rest[open + 1..open + close];
        let end_tag = format!("</{tag}>");
        let after = &rest[open + close + 1..];
        let Some(end) = after.find(&end_tag) else {
            break;
        };
        plain.push_str(&rest[..open]);
        let start = plain.len();
        plain.push_str(&after[..end]);
        highlights.push((
            start..plain.len(),
            HighlightStyle {
                color: Some(ink),
                ..HighlightStyle::default()
            },
        ));
        rest = &after[end + end_tag.len()..];
    }
    plain.push_str(rest);
    StyledText::new(SharedString::from(plain))
        .with_highlights(highlights)
        .into_any_element()
}

/// A sentence with its keys drawn as keys (`.get-started-keys`): in ink, a
/// shade heavier, on a faint ground, a hair of space either side.
fn with_keys(text: &str, cx: &App) -> AnyElement {
    let palette = cx.palette();
    let mut plain = String::new();
    let mut highlights = Vec::new();
    for (key, piece) in split_keys(text) {
        if key {
            let start = plain.len();
            plain.push('\u{200A}');
            plain.push_str(piece);
            plain.push('\u{200A}');
            highlights.push((
                start..plain.len(),
                HighlightStyle {
                    color: Some(palette.text),
                    font_weight: Some(FONT_WEIGHT_MEDIUM),
                    background_color: Some(palette.text.opacity(0.07)),
                    ..HighlightStyle::default()
                },
            ));
        } else {
            plain.push_str(piece);
        }
    }
    StyledText::new(SharedString::from(plain))
        .with_highlights(highlights)
        .into_any_element()
}

impl Render for GetStartedPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let steps = steps(self.host);
        let keys = Keys::of(self.host);
        let standing = Standing::read(&steps, cx);
        let tex = tex(cx);
        let expanded = match self.open {
            Some((step, seen)) if seen == standing.done.len() => step,
            _ => standing.current,
        };
        let done_count = standing.done.len();
        let total = steps.len();
        let summary =
            div()
                .mb(px(10.))
                .pt(px(12.))
                .px(px(12.))
                .pb(px(10.))
                .rounded(RADIUS_SURFACE)
                .border_1()
                .border_color(palette.line)
                .bg(palette.raised)
                .child(
                    div()
                        .text_role(TextRole::Title, cx)
                        .text_color(palette.text)
                        .child(if standing.current.is_none() {
                            t!("You’re ready to write")
                        } else {
                            t!("Your first paper in Lattice")
                        }),
                )
                .child(
                    div()
                        .mt(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(div().flex_1().h(px(4.)).flex().gap(px(2.)).children(
                            steps.iter().map(|step| {
                                div().flex_1().h_full().rounded(RADIUS_PILL).bg(
                                    if standing.done.contains(&step.step) {
                                        palette.success
                                    } else {
                                        palette.line_strong
                                    },
                                )
                            }),
                        ))
                        .child(
                            div()
                                .flex_none()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .font_features(tabular_nums())
                                .child(format!("{done_count}/{total}")),
                        ),
                );
        let count = steps.len();
        let mut rows = Vec::with_capacity(count);
        for (index, step) in steps.iter().enumerate() {
            rows.push(self.render_step(index, step, &keys, &standing, &tex, expanded, window, cx));
        }
        let list = div()
            .flex()
            .flex_col()
            .rounded(RADIUS_SURFACE)
            .border_1()
            .border_color(palette.line)
            .bg(palette.raised)
            .overflow_hidden()
            .children(rows.into_iter().enumerate().map(|(index, row)| {
                div()
                    .when(index > 0, |row| row.border_t_1().border_color(palette.line))
                    .child(row)
            }));
        div()
            .id("get-started-panel")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .bg(palette.input)
            .child(
                div()
                    .id("get-started-scroll")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .pt(px(10.))
                            .px(px(10.))
                            .pb(px(16.))
                            .flex()
                            .flex_col()
                            .min_w_0()
                            .child(summary)
                            .child(list),
                    ),
            )
            .child(FluidScrollbar::vertical(
                "get-started-scrollbar",
                &self.scroll,
            ))
    }
}

impl GetStartedPanel {
    #[allow(clippy::too_many_arguments)]
    fn render_step(
        &self,
        index: usize,
        step: &StepText,
        keys: &Keys,
        standing: &Standing,
        tex: &Tex,
        expanded: Option<Step>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let id = step.step;
        let done = standing.done.contains(&id);
        let skipped = standing.skipped.contains(&id);
        let current = standing.current == Some(id);
        let open = expanded == Some(id);
        let mark = if done {
            status_mark(Tone::Ok, cx)
        } else if skipped {
            status_mark(Tone::None, cx)
        } else {
            let (ground, ink) = if current {
                (palette.text, palette.raised)
            } else {
                (palette.line, palette.text_secondary)
            };
            mark_disc(
                ground,
                div()
                    .text_role(TextRole::Micro, cx)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .font_features(tabular_nums())
                    .line_height(px(10.))
                    .text_color(ink)
                    .child(format!("{}", index + 1))
                    .into_any_element(),
            )
        };
        let (state, pointer) = use_interaction(
            SharedString::from(format!("get-started-head-{}", id.id())),
            window,
            cx,
        );
        let seen = standing.done.len();
        let head = track_pointer(
            div()
                .id(SharedString::from(format!("get-started-step-{}", id.id())))
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(10.))
                .py(px(8.))
                .cursor_pointer()
                .bg(state.wash(gpui::transparent_black(), palette.hover, palette.pressed))
                .child(mark)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_role(TextRole::Body, cx)
                        .font_weight(if done || skipped {
                            FONT_WEIGHT_REGULAR
                        } else {
                            FONT_WEIGHT_MEDIUM
                        })
                        .text_color(if done || skipped {
                            palette.text_secondary
                        } else {
                            palette.text
                        })
                        .child(lattice_i18n::tr(step.title)),
                )
                .children(self.value_of(id, standing, tex).map(|value| {
                    div()
                        .flex_none()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .font_features(tabular_nums())
                        .child(value)
                }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open = Some((if open { None } else { Some(id) }, seen));
                    cx.notify();
                })),
            pointer,
        );
        let body = open.then(|| {
            let actions = self.actions_of(step, standing, tex, cx);
            div()
                .pl(px(38.))
                .pr(px(10.))
                .pb(px(10.))
                .child(
                    div()
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text_secondary)
                        .child(with_keys(&fill(step.why, keys), cx)),
                )
                .children(self.extra_of(id, tex, window, cx))
                .when(!actions.is_empty(), |body| {
                    body.child(
                        div()
                            .mt(px(10.))
                            .flex()
                            .flex_wrap()
                            .gap(px(6.))
                            .children(actions),
                    )
                })
        });
        div()
            .flex()
            .flex_col()
            .when(current, |row| row.bg(palette.accent.opacity(0.05)))
            .child(head)
            .children(body)
            .into_any_element()
    }
}

impl Focusable for GetStartedPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for GetStartedPanel {
    fn panel_name(&self) -> &'static str {
        "GetStartedPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for GetStartedPanel {
    /// The tab's title, as Trellis names the tool (`trellis-titles.ts`).
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("Get started").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        t!("Get started")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}
