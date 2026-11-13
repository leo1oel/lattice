//! The pictured choices of Settings › Appearance (`theme-settings.tsx`,
//! `code-theme-settings.tsx`; dialogs.css `.theme-*`, `.code-theme-*`):
//!
//! - A tile: its art on the 6px corner ringed by the hairline (the strong
//!   hairline under the pointer, on the fast tier), its name under it in the
//!   micro role; the chosen one ringed 1.5px in the primary ink 2px off the
//!   art, with a 16px check badge at its corner and its name in the primary
//!   ink at medium weight.
//! - An appearance's art is a miniature Lattice window in that appearance of
//!   the tint (title bar dots, the project, the editor with a heading in the
//!   accent, the PDF), 88px wide; "Match system" is both, split on a
//!   diagonal as macOS draws Auto. A tint's art is its two appearances side by
//!   side, 56 × 36, "Aa" in each one's ink under its identifying mark.
//! - A swatch: an 18px disc of the colour with an inset ring of the ink at
//!   16%, in a 24px target; it grows to 110% under the pointer and settles to
//!   94% while pressed; the chosen one is ringed 1.5px in its own colour, the
//!   ring growing in from 80%, with a check in the accent's contrast ink.
//! - A code theme card: six lines of LaTeX in the theme's own colours on its
//!   ground, both variants split on a diagonal for a theme that has two, a
//!   moon on one that is dark only; its name under it, checked when chosen.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ClickEvent, ContentMask, ElementId, FontStyle, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, fill, point,
    prelude::FluentBuilder as _, px, rgb, size, svg,
};
use lattice_ui::{
    Accent, ActiveLattice as _, Appearance, CodeTheme, Icon, Palette, TextRole, TextRoleStyle as _,
    Tint, TypeScale,
    elevation::ring,
    interaction::{fade, mix, track_pointer, use_interaction},
    motion::Motion,
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_COMPACT},
};

type Click = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

const ART_RADIUS: f32 = 6.;

/// The selection ring a tile's art and a code card's frame take: 2px of the
/// card's surface, then 1.5px of the primary ink.
fn chosen_ring(palette: &Palette) -> Vec<gpui::BoxShadow> {
    let mut outer = ring(palette.text);
    outer.spread_radius = px(3.5);
    let mut gap = ring(palette.raised);
    gap.spread_radius = px(2.);
    vec![outer, gap]
}

/// One pictured option: the art, ringed, and its name under it.
pub fn tile(
    id: ElementId,
    name: impl Into<gpui::SharedString>,
    width: Option<Pixels>,
    art: AnyElement,
    chosen: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let (interaction, pointer) = use_interaction(id.clone(), window, cx);
    let edge = mix(palette.line, palette.line_strong, interaction.hover);
    let shadows = if chosen {
        chosen_ring(&palette)
    } else {
        vec![ring(edge)]
    };
    let name: gpui::SharedString = name.into();
    let element = div()
        .id(id)
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.))
        .min_w_0()
        .cursor_pointer()
        .map(|this| match width {
            Some(width) => this.w(width),
            None => this.flex_1(),
        })
        .child(
            div()
                .relative()
                .rounded(px(ART_RADIUS))
                .shadow(shadows)
                .child(art)
                .when(chosen, |this| this.child(check_badge(&palette))),
        )
        .child(
            div()
                .max_w_full()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_role_in(TextRole::Micro, TypeScale::Settings, cx)
                .font_weight(if chosen {
                    FONT_WEIGHT_MEDIUM
                } else {
                    FontWeight::NORMAL
                })
                .text_color(if chosen {
                    palette.text
                } else {
                    palette.text_secondary
                })
                .child(name),
        )
        .on_click(on_click);
    track_pointer(element, pointer).into_any_element()
}

/// The chosen tile's check: a 16px disc of the primary ink ringed in the
/// card's surface, at the art's corner.
fn check_badge(palette: &Palette) -> AnyElement {
    let mut gap = ring(palette.raised);
    gap.spread_radius = px(2.);
    div()
        .absolute()
        .right(px(-5.))
        .bottom(px(-5.))
        .size(px(16.))
        .rounded_full()
        .bg(palette.text)
        .shadow(vec![gap])
        .flex()
        .items_center()
        .justify_center()
        .child(
            svg()
                .path(Icon::CHECK.path())
                .size(px(9.))
                .text_color(palette.raised),
        )
        .into_any_element()
}

