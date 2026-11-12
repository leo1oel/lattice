//! The Build button's card: the build as the sequence it was, pass by pass
//! (`src/trellis/trellis-build-sequence.tsx`, `.build-sequence` in
//! trellis.css).
//!
//! Every row is a pass latexmk really ran, in its order and with its own
//! time (lattice-core's `build_steps.rs` reads them off latexmk's output): a
//! second pdflatex for references, biber in place of bibtex, the prewarm's
//! draft passes on a cold build, or none at all when the PDF was already up
//! to date. SyncTeX is not a pass of its own, so its row says whether the map
//! came with the PDF. While a build runs the card fills in as each pass
//! starts, and the pass still running counts its own time. Its one action,
//! the first problem, is F8's too.

use std::time::{Duration, Instant};

use gpui::{
    AnimationExt as _, AnyElement, App, Entity, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Transformation, div,
    percentage, prelude::*, px,
};
use lattice_core::latex::BuildStep;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, elevation::Elevation,
    tokens::FONT_WEIGHT_SEMIBOLD,
};

use super::{icons, outcome::counts_text};
use crate::build_panel::BuildPanel;

const ENGINES: [&str; 6] = [
    "pdflatex", "xelatex", "lualatex", "latex", "platex", "uplatex",
];
const BIBLIOGRAPHY: [&str; 6] = [
    "bibtex", "bibtex8", "bibtexu", "pbibtex", "upbibtex", "biber",
];
const INDEX: [&str; 5] = ["makeindex", "mendex", "upmendex", "xindy", "texindy"];
const PDF_OUTPUT: [&str; 5] = ["xdvipdfmx", "dvipdfmx", "dvipdfm", "dvipdf", "ps2pdf"];
/// `preamble_format.rs`'s step: loads the preamble once so later passes skip it.
const PREAMBLE_FORMAT: &str = "pdflatex -ini";

#[cfg(target_os = "macos")]
const HINT: &str = "⌘S, or ⇧-click for a clean rebuild";
#[cfg(not(target_os = "macos"))]
const HINT: &str = "Ctrl+S, or Shift-click for a clean rebuild";

/// "0.6 s"; a pass too quick to show a tenth still took some time.
pub fn step_seconds(ms: u64) -> String {
    if ms < 50 {
        "<0.1 s".into()
    } else {
        format!("{:.1} s", ms as f64 / 1000.)
    }
}

/// What a pass did, beside its program's name.
pub fn role(step: &BuildStep) -> Option<String> {
    let tool = step.tool.as_str();
    let run = step.run;
    Some(if step.draft {
        format!("draft pass {run}")
    } else if tool == PREAMBLE_FORMAT {
        "preamble".into()
    } else if ENGINES.contains(&tool) {
        format!("pass {run}")
    } else if BIBLIOGRAPHY.contains(&tool) {
        "bibliography".into()
    } else if INDEX.contains(&tool) {
        "index".into()
    } else if tool == "makeglossaries" {
        "glossary".into()
    } else if PDF_OUTPUT.contains(&tool) {
        "PDF output".into()
    } else if tool == "dvips" {
        "PostScript output".into()
    } else if run > 1 {
        format!("run {run}")
    } else {
        return None;
    })
}

