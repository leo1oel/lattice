//! The live preview's state, as a small pill over the PDF
//! (`src/live-preview/live-preview-status.tsx` and `live-preview.css`):
//! downloading rtex, starting, the first layout, live, a layout catching up,
//! or stopped; its dot pulses while a quiet build brings the full PDF up to
//! date. It floats at the bottom left of the pages rather than joining the
//! PDF toolbar, so it costs the toolbar no width in a narrow panel, and while
//! all is live it shrinks to its dot, so it does not sit over the page while
//! the writer types; the tooltip still names it. Live preview is on by
//! default, so a Mac that cannot run it or a download that failed shows
//! nothing here: the PDF just updates with each build, and Settings says
//! why.

use gpui::{
    Animation, AnimationExt as _, AnyElement, AnyView, App, AppContext as _, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, ease_in_out, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    interaction::{mix, track_pointer, use_interaction},
    components::{PopFrom, tip_in},
    motion::Motion,
    tokens::{RADIUS_CONTROL, SPACING_2, SPACING_3, SPACING_5, SPACING_6, SPACING_16},
};

use super::{LivePreview, Phase, State};

/// The pill's ink, by what it says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Busy,
    Live,
    Pending,
    Stopped,
}

/// What the pill says, and the tooltip under it.
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub tone: Tone,
    pub label: SharedString,
    pub tip: SharedString,
    /// A quiet build is bringing the full PDF up to date: the dot pulses.
    pub rebuilding: bool,
}

/// What the pill shows for `preview`, or `None` when it shows nothing.
pub fn status(preview: &LivePreview) -> Option<Status> {
    let state = preview.state();
    let snapshot = preview.snapshot();
    if matches!(state, State::Off | State::Unavailable | State::DownloadFailed(_)) {
        return None;
    }
    let about = t!(
        "Live preview redraws the paragraph you are typing within milliseconds, with rtex and \
         your own LuaLaTeX. Page breaks, references, the exported PDF and jumps to the source \
         still come from the normal build."
    );
    let phase = snapshot.map(|snapshot| snapshot.phase);
    let (tone, label, detail): (Tone, String, Option<String>) = match state {
        State::Downloading(progress) => {
            let percent = (progress * 100.).round() as u32;
            (
                Tone::Busy,
                t!("Setting up live preview… {percent}%", percent = percent).to_string(),
                Some(t!("Downloading rtex once, about 4 MB. Builds work as usual meanwhile. You can turn it off in Settings › Editor & builds.").to_string()),
            )
        }
        State::Starting => (
            Tone::Busy,
            t!("Starting live preview…").to_string(),
            Some(t!("Loading your preamble into LuaLaTeX.").to_string()),
        ),
        _ if phase == Some(Phase::Starting) => (
            Tone::Busy,
            t!("Starting live preview…").to_string(),
            Some(t!("Loading your preamble into LuaLaTeX.").to_string()),
        ),
        State::Failed(message) => (
            Tone::Stopped,
            t!("Live preview stopped").to_string(),
            Some(message.clone()),
        ),
        _ if phase == Some(Phase::FirstLayout) => (
            Tone::Busy,
            t!("First layout…").to_string(),
            Some(t!("Typesetting the whole document once. Typing shows here as soon as it finishes.").to_string()),
        ),
        _ if phase == Some(Phase::Error) => (
            Tone::Stopped,
            t!("Live preview stopped").to_string(),
            Some(
                snapshot
                    .and_then(|snapshot| snapshot.detail.clone())
                    .unwrap_or_else(|| t!("rtex stopped. The PDF still updates with each build.").to_string()),
            ),
        ),
        _ if phase == Some(Phase::Paused) => (
            Tone::Pending,
            t!("Live typing paused").to_string(),
            Some(t!("rtex could not load the preamble for live typing. The preview still updates after each full layout and build.").to_string()),
        ),
        _ if snapshot.is_some_and(|snapshot| snapshot.layout_pending) => (
            Tone::Pending,
            t!("Layout updating").to_string(),
            Some(t!("The paragraph you typed is shown. Page breaks and what follows it catch up in a moment.").to_string()),
        ),
        _ => (Tone::Live, t!("Live").to_string(), None),
    };
    // The pulse stands in for the Build button's spinner and the PDF's
    // "Updating…", which a quiet build does not show (`quiet_builds.rs`).
    let rebuilding = tone != Tone::Stopped && snapshot.is_some_and(|snapshot| snapshot.rebuilding);
    let rebuild_note = rebuilding.then(|| {
        t!("The full PDF is rebuilding in the background. Page breaks, references and jumps to the source catch up when it finishes.").to_string()
    });
    let tip = [Some(label.clone()), detail, rebuild_note, Some(about.to_string())]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(Status {
        tone,
        label: label.into(),
        tip: tip.into(),
        rebuilding,
    })
}