/// The parts of the miniature window, in its 84 × 52 viewBox:
/// (x, y, w, h, radius, part).
#[derive(Clone, Copy)]
enum Part {
    Chrome,
    Sheet,
    Ink,
    Accent,
    Page,
    Print,
}

const WINDOW: &[(f32, f32, f32, f32, f32, Part)] = &[
    (0., 0., 84., 52., 0., Part::Chrome),
    (4.6, 3.6, 2.8, 2.8, 1.4, Part::Ink),
    (9.1, 3.6, 2.8, 2.8, 1.4, Part::Ink),
    (13.6, 3.6, 2.8, 2.8, 1.4, Part::Ink),
    (3., 10., 18., 39., 2.5, Part::Sheet),
    (6., 14., 10., 2., 1., Part::Ink),
    (6., 19., 12., 2., 1., Part::Ink),
    (6., 24., 8., 2., 1., Part::Ink),
    (23., 10., 34., 39., 2.5, Part::Sheet),
    (27., 15., 15., 2.4, 1.2, Part::Accent),
    (27., 21., 24., 2., 1., Part::Ink),
    (27., 26., 20., 2., 1., Part::Ink),
    (27., 31., 25., 2., 1., Part::Ink),
    (27., 36., 14., 2., 1., Part::Ink),
    (59., 10., 22., 39., 2.5, Part::Sheet),
    (62., 13., 16., 22., 1., Part::Page),
    (64.5, 16.5, 9., 1.4, 0.7, Part::Print),
    (64.5, 20., 11., 1., 0.5, Part::Print),
    (64.5, 22.5, 10., 1., 0.5, Part::Print),
    (64.5, 25., 11., 1., 0.5, Part::Print),
];

/// Paint the miniature window in `palette`'s colours (the accent is the
/// window's own, `accent`) inside `bounds`.
fn paint_window(bounds: Bounds<Pixels>, palette: &Palette, accent: Hsla, window: &mut Window) {
    let scale = bounds.size.width / px(84.);
    let ink = Hsla {
        a: palette.text_secondary.a * 0.55,
        ..palette.text_secondary
    };
    let page_edge = gpui::hsla(0., 0., 0., 0.08);
    for &(x, y, w, h, r, part) in WINDOW {
        let rect = Bounds::new(
            point(bounds.left() + px(x) * scale, bounds.top() + px(y) * scale),
            size(px(w) * scale, px(h) * scale),
        );
        let color = match part {
            Part::Chrome => palette.chrome,
            Part::Sheet => palette.panel,
            Part::Ink => ink,
            Part::Accent => accent,
            Part::Page => palette.pdf_page,
            Part::Print => rgb(0xB4B4B9).into(),
        };
        let mut quad = fill(rect, color).corner_radii(px(r) * scale);
        if matches!(part, Part::Page) {
            quad = quad.border_widths(px(0.5) * scale).border_color(page_edge);
        }
        window.paint_quad(quad);
    }
}

/// An appearance's art: the window in `appearance` (`None`: both, split on
/// the diagonal from 58% at the top to 42% at the foot) of `tint`.
pub fn window_art(appearance: Option<Appearance>, tint: Tint, cx: &App) -> AnyElement {
    let accent_preset = cx.palette().accent_preset;
    let accent = cx.palette().accent;
    let light = Palette::new(Appearance::Light, tint, accent_preset);
    let dark = Palette::new(Appearance::Dark, tint, accent_preset);
    let width = px(88.);
    let height = width * (52. / 84.);
    div()
        .w(width)
        .h(height)
        .rounded(px(ART_RADIUS))
        .overflow_hidden()
        .child(
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| match appearance {
                    Some(Appearance::Light) => paint_window(bounds, &light, accent, window),
                    Some(Appearance::Dark) => paint_window(bounds, &dark, accent, window),
                    None => {
                        paint_window(bounds, &light, accent, window);
                        for mask in diagonal_masks(bounds, 0.58, 0.42) {
                            window
                                .with_content_mask(Some(ContentMask { bounds: mask }), |window| {
                                    paint_window(bounds, &dark, accent, window)
                                });
                        }
                    }
                },
            )
            .size_full(),
        )
        .into_any_element()
}

