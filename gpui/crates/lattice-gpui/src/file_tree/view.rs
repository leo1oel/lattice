//! The tree panel drawn: the rows on Kit's tree with their menus, drags and
//! drops, the root's drop wash, the hover and the scrollbar.

use std::{rc::Rc, time::Duration};

use gpui::{
    Animation, AnimationExt as _, AppContext as _, Context, DragMoveEvent, ExternalPaths,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{input::Input, list::ListItem, tree::tree};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{ContextMenu, TreeRow, context_menu_trigger},
    fluid_hover::{FluidHover, ItemKind},
    scrollbar::{FluidScrollbar, ScrollbarFeel},
    shape,
};

use super::{
    DragPreview, DraggedEntry, FileTreeEvent, FileTreePanel,
    drop_aim::{Aim, drop_mark},
    motion::{Frame, Gone, ROW},
    selection::including,
};

/// How far the rows stand in from the panel's sides (`--space-5`: the
/// section's left padding, the tree surface's right one); the scrollbar
/// stands in the right one.
const ROW_INSET: gpui::Pixels = px(12.);
/// How far the name field's border and padding reach left of the name, so
/// the name stays where it was; less than the gap after the icon, so the
/// field never covers the icon (`[data-item-rename-input]`).
const NAME_FIELD_LEAD: gpui::Pixels = px(3.);

/// A row as a folder's motion draws it this frame: slid from where it was,
/// its bottom still covered while the folder uncovers it, or, for the
/// folder that closed, with the rows it hid under it being wiped.
fn moving(
    item: ListItem,
    frame: &Frame,
    gone: &[Gone],
    ix: usize,
    ground: gpui::Hsla,
    cx: &gpui::App,
) -> ListItem {
    let mut item = item.relative();
    let slide = frame.slide(ix, ROW);
    if slide != 0. {
        item = item.top(px(slide));
    }
    if let Some(covered) = frame.covered(ix, ROW).filter(|covered| *covered > 0.) {
        item = item.child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(px(covered))
                .bg(ground),
        );
    }
    if ix == frame.folder && !frame.opened && !gone.is_empty() {
        let rows = gone.iter().enumerate().map(|(at, row)| {
            let drawn = match row.folder {
                Some(open) => {
                    TreeRow::folder(("file-tree-gone", at), row.label.clone(), row.depth, open)
                }
                None => TreeRow::file(("file-tree-gone", at), row.label.clone(), row.depth),
            };
            div().h(px(ROW)).flex_none().child(drawn.into_list_item(cx))
        });
        item = item.child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(px(ROW))
                .h(px(frame.gone_height(ROW)))
                .overflow_hidden()
                .flex()
                .flex_col()
                .children(rows),
        );
    }
    item
}

