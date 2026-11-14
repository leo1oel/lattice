//! A notification card, as the Tauri app's toast stack draws one
//! (`src/telemetry/toast-stack.tsx` and `toast-stack.css`).
//!
//! 320 wide at the floating level: a 16px level mark (the only thing the
//! level colours), the message, and the compact X, on three columns 8px
//! apart, 10px in (12px on the mark's side). One line keeps the three on one
//! centre; past one line (a long title or detail, actions, a progress bar)
//! the mark and the X pin to the title's line instead. The title is the
//! subtitle's 13/18 at medium weight, three lines at most; the detail the
//! caption's 12/16 in the secondary ink, four lines at most, its line breaks
//! kept, the whole of it in a tooltip. Actions are compact Buttons 6px
//! apart, the first tinted, after a Copy button when the card has text to
//! copy; a running operation adds its bar and its percentage.
//!
//! The stack (`lattice-gpui`'s notices) owns where each card stands and how
//! it moves; a card only draws itself, with its words faded out while it
//! waits behind the front card ([`Toast::content_opacity`]).

use std::{rc::Rc, time::Duration};

use gpui::{
    Animation, AnimationExt as _, AnyElement, AnyView, App, ClipboardItem, ElementId, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
    relative,
};
use gpui_kit::base::{Transition, transition};

use crate::{
    ActiveLattice as _, Elevation, Icon, Palette, TextRole, TextRoleStyle as _,
    components::{Button, IconButton, LatticeTooltip},
    icons::ICON_LARGE,
    motion::Motion,
    tokens::{CONTAINER_TOAST, FONT_WEIGHT_MEDIUM},
};

type DismissHandler = Rc<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>;

/// A message longer than this, title or detail, wraps (`multiline`).
const ONE_LINE: usize = 72;
/// The level mark's square (`--toast-icon-size`).
const MARK: f32 = 16.;
/// The X's square (`--control-size-icon-compact`).
const CLOSE: f32 = 24.;
/// The title's line box (`--type-subtitle-line-height`), which the mark and
/// the X centre on past one line.
const TITLE_LINE: f32 = 18.;
/// How long Copy shows its check (`copy-button.tsx`).
const COPIED_FOR: Duration = Duration::from_millis(1600);
/// The indeterminate bar's sweep (`app-toast-sweep`, 1.4 s ease-in-out).
const SWEEP: Duration = Duration::from_millis(1400);
/// CSS `ease-in-out`.
const EASE_IN_OUT: crate::token_types::Ease = crate::token_types::Ease::CubicBezier(0.42, 0., 0.58, 1.);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ToastLevel {
    #[default]
    Info,
    Success,
    Warning,
    Error,
}

impl ToastLevel {
    /// One silhouette per level family, severity in its colour
    /// (`LEVEL_ICON`: info, a check for success, the alert circle for a
    /// warning and an error alike).
    fn mark(self, palette: &Palette) -> (Icon, Hsla) {
        match self {
            ToastLevel::Info => (Icon::INFO, palette.info),
            ToastLevel::Success => (Icon::CIRCLE_CHECK, palette.success),
            ToastLevel::Warning => (Icon::CIRCLE_ALERT, palette.warning),
            ToastLevel::Error => (Icon::CIRCLE_ALERT, palette.danger),
        }
    }
}

/// How far a running operation is: a share, or not yet known.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ToastProgress {
    Fraction(f32),
    Indeterminate,
}

#[derive(IntoElement)]
pub struct Toast {
    id: ElementId,
    level: ToastLevel,
    title: SharedString,
    detail: Option<SharedString>,
    actions: Vec<AnyElement>,
    copy: Option<SharedString>,
    progress: Option<ToastProgress>,
    mark: Option<AnyElement>,
    content_opacity: f32,
    width: Option<Pixels>,
    height: Option<Pixels>,
    on_measure: Option<Box<dyn FnOnce(Pixels, &mut App)>>,
    on_dismiss: Option<DismissHandler>,
    parity: Option<SharedString>,
}