/// Each tint's identifying hue (theme.css `--tint-mark`).
fn tint_mark(tint: Tint) -> Hsla {
    rgb(match tint {
        Tint::Graphite => 0xa4a4a6,
        Tint::Paper => 0xcdb38c,
        Tint::Sage => 0x9dc3a3,
        Tint::Mist => 0x98bcdc,
        Tint::Dusk => 0xbdafd9,
    })
    .into()
}

/// A tint's art: its light and dark halves, each the chrome over the panel
/// with "Aa" in its ink, under the tint's mark.
pub fn tint_art(tint: Tint, cx: &App) -> AnyElement {
    let accent = cx.palette().accent_preset;
    let half = |appearance: Appearance| {
        let palette = Palette::new(appearance, tint, accent);
        div()
            .relative()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .child(div().h(px(36. * 0.3)).bg(palette.chrome))
            .child(div().flex_1().bg(palette.panel))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_role_in(TextRole::Display, TypeScale::Settings, cx)
                    .text_size(TextRole::Micro.size(TypeScale::Settings))
                    .line_height(gpui::relative(1.))
                    .text_color(palette.text)
                    .child("Aa"),
            )
    };
    div()
        .relative()
        .w(px(56.))
        .h(px(36.))
        .rounded(px(ART_RADIUS))
        .overflow_hidden()
        .flex()
        .child(half(Appearance::Light))
        .child(half(Appearance::Dark))
        .child(
            div()
                .absolute()
                .left(px(24.))
                .top(px(3.))
                .w(px(8.))
                .h(px(4.))
                .rounded(RADIUS_COMPACT)
                .bg(tint_mark(tint)),
        )
        .into_any_element()
}

/// A colour swatch in a radio group.
pub fn swatch(
    id: ElementId,
    color: Hsla,
    chosen: bool,
    ring_color: Hsla,
    check_color: Hsla,
    plus: bool,
    on_click: Click,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let (interaction, pointer) = use_interaction(id.clone(), window, cx);
    let grow = 1. + 0.1 * interaction.hover - 0.16 * interaction.press;
    // The chosen ring fades in on the fast tier and grows from 80% on the
    // moderate one.
    let shown = fade(
        ElementId::NamedChild(std::sync::Arc::new(id.clone()), "ring".into()),
        chosen,
        Motion::Fast,
        window,
        cx,
    );
    let grown = fade(
        ElementId::NamedChild(std::sync::Arc::new(id.clone()), "ring-scale".into()),
        chosen,
        Motion::Moderate,
        window,
        cx,
    );
    let mut edge = ring(Hsla {
        a: palette.text.a * 0.16,
        ..palette.text
    });
    edge.spread_radius = px(1.);
    let disc = gpui::scaled(
        div()
            .size(px(18.))
            .rounded_full()
            .bg(color)
            .shadow(vec![inset(edge)]),
    )
    .scale(grow);
    let ring_size = px(22.) * (0.8 + 0.2 * grown);
    let element = div()
        .id(id)
        .relative()
        .size(px(24.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .child(
            div()
                .absolute()
                .size(ring_size)
                .rounded_full()
                .border(px(1.5))
                .border_color(Hsla {
                    a: ring_color.a * shown,
                    ..ring_color
                }),
        )
        .child(disc)
        .when(chosen || plus, |this| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        svg()
                            .path(if chosen {
                                Icon::CHECK.path()
                            } else {
                                Icon::PLUS.path()
                            })
                            .size(px(11.))
                            .text_color(if chosen { check_color } else { gpui::white() }),
                    ),
            )
        })
        .on_click(move |event, window, cx| on_click(event, window, cx));
    track_pointer(element, pointer).into_any_element()
}

/// `box-shadow: inset 0 0 0 1px …`.
fn inset(shadow: gpui::BoxShadow) -> gpui::BoxShadow {
    gpui::BoxShadow {
        inset: true,
        ..shadow
    }
}

/// Which token each preview run takes (`PREVIEW` in code-theme-settings.tsx).
#[derive(Clone, Copy)]
enum Role {
    Plain,
    Function,
    Bracket,
    Comment,
    Citation,
    Keyword,
    Type,
    Variable,
    Operator,
    Number,
    Reference,
}

