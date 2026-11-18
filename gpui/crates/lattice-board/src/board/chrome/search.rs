// Lattice's own (not copied from quiet.md): the board's search, after
// Excalidraw \`SearchMenu.tsx\` @ 3a317b5 (MIT License, Copyright (c) 2020
// Excalidraw), as the Tauri app's board shows it.

//! "Find on canvas" (\`actionToggleSearchMenu\`, ⌘F): a panel on the right
//! with the query field, the result count and the matches, text first and
//! then frame names, each shown in its line with the match in bold.
//! Enter or ↓ goes to the next match, ↑ to the previous one, Escape closes.
//! The focused match is brought into view, zoomed in until its text is
//! 14px on screen (upstream's \`FONT_SIZE_LEGIBILITY_THRESHOLD\`), and every
//! match is highlighted on the canvas (\`renderSearchMatches\`: yellow, the
//! focused one orange). Matching ignores case and runs on the text as
//! drawn (\`element.text\`, wrapped lines), as upstream's does.

use super::*;
use crate::board::BoardView;
use crate::board::types::Element;
use crate::board::viewport::{Viewport, center_scroll_on, is_bounds_in_viewport};
use crate::settings::tr;
use crate::text_field::{TextField, TextFieldEvent};
use lattice_board_core::board::frame::get_frame_like_title;
use lattice_board_core::board::text_measure::{Font, Measure};

/// Text this small on screen is zoomed to when focused.
const LEGIBLE: f64 = 14.;
/// Characters of context shown before a match.
const BEFORE: usize = 24;