/// The tooltip over the pill: its paragraphs, wrapped at `--space-16` × 9.
struct PillTip {
    text: SharedString,
}

impl Render for PillTip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let paragraphs: Vec<AnyElement> = self
            .text
            .split("\n\n")
            .map(|paragraph| div().child(SharedString::from(paragraph.to_string())).into_any_element())
            .collect();
        let card = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .max_w(SPACING_16 * 9.)
            .px(px(8.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text)
            .children(paragraphs);
        tip_in(("live-preview-tip", cx.entity_id()), PopFrom::Above, card)
    }
}

/// The pill, over the bottom left of the pages, or nothing.
pub fn pill(preview: &Entity<LivePreview>, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let status = status(preview.read(cx))?;
    let palette = cx.palette().clone();
    let stopped = status.tone == Tone::Stopped;
    let live = status.tone == Tone::Live;
    let dot_color = match status.tone {
        Tone::Live => palette.success,
        Tone::Pending => palette.warning,
        Tone::Stopped => palette.danger,
        Tone::Busy => palette.text_secondary,
    };
    let pulse = status.tone == Tone::Busy || status.rebuilding;
    let dot = div()
        .flex_none()
        .size(SPACING_3)
        .rounded_full()
        .bg(dot_color);
    let dot = if pulse {
        // `live-preview-status-pulse`: opacity 1 → 0.35 on the flourish
        // tier, ease-in-out, alternating; one animation here runs both
        // halves.
        dot.with_animation(
            "live-preview-pulse",
            Animation::new(Motion::Flourish.duration() * 2).repeat(),
            |dot, delta| {
                let half = if delta <= 0.5 { delta * 2. } else { 2. - delta * 2. };
                dot.opacity(1. - 0.65 * ease_in_out(half))
            },
        )
        .into_any_element()
    } else {
        dot.into_any_element()
    };
    let (interaction, pointer) = use_interaction("live-preview-status", window, cx);
    let tip = status.tip.clone();
    let mut body = div()
        .id("live-preview-status")
        .relative()
        .flex()
        .items_center()
        .gap(SPACING_3)
        .max_w_full()
        .rounded(RADIUS_CONTROL)
        .bg(if stopped {
            mix(palette.raised, palette.hover, interaction.hover)
        } else {
            palette.raised
        })
        .shadow(Elevation::Popover.shadows(&palette))
        .text_role(TextRole::Micro, cx)
        .text_color(if stopped { palette.text } else { palette.text_secondary })
        .whitespace_nowrap()
        .when(live, |this| this.p(SPACING_3))
        .when(!live, |this| this.px(SPACING_5).py(SPACING_2))
        .children(lattice_ui::parity::probe("live-preview-status"))
        .child(dot)
        .when(!live, |this| {
            this.child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(status.label.clone()),
            )
        })
        .tooltip(move |_, cx| -> AnyView {
            cx.new(|_| PillTip { text: tip.clone() }).into()
        });
    if stopped {
        let preview = preview.clone();
        body = track_pointer(body, pointer)
            .cursor_pointer()
            .child(Icon::ROTATE_CW.element(px(11.), palette.text))
            .on_click(move |_, _, cx| preview.update(cx, |preview, cx| preview.retry(cx)));
    }
    Some(
        div()
            .absolute()
            .left(SPACING_6)
            .right(SPACING_6)
            .bottom(SPACING_6)
            .flex()
            .child(body)
            .into_any_element(),
    )
}
