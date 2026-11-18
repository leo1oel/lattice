// Adapted from quiet.md's `src/input.rs` (https://github.com/s1dashu/quiet-md,
// MIT License, Copyright (c) 2026 s1dashu): its keys, events and input
// handling, drawn here by a text element of its own instead of quiet.md's
// rich text element. See THIRD_PARTY_NOTICES.md.

//! The whiteboard's text field: the wysiwyg text editor over a text element,
//! a frame's name, the color picker's hex field and the font list's search.
//! One font (CoreText falls back per character, CJK included), a size, a line
//! height, an alignment, and lines wrapped at the field's width when
//! `wrap` is set, as a `<textarea>` with `white-space: pre-wrap` wraps them.

use gpui::*;
use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;
use unicode_segmentation::UnicodeSegmentation;

actions!(
    board_field,
    [
        Backspace,
        DeleteToHome,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        WordLeft,
        WordRight,
        SelectWordLeft,
        SelectWordRight,
        Home,
        End,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Submit,
        ShiftSubmit,
        Cancel,
        Up,
        Down,
        Swallow,
        Tab,
        ShiftTab
    ]
);

const CONTEXT: &str = "BoardTextField";

pub fn bind_keys(cx: &mut App) {
    let c = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("cmd-backspace", DeleteToHome, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("alt-left", WordLeft, c),
        KeyBinding::new("alt-right", WordRight, c),
        KeyBinding::new("alt-shift-left", SelectWordLeft, c),
        KeyBinding::new("alt-shift-right", SelectWordRight, c),
        KeyBinding::new("cmd-left", Home, c),
        KeyBinding::new("cmd-right", End, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new("cmd-a", SelectAll, c),
        KeyBinding::new("cmd-c", Copy, c),
        KeyBinding::new("cmd-x", Cut, c),
        KeyBinding::new("cmd-v", Paste, c),
        KeyBinding::new("enter", Submit, c),
        KeyBinding::new("shift-enter", ShiftSubmit, c),
        KeyBinding::new("escape", Cancel, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("tab", Tab, c),
        KeyBinding::new("shift-tab", ShiftTab, c),
        KeyBinding::new("cmd-z", Swallow, c),
        KeyBinding::new("cmd-shift-z", Swallow, c),
    ]);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextFieldEvent {
    Changed,
    Submit,
    Cancel,
    Up,
    Down,
    /// Tab / Shift+Tab when `tab_events` is set.
    Tab,
    ShiftTab,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// One drawn row: the text it shows, shaped, and where it sits in the field.
struct Row {
    range: Range<usize>,
    line: ShapedLine,
    x: Pixels,
    y: Pixels,
}

#[derive(Default)]
struct Layout {
    rows: Vec<Row>,
    line_height: Pixels,
    origin: Point<Pixels>,
}

impl Layout {
    fn row_of(&self, i: usize) -> Option<&Row> {
        self.rows
            .iter()
            .find(|r| i >= r.range.start && i < r.range.end)
            .or_else(|| {
                self.rows
                    .iter()
                    .rev()
                    .find(|r| i >= r.range.start && i <= r.range.end)
            })
    }
    fn position_for(&self, i: usize) -> Point<Pixels> {
        let Some(r) = self.row_of(i) else {
            return self.origin;
        };
        point(
            self.origin.x + r.x + r.line.x_for_index(i - r.range.start),
            self.origin.y + r.y,
        )
    }
    fn index_for(&self, p: Point<Pixels>) -> usize {
        let y = p.y - self.origin.y;
        let Some(r) = self
            .rows
            .iter()
            .find(|r| y < r.y + self.line_height)
            .or(self.rows.last())
        else {
            return 0;
        };
        r.range.start
            + r.line
                .closest_index_for_x(p.x - self.origin.x - r.x)
                .min(r.range.end - r.range.start)
    }
}

pub struct TextField {
    focus: FocusHandle,
    pub text: String,
    sel: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    placeholder: SharedString,
    layout: Rc<RefCell<Layout>>,
    pub size: f32,
    pub line_height: f32,
    pub placeholder_color: Hsla,
    pub color: Hsla,
    pub align: Align,
    /// Wrap long lines at the field's width instead of letting them run on.
    pub wrap: bool,
    /// Enter and pasted newlines insert line breaks; Up/Down move by line.
    pub multiline: bool,
    pub font: Font,
    /// Longest text in chars (longer input is cut off).
    pub max_len: Option<usize>,
    /// Tab / Shift+Tab emit events instead of reaching the parent.
    pub tab_events: bool,
    selecting: bool,
}

impl EventEmitter<TextFieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn prev_word(s: &str, o: usize) -> usize {
    s[..o]
        .unicode_word_indices()
        .next_back()
        .map_or(0, |(i, _)| i)
}

fn next_word(s: &str, o: usize) -> usize {
    s[o..]
        .unicode_word_indices()
        .next()
        .map_or(s.len(), |(i, w)| o + i + w.len())
}

impl TextField {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        TextField {
            focus: cx.focus_handle(),
            text: String::new(),
            sel: 0..0,
            reversed: false,
            marked: None,
            placeholder: placeholder.into(),
            layout: Rc::default(),
            size: 13.,
            line_height: 20.,
            placeholder_color: hsla(0., 0., 0.5, 1.),
            color: black(),
            align: Align::Left,
            wrap: false,
            multiline: false,
            font: crate::theme::ui_font(),
            max_len: None,
            tab_events: false,
            selecting: false,
        }
    }

    pub fn set_text(&mut self, s: &str, cx: &mut Context<Self>) {
        self.text = s.to_string();
        self.sel = self.text.len()..self.text.len();
        self.marked = None;
        cx.notify();
    }

    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.sel = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }

    /// Selects `r` (byte offsets, clamped; a caret when empty).
    pub fn select_range(&mut self, r: Range<usize>, cx: &mut Context<Self>) {
        let (a, b) = (r.start.min(self.text.len()), r.end.min(self.text.len()));
        self.sel = a.min(b)..a.max(b);
        self.reversed = false;
        cx.notify();
    }

    /// The caret (the selection's moving end).
    pub fn caret(&self) -> usize {
        self.cursor()
    }

    /// The selection (byte offsets; empty: the caret).
    pub fn selection(&self) -> Range<usize> {
        self.sel.clone()
    }

    fn cursor(&self) -> usize {
        if self.reversed {
            self.sel.start
        } else {
            self.sel.end
        }
    }

    fn move_to(&mut self, o: usize, cx: &mut Context<Self>) {
        self.sel = o..o;
        self.reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, o: usize, cx: &mut Context<Self>) {
        if self.reversed {
            self.sel.start = o
        } else {
            self.sel.end = o
        }
        if self.sel.end < self.sel.start {
            self.reversed = !self.reversed;
            self.sel = self.sel.end..self.sel.start;
        }
        cx.notify();
    }

    fn prev(&self, o: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < o).then_some(i))
            .unwrap_or(0)
    }

    fn next(&self, o: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .find_map(|(i, _)| (i > o).then_some(i))
            .unwrap_or(self.text.len())
    }

    fn replace(&mut self, range: Range<usize>, s: &str, cx: &mut Context<Self>) {
        let mut s = if self.multiline {
            s.replace("\r\n", "\n").replace('\r', "\n")
        } else {
            s.replace(['\n', '\r'], " ")
        };
        if let Some(max) = self.max_len {
            let room = max.saturating_sub(
                self.text.chars().count() - self.text[range.clone()].chars().count(),
            );
            if let Some((cut, _)) = s.char_indices().nth(room) {
                s.truncate(cut);
            }
        }
        self.text.replace_range(range.clone(), &s);
        let o = range.start + s.len();
        self.sel = o..o;
        self.reversed = false;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        if self.sel.is_empty() {
            let p = self.prev(self.cursor());
            self.select_to(p, cx);
        }
        self.replace(self.sel.clone(), "", cx);
    }

    fn delete_to_home(&mut self, _: &DeleteToHome, _: &mut Window, cx: &mut Context<Self>) {
        if self.sel.is_empty() {
            let start = self.text[..self.cursor()].rfind('\n').map_or(0, |i| i + 1);
            self.select_to(start, cx);
        }
        self.replace(self.sel.clone(), "", cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        if self.sel.is_empty() {
            let n = self.next(self.cursor());
            self.select_to(n, cx);
        }
        self.replace(self.sel.clone(), "", cx);
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        let o = if self.sel.is_empty() {
            self.prev(self.cursor())
        } else {
            self.sel.start
        };
        self.move_to(o, cx);
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        let o = if self.sel.is_empty() {
            self.next(self.cursor())
        } else {
            self.sel.end
        };
        self.move_to(o, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        let p = self.prev(self.cursor());
        self.select_to(p, cx);
    }
    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        let n = self.next(self.cursor());
        self.select_to(n, cx);
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let o = if self.sel.is_empty() {
            prev_word(&self.text, self.cursor())
        } else {
            self.sel.start
        };
        self.move_to(o, cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        let o = if self.sel.is_empty() {
            next_word(&self.text, self.cursor())
        } else {
            self.sel.end
        };
        self.move_to(o, cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let p = prev_word(&self.text, self.cursor());
        self.select_to(p, cx);
    }
    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        let n = next_word(&self.text, self.cursor());
        self.select_to(n, cx);
    }
    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }
    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.text.len(), cx);
    }
    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.select_all_text(cx);
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.sel.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.sel.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.sel.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.sel.clone()].to_string(),
            ));
            self.replace(self.sel.clone(), "", cx);
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = cx.read_from_clipboard().and_then(|i| i.text()) {
            self.replace(self.sel.clone(), &t, cx);
        }
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            return self.replace(self.sel.clone(), "\n", cx);
        }
        cx.emit(TextFieldEvent::Submit);
    }

    fn shift_submit(&mut self, _: &ShiftSubmit, _: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            return self.replace(self.sel.clone(), "\n", cx);
        }
        cx.emit(TextFieldEvent::Submit);
    }

    fn swallow(&mut self, _: &Swallow, _: &mut Window, cx: &mut Context<Self>) {
        if !self.multiline {
            cx.propagate();
        }
    }

    fn tab(&mut self, _: &Tab, _: &mut Window, cx: &mut Context<Self>) {
        match (self.tab_events, self.multiline) {
            (true, _) => cx.emit(TextFieldEvent::Tab),
            (false, false) => cx.propagate(),
            _ => {}
        }
    }

    fn shift_tab(&mut self, _: &ShiftTab, _: &mut Window, cx: &mut Context<Self>) {
        match (self.tab_events, self.multiline) {
            (true, _) => cx.emit(TextFieldEvent::ShiftTab),
            (false, false) => cx.propagate(),
            _ => {}
        }
    }

    fn move_line(&mut self, dir: f32, cx: &mut Context<Self>) {
        let target = {
            let l = self.layout.borrow();
            let at = l.position_for(self.cursor());
            let y = at.y + l.line_height * (0.5 + dir);
            let first = l.position_for(0).y;
            let last = l.position_for(self.text.len()).y;
            if y < first {
                0
            } else if y > last + l.line_height {
                self.text.len()
            } else {
                l.index_for(point(at.x, y)).min(self.text.len())
            }
        };
        self.move_to(target, cx);
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextFieldEvent::Cancel);
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            return self.move_line(-1., cx);
        }
        cx.emit(TextFieldEvent::Up);
    }

    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            return self.move_line(1., cx);
        }
        cx.emit(TextFieldEvent::Down);
    }

    fn index_for(&self, p: Point<Pixels>) -> usize {
        self.layout.borrow().index_for(p).min(self.text.len())
    }

    fn on_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let i = self.index_for(ev.position);
        if ev.click_count >= 2 {
            return self.select_all_text(cx);
        }
        self.selecting = true;
        if ev.modifiers.shift {
            self.select_to(i, cx)
        } else {
            self.move_to(i, cx)
        }
    }

    fn on_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting && ev.pressed_button == Some(MouseButton::Left) {
            let i = self.index_for(ev.position);
            self.select_to(i, cx);
        }
    }

    fn on_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn to16(&self, o: usize) -> usize {
        self.text[..o.min(self.text.len())].encode_utf16().count()
    }

    fn from16(&self, o16: usize) -> usize {
        let mut n = 0;
        for (i, ch) in self.text.char_indices() {
            if n >= o16 {
                return i;
            }
            n += ch.len_utf16();
        }
        self.text.len()
    }

    fn range16(&self, r: &Range<usize>) -> Range<usize> {
        self.to16(r.start)..self.to16(r.end)
    }
    fn range8(&self, r: &Range<usize>) -> Range<usize> {
        self.from16(r.start)..self.from16(r.end)
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let r = self.range8(&range);
        actual.replace(self.range16(&r));
        Some(self.text[r].to_string())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range16(&self.sel),
            reversed: self.reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|r| self.range16(r))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        s: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let r = range
            .map(|r| self.range8(&r))
            .or(self.marked.clone())
            .unwrap_or(self.sel.clone());
        self.marked = None;
        self.replace(r, s, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        s: &str,
        new_sel: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let r = range
            .map(|r| self.range8(&r))
            .or(self.marked.clone())
            .unwrap_or(self.sel.clone());
        self.text.replace_range(r.clone(), s);
        self.marked = (!s.is_empty()).then(|| r.start..r.start + s.len());
        self.sel = new_sel
            .map(|ns| {
                let base = self.to16(r.start);
                self.from16(base + ns.start)..self.from16(base + ns.end)
            })
            .unwrap_or(r.start + s.len()..r.start + s.len());
        self.reversed = false;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let r = self.range8(&range);
        let l = self.layout.borrow();
        let (a, b) = (l.position_for(r.start), l.position_for(r.end));
        Some(Bounds::from_corners(a, point(b.x, b.y + l.line_height)))
    }

    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.to16(self.index_for(p)))
    }
}

