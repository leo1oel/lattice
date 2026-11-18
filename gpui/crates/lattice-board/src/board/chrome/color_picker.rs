// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The color picker, after Excalidraw `components/ColorPicker/*`
//! (`ColorPicker.tsx`, `TopPicks.tsx`, `Picker.tsx`, `PickerColorList.tsx`,
//! `ShadeList.tsx`, `ColorInput.tsx`, `ColorPicker.scss`) and
//! `PropertiesPopover.tsx` @ 3a317b5: the five top picks (22px, radius 4),
//! a 1×16 separator and the active-color trigger (26px); the trigger opens an
//! island (padding 12, max 13rem) 20px to its right with an arrow: "Colors"
//! (the 5×3 palette at the active shade, 30px, radius 6), "Shades" (the
//! hue's five) and the hex input. Swatches show the color as the canvas draws
//! it (dark mode mapped), with their hotkey labels; above them the scene's
//! most used custom colors (1–5). Hotkeys (`keyboardNavHandlers.ts`): the
//! palette's q…b at the active shade, ⇧1–5 the shades, 1–5 the custom
//! colors. Differs: no top-picks drag & drop or reset, no eye dropper, no
//! arrow-key / Tab navigation, no error message under an invalid hex (the
//! border turns red).

use super::colors;
use super::tip::ExTip;
use super::*;
use crate::board::action::BoardAction;
use crate::board::utils::is_transparent;
use crate::settings::tr;
use crate::text_field::{TextField, TextFieldEvent};

thread_local! {
    /// The color triggers' window bounds at the last layout.
    static TRIGGER: RefCell<HashMap<(EntityId, Pop), Bounds<Pixels>>> = RefCell::default();
    /// The open picker's hex field.
    static HEX: RefCell<HashMap<EntityId, (Pop, Entity<TextField>, Subscription)>> = RefCell::default();
    /// The open picker, for its hotkeys: which one, its custom colors (taken
    /// when it opened, like upstream's `useState`), the current color, the
    /// active shade and the action.
    static OPEN: RefCell<HashMap<EntityId, Open>> = RefCell::default();
}

#[derive(Clone)]
struct Open {
    p: Pop,
    customs: Vec<String>,
    current: Option<String>,
    shade: usize,
    action: fn(String) -> BoardAction,
}

/// `isCustomColor`: not one of the palette's values.
fn is_custom(c: &str) -> bool {
    !(c == colors::TRANSPARENT
        || c == colors::BLACK
        || c == colors::WHITE
        || colors::HUES.iter().any(|(_, s)| s.contains(&c)))
}

/// `getMostUsedCustomColors`: the five most used custom stroke / background
/// colors in the scene.
fn most_used_custom(elements: &[crate::board::types::Element], p: Pop) -> Vec<String> {
    let mut counts: Vec<(String, usize)> = vec![];
    for e in elements.iter().filter(|e| !e.is_deleted) {
        let c = if p == Pop::Stroke {
            &e.stroke_color
        } else {
            &e.background_color
        };
        if is_transparent(c) || !is_custom(c) {
            continue;
        }
        match counts.iter_mut().find(|(x, _)| x == c) {
            Some(n) => n.1 += 1,
            None => counts.push((c.clone(), 1)),
        }
    }
    counts.sort_by_key(|c| std::cmp::Reverse(c.1));
    counts.into_iter().take(5).map(|c| c.0).collect()
}