pub(crate) struct Search {
    pub(crate) field: Entity<TextField>,
    pub(crate) matches: Vec<Match>,
    pub(crate) focus: Option<usize>,
    _sub: Subscription,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Match {
    pub(crate) id: String,
    pub(crate) frame: bool,
    /// The line, and the match's byte range in it.
    pub(crate) line: usize,
    pub(crate) range: std::ops::Range<usize>,
    pub(crate) text: String,
}

/// \`text\`'s case-insensitive occurrences of \`query\`, as byte ranges.
fn find_all(text: &str, query: &[char]) -> Vec<std::ops::Range<usize>> {
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = vec![];
    let mut i = 0;
    while !query.is_empty() && i + query.len() <= chars.len() {
        if (0..query.len()).all(|k| fold(chars[i + k].1) == query[k]) {
            let end = chars.get(i + query.len()).map_or(text.len(), |c| c.0);
            out.push(chars[i].0..end);
            i += query.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Every match of \`query\` among \`elements\`: text in scene order, then
/// frame names.
pub(crate) fn matches<'a>(elements: impl Iterator<Item = &'a Element>, query: &str) -> Vec<Match> {
    let q: Vec<char> = query
        .chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect();
    if q.is_empty() {
        return vec![];
    }
    let elements: Vec<&Element> = elements.collect();
    let mut out = vec![];
    for e in elements.iter().copied() {
        let Some(t) = e.text() else { continue };
        for (line, text) in t.text.split('\n').enumerate() {
            for range in find_all(text, &q) {
                out.push(Match {
                    id: e.id.clone(),
                    frame: false,
                    line,
                    range,
                    text: text.to_string(),
                });
            }
        }
    }
    for e in elements.into_iter().filter(|e| e.is_frame_like()) {
        let title = get_frame_like_title(e);
        for range in find_all(title, &q) {
            out.push(Match {
                id: e.id.clone(),
                frame: true,
                line: 0,
                range,
                text: title.to_string(),
            });
        }
    }
    out
}

/// A text match's highlight in scene coordinates: its four corners, the
/// element's rotation applied.
pub(crate) fn quad(e: &Element, m: &Match, measure: &dyn Measure) -> Option<[[f64; 2]; 4]> {
    let t = e.text()?;
    let font = Font::new(t.font_size, t.font_family);
    let line_h = t.font_size * t.line_height;
    let width = measure.line_width(&m.text, font);
    let off = match t.text_align {
        lattice_board_core::board::types::TextAlign::Left => 0.,
        lattice_board_core::board::types::TextAlign::Center => (e.width - width) / 2.,
        lattice_board_core::board::types::TextAlign::Right => e.width - width,
    };
    let x0 = e.x + off + measure.line_width(&m.text[..m.range.start], font);
    let x1 = e.x + off + measure.line_width(&m.text[..m.range.end], font);
    let y0 = e.y + m.line as f64 * line_h;
    let y1 = y0 + line_h;
    let (cx, cy) = (e.x + e.width / 2., e.y + e.height / 2.);
    let (s, c) = e.angle.sin_cos();
    let rot = |x: f64, y: f64| {
        [
            cx + (x - cx) * c - (y - cy) * s,
            cy + (x - cx) * s + (y - cy) * c,
        ]
    };
    Some([rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)])
}

impl BoardView {
    /// Opens the panel with its field focused, or closes it.
    pub(crate) fn toggle_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.is_some() {
            return self.close_search(window, cx);
        }
        let field = cx.new(|cx| {
            let mut t = TextField::new(tr("在画布上查找", "Find on canvas"), cx);
            t.size = 14.;
            t.font = crate::theme::ui_font();
            t.color = style::text();
            t.placeholder_color = style::input_label();
            t
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |me, _, ev: &TextFieldEvent, window, cx| match ev {
                TextFieldEvent::Changed => me.refresh_search(true, cx),
                TextFieldEvent::Submit | TextFieldEvent::Down => me.step_search(1, cx),
                TextFieldEvent::Up => me.step_search(-1, cx),
                TextFieldEvent::Cancel => me.close_search(window, cx),
                _ => {}
            },
        );
        let fh = field.read(cx).focus_handle(cx);
        window.focus(&fh, cx);
        window.defer(cx, move |window, cx| window.focus(&fh, cx));
        self.search = Some(Search {
            field,
            matches: vec![],
            focus: None,
            _sub: sub,
        });
        cx.notify();
    }

    pub(crate) fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.take().is_some() {
            self.focus(window, cx);
            cx.notify();
        }
    }

    /// Runs the query again: the query changed (\`jump\`: to its first match)
    /// or the scene did (the focus stays where it can).
    pub(crate) fn refresh_search(&mut self, jump: bool, cx: &mut Context<Self>) {
        let Some(s) = &self.search else { return };
        let query = s.field.read(cx).text.to_string();
        let found = matches(self.scene.non_deleted_elements(), &query);
        let s = self.search.as_mut().expect("open");
        if s.matches == found {
            cx.notify();
            return;
        }
        s.matches = found;
        if s.matches.is_empty() {
            s.focus = None;
        } else if jump || s.focus.is_none() {
            s.focus = Some(0);
            self.show_match(cx);
        } else {
            s.focus = s.focus.map(|f| f.min(s.matches.len() - 1));
        }
        cx.notify();
    }

    /// Moves the focus \`by\` matches, wrapping.
    pub(crate) fn step_search(&mut self, by: isize, cx: &mut Context<Self>) {
        let Some(s) = self.search.as_mut() else {
            return;
        };
        let n = s.matches.len() as isize;
        if n == 0 {
            return;
        }
        let at = s.focus.map_or(if by > 0 { -1 } else { 0 }, |f| f as isize);
        s.focus = Some((at + by).rem_euclid(n) as usize);
        self.show_match(cx);
        cx.notify();
    }

    pub(crate) fn focus_search_match(&mut self, i: usize, cx: &mut Context<Self>) {
        if let Some(s) = self.search.as_mut() {
            s.focus = Some(i);
        }
        self.show_match(cx);
        cx.notify();
    }

    /// Brings the focused match into view, legible.
    fn show_match(&mut self, cx: &mut Context<Self>) {
        let Some(m) = self
            .search
            .as_ref()
            .and_then(|s| s.focus.map(|f| s.matches[f].clone()))
        else {
            return;
        };
        let Some(e) = self.scene.get_non_deleted_element(&m.id).cloned() else {
            return;
        };
        let canvas = self.canvas();
        let v = self.viewport();
        let (bounds, size) = if m.frame {
            ([e.x, e.y, e.x + e.width, e.y + e.height], None)
        } else {
            let Some(q) = quad(&e, &m, &*self.m) else {
                return;
            };
            let xs = q.map(|p| p[0]);
            let ys = q.map(|p| p[1]);
            let f = |a: [f64; 4], min: bool| {
                a.into_iter().fold(
                    if min {
                        f64::INFINITY
                    } else {
                        f64::NEG_INFINITY
                    },
                    if min { f64::min } else { f64::max },
                )
            };
            (
                [f(xs, true), f(ys, true), f(xs, false), f(ys, false)],
                e.text().map(|t| t.font_size),
            )
        };
        let zoom = size.map_or(v.zoom, |s| v.zoom.max((LEGIBLE / s).min(30.)));
        if zoom == v.zoom && is_bounds_in_viewport(bounds, v, canvas) {
            return;
        }
        let center = [(bounds[0] + bounds[2]) / 2., (bounds[1] + bounds[3]) / 2.];
        let (scroll_x, scroll_y) =
            center_scroll_on(center, canvas.width, canvas.height, zoom, None);
        self.set_viewport(
            Viewport {
                scroll_x,
                scroll_y,
                zoom,
            },
            cx,
        );
    }
}

/// The panel (\`.layer-ui__search\` in the default sidebar).
pub(crate) fn render(me: &BoardView, cx: &mut Context<BoardView>) -> Option<AnyElement> {
    let s = me.search.as_ref()?;
    let n = s.matches.len();
    let has_query = !s.field.read(cx).text.is_empty();
    let count = match n {
        _ if !has_query => String::new(),
        0 => tr("未找到匹配项...", "No matches found...").to_string(),
        1 => format!("1 {}", tr("个结果", "result")),
        n => format!("{n} {}", tr("个结果", "results")),
    };
    let item = |i: usize, m: &Match, focused: bool| {
        let start = m.text[..m.range.start]
            .char_indices()
            .rev()
            .nth(BEFORE - 1)
            .map_or(0, |c| c.0);
        let lead = if start > 0 { "…" } else { "" };
        div()
            .id(("board-search-match", i))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(style::RADIUS_MD))
            .cursor_pointer()
            .text_size(px(13.))
            .line_height(style::lh(13.))
            .overflow_hidden()
            .whitespace_nowrap()
            .when(focused, |d| d.bg(style::surface_primary_container()))
            .hover(|d| d.bg(style::button_hover_bg()))
            .child(
                div()
                    .flex()
                    .child(format!("{lead}{}", &m.text[start..m.range.start]))
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .child(m.text[m.range.clone()].to_string()),
                    )
                    .child(m.text[m.range.end..].to_string()),
            )
            .on_click(cx.listener(move |me, _, _, cx| me.focus_search_match(i, cx)))
    };
    let section = |title: &'static str, frame: bool| {
        let rows: Vec<_> = s
            .matches
            .iter()
            .enumerate()
            .filter(|(_, m)| m.frame == frame)
            .map(|(i, m)| item(i, m, s.focus == Some(i)))
            .collect();
        (!rows.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .px(px(8.))
                        .pb(px(4.))
                        .text_size(px(12.))
                        .text_color(style::input_label())
                        .child(title),
                )
                .children(rows)
        })
    };
    Some(
        eat(div()
            .id("board-search")
            .absolute()
            .top_0()
            .right_0()
            .bottom_0()
            .w(px(302.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(12.))
            .bg(style::island_bg())
            .border_l_1()
            .border_color(style::border())
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(tr("在画布上查找", "Find on canvas")),
                    )
                    .child(
                        div()
                            .id("board-search-close")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(style::RADIUS_MD))
                            .cursor_pointer()
                            .hover(|d| d.bg(style::button_hover_bg()))
                            .child(icon("close", 16., style::text()))
                            .on_click(cx.listener(|me, _, window, cx| me.close_search(window, cx))),
                    ),
            )
            .child(
                div()
                    .h(px(36.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(style::RADIUS_LG))
                    .bg(crate::theme::palette(|p| p.input))
                    .border_1()
                    .border_color(crate::theme::palette(|p| p.field_border))
                    .child(icon("search", 16., style::input_label()))
                    .child(s.field.clone()),
            )
            .when(has_query, |d| {
                d.child(
                    div()
                        .text_size(px(12.))
                        .text_color(style::input_label())
                        .child(count),
                )
            })
            .child(
                div()
                    .id("board-search-results")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .when_some(section(tr("文本", "Text"), false), |d, x| d.child(x))
                    .when_some(section(tr("画框", "Frames"), true), |d, x| d.child(x)),
            ))
        .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::matches;
    use crate::board::types::Element;

    fn text(id: &str, text: &str) -> Element {
        let element = format!(
            r#"{{"id":{id:?},"type":"text","x":0,"y":0,"width":100,"height":25,"text":{t},"originalText":{t},"fontSize":20,"fontFamily":5,"textAlign":"left","verticalAlign":"top","lineHeight":1.25}}"#,
            t = serde_json::Value::from(text),
        );
        let file = format!(
            r#"{{"type":"excalidraw","version":2,"source":"test","elements":[{element}],"appState":{{}},"files":{{}}}}"#
        );
        let board = crate::whiteboard::Board::from_file(&file).expect("a board");
        board.elements.into_iter().next().expect("the text")
    }

    #[test]
    fn matches_ignore_case_and_keep_byte_ranges_per_line() {
        let els = [
            text(
                "a",
                "Attention map
attention heads",
            ),
            text("b", "Résumé ATTENTION"),
        ];
        let found = matches(els.iter(), "aTTention");
        let spots: Vec<_> = found
            .iter()
            .map(|m| (m.id.as_str(), m.line, m.range.clone()))
            .collect();
        assert_eq!(spots, [("a", 0, 0..9), ("a", 1, 0..9), ("b", 0, 9..18)]);
        assert_eq!(&found[2].text[found[2].range.clone()], "ATTENTION");
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        assert!(matches([text("a", "x")].iter(), "").is_empty());
    }
}
