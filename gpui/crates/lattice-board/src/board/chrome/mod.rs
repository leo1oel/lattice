// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! 画板的界面外壳, after Excalidraw's `LayerUI.tsx` @ 3a317b5: the main menu
//! (top left, `MainMenu`), the tool bar with its hint line (top center,
//! `Toolbar.tsx`, `HintViewer.tsx`), the styles panel (left,
//! `SelectedShapeActions`), the footer (zoom, undo / redo, help), the context
//! menu and the help dialog. Upstream decides what each piece contains, when
//! it shows and how it looks: the looks are upstream's CSS (`style.rs`) and
//! icons (`assets/icons/excalidraw/`), light and dark, not our `Theme`.
//! Differs: no collaboration, library, sidebars, AI, socials, stats, zen /
//! view mode; below 730px wide it takes upstream's mobile layout instead
//! (`mobile.rs`); the main menu adds 退出, and the top
//! left keeps room for the window's traffic lights. Everything here only
//! reads `BoardView` and dispatches `BoardAction`s / `set_tool`.

pub(crate) mod color_picker;
pub mod colors;
mod context_menu;
mod controls;
pub(crate) mod export;
mod help;
mod hints;
mod menu;
mod mobile;
mod properties;
pub(crate) mod search;
pub mod style;
mod tip;
mod toolbar;

use super::BoardView;
use gpui::prelude::FluentBuilder;
use gpui::*;
use std::cell::RefCell;
use std::collections::HashMap;

/// The chrome's open popup (upstream `appState.openPopup` / `openMenu`; one
/// at a time).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Pop {
    Stroke,
    Background,
    StartArrowhead,
    EndArrowhead,
    Font,
    ExtraTools,
    MainMenu,
    CanvasBackground,
    ClearCanvas,
}

thread_local! {
    /// Chrome-only state, per board view: which popup is open.
    static POP: RefCell<HashMap<EntityId, Pop>> = RefCell::default();
}

pub(crate) fn pop(cx: &Context<BoardView>) -> Option<Pop> {
    POP.with(|p| p.borrow().get(&cx.entity_id()).copied())
}

pub(crate) fn set_pop(p: Option<Pop>, cx: &mut Context<BoardView>) {
    let id = cx.entity_id();
    POP.with(|m| match p {
        Some(p) => {
            m.borrow_mut().insert(id, p);
        }
        None => {
            m.borrow_mut().remove(&id);
        }
    });
    color_picker::popup_changed(p, cx);
    properties::font_popup_changed(p == Some(Pop::Font), cx);
    cx.notify();
}

/// The chrome as its own view, so GPUI keeps its layout and paint from the
/// last frame (`AnyView::cached`) while only the drawing changes: on a
/// pointer move that hovers or drags the selection (`BoardView::chrome_quiet`)
/// with the app state and the selected elements as they were (moves aside:
/// `BoardView::scope_unchanged`), it isn't told to redraw; every other
/// change to the board redraws it.
pub(crate) struct ChromeView {
    board: WeakEntity<BoardView>,
    /// The selection scope and app state it last redrew for.
    seen: Option<(super::ScopeStamp, super::app_state::AppState)>,
    _watch: Subscription,
}

impl ChromeView {
    pub(crate) fn new(board: &Entity<BoardView>, cx: &mut Context<Self>) -> Self {
        let watch = cx.observe(board, |me, board, cx| {
            let b = board.read(cx);
            let quiet = b.chrome_quiet.replace(false);
            let same = me
                .seen
                .as_ref()
                .is_some_and(|(s, a)| *a == b.app && b.scope_unchanged(s));
            if quiet && same {
                return;
            }
            if !same {
                me.seen = Some((b.scope_stamp(), b.app.clone()));
            }
            cx.notify();
        });
        ChromeView {
            board: board.downgrade(),
            seen: None,
            _watch: watch,
        }
    }
}

impl Render for ChromeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(board) = self.board.upgrade() else {
            return div().into_any_element();
        };
        board.update(cx, |me, cx| render(me, window, cx).into_any_element())
    }
}

pub fn render(
    me: &mut BoardView,
    window: &mut Window,
    cx: &mut Context<BoardView>,
) -> impl IntoElement {
    let export = export::render(me, window, cx);
    let search = search::render(me, cx);
    let me = &*me;
    let compact = me.compact();
    let sections = properties::sections(me, window, cx);
    let can_edit = sections.is_some();
    let sections = sections.filter(|_| !compact || mobile::edit_menu(cx));
    if sections.is_none()
        && matches!(
            pop(cx),
            Some(
                Pop::Stroke | Pop::Background | Pop::StartArrowhead | Pop::EndArrowhead | Pop::Font
            )
        )
    {
        set_pop(None, cx);
    }
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .font_family(style::ui_font())
        .text_color(style::text())
        .map(|d| {
            if compact {
                d.child(mobile::top_bar(me, cx))
                    .child(mobile::bottom_bar(me, can_edit, sections, cx))
            } else {
                d.child(menu::main_menu(cx))
                    .child(toolbar::render(me, cx))
                    .when_some(sections, |d, s| d.child(panel(me, s)))
                    .child(controls::footer(me, cx))
            }
        })
        .when_some(context_menu::render(me, window, cx), |d, m| d.child(m))
        .when_some(search, |d, s| d.child(s))
        .when_some(export, |d, e| d.child(e))
        .when(me.help_open(), |d| d.child(help::render(window, cx)))
        .when(pop(cx) == Some(Pop::ClearCanvas), |d| {
            d.child(help::clear_canvas(window, cx))
        })
}