/// `colorPickerKeyNavHandler`'s hotkeys while a picker is open (and its hex
/// field isn't focused). True if the key was the picker's.
pub(crate) fn hotkey(
    me: &mut BoardView,
    ev: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) -> bool {
    let Some(p) = pop(cx).filter(|p| matches!(p, Pop::Stroke | Pop::Background)) else {
        return false;
    };
    let Some(o) = OPEN
        .with(|m| m.borrow().get(&cx.entity_id()).cloned())
        .filter(|o| o.p == p)
    else {
        return false;
    };
    if HEX.with(|h| {
        h.borrow()
            .get(&cx.entity_id())
            .is_some_and(|(_, f, _)| f.read(cx).focus_handle(cx).is_focused(window))
    }) {
        return false;
    }
    let m = &ev.keystroke.modifiers;
    if m.platform || m.control || m.alt {
        return false;
    }
    let key = ev.keystroke.key.as_str();
    let digit = key.parse::<usize>().ok().filter(|d| (1..=5).contains(d));
    let pick = if let Some(d) = digit
        && m.shift
    {
        o.current
            .as_deref()
            .and_then(colors::find)
            .map(|(h, _)| colors::HUES[h].1[d - 1].to_string())
    } else if let Some(d) = digit {
        o.customs.get(d - 1).cloned()
    } else if let Some(i) = HOTKEYS.iter().position(|k| *k == key).filter(|_| !m.shift) {
        Some(colors::grid(o.shade)[i].to_string())
    } else {
        None
    };
    let Some(c) = pick else { return false };
    me.run((o.action)(c), window, cx);
    true
}

/// `colorPickerHotkeyBindings`.
const HOTKEYS: [&str; 15] = [
    "q", "w", "e", "r", "t", "a", "s", "d", "f", "g", "z", "x", "c", "v", "b",
];

/// `HotkeyLabel`: bottom right, 10px monospace, white on dark colors.
fn hotkey_label(color: &str, label: String) -> Div {
    div()
        .absolute()
        .right(px(4.))
        .bottom(px(2.))
        .font_family(crate::theme::MONO_FONT)
        .text_size(px(10.))
        .line_height(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(if is_dark(color, 160.) {
            style::hex(0xffffff)
        } else {
            style::hex(0x000000)
        })
        .child(label)
}

/// A popup opened or closed: the hex field goes with its picker.
pub(crate) fn popup_changed(p: Option<Pop>, cx: &mut Context<BoardView>) {
    let id = cx.entity_id();
    HEX.with(|h| {
        let mut h = h.borrow_mut();
        if h.get(&id).is_some_and(|(q, _, _)| Some(*q) != p) {
            h.remove(&id);
        }
    });
}

/// `isColorDark` (YIQ below `threshold`; transparent isn't dark).
fn is_dark(color: &str, threshold: f64) -> bool {
    if is_transparent(color) {
        return false;
    }
    let c = crate::board::color::color_or_black(color);
    (c.r as f64 * 299. + c.g as f64 * 587. + c.b as f64 * 114.) / 1000. < threshold
}

/// The color as the canvas shows it (`applyDarkModeFilter`).
fn display(color: &str) -> Hsla {
    crate::board::render::color(crate::board::color::color_or_black(color), 1.)
}

/// `.color-picker__button`: the color, transparent as the checker pattern;
/// `has-outline` rings light colors; `active` adds a 1px
/// `--color-primary-darkest` outline.
fn swatch(
    id: impl Into<ElementId>,
    color: &str,
    size: f32,
    radius: f32,
    active: bool,
    outline_threshold: f64,
    large: bool,
) -> Stateful<Div> {
    let transparent = is_transparent(color);
    let mut d = div()
        .id(id)
        .flex_none()
        .relative()
        .size(px(size))
        .rounded(px(radius))
        .cursor_pointer();
    if transparent {
        // the 16px pattern (8px squares, 8% black), at "left center"
        let off = (size - 16.) / 2.;
        let mut cells = div()
            .absolute()
            .inset_0()
            .rounded(px(radius))
            .overflow_hidden();
        let n = (size / 8.).ceil() as i32 + 1;
        for i in 0..n {
            for j in -1..n {
                if (i + j).rem_euclid(2) == 0 {
                    cells = cells.child(
                        div()
                            .absolute()
                            .left(px(i as f32 * 8.))
                            .top(px(j as f32 * 8. + off))
                            .size(px(8.))
                            .bg(style::hexa(0, 0.08)),
                    );
                }
            }
        }
        d = d.child(cells);
    } else {
        d = d.bg(display(color));
    }
    if !is_dark(color, outline_threshold) {
        d = d.child(ring_out(radius, style::color_outline()));
    }
    if active {
        d = d.child(ring_out(radius, style::primary_darkest()));
    } else if large {
        d = d.hover(|s| s.border_1().border_color(style::primary()));
    }
    d.active(|s| s.border_1().border_color(style::primary()))
}

/// `box-shadow: 0 0 0 1px c`: a 1px ring just outside (a border, as GPUI's
/// shadows also fill the inside).
fn ring_out(radius: f32, c: Hsla) -> Div {
    div()
        .absolute()
        .top(px(-1.))
        .left(px(-1.))
        .right(px(-1.))
        .bottom(px(-1.))
        .rounded(px(radius + 1.))
        .border_1()
        .border_color(c)
}

/// The active-color trigger (`ColorPickerTrigger`): 26px, radius 5; no color
/// (a mixed selection) shows the slash.
fn trigger(id: &'static str, color: Option<&str>) -> Stateful<Div> {
    let c = color.unwrap_or(colors::TRANSPARENT);
    let s = swatch((id, 900usize), c, 26., 5., false, 240., false);
    // no ring while open: upstream rings it only on keyboard focus
    if color.is_none() {
        s.child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(icon("slash", 20., style::hex(style::GRAY_60))),
        )
    } else {
        s
    }
}