const PREVIEW: &[&[(&str, Role)]] = &[
    &[
        ("\\section", Role::Function),
        ("{", Role::Bracket),
        ("Method", Role::Plain),
        ("}", Role::Bracket),
    ],
    &[("% two passes", Role::Comment)],
    &[
        ("As in ", Role::Plain),
        ("\\cite", Role::Citation),
        ("{", Role::Bracket),
        ("he16", Role::Citation),
        ("}", Role::Bracket),
        (".", Role::Plain),
    ],
    &[
        ("\\begin", Role::Keyword),
        ("{", Role::Bracket),
        ("equation", Role::Type),
        ("}", Role::Bracket),
    ],
    &[
        ("  ", Role::Plain),
        ("E", Role::Variable),
        (" ", Role::Plain),
        ("=", Role::Operator),
        (" ", Role::Plain),
        ("mc", Role::Variable),
        ("^", Role::Operator),
        ("2", Role::Number),
        (" ", Role::Plain),
        ("\\label", Role::Reference),
        ("{", Role::Bracket),
        ("e", Role::Reference),
        ("}", Role::Bracket),
    ],
    &[
        ("\\end", Role::Keyword),
        ("{", Role::Bracket),
        ("equation", Role::Type),
        ("}", Role::Bracket),
    ],
];

/// The specimen's lines, shaped in one variant's colours.
fn shape_preview(
    theme: CodeTheme,
    kind: Appearance,
    tint: Tint,
    accent: Accent,
    window: &mut Window,
    cx: &App,
) -> (Hsla, Vec<gpui::ShapedLine>) {
    let colors = theme.preview(kind, tint, accent);
    let syntax = colors.syntax;
    let family = cx.lattice().fonts.editor.clone();
    let font_size = TextRole::Micro
        .size(TypeScale::Settings)
        .to_pixels(window.rem_size());
    let lines = PREVIEW
        .iter()
        .map(|line| {
            let mut text = String::new();
            let mut runs = Vec::new();
            for (run, role) in line.iter() {
                let (color, weight, italic) = match role {
                    Role::Plain => (colors.ink, FontWeight::NORMAL, false),
                    Role::Function => (syntax.function, FONT_WEIGHT_MEDIUM, false),
                    Role::Bracket => (syntax.bracket, FontWeight::NORMAL, false),
                    Role::Comment => (syntax.comment, FontWeight::NORMAL, true),
                    Role::Citation => (syntax.citation, FontWeight::NORMAL, false),
                    Role::Keyword => (syntax.keyword, FONT_WEIGHT_MEDIUM, false),
                    Role::Type => (syntax.type_, FontWeight::NORMAL, false),
                    Role::Variable => (syntax.variable, FontWeight::NORMAL, false),
                    Role::Operator => (syntax.operator, FontWeight::NORMAL, false),
                    Role::Number => (syntax.number, FontWeight::NORMAL, false),
                    Role::Reference => (syntax.reference, FontWeight::NORMAL, true),
                };
                let mut font = gpui::font(family.clone());
                font.weight = weight;
                if italic {
                    font.style = FontStyle::Italic;
                }
                text.push_str(run);
                runs.push(gpui::TextRun {
                    len: run.len(),
                    font,
                    color,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                });
            }
            window
                .text_system()
                .shape_line(text.into(), font_size, &runs, None)
        })
        .collect();
    (colors.ground, lines)
}

/// Paint a shaped specimen on its ground inside `bounds`.
fn paint_preview(
    bounds: Bounds<Pixels>,
    ground: Hsla,
    lines: &[gpui::ShapedLine],
    line_height: Pixels,
    window: &mut Window,
    cx: &mut App,
) {
    window.paint_quad(fill(bounds, ground));
    let mut origin = point(bounds.left() + px(10.), bounds.top() + px(8.));
    for line in lines {
        line.paint(origin, line_height, gpui::TextAlign::Left, None, window, cx)
            .ok();
        origin.y += line_height;
    }
}