impl Toast {
    pub fn new(
        id: impl Into<ElementId>,
        level: ToastLevel,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            level,
            title: title.into(),
            detail: None,
            actions: Vec::new(),
            copy: None,
            progress: None,
            mark: None,
            content_opacity: 1.,
            width: None,
            height: None,
            on_measure: None,
            on_dismiss: None,
            parity: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// The first action is the compact tinted lead, the rest compact
    /// secondary; pass the Buttons already sized.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    /// A Copy button before the actions, putting `text` on the clipboard.
    pub fn copy(mut self, text: impl Into<SharedString>) -> Self {
        self.copy = Some(text.into());
        self
    }

    /// A running operation's bar under the message.
    pub fn progress(mut self, progress: ToastProgress) -> Self {
        self.progress = Some(progress);
        self
    }

    /// The mark in the level icon's place (a running operation's loader).
    pub fn mark(mut self, mark: impl IntoElement) -> Self {
        self.mark = Some(mark.into_any_element());
        self
    }

    /// The words' opacity: a card behind the front one shows only its
    /// sliver, so its words fade out (`[data-behind]`).
    pub fn content_opacity(mut self, opacity: f32) -> Self {
        self.content_opacity = opacity;
        self
    }

    /// A width under the 320px a window narrower than 352px leaves
    /// (`max-width: calc(100vw - 32px)`).
    pub fn width(mut self, width: Pixels) -> Self {
        self.width = Some(width);
        self
    }

    /// The surface's height, when a stack sets it (a card behind the front
    /// one takes the front card's height): the words keep their own height
    /// and the surface clips them.
    pub fn height(mut self, height: Pixels) -> Self {
        self.height = Some(height);
        self
    }

    /// Hand the words' own height, as they lay out, to `on_measure`.
    pub fn on_measure(mut self, on_measure: impl FnOnce(Pixels, &mut App) + 'static) -> Self {
        self.on_measure = Some(Box::new(on_measure));
        self
    }

    /// Record the card and its title as the parity harness's region `name`
    /// and `name/title`.
    pub fn parity(mut self, name: impl Into<SharedString>) -> Self {
        self.parity = Some(name.into());
        self
    }

    pub fn on_dismiss(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_dismiss = Some(Rc::new(handler));
        self
    }

    /// Whether the card lays out past one line (`multiline`): length is
    /// judged across title and detail both, since a message can arrive as a
    /// long title with no detail.
    fn multiline(&self) -> bool {
        let long = |text: &str| text.chars().count() > ONE_LINE;
        long(&self.title)
            || self.detail.as_deref().is_some_and(long)
            || !self.actions.is_empty()
            || self.copy.is_some()
            || self.progress.is_some()
    }
}

impl RenderOnce for Toast {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let multiline = self.multiline();
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let (icon, hue) = self.level.mark(&palette);
        let mark = self
            .mark
            .unwrap_or_else(|| icon.element(ICON_LARGE, hue).into_any_element());
        // Past one line the mark and the X stand on the title's line box.
        let pin = |size: f32| px(((TITLE_LINE - size) / 2.).max(-8.));
        let detail = self.detail.clone();
        let title = div()
            .text_role(TextRole::Subtitle, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .text_color(palette.text)
            .line_clamp(3)
            .when_some(self.parity.clone(), |this, name| {
                let region = format!("{name}/title");
                this.relative()
                    .children(crate::parity::probe(region.clone()))
                    .children(crate::parity::text_probe(region, 0, self.title.clone()))
            })
            .child(self.title.clone());
        let detail = detail.map(|detail| {
            let tip = detail.clone();
            div()
                .id(child("detail"))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .line_clamp(4)
                .child(detail)
                .tooltip(move |_, cx| -> AnyView { LatticeTooltip::view(tip.clone(), None, cx) })
        });
        let has_actions = self.copy.is_some() || !self.actions.is_empty();
        let copy = self
            .copy
            .map(|text| CopyButton::new(child("copy"), text).into_any_element());
        let progress = self
            .progress
            .map(|progress| progress_row(child("progress"), progress, &palette, window, cx));
        let body = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(2.))
            .child(title)
            .children(detail)
            .children(progress)
            .when(has_actions, |this| {
                this.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(6.))
                        .mt(px(6.))
                        .children(copy)
                        .children(self.actions),
                )
            });
        let close = self.on_dismiss.map(|on_dismiss| {
            div()
                .flex_none()
                .when(multiline, |this| this.mt(pin(CLOSE)))
                .child(
                    IconButton::new(child("close"), Icon::CLOSE)
                        .frame(px(CLOSE), px(CLOSE))
                        .tooltip(lattice_i18n::t!("Dismiss notification"))
                        .on_click(move |event, window, cx| on_dismiss(event, window, cx)),
                )
        });
        let content = div()
            .flex_none()
            .flex()
            .when(multiline, |this| this.items_start())
            .when(!multiline, |this| this.items_center())
            .gap(px(8.))
            .pl(px(12.))
            .pr(px(10.))
            .py(px(10.))
            .opacity(self.content_opacity)
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(MARK))
                    .when(multiline, |this| this.mt(pin(MARK)))
                    .child(mark),
            )
            .child(body)
            .children(close);
        let content = match self.on_measure {
            Some(on_measure) => crate::measure::measured(content, move |bounds, cx| {
                on_measure(bounds.size.height, cx)
            }),
            None => content.into_any_element(),
        };
        div()
            .map(|this| match self.width {
                Some(width) => this.w(width),
                None => this.w(CONTAINER_TOAST),
            })
            .flex()
            .flex_col()
            .rounded(px(10.))
            .bg(palette.raised)
            .shadow(Elevation::Floating.shadows(&palette))
            .when_some(self.height, |this, height| this.h(height).overflow_hidden())
            .relative()
            .children(self.parity.and_then(crate::parity::probe))
            .child(content)
    }
}