impl Render for FileTreePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.project.is_none() {
            return div()
                .id("file-tree-empty")
                .track_focus(&self.focus_handle)
                .size_full()
                .px(px(20.))
                .py(px(12.))
                .text_role(TextRole::Body, cx)
                .text_color(cx.palette().text_secondary)
                .child(t!("Open a LaTeX project folder to start"))
                .into_any_element();
        }
        let view = cx.entity().downgrade();
        let menu_view = view.clone();
        let background_view = view.clone();
        // The rows' menu and the empty area's: Lattice's menu at the pointer.
        let row_menu = ContextMenu::<(String, bool)>::keyed("file-tree-row-menu", window, cx);
        let background_menu = ContextMenu::<()>::keyed("file-tree-menu", window, cx);
        let rows_menu = row_menu.clone();
        self.row_menu = Some(row_menu.clone());
        let root_drop = view.clone();
        let selected = Rc::new(self.selected_paths(cx));
        let filtering = self.search_query().is_some();
        // A folder opening or closing, this frame (`motion.rs`).
        let frame = self.motion_frame(cx);
        if frame.is_some() {
            window.request_animation_frame();
        }
        let ground = cx.palette().side_panel;
        let (pinned, pinned_bottom) = self.pinned_layer(cx);
        let naming = self
            .naming
            .as_ref()
            .map(|naming| (naming.path.clone(), naming.input.clone()));
        let aimed = self.aim.borrow().folder(cx);
        let row_aim = self.aim.clone();
        let row_pressed = self.pressed_row.clone();
        let marks = self.marks.clone();
        let figures = self.figures.clone();
        // The tree's hover is one fill gliding between rows, as the app's
        // (`project-tree-hover.tsx`): the open file's row keeps its own
        // selection fill and is never lit, and rows recycled under a resting
        // pointer stay dark until 150 ms after the scroll.
        let hover = FluidHover::new("file-tree-hover", window, cx)
            .fill(cx.palette().hover)
            .radius(shape::RADIUS_TARGET)
            .quiet_after_scroll(Duration::from_millis(150), cx);
        let rows_hover = hover.clone();
        self.hover = Some(hover.clone());
        let scroll = self.state.read(cx).scroll_handle().clone();
        // Measured on the Main window: rows 12px in from both sides, the
        // first 7px under the tab strip.
        div()
            .id("file-tree")
            .key_context("LatticeFileTree")
            .track_focus(&self.focus_handle)
            .size_full()
            .flex()
            .flex_col()
            .pt(px(7.))
            .px(ROW_INSET)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" && this.naming.is_some() {
                    cx.stop_propagation();
                    this.cancel_naming(window, cx);
                }
            }))
            .capture_key_down(cx.listener(Self::search_capture))
            .capture_key_down(cx.listener(|this, _: &KeyDownEvent, _, _| this.end_motion()))
            .on_any_mouse_down(cx.listener(|this, _, _, _| this.end_motion()))
            .on_key_down(cx.listener(Self::search_key))
            .on_key_down(cx.listener(Self::clipboard_key))
            .on_key_down(cx.listener(Self::rename_key))
            // Each move of a drag aims anew: off every row is the root.
            .on_drag_move({
                let aim = self.aim.clone();
                let view = view.clone();
                move |event: &DragMoveEvent<DraggedEntry>, _, cx| {
                    let inside = event.bounds.contains(&event.event.position);
                    *aim.borrow_mut() = Aim { inside, row: None };
                    let dragged = event.drag(cx);
                    if !inside && dragged.single_file() && !dragged.figure {
                        let (path, pointer) = (dragged.path.clone(), event.event.position);
                        view.update(cx, |_, cx| {
                            cx.emit(FileTreeEvent::DragOut { path, pointer })
                        })
                        .ok();
                    }
                }
            })
            .on_drag_move({
                let aim = self.aim.clone();
                move |event: &DragMoveEvent<ExternalPaths>, _, _| {
                    let inside = event.bounds.contains(&event.event.position);
                    *aim.borrow_mut() = Aim { inside, row: None };
                }
            })
            // A row dropped on the empty area moves to the top level.
            .on_drop({
                let aim = self.aim.clone();
                move |dragged: &DraggedEntry, _, cx| {
                    *aim.borrow_mut() = Aim::default();
                    root_drop
                        .update(cx, |_, cx| {
                            cx.emit(FileTreeEvent::Move {
                                paths: dragged.paths.clone(),
                                target: String::new(),
                            })
                        })
                        .ok();
                }
            })
            .on_drop({
                let view = view.clone();
                let aim = self.aim.clone();
                move |paths: &ExternalPaths, _, cx| {
                    *aim.borrow_mut() = Aim::default();
                    let paths = paths.paths().to_vec();
                    view.update(cx, |_, cx| {
                        cx.emit(FileTreeEvent::DropFiles {
                            paths,
                            target: String::new(),
                        })
                    })
                    .ok();
                }
            })
            .map(|this| context_menu_trigger(this, &background_menu, ()))
            .children(ContextMenu::layer(
                &background_menu,
                window,
                cx,
                move |menu, _, _, cx| Self::background_menu(&background_view, menu, cx),
            ))
            .children(ContextMenu::layer(
                &row_menu,
                window,
                cx,
                move |menu, (path, folder), _, cx| {
                    Self::row_menu(&menu_view, path.clone(), *folder, menu, cx)
                },
            ))
            .relative()
            .child(hover.highlight())
            // A drag aimed at the project root washes the whole tree
            // (`.project-file-tree-surface::after`), fading in.
            .when(aimed.as_deref() == Some(""), |tree| {
                let palette = cx.palette().clone();
                tree.child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(6.))
                        .bg(palette.accent_soft)
                        .border_1()
                        .border_color(palette.accent.opacity(0.27))
                        .with_animation(
                            "file-tree-root-drop",
                            Animation::new(lattice_ui::motion::Motion::Moderate.duration()),
                            |wash, t| wash.opacity(lattice_ui::motion::Motion::Moderate.sample(t)),
                        ),
                )
            })
            .children(self.search_field(cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    // A press that lands on no row clears the selection
                    // (`project-file-tree.tsx`): the rows mark their presses
                    // on the way up, before this sees them.
                    .capture_any_mouse_down(
                        cx.listener(|this, _, _, _| this.pressed_row.set(false)),
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, _, cx| {
                            if !this.pressed_row.get()
                                && this.naming.is_none()
                                && !event.modifiers.modified()
                            {
                                this.clear_selection(cx);
                            }
                        }),
                    )
                    .child(
                        // Rows scrolling up are cut off at the pinned rows' bottom
                        // edge (`--trees-sticky-overlay-height`), so none shows
                        // through them; the list keeps its full height inside.
                        div()
                            .absolute()
                            .top(px(pinned_bottom))
                            .bottom_0()
                            .left_0()
                            .right_0()
                            .overflow_hidden()
                            .child(
                                div()
                                    .absolute()
                                    .top(px(-pinned_bottom))
                                    .bottom_0()
                                    .left_0()
                                    .right_0()
                                    .child(
                                        tree(&self.state, move |ix, entry, _, window, cx| {
                                            let item = entry.item();
                                            let relative = item.id.to_string();
                                            let is_folder = entry.is_folder();
                                            let row_selected = selected.contains(&relative);
                                            let kind = if row_selected {
                                                ItemKind::skip()
                                            } else {
                                                ItemKind::target()
                                            };
                                            let mut row = if is_folder {
                                                TreeRow::folder(
                                                    ix,
                                                    item.label.clone(),
                                                    entry.depth(),
                                                    entry.is_expanded(),
                                                )
                                                .selected(row_selected)
                                                .contains_change(marks.folders.contains(&relative))
                                            } else {
                                                TreeRow::file(ix, item.label.clone(), entry.depth())
                                                    .selected(row_selected)
                                                    .git(marks.files.get(&relative).copied())
                                            }
                                            .turn(
                                                frame
                                                    .as_ref()
                                                    .map_or(0., |(frame, _)| frame.turn(ix)),
                                            )
                                            .fluid(rows_hover.probe(ix, kind))
                                            .drop_mark(drop_mark(
                                                aimed.as_deref(),
                                                &relative,
                                                is_folder,
                                            ));
                                            if let Some((_, input)) =
                                                naming.as_ref().filter(|(at, _)| *at == relative)
                                            {
                                                // The app's rename field: 20px on the compact
                                                // corner, its padding and border outside the name's
                                                // left edge, so the name stays where it was.
                                                let palette = cx.palette().clone();
                                                row = row.editing(
                                                    div()
                                                        .flex()
                                                        .items_center()
                                                        .h(px(20.))
                                                        .ml(-NAME_FIELD_LEAD)
                                                        .px(NAME_FIELD_LEAD - px(1.))
                                                        .rounded(px(4.))
                                                        .border_1()
                                                        .border_color(palette.field_border_hover)
                                                        .bg(palette.input)
                                                        .text_role(TextRole::Body, cx)
                                                        .text_color(palette.text)
                                                        .child(
                                                            Input::new(input)
                                                                .appearance(false)
                                                                .px_0()
                                                                .py_0()
                                                                .h(px(18.)),
                                                        ),
                                                );
                                            }
                                            // Parity regions are named by the path from the project
                                            // root, as the app's tree names its rows (`data-item-path`).
                                            if lattice_ui::parity::enabled() {
                                                row = row.parity(format!("row/{relative}"));
                                            }
                                            let dragged = DraggedEntry {
                                                paths: including(&selected, &relative),
                                                path: relative.clone(),
                                                name: item.label.clone(),
                                                folder: is_folder,
                                                figure: figures.contains(&relative),
                                            };
                                            // A drop on a folder moves into it; on a file, into the
                                            // file's folder.
                                            let target = if is_folder {
                                                relative.clone()
                                            } else {
                                                relative
                                                    .rsplit_once('/')
                                                    .map(|(parent, _)| parent.to_string())
                                                    .unwrap_or_default()
                                            };
                                            let open = view.clone();
                                            let click_path = relative.clone();
                                            let drop = view.clone();
                                            let paths_drop = view.clone();
                                            let entry_aim = row_aim.clone();
                                            let paths_aim = row_aim.clone();
                                            let entry_drop_aim = row_aim.clone();
                                            let paths_drop_aim = row_aim.clone();
                                            let (entry_target, paths_target) =
                                                (target.clone(), target.clone());
                                            let files_target = target.clone();
                                            let menu_target = (relative.clone(), is_folder);
                                            let pressed = row_pressed.clone();
                                            let mut item = row.into_list_item(cx);
                                            if let Some((frame, gone)) = &frame {
                                                window.request_animation_frame();
                                                item = moving(item, frame, gone, ix, ground, cx);
                                            }
                                            // A row waits to be dragged until the search's query is
                                            // empty (Pierre's `canDrag` while filtering).
                                            context_menu_trigger(item, &rows_menu, menu_target)
                        .when(!filtering, |item| {
                            item.on_drag(dragged, |dragged, _, _, cx| {
                                cx.new(|_| DragPreview(dragged.clone()))
                            })
                        })
                        .on_drag_move(move |event: &DragMoveEvent<DraggedEntry>, _, _| {
                            if event.bounds.contains(&event.event.position) {
                                entry_aim.borrow_mut().row = Some(entry_target.clone());
                            }
                        })
                        .on_drag_move(move |event: &DragMoveEvent<ExternalPaths>, _, _| {
                            if event.bounds.contains(&event.event.position) {
                                paths_aim.borrow_mut().row = Some(paths_target.clone());
                            }
                        })
                        .on_drop(move |paths: &ExternalPaths, _, cx| {
                            cx.stop_propagation();
                            *paths_drop_aim.borrow_mut() = Aim::default();
                            let (paths, target) = (paths.paths().to_vec(), files_target.clone());
                            paths_drop
                                .update(cx, |_, cx| {
                                    cx.emit(FileTreeEvent::DropFiles { paths, target })
                                })
                                .ok();
                        })
                        .on_drop(move |dragged: &DraggedEntry, _, cx| {
                            cx.stop_propagation();
                            *entry_drop_aim.borrow_mut() = Aim::default();
                            // Nothing moves into itself or a folder inside
                            // it; the rest still go.
                            let paths: Vec<String> = dragged
                                .paths
                                .iter()
                                .filter(|path| {
                                    **path != target && !target.starts_with(&format!("{path}/"))
                                })
                                .cloned()
                                .collect();
                            if paths.is_empty() {
                                return;
                            }
                            drop.update(cx, |_, cx| {
                                cx.emit(FileTreeEvent::Move {
                                    paths,
                                    target: target.clone(),
                                })
                            })
                            .ok();
                        })
                        .on_mouse_down(MouseButton::Left, move |_, _, _| pressed.set(true))
                        .on_click(move |event, window, cx| {
                            open.update(cx, |this, cx| {
                                this.click_row(&click_path, is_folder, event, window, cx);
                                if !is_folder && event.click_count() == 2 {
                                    this.keep_row(&click_path, cx);
                                }
                                cx.defer_in(window, |this, window, cx| {
                                    this.close_search(false, window, cx)
                                });
                            })
                            .ok();
                        })
                                        })
                                        // Lattice's scrollbar, below, in place of Kit's.
                                        .scrollbar(false),
                                    ),
                            ),
                    )
                    .children(pinned)
                    // The bar stands in the panel's right gutter, flush with
                    // its edge, as the app's does (`.project-section` has no
                    // right padding and the surface's `padding-right` keeps
                    // the rows off the bar), so it never covers a row's name.
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left_0()
                            .right(-ROW_INSET)
                            .child(
                                FluidScrollbar::vertical("file-tree-scrollbar", &scroll)
                                    .feel(ScrollbarFeel::LIST),
                            ),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use lattice_ui::components::TREE_ROW_LABEL_GAP;

    use super::*;

    // Leo: the name field of a new file covered its icon. Its reach left of
    // the name has to stay inside the gap after the icon, with room to spare.
    #[test]
    fn the_name_field_clears_the_rows_icon() {
        assert!(NAME_FIELD_LEAD + px(2.) <= TREE_ROW_LABEL_GAP);
    }
}
