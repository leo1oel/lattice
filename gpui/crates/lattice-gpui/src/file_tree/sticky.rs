//! Sticky folders, as the Tauri app's Pierre tree pins them
//! (`stickyFolders: true`): while a folder's rows scroll by, its row stays
//! at the top, one under another down the open folders, each at its depth
//! times the row height. As the folder's last row leaves, its pinned row is
//! pushed up with it and slides under the one above. Pinned rows are drawn
//! on the tree's ground, with no rule or shadow, their chevron open.
//!
//! A click on a pinned row selects that folder, closes it, and scrolls it to
//! just under its own pinned folders. A wheel over them scrolls the tree.

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div, point, px,
};
use lattice_ui::{ActiveLattice as _, components::TreeRow};

use super::{FileTreePanel, motion::ROW};

/// A row pinned at the top: the tree's row `ix` at depth `depth`, its top
/// `top` from the tree's top edge (under `depth × ROW` once it is pushed).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Pinned {
    pub(crate) ix: usize,
    pub(crate) depth: usize,
    pub(crate) top: f32,
}

/// The rows pinned with the tree scrolled `scrolled` down, from each row's
/// depth and whether it is an open folder (`layout.js`): an open folder
/// whose row has gone above its place, while rows inside it are still below.
pub(super) fn pinned(rows: &[(usize, bool)], scrolled: f32, row: f32) -> Vec<Pinned> {
    let mut pinned = Vec::new();
    if scrolled <= 0. {
        return pinned;
    }
    for (ix, &(depth, open)) in rows.iter().enumerate() {
        let place = depth as f32 * row;
        if (ix as f32 * row) >= scrolled + place {
            break;
        }
        if !open {
            continue;
        }
        let end = rows[ix + 1..]
            .iter()
            .take_while(|(inner, _)| *inner > depth)
            .count()
            + ix;
        if end == ix {
            continue;
        }
        let pushed = (end + 1) as f32 * row - scrolled - row;
        let top = place.min(pushed);
        if top + row - place > 0. {
            pinned.push(Pinned { ix, depth, top });
        }
    }
    pinned
}

impl FileTreePanel {
    fn shown_shape(&self, cx: &App) -> Vec<(usize, bool)> {
        let state = self.state.read(cx);
        (0..)
            .map_while(|ix| state.entry(ix))
            .map(|entry| (entry.depth(), entry.is_folder() && entry.is_expanded()))
            .collect()
    }

    /// The rows pinned now.
    pub(crate) fn pinned_rows(&self, cx: &App) -> Vec<Pinned> {
        let scroll = self.state.read(cx).scroll_handle().clone();
        let scrolled = -f32::from(scroll.0.borrow().base_handle.offset().y);
        pinned(&self.shown_shape(cx), scrolled, ROW)
    }

    /// A pinned folder clicked: selected, closed, and scrolled to just
    /// under its pinned folders.
    pub(crate) fn click_pinned(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self
            .state
            .read(cx)
            .entry(ix)
            .map(|entry| entry.item().id.clone())
        else {
            return;
        };
        self.pick(&id, true, gpui::Modifiers::default(), cx);
        self.close_search(false, window, cx);
        let state = self.state.read(cx);
        let Some((ix, depth)) = state
            .index_of(&id)
            .and_then(|ix| state.entry(ix).map(|entry| (ix, entry.depth())))
        else {
            return;
        };
        if let Some(entry) = state.entry(ix) {
            // The item's open state is shared with the tree's copy of it.
            let _ = entry.item().clone().expanded(false);
        }
        self.expanded.remove(id.as_ref());
        self.rebuild(cx);
        let scroll = self.state.read(cx).scroll_handle().clone();
        let y = (ix as f32 - depth as f32) * ROW;
        scroll
            .0
            .borrow()
            .base_handle
            .set_offset(point(px(0.), px(-y)));
        cx.notify();
    }

    /// The pinned rows over the tree's top, drawn on its ground, and how
    /// far down the lowest of them reaches (0 with none).
    pub(super) fn pinned_layer(&self, cx: &mut Context<Self>) -> (Option<AnyElement>, f32) {
        let pinned = self.pinned_rows(cx);
        if pinned.is_empty() {
            return (None, 0.);
        }
        let bottom = pinned.iter().map(|pin| pin.top + ROW).fold(0., f32::max);
        let palette = cx.palette().clone();
        let ground = palette.side_panel;
        let selected = self.selected_paths(cx);
        let state = self.state.read(cx);
        let rows: Vec<AnyElement> = pinned
            .iter()
            .filter_map(|pin| {
                let entry = state.entry(pin.ix)?;
                let id = entry.item().id.to_string();
                let place = pin.depth as f32 * ROW;
                let view = cx.entity().downgrade();
                let pressed = self.pressed_row.clone();
                let ix = pin.ix;
                let row = TreeRow::folder(
                    ("file-tree-pinned", pin.ix),
                    entry.item().label.clone(),
                    entry.depth(),
                    true,
                )
                .selected(selected.contains(&id))
                .into_list_item(cx);
                Some(
                    div()
                        .id(("file-tree-pin", pin.ix))
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(px(place))
                        .h(px(pin.top + ROW - place))
                        .overflow_hidden()
                        .bg(ground)
                        .block_mouse_except_scroll()
                        .on_mouse_down(MouseButton::Left, move |_, _, _| pressed.set(true))
                        .on_click(move |_, window, cx| {
                            view.update(cx, |this, cx| this.click_pinned(ix, window, cx))
                                .ok();
                        })
                        .child(
                            div()
                                .absolute()
                                .left_0()
                                .right_0()
                                .top(px(pin.top - place))
                                .h(px(ROW))
                                .child(row),
                        )
                        .into_any_element(),
                )
            })
            .collect();
        (
            Some(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .children(rows)
                    .into_any_element(),
            ),
            bottom,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // figures/ (open, 3 rows inside, one an open folder with 2), then
    // main.tex: rows 0 figures, 1 a.png, 2 raw/ (open), 3 raw/x, 4 raw/y,
    // 5 main.tex.
    fn rows() -> Vec<(usize, bool)> {
        vec![
            (0, true),
            (1, false),
            (1, true),
            (2, false),
            (2, false),
            (0, false),
        ]
    }

    #[test]
    fn nothing_is_pinned_at_the_top() {
        assert!(pinned(&rows(), 0., 28.).is_empty());
    }

    #[test]
    fn open_folders_pin_one_under_another_and_are_pushed_out_by_their_end() {
        // Scrolled one row: figures/ is above its place, raw/ not yet.
        assert_eq!(
            pinned(&rows(), 28., 28.),
            vec![Pinned {
                ix: 0,
                depth: 0,
                top: 0.
            }]
        );
        // Three rows: raw/ (row 2) has gone above its place at 28px.
        assert_eq!(
            pinned(&rows(), 3. * 28., 28.),
            vec![
                Pinned {
                    ix: 0,
                    depth: 0,
                    top: 0.
                },
                Pinned {
                    ix: 2,
                    depth: 1,
                    top: 28.
                },
            ]
        );
        // Four and a half rows: figures/ ends at row 4, so it is pushed
        // up by half a row; raw/ is pushed out past its place.
        assert_eq!(
            pinned(&rows(), 4.5 * 28., 28.),
            vec![Pinned {
                ix: 0,
                depth: 0,
                top: -14.
            }]
        );
        // Past figures/' last row nothing stays pinned.
        assert!(pinned(&rows(), 5. * 28., 28.).is_empty());
    }
}