fn heading(t: &'static str) -> Div {
    div()
        .px(px(8.))
        .text_size(px(12.))
        .line_height(style::lh(12.))
        .child(t)
}

/// `getColorNameAndShadeFromColor` for a hue (shaded colors only).
fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Upstream's `colors.*` name of a palette entry.
fn palette_name(i: usize) -> &'static str {
    match i {
        0 => tr("透明", "Transparent"),
        1 => tr("白", "White"),
        3 => tr("黑", "Black"),
        _ => colors::name(colors::grid(0)[i]),
    }
}

/// One color control: the heading, the top picks and the trigger with its
/// picker. `action` turns a color into the `BoardAction`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn color_picker(
    id: &'static str,
    title: Option<&'static str>,
    p: Pop,
    current: Option<String>,
    picks: [&'static str; 5],
    action: fn(String) -> BoardAction,
    elements: &[crate::board::types::Element],
    window: &mut Window,
    cx: &mut Context<BoardView>,
) -> Div {
    let open = pop(cx) == Some(p);
    let eid = cx.entity_id();
    if open && p != Pop::CanvasBackground {
        let found = current.as_deref().and_then(colors::find);
        let shade = found.map(|f| f.1).unwrap_or(if p == Pop::Stroke {
            colors::STROKE_SHADE
        } else {
            colors::BACKGROUND_SHADE
        });
        OPEN.with(|m| {
            let mut m = m.borrow_mut();
            let customs = m
                .get(&eid)
                .filter(|o| o.p == p)
                .map(|o| o.customs.clone())
                .unwrap_or_else(|| most_used_custom(elements, p));
            m.insert(
                eid,
                Open {
                    p,
                    customs,
                    current: current.clone(),
                    shade,
                    action,
                },
            );
        });
    } else if pop(cx).is_none_or(|q| !matches!(q, Pop::Stroke | Pop::Background)) {
        OPEN.with(|m| {
            m.borrow_mut().remove(&eid);
        });
    }
    let mut top = div().flex().items_center().justify_between().gap(px(5.));
    for (i, c) in picks.into_iter().enumerate() {
        let on = current.as_deref().is_some_and(|x| same(x, c));
        top = top.child(
            swatch((id, i), c, 22., 4., on, 240., false)
                .ex_tip(c, None)
                .on_click(
                    cx.listener(move |me, _, window, cx| me.run(action(c.into()), window, cx)),
                ),
        );
    }
    let at = TRIGGER.with(|t| t.borrow().get(&(eid, p)).copied());
    let label = if p == Pop::Stroke {
        tr("显示描边颜色选择器", "Show stroke color picker")
    } else {
        tr("显示背景颜色选择器", "Show background color picker")
    };
    let trig = trigger(id, current.as_deref())
        .child(
            canvas(
                move |b, _, _| {
                    TRIGGER.with(|t| {
                        t.borrow_mut().insert((eid, p), b);
                    })
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .when(!open, |d| d.ex_tip(label, None))
        .on_click(cx.listener(move |_, _, _, cx| {
            let open = pop(cx) == Some(p);
            set_pop(
                if !open {
                    Some(p)
                } else if p == Pop::CanvasBackground {
                    Some(Pop::MainMenu)
                } else {
                    None
                },
                cx,
            )
        }));
    let popup = at
        .filter(|_| open)
        .map(|b| picker(id, p, current.as_deref(), action, b, window, cx));
    div()
        .flex()
        .flex_col()
        .when_some(title, |d, t| {
            d.child(
                div()
                    .mb(px(4.))
                    .text_size(px(style::LABEL_TEXT))
                    .line_height(style::lh(style::LABEL_TEXT))
                    .child(t),
            )
        })
        // `.color-picker-container`: 1fr 15px 1.625rem, padding 4px 0
        .child(
            div()
                .py(px(4.))
                .flex()
                .items_center()
                .child(div().flex_1().child(top))
                .child(
                    div()
                        .w(px(15.))
                        .flex()
                        .justify_center()
                        .child(div().w(px(1.)).h(px(16.)).bg(style::border())),
                )
                .child(trig),
        )
        .children(popup)
}

fn set(
    c: String,
    action: fn(String) -> BoardAction,
    cx: &Context<BoardView>,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    cx.listener(move |me: &mut BoardView, _: &ClickEvent, window, cx| {
        me.run(action(c.clone()), window, cx)
    })
}

/// `Picker` in a `PropertiesPopover` beside the trigger `b`.
fn picker(
    id: &'static str,
    p: Pop,
    current: Option<&str>,
    action: fn(String) -> BoardAction,
    b: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) -> AnyElement {
    let found = current.and_then(colors::find);
    let shade = found.map(|f| f.1).unwrap_or(if p == Pop::Stroke {
        colors::STROKE_SHADE
    } else {
        colors::BACKGROUND_SHADE
    });
    // the 5×3 palette (`.color-picker-content--default`: padding 8, 30px, gap 4)
    let mut grid = div()
        .p(px(8.))
        .flex()
        .flex_wrap()
        .gap(px(4.))
        .w(px(5. * 30. + 4. * 4. + 16.));
    for (i, c) in colors::grid(shade).into_iter().enumerate() {
        let on = current.is_some_and(|x| same(x, c))
            || found.is_some_and(|(h, _)| colors::HUES[h].1.contains(&c));
        let tip = if c.starts_with('#') {
            format!("{} {c}", palette_name(i))
        } else {
            palette_name(i).to_string()
        };
        grid = grid.child(
            swatch((id, 100 + i), c, 30., 6., on, 255., true)
                .child(hotkey_label(c, HOTKEYS[i].into()))
                .ex_tip(&format!("{tip} — {}", HOTKEYS[i].to_uppercase()), None)
                .on_click(set(c.into(), action, cx)),
        );
    }
    let shades: AnyElement = match found {
        Some((h, s)) => {
            let mut r = div().p(px(8.)).flex().gap(px(4.));
            for (i, c) in colors::HUES[h].1.iter().enumerate() {
                r = r.child(
                    swatch((id, 200 + i), c, 30., 6., i == s, 255., true)
                        .child(hotkey_label(c, format!("⇧{}", i + 1)))
                        .ex_tip(&format!("{} - {}", colors::HUES[h].0, i + 1), None)
                        .on_click(set(c.to_string(), action, cx)),
                );
            }
            r.into_any_element()
        }
        None => div()
            .p(px(8.))
            .h(px(46.))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .child(tr(
                "此颜色没有可用的明暗变化",
                "No shades available for this color",
            ))
            .into_any_element(),
    };
    // the hex input (`ColorInput`), made with the picker
    let eid = cx.entity_id();
    let field = HEX.with(|h| {
        h.borrow()
            .get(&eid)
            .filter(|(q, _, _)| *q == p)
            .map(|(_, f, _)| f.clone())
    });
    let field = field.unwrap_or_else(|| {
        let f = cx.new(|cx| {
            let mut t = TextField::new("", cx);
            t.size = 14.;
            t.line_height = 20.;
            t.max_len = Some(9);
            t
        });
        let sub = cx.subscribe_in(
            &f,
            window,
            move |me, f, ev: &TextFieldEvent, window, cx| match ev {
                TextFieldEvent::Changed => {
                    let t = f
                        .read(cx)
                        .text
                        .trim()
                        .trim_start_matches('#')
                        .to_ascii_lowercase();
                    if matches!(t.len(), 3 | 4 | 6 | 8) && t.chars().all(|c| c.is_ascii_hexdigit())
                    {
                        me.run(action(format!("#{t}")), window, cx);
                    }
                }
                TextFieldEvent::Submit | TextFieldEvent::Cancel => me.focus(window, cx),
                _ => {}
            },
        );
        HEX.with(|h| h.borrow_mut().insert(eid, (p, f.clone(), sub)));
        f
    });
    let focused = field.read(cx).focus_handle(cx).is_focused(window);
    let want = current.unwrap_or("").trim_start_matches('#').to_string();
    let text = field.read(cx).text.clone();
    if !focused && text != want {
        field.update(cx, |t, cx| t.set_text(&want, cx));
    }
    let valid = {
        let t = text.trim().trim_start_matches('#');
        t.is_empty()
            || (matches!(t.len(), 3 | 4 | 6 | 8) && t.chars().all(|c| c.is_ascii_hexdigit()))
    };
    field.update(cx, |t, _| t.color = style::text());
    let hex = div()
        .m(px(8.))
        .px(px(12.))
        .h(px(34.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_1()
        .rounded(px(style::RADIUS_LG))
        .border_color(if valid {
            style::border()
        } else {
            style::hex(0xe03131)
        })
        .when(focused, |d| d.border_color(style::primary_darkest()))
        .child(
            div()
                .px(px(4.))
                .text_size(px(14.))
                .text_color(style::input_label())
                .child("#"),
        )
        .child(div().w(px(120.)).child(field));
    let customs = OPEN
        .with(|m| m.borrow().get(&eid).map(|o| o.customs.clone()))
        .unwrap_or_default();
    let custom = (!customs.is_empty()).then(|| {
        let mut r = div().p(px(8.)).flex().flex_wrap().gap(px(4.));
        for (i, c) in customs.iter().enumerate() {
            let on = current.is_some_and(|x| same(x, c));
            r = r.child(
                swatch((id, 300 + i), c, 30., 6., on, 255., true)
                    .child(hotkey_label(c, (i + 1).to_string()))
                    .ex_tip(c, None)
                    .on_click(set(c.clone(), action, cx)),
            );
        }
        div()
            .flex()
            .flex_col()
            .child(heading(tr("常用自定义颜色", "Most used custom colors")))
            .child(r)
    });
    // the canvas background has no palette (`palette={null}`): just the hex
    let palette = p != Pop::CanvasBackground;
    let content = island((id, 999usize), 3.)
        .max_w(px(208.))
        .flex()
        .flex_col()
        .gap(px(12.))
        // (the main menu stays open under the canvas background's)
        .on_mouse_down_out(cx.listener(move |_, _, _, cx| {
            if pop(cx) == Some(p) {
                set_pop((p == Pop::CanvasBackground).then_some(Pop::MainMenu), cx)
            }
        }))
        .when(palette, |d| {
            d.children(custom)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(heading(tr("颜色", "Colors")))
                        .child(grid),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(heading(tr("色调明暗", "Shades")))
                        .child(shades),
                )
        })
        .child(
            div()
                .flex()
                .flex_col()
                .child(heading(tr("十六进制值", "Hex code")))
                .child(hex),
        );
    // `side: right, align: start, alignOffset: -16, sideOffset: 20`, plus the
    // 10px arrow (Radix adds its height to the offset), pointing at the trigger
    let arrow_y = b.size.height / 2. + px(16.);
    let arrow = canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let o = bounds.origin;
            let mut pb = PathBuilder::fill();
            pb.move_to(point(o.x, o.y + arrow_y - px(10.)));
            pb.line_to(point(o.x - px(10.), o.y + arrow_y));
            pb.line_to(point(o.x, o.y + arrow_y + px(10.)));
            pb.close();
            if let Ok(path) = pb.build() {
                window.paint_path(path, style::popup_bg());
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size(px(1.));
    deferred(
        anchored()
            .position(point(b.right() + px(30.), b.top() - px(16.)))
            .snap_to_window_with_margin(px(8.))
            .child(div().relative().child(content).child(arrow)),
    )
    .with_priority(3)
    .into_any_element()
}