/// Rows of `text`: its lines, each wrapped at `width` (when given) after the
/// last space that fits, or mid-word when no space does.
fn lay_out(
    text: &str,
    font: &Font,
    size: Pixels,
    line_height: Pixels,
    color: Hsla,
    width: Option<Pixels>,
    align: Align,
    window: &Window,
) -> Vec<Row> {
    let ts = window.text_system();
    let shape = |s: &str| {
        ts.shape_line(
            SharedString::from(s.to_string()),
            size,
            &[TextRun {
                len: s.len(),
                font: font.clone(),
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        )
    };
    let mut rows = vec![];
    let mut start = 0;
    for line in text.split('\n') {
        let full = shape(line);
        let mut from = 0;
        loop {
            let rest = &line[from..];
            let x0 = full.x_for_index(from);
            let fits = |i: usize| width.is_none_or(|w| full.x_for_index(i) - x0 <= w);
            let mut end = line.len();
            if !fits(end) {
                let mut last_fit = from;
                let mut last_space = None;
                for (i, c) in rest.char_indices() {
                    let at = from + i + c.len_utf8();
                    if !fits(at) {
                        break;
                    }
                    last_fit = at;
                    if c.is_whitespace() {
                        last_space = Some(at);
                    }
                }
                end = last_space.unwrap_or(if last_fit == from {
                    from + rest.chars().next().map_or(0, char::len_utf8)
                } else {
                    last_fit
                });
            }
            let shaped = shape(&line[from..end]);
            rows.push(Row {
                range: start + from..start + end,
                line: shaped,
                x: px(0.),
                y: px(0.),
            });
            from = end;
            if from >= line.len() {
                break;
            }
        }
        start += line.len() + 1;
    }
    let w = width.unwrap_or_else(|| rows.iter().map(|r| r.line.width).fold(px(0.), Pixels::max));
    for (i, r) in rows.iter_mut().enumerate() {
        r.y = line_height * i as f32;
        r.x = match align {
            Align::Left => px(0.),
            Align::Center => (w - r.line.width) / 2.,
            Align::Right => w - r.line.width,
        };
    }
    rows
}

/// The field's text, selection, composition and caret.
struct FieldText {
    field: Entity<TextField>,
}

impl IntoElement for FieldText {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for FieldText {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let f = self.field.read(cx);
        let font_size = px(f.size);
        let lh = px(f.line_height);
        let (text, font, color, wrap, align) =
            (f.text.clone(), f.font.clone(), f.color, f.wrap, f.align);
        let layout = f.layout.clone();
        let id =
            window.request_measured_layout(Style::default(), move |known, avail, window, _| {
                let width = if wrap {
                    known.width.or(match avail.width {
                        AvailableSpace::Definite(w) => Some(w),
                        _ => None,
                    })
                } else {
                    None
                };
                let rows = lay_out(&text, &font, font_size, lh, color, width, align, window);
                let w = width
                    .unwrap_or_else(|| rows.iter().map(|r| r.line.width).fold(px(0.), Pixels::max));
                let h = lh * rows.len().max(1) as f32;
                layout.borrow_mut().rows = rows;
                layout.borrow_mut().line_height = lh;
                size(w, h)
            });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let f = self.field.read(cx);
        let focus = f.focus.clone();
        f.layout.borrow_mut().origin = bounds.origin;
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.field.clone()),
            cx,
        );
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        // what to draw, read first: painting text needs `cx` mutably
        let (lh, under, lines, over) = {
            let f = self.field.read(cx);
            let focused = f.focus.is_focused(window);
            let l = f.layout.borrow();
            let lh = l.line_height;
            let (mut under, mut lines, mut over) = (vec![], vec![], vec![]);
            if f.text.is_empty() && !f.placeholder.is_empty() {
                lines.push((
                    bounds.origin,
                    window.text_system().shape_line(
                        f.placeholder.clone(),
                        px(f.size),
                        &[TextRun {
                            len: f.placeholder.len(),
                            font: f.font.clone(),
                            color: f.placeholder_color,
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        }],
                        None,
                    ),
                ));
            }
            if focused && !f.sel.is_empty() {
                let sel_color = hsla(211. / 360., 0.9, 0.6, 0.3);
                for r in &l.rows {
                    let (a, b) = (f.sel.start.max(r.range.start), f.sel.end.min(r.range.end));
                    if a > b || (a == b && !(f.sel.start <= r.range.end && f.sel.end > r.range.end))
                    {
                        continue;
                    }
                    let x1 = r.x + r.line.x_for_index(a - r.range.start);
                    let x2 = r.x
                        + r.line.x_for_index(b - r.range.start)
                        + if f.sel.end > r.range.end {
                            px(4.)
                        } else {
                            px(0.)
                        };
                    under.push(fill(
                        Bounds::from_corners(
                            point(bounds.origin.x + x1, bounds.origin.y + r.y),
                            point(bounds.origin.x + x2, bounds.origin.y + r.y + lh),
                        ),
                        sel_color,
                    ));
                }
            }
            for r in &l.rows {
                lines.push((
                    point(bounds.origin.x + r.x, bounds.origin.y + r.y),
                    r.line.clone(),
                ));
            }
            if let Some(m) = &f.marked {
                for r in &l.rows {
                    let (a, b) = (m.start.max(r.range.start), m.end.min(r.range.end));
                    if a >= b {
                        continue;
                    }
                    let x1 = r.x + r.line.x_for_index(a - r.range.start);
                    let x2 = r.x + r.line.x_for_index(b - r.range.start);
                    over.push(fill(
                        Bounds::from_corners(
                            point(bounds.origin.x + x1, bounds.origin.y + r.y + lh - px(2.)),
                            point(bounds.origin.x + x2, bounds.origin.y + r.y + lh - px(1.)),
                        ),
                        f.color,
                    ));
                }
            }
            if focused && f.sel.is_empty() {
                over.push(fill(
                    Bounds::new(l.position_for(f.cursor()), size(px(1.5), lh)),
                    f.color,
                ));
            }
            (lh, under, lines, over)
        };
        for q in under {
            window.paint_quad(q);
        }
        for (at, line) in lines {
            let _ = line.paint(at, lh, TextAlign::Left, None, window, cx);
        }
        for q in over {
            window.paint_quad(q);
        }
    }
}

impl Render for TextField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("board-text-field")
            .track_focus(&self.focus)
            .key_context(CONTEXT)
            .cursor(CursorStyle::IBeam)
            .relative()
            .flex_1()
            .min_w_0()
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete_to_home))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::shift_submit))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::swallow))
            .on_action(cx.listener(Self::tab))
            .on_action(cx.listener(Self::shift_tab))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_down))
            .on_mouse_move(cx.listener(Self::on_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_up))
            .child(FieldText { field: cx.entity() })
    }
}