/// A code theme's card.
pub fn code_theme_card(
    theme: CodeTheme,
    name: gpui::SharedString,
    chosen: bool,
    variant: Option<Appearance>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let id = ElementId::Name(format!("code-theme-{}", theme.id()).into());
    let (interaction, pointer) = use_interaction(id.clone(), window, cx);
    let kinds = theme.kinds();
    let (tint, accent) = (palette.tint, palette.accent_preset);
    let both = kinds.len() == 2;
    let dark_only = !both && kinds.first() == Some(&Appearance::Dark);
    let edge = mix(palette.line, palette.line_strong, interaction.hover);
    let shadows = if chosen {
        chosen_ring(&palette)
    } else {
        vec![ring(edge)]
    };
    let height = TextRole::Micro
        .leading(TypeScale::Settings)
        .to_pixels(window.rem_size())
        * 6.
        + px(16.);
    let frame = div()
        .relative()
        .w_full()
        .h(height)
        .rounded(px(ART_RADIUS))
        .overflow_hidden()
        .shadow(shadows);
    let variant_kind = variant
        .or(kinds.first().copied())
        .unwrap_or(Appearance::Light);
    let line_height = TextRole::Micro
        .leading(TypeScale::Settings)
        .to_pixels(window.rem_size());
    let first = shape_preview(
        theme,
        if both {
            Appearance::Light
        } else {
            variant_kind
        },
        tint,
        accent,
        window,
        cx,
    );
    let second = both.then(|| shape_preview(theme, Appearance::Dark, tint, accent, window, cx));
    let frame = frame.child(
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                paint_preview(bounds, first.0, &first.1, line_height, window, cx);
                if let Some((ground, lines)) = &second {
                    // The dark variant right of the diagonal from 62% at the
                    // top to 38% at the foot, a strip at a time.
                    for mask in diagonal_masks(bounds, 0.62, 0.38) {
                        window.with_content_mask(Some(ContentMask { bounds: mask }), |window| {
                            paint_preview(bounds, *ground, lines, line_height, window, cx)
                        });
                    }
                }
            },
        )
        .size_full(),
    );
    let frame = frame.when(dark_only, |this| {
        this.child(
            div()
                .absolute()
                .top(px(6.))
                .right(px(6.))
                .size(px(18.))
                .rounded_full()
                .bg(gpui::hsla(0., 0., 1., 0.14))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    svg()
                        .path(Icon::SUN_MOON.path())
                        .size(px(10.))
                        .text_color(gpui::hsla(0., 0., 1., 0.8)),
                ),
        )
    });
    let element = div()
        .id(id)
        .flex()
        .flex_col()
        .gap(px(6.))
        .min_w_0()
        .cursor_pointer()
        .child(frame)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .min_w_0()
                .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(if chosen {
                    palette.text
                } else {
                    palette.text_secondary
                })
                .when(chosen, |this| {
                    this.child(
                        svg()
                            .path(Icon::CHECK.path())
                            .size(px(12.))
                            .flex_none()
                            .text_color(palette.text),
                    )
                })
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(name),
                ),
        )
        .on_click(on_click);
    track_pointer(element, pointer).into_any_element()
}

/// The masks that together cover the part of `bounds` right of the
/// diagonal from `top` (a fraction of the width at the top edge) to `foot`
/// (at the bottom edge), as CSS's `clip-path: polygon(top 0, 100% 0, 100%
/// 100%, foot 100%)`: everything past the band at once, the band in
/// half-pixel strips.
fn diagonal_masks(bounds: Bounds<Pixels>, top: f32, foot: f32) -> Vec<Bounds<Pixels>> {
    let band_left = bounds.left() + bounds.size.width * foot;
    let band_right = bounds.left() + bounds.size.width * top;
    let mut masks = vec![Bounds::from_corners(
        point(band_right, bounds.top()),
        point(bounds.right(), bounds.bottom()),
    )];
    let strip = px(0.5);
    let mut x = band_left;
    while x < band_right {
        let along = ((x + strip / 2. - bounds.left()) / bounds.size.width).clamp(0., 1.);
        let from = ((top - along) / (top - foot)).clamp(0., 1.);
        masks.push(Bounds::new(
            point(x, bounds.top() + bounds.size.height * from),
            size(strip, bounds.size.height * (1. - from)),
        ));
        x += strip;
    }
    masks
}
