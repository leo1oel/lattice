// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Flowcharts from the keyboard, after Excalidraw `App.flowchart.ts` @
//! 3a317b5: ⌘ (Ctrl elsewhere) + an arrow key adds pending successor nodes
//! to the selected node, linked by elbow arrows; releasing ⌘ inserts them
//! and selects the first. Alt + an arrow key walks to the linked node in
//! that direction. Escape drops the pending nodes.

use super::super::BoardView;
use super::super::Hooks;
use super::super::flowchart::LinkDirection;
use super::super::history::CaptureUpdateAction;
use gpui::{Context, KeyUpEvent, ModifiersChangedEvent, Window};
use std::collections::BTreeSet;

/// ⌘ + arrow: one more pending node.
pub fn create(me: &mut BoardView, dir: LinkDirection, cx: &mut Context<BoardView>) {
    let sel = me.selected_elements();
    if sel.len() != 1 || !sel[0].is_flowchart_node() {
        return;
    }
    let id = sel[0].id.clone();
    let m = me.m.clone();
    let hooks = Hooks(&*m);
    let head = me.app.current_item_end_arrowhead;
    me.flowchart
        .create_nodes(&id, head, me.app.zoom, dir, &mut me.scene, &hooks);
    cx.notify();
}

/// Alt + arrow: to the linked node that way.
pub fn navigate(me: &mut BoardView, dir: LinkDirection, cx: &mut Context<BoardView>) {
    let sel: Vec<_> = me.selected_elements().into_iter().cloned().collect();
    if sel.len() != 1 {
        return;
    }
    if let Some(next) = me.navigator.explore_by_direction(&sel[0], &me.scene, dir) {
        me.app.selected_element_ids = BTreeSet::from([next]);
        me.app.selected_group_ids.clear();
        me.sync_linear();
        cx.notify();
    }
}

/// Escape while creating.
pub fn cancel(me: &mut BoardView, cx: &mut Context<BoardView>) -> bool {
    if !me.flowchart.is_creating_chart {
        return false;
    }
    me.flowchart.clear();
    cx.notify();
    true
}

fn commit_pending(me: &mut BoardView, cx: &mut Context<BoardView>) {
    let nodes = me.flowchart.pending_nodes.take().unwrap_or_default();
    me.flowchart.clear();
    if let Some(first) = nodes.first().map(|n| n.id.clone()) {
        me.scene.insert_elements_at_index(nodes, None);
        me.app.selected_element_ids = BTreeSet::from([first]);
        me.app.selected_group_ids.clear();
        me.sync_linear();
    }
    me.commit(Some(CaptureUpdateAction::Immediately), cx);
}

pub fn modifiers_changed(
    me: &mut BoardView,
    ev: &ModifiersChangedEvent,
    _: &mut Window,
    cx: &mut Context<BoardView>,
) {
    let cmd = if cfg!(target_os = "macos") {
        ev.modifiers.platform
    } else {
        ev.modifiers.control
    };
    if !cmd && me.flowchart.is_creating_chart {
        commit_pending(me, cx);
    }
    if !ev.modifiers.alt && me.navigator.is_exploring {
        me.navigator.clear();
        me.commit(Some(CaptureUpdateAction::Immediately), cx);
    }
}

pub fn key_up(_: &mut BoardView, _: &KeyUpEvent, _: &mut Window, _: &mut Context<BoardView>) {}