/// The bar of a running operation and, when it can say, its percentage
/// (`ToastProgress`): a 4px pill track of the ink at 12%, its fill the
/// accent, eased to each new share on the moderate tier; while the share is
/// unknown a 35% segment sweeps across, holding still under reduced motion.
fn progress_row(
    id: ElementId,
    progress: ToastProgress,
    palette: &Palette,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let track = div()
        .relative()
        .flex_1()
        .h(px(4.))
        .rounded_full()
        .overflow_hidden()
        .bg(palette.text.opacity(0.12));
    let fill = div()
        .absolute()
        .top_0()
        .bottom_0()
        .rounded_full()
        .bg(palette.accent);
    let child = |name: &'static str| ElementId::NamedChild(std::sync::Arc::new(id.clone()), name.into());
    let (bar, percent) = match progress {
        ToastProgress::Fraction(share) => {
            let share = share.clamp(0., 1.);
            let token = Motion::Moderate.token();
            let policy = Transition::new(token.duration).ease(move |t| token.ease.sample(t));
            let drawn = transition(child("fill"), share, policy, window, cx);
            let percent = (share * 100.).round() as u32;
            (
                track.child(fill.left_0().w(relative(drawn))),
                Some(format!("{percent}%")),
            )
        }
        ToastProgress::Indeterminate if cx.reduce_motion() => {
            // A still segment, as `translateX(95%)` holds it.
            (track.child(fill.left(relative(0.35 * 0.95)).w(relative(0.35))), None)
        }
        ToastProgress::Indeterminate => (
            track.child(
                fill.w(relative(0.35)).with_animation(
                    child("sweep"),
                    Animation::new(SWEEP)
                        .repeat()
                        .with_easing(|t| EASE_IN_OUT.sample(t)),
                    // translateX(-100%) to translateX(290%) of its own width.
                    |fill, t| fill.left(relative(0.35 * (-1. + 3.9 * t))),
                ),
            ),
            None,
        ),
    };
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .mt(px(6.))
        .child(bar)
        .children(percent.map(|percent| {
            div()
                .flex_none()
                .min_w(px(28.))
                .text_right()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(percent)
        }))
        .into_any_element()
}

/// Copy, as the app's `CopyButton` copies: a compact secondary Button whose
/// copy mark gives way to a green check for 1.6 s, the two crossfading and
/// scaling between 85% and full size on the moderate tier.
#[derive(IntoElement)]
pub struct CopyButton {
    id: ElementId,
    text: SharedString,
    label: SharedString,
}

impl CopyButton {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            label: lattice_i18n::t!("Copy").into(),
        }
    }
}

impl RenderOnce for CopyButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let child = |name: &'static str| {
            ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), name.into())
        };
        let copied_at = window.use_keyed_state(child("copied"), cx, |_, _| None::<std::time::Instant>);
        let copied = copied_at
            .read(cx)
            .is_some_and(|at| at.elapsed() < COPIED_FOR);
        if copied {
            // Asks for frames until the check gives way again.
            window.request_animation_frame();
        }
        let shown = crate::interaction::fade(child("swap"), copied, Motion::Moderate, window, cx);
        let swap = |icon: Icon, ink: Hsla, opacity: f32| {
            let scale = 0.85 + 0.15 * opacity;
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .opacity(opacity)
                .child(icon.element(px(13. * scale), ink))
        };
        let mark = div()
            .relative()
            .flex_none()
            .size(px(14.))
            .child(swap(Icon::COPY, palette.text, 1. - shown))
            .child(swap(Icon::CHECK, palette.success, shown));
        let text = self.text;
        Button::new(self.id, self.label)
            .compact()
            .leading(mark)
            .on_click(move |_, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
                copied_at.update(cx, |at, cx| {
                    *at = Some(std::time::Instant::now());
                    cx.notify();
                });
            })
    }
}
