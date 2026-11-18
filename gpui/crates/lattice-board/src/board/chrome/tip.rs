// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Tooltips, after Excalidraw `components/Tooltip.tsx` / `Tooltip.scss` @
//! 3a317b5: black, white 13px medium text, 8px padding, radius 6, 5px off the
//! trigger, below it unless there's no room. Upstream shows most buttons'
//! `title` natively; we show those the same way (labels "Rectangle — R or 2",
//! as upstream's titles), without the 15ch wrapping.

use super::style;
use gpui::*;
use std::rc::Rc;

struct Tip {
    label: SharedString,
    anchor: Option<Bounds<Pixels>>,
    origin: Point<Pixels>,
}

const MARGIN: f32 = 5.;
const PAD: f32 = 8.;
const SIZE: f32 = 13.;
const LINE: f32 = 19.5;

impl Render for Tip {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let bubble = div()
            .px(px(PAD))
            .py(px(PAD))
            .rounded(px(6.))
            .bg(style::hex(0x000000))
            .text_color(style::hex(0xffffff))
            .font_family(style::ui_font())
            .text_size(px(SIZE))
            .line_height(px(LINE))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .child(self.label.clone());
        let Some(a) = self.anchor else {
            return div()
                .pl(px(8.))
                .pt(px(10.))
                .child(bubble)
                .into_any_element();
        };
        let mut ts = window.text_style();
        ts.font_family = style::ui_font();
        ts.font_weight = FontWeight::MEDIUM;
        let run = ts.to_run(self.label.len());
        let w = window
            .text_system()
            .shape_line(self.label.clone(), px(SIZE), &[run], None)
            .width
            + px(2. * PAD);
        let h = px(LINE + 2. * PAD);
        let vp = window.viewport_size();
        let m = px(MARGIN);
        let x = (a.center().x - w / 2.).max(m).min(vp.width - w - m);
        let y = if a.bottom() + m + h <= vp.height {
            a.bottom() + m
        } else {
            a.top() - h - m
        };
        div()
            .size(px(1.))
            .child(
                div()
                    .absolute()
                    .left(x - self.origin.x)
                    .top(y - self.origin.y)
                    .child(bubble),
            )
            .into_any_element()
    }
}

pub trait ExTip: Sized {
    /// The tooltip `label`, with ` — keys` when there's a shortcut.
    fn ex_tip(self, label: &str, keys: Option<&str>) -> Self;
}

impl ExTip for Stateful<Div> {
    fn ex_tip(self, label: &str, keys: Option<&str>) -> Self {
        let label = SharedString::from(match keys {
            Some(k) => format!("{label} — {k}"),
            None => label.to_string(),
        });
        let bounds = Rc::new(std::cell::Cell::new(None::<Bounds<Pixels>>));
        let record = bounds.clone();
        self.child(
            canvas(move |b, _, _| record.set(Some(b)), |_, _, _, _| {})
                .absolute()
                .inset_0(),
        )
        .tooltip(move |window, cx| {
            let origin = window.mouse_position() + point(px(1.), px(1.));
            let (label, anchor) = (label.clone(), bounds.get());
            cx.new(|_| Tip {
                label,
                anchor,
                origin,
            })
            .into()
        })
    }
}