/// The styles panel (`.App-menu__left`): left, under the top row.
pub(crate) fn panel(me: &BoardView, sections: Div) -> AnyElement {
    // `appState.height - 166`
    let max_h = (me.bounds.get().size.height - px(166.)).max(px(120.));
    div()
        .absolute()
        .left(px(style::PADDING))
        .top(px(properties::TOP))
        .child(
            island("board-props", 0.)
                .max_w(px(properties::MAX_W))
                .max_h(max_h)
                .flex()
                .flex_col()
                .child(
                    div()
                        .id("board-props-scroll")
                        .max_h(max_h)
                        .overflow_y_scroll()
                        .p(px(properties::PAD))
                        .child(sections),
                ),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------

/// Presses on the chrome don't reach the canvas.
pub(crate) fn eat<E: InteractiveElement>(e: E) -> E {
    e.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .on_scroll(|_, _, cx| cx.stop_propagation())
}

/// `Island`: island background, `--shadow-island`, radius 8, padding
/// `padding × --space-factor`.
pub(crate) fn island(id: impl Into<ElementId>, padding: f32) -> Stateful<Div> {
    eat(div()
        .id(id)
        .occlude()
        .bg(style::island_bg())
        .shadow(style::shadow_island())
        .rounded(px(style::RADIUS_LG))
        .p(px(padding * style::SPACE)))
}

/// An upstream icon (`assets/icons/excalidraw/`).
pub(crate) fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg()
        .path(SharedString::from(format!("icons/excalidraw/{name}.svg")))
        .size(px(size))
        .flex_none()
        .text_color(color)
}

/// `.ToolIcon` in the tool bar (`.App-toolbar-container .ToolIcon__icon`):
/// `--lg-button-size`, radius 8; hover `--button-hover-bg`; pressed adds the
/// `--button-active-border` ring; checked `--color-surface-primary-container`
/// with the icon in `--color-on-primary-container`.
pub(crate) fn tool_icon(id: impl Into<ElementId>, size: f32, checked: bool) -> Stateful<Div> {
    div()
        .id(id)
        .flex_none()
        .relative()
        .size(px(size))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(style::RADIUS_LG))
        .cursor_pointer()
        .when(checked, |d| d.bg(style::surface_primary_container()))
        .when(!checked, |d| d.hover(|s| s.bg(style::button_hover_bg())))
        .active(|s| {
            s.bg(style::button_hover_bg())
                .border_1()
                .border_color(style::button_active_border())
        })
}

pub(crate) fn tool_icon_color(checked: bool) -> Hsla {
    if checked {
        style::on_primary_container()
    } else {
        style::text()
    }
}

/// `.ToolIcon__keybinding`: bottom 2, right 3, 10px, `--keybinding-color`.
pub(crate) fn keybinding(k: impl Into<SharedString>, checked: bool) -> Div {
    div()
        .absolute()
        .right(px(3.))
        .bottom(px(2.))
        .text_size(px(10.))
        .line_height(px(10.))
        .text_color(if checked {
            style::on_primary_container()
        } else {
            style::keybinding()
        })
        .child(k.into())
}

/// `outlineButtonIconStyles` in the styles panel (`.buttonList label`):
/// 32px, radius 8, `--button-bg` (transparent border); hover
/// `--button-hover-bg`; pressed `--color-primary-darkest` border; checked
/// `--color-surface-primary-container` with `--color-on-primary-container`.
pub(crate) fn outline_button(id: impl Into<ElementId>, checked: bool) -> Stateful<Div> {
    div()
        .id(id)
        .flex_none()
        .size(px(style::DEFAULT_BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(style::RADIUS_LG))
        .border_1()
        .cursor_pointer()
        .when(checked, |d| {
            d.bg(style::surface_primary_container())
                .border_color(style::surface_primary_container())
        })
        .when(!checked, |d| {
            d.bg(style::panel_button_bg())
                .border_color(transparent_black())
                .hover(|s| s.bg(style::panel_button_hover_bg()))
        })
        .active(|s| s.border_color(style::primary_darkest()))
}

/// `filledButtonOnCanvas` + `outlineButtonStyles` (`.help-icon`,
/// `.main-menu-trigger`): `--lg-button-size`, `--color-surface-low` with a 1px
/// `--color-surface-lowest` ring; hover `--button-hover-bg`; pressed
/// `--color-brand-active` ring.
pub(crate) fn filled_button(id: impl Into<ElementId>, open: bool) -> Stateful<Div> {
    eat(div()
        .id(id)
        .occlude()
        .flex_none()
        .h(px(style::LG_BUTTON))
        .min_w(px(style::LG_BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .rounded(px(style::RADIUS_LG))
        .cursor_pointer()
        .shadow(style::ring(style::surface_lowest()))
        .bg(if open {
            style::button_hover_bg()
        } else {
            style::surface_low()
        })
        .hover(|s| s.bg(style::button_hover_bg()))
        .active(|s| s.shadow(style::ring(style::brand_active()))))
}

/// The key names upstream's `getShortcutKey` writes ("Cmd+Shift+Z").
pub(crate) fn shortcut(s: &str) -> String {
    use crate::settings::tr;
    let mac = cfg!(target_os = "macos");
    s.split('+')
        .map(|k| match k {
            "CtrlOrCmd" => {
                if mac {
                    "Cmd"
                } else {
                    "Ctrl"
                }
            }
            "Alt" => {
                if mac {
                    "Option"
                } else {
                    "Alt"
                }
            }
            "Enter" => tr("回车键", "Enter"),
            "Space" => tr("空格", "Space"),
            k => k,
        })
        .collect::<Vec<_>>()
        .join("+")
}