/// "just now", "3 minutes ago": how long ago a build finished, as
/// `Intl.RelativeTimeFormat` with `numeric: "auto"` says it.
pub fn age(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs_f64();
    let ago = |count: f64, one: &str, many: &str, previous: &str| {
        let count = count.round() as u64;
        match count {
            0 => format!("this {one}"),
            1 if !previous.is_empty() => previous.to_string(),
            1 => format!("1 {one} ago"),
            count => format!("{count} {many} ago"),
        }
    };
    if seconds < 45. {
        "just now".into()
    } else if seconds < 3600. {
        ago(seconds / 60., "minute", "minutes", "")
    } else if seconds < 86_400. {
        ago(seconds / 3600., "hour", "hours", "")
    } else {
        ago(seconds / 86_400., "day", "days", "yesterday")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StepState {
    Done,
    Running,
    Failed,
    Warning,
    None,
}

fn mark(state: StepState, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let (ground, ink): (Hsla, Hsla) = match state {
        StepState::Done => (palette.success_soft, palette.success),
        StepState::Failed => (palette.danger_soft, palette.danger),
        StepState::Warning => (palette.warning_soft, palette.warning),
        StepState::Running => (gpui::transparent_black(), palette.text_secondary),
        StepState::None => (palette.line, palette.text_secondary),
    };
    let glyph: AnyElement = match state {
        StepState::Running => icons::LOADER
            .element(px(14.), ink)
            .with_animation(
                "build-sequence-running",
                gpui::Animation::new(Duration::from_secs(1)).repeat(),
                |mark, t| mark.with_transformation(Transformation::rotate(percentage(t))),
            )
            .into_any_element(),
        StepState::Done => Icon::CHECK_HEAVY.element(px(12.), ink).into_any_element(),
        StepState::Failed => icons::X.element(px(12.), ink).into_any_element(),
        StepState::Warning => div()
            .text_size(px(12.))
            .line_height(px(12.))
            .font_weight(FONT_WEIGHT_SEMIBOLD)
            .text_color(ink)
            .child("!")
            .into_any_element(),
        StepState::None => icons::MINUS.element(px(12.), ink).into_any_element(),
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(18.))
        .rounded_full()
        .bg(ground)
        .child(glyph)
        .into_any_element()
}

/// One row: its mark, the program and what it did, and its time.
fn step_row(
    state: StepState,
    tool: String,
    what: Option<String>,
    time: Option<String>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .py(px(6.))
        .px(px(10.))
        .rounded(px(6.))
        .child(mark(state, cx))
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .child(div().truncate().child(tool))
                .children(what.map(|what| {
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(what)
                })),
        )
        .children(time.map(|time| {
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_role(TextRole::Caption, cx)
                .text_color(if state == StepState::Running {
                    palette.text
                } else {
                    palette.text_secondary
                })
                .child(time)
        }))
        .into_any_element()
}

/// The card, drawn afresh with the build: its owner redraws as the build
/// goes (the Build button's panel observes it).
pub fn card(build: &Entity<BuildPanel>, cx: &App) -> AnyElement {
    {
        let palette = cx.palette().clone();
        let build = build.clone();
        let panel = build.read(cx);
        let running = panel.running();
        let building = running.is_some();
        let outcome = if building {
            None
        } else {
            panel.outcome().cloned()
        };
        let card = div()
            .flex()
            .flex_col()
            .p(px(4.))
            .rounded(px(10.))
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_role(TextRole::Body, cx)
            .text_color(palette.text);
        let hint = |idle: bool| {
            div()
                .mt(px(if idle { 0. } else { 4. }))
                .pt(px(if idle { 6. } else { 8. }))
                .px(px(10.))
                .pb(px(4.))
                .when(!idle, |hint| hint.border_t_1().border_color(palette.line))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(HINT)
        };
        let Some((elapsed, steps, outcome)) = (match (running, &outcome) {
            (Some((started, steps)), _) => Some((Some(started.elapsed()), steps.to_vec(), None)),
            (None, Some(outcome)) => Some((None, outcome.steps.clone(), Some(outcome.clone()))),
            (None, None) => None,
        }) else {
            return card.child(hint(true)).into_any_element();
        };
        let elapsed_ms = elapsed.map(|elapsed| elapsed.as_millis() as u64);
        let lasted = |step: &BuildStep| {
            step.duration_ms
                .unwrap_or_else(|| elapsed_ms.unwrap_or(0).saturating_sub(step.started_ms))
        };
        let failed = outcome.as_ref().is_some_and(|outcome| !outcome.succeeded);
        // A failed build's errors are its last real pass's: latexmk stops
        // there, or carries on past them to finish there.
        let failed_at = if failed {
            steps.iter().rposition(|step| !step.draft)
        } else {
            None
        };
        let state_of = |step: &BuildStep, ix: usize| {
            if step.duration_ms.is_none() {
                StepState::Running
            } else if Some(ix) == failed_at {
                StepState::Failed
            } else {
                StepState::Done
            }
        };
        let total_ms = elapsed_ms.or_else(|| match &outcome {
            Some(outcome) if outcome.succeeded => Some(outcome.duration.as_millis() as u64),
            _ => steps.last().map(|last| last.started_ms + lasted(last)),
        });
        let pages = outcome
            .as_ref()
            .and_then(|outcome| outcome.pages)
            .map(|pages| {
                if pages == 1 {
                    "1 page".to_string()
                } else {
                    format!("{} pages", super::word_count::format_count(pages as usize))
                }
            });
        let facts = [pages, total_ms.map(step_seconds)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
        let verdict = match &outcome {
            None => "Building…",
            Some(outcome) if outcome.succeeded => "Built",
            Some(outcome) if outcome.wrote_pdf => "Built with errors",
            Some(_) => "Build failed",
        };
        let place = outcome.as_ref().map(|outcome| {
            [
                outcome.root_document.clone(),
                Some(age(Instant::now().duration_since(outcome.finished_at))),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ")
        });
        let head = div()
            .flex()
            .flex_wrap()
            .items_baseline()
            .gap_x(px(8.))
            .min_w_0()
            .pt(px(6.))
            .px(px(10.))
            .child(div().text_role(TextRole::Title, cx).child(verdict))
            .when(!facts.is_empty(), |head| {
                head.child(
                    div()
                        .ml_auto()
                        .whitespace_nowrap()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(facts),
                )
            })
            .children(place.map(|place| {
                div()
                    .w_full()
                    .truncate()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(place)
            }));
        let total: u64 = steps.iter().map(&lasted).sum();
        let track = (!steps.is_empty()).then(|| {
            div()
                .flex()
                .gap(px(2.))
                .h(px(4.))
                .mt(px(8.))
                .mx(px(10.))
                .mb(px(4.))
                .children(steps.iter().enumerate().map(|(ix, step)| {
                    let color = match state_of(step, ix) {
                        StepState::Running => palette.line_strong,
                        StepState::Failed => palette.danger,
                        _ if step.draft => palette.success_soft,
                        _ => palette.success,
                    };
                    // Every pass keeps a sliver, so a quick bibtex between
                    // two pdflatex runs still shows as its own segment.
                    let grow = (lasted(step) as f32).max(total as f32 * 0.03).max(1.);
                    div()
                        .min_w(px(4.))
                        .h_full()
                        .flex_basis(px(0.))
                        .rounded_full()
                        .bg(color)
                        .map(|mut segment| {
                            segment.style().flex_grow = Some(grow);
                            segment
                        })
                }))
        });
        let mut rows: Vec<AnyElement> = steps
            .iter()
            .enumerate()
            .map(|(ix, step)| {
                step_row(
                    state_of(step, ix),
                    step.tool.clone(),
                    role(step),
                    Some(step_seconds(lasted(step))),
                    cx,
                )
            })
            .collect();
        if building && steps.is_empty() {
            rows.push(step_row(
                StepState::Running,
                "latexmk".into(),
                Some("starting".into()),
                None,
                cx,
            ));
        }
        if let Some(outcome) = outcome.as_ref().filter(|outcome| outcome.succeeded) {
            if steps.is_empty() {
                rows.push(step_row(
                    StepState::None,
                    "Nothing to rerun".into(),
                    None,
                    None,
                    cx,
                ));
            }
            // A failed build's PDF, and its map, are the previous build's.
            if let Some(synctex) = outcome.synctex {
                let state = if synctex {
                    StepState::Done
                } else {
                    StepState::None
                };
                let what = (!synctex).then(|| "not written".to_string());
                rows.push(step_row(state, "SyncTeX".into(), what, None, cx));
            }
        }
        let issue = outcome.as_ref().and_then(|outcome| {
            let issue = outcome.issue.as_ref()?;
            let error = issue.level == "error";
            let where_ = issue.file.as_ref().map(|file| {
                let name = file.rsplit('/').next().unwrap_or(file);
                match issue.line {
                    Some(line) if line > 0 => format!("{name}:{line}"),
                    _ => name.to_string(),
                }
            });
            let tone = if error {
                palette.danger
            } else {
                palette.warning
            };
            let hover = palette.text_secondary.opacity(0.14);
            let build = build.clone();
            let mut tally = outcome.counts;
            tally.info = 0;
            Some(
                div()
                    .id("build-sequence-issue")
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .mt(px(2.))
                    .py(px(6.))
                    .px(px(10.))
                    .rounded(px(6.))
                    .bg(palette.text_secondary.opacity(0.08))
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .child(mark(
                        if error {
                            StepState::Failed
                        } else {
                            StepState::Warning
                        },
                        cx,
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_color(palette.text)
                                    .child(counts_text(&tally)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(px(4.))
                                    .min_w_0()
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(tone)
                                    .child(div().min_w_0().truncate().child(issue.message.clone()))
                                    .children(where_.map(|where_| {
                                        div()
                                            .flex_none()
                                            .max_w(gpui::relative(0.5))
                                            .truncate()
                                            .pl(px(6.))
                                            .child(where_)
                                    })),
                            ),
                    )
                    .child(icons::CHEVRON_RIGHT.element(px(12.), palette.text_secondary))
                    .on_click(move |_, _, cx| {
                        build.update(cx, |build, cx| build.first_problem(cx))
                    }),
            )
        });
        card.w(px(320.))
            .child(head)
            .children(track)
            .child(div().flex().flex_col().children(rows))
            .children(issue)
            .child(hint(false))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(tool: &str, run: u32, draft: bool) -> BuildStep {
        BuildStep {
            tool: tool.into(),
            run,
            draft,
            started_ms: 0,
            duration_ms: Some(1),
        }
    }

    #[test]
    fn each_pass_says_what_it_did() {
        assert_eq!(role(&step("pdflatex", 2, false)).as_deref(), Some("pass 2"));
        assert_eq!(
            role(&step("pdflatex", 1, true)).as_deref(),
            Some("draft pass 1")
        );
        assert_eq!(
            role(&step("biber", 1, false)).as_deref(),
            Some("bibliography")
        );
        assert_eq!(
            role(&step("pdflatex -ini", 1, false)).as_deref(),
            Some("preamble")
        );
        assert_eq!(
            role(&step("xdvipdfmx", 1, false)).as_deref(),
            Some("PDF output")
        );
        assert_eq!(role(&step("custom", 1, false)), None);
        assert_eq!(role(&step("custom", 3, false)).as_deref(), Some("run 3"));
    }

    #[test]
    fn a_quick_pass_still_took_some_time() {
        assert_eq!(step_seconds(10), "<0.1 s");
        assert_eq!(step_seconds(640), "0.6 s");
    }

    #[test]
    fn ages_read_as_relative_time() {
        assert_eq!(age(Duration::from_secs(10)), "just now");
        assert_eq!(age(Duration::from_secs(60)), "1 minute ago");
        assert_eq!(age(Duration::from_secs(180)), "3 minutes ago");
        assert_eq!(age(Duration::from_secs(7200)), "2 hours ago");
        assert_eq!(age(Duration::from_secs(86_400)), "yesterday");
    }
}
