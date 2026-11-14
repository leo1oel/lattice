//! Who else is in the linked Overleaf project, as the Tauri app shows them
//! (`src/overleaf/overleaf-presence.tsx`, `overleaf-editor-extensions.ts`):
//! stacked initials in the titlebar beside the Overleaf control, a card on
//! hover saying who is where (each row, and each chip, a jump there), and
//! each person's caret in the editors showing their file.
//!
//! The card's "Message everyone in Chat" row waits for the chat (a later
//! slice of the Overleaf port).

use gpui::{
    AnimationExt as _, AnyElement, App, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, WeakEntity,
    Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::overleaf_rt::PresenceUser;
use lattice_editor::remote_cursors::hue_color;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    motion::Motion,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, RADIUS_PILL},
};

use super::Shell;
use crate::{
    build::hover_card::HoverCard, editor_panel::OverleafCaret, history::widgets::initials,
};

/// At most this many chips; the rest are counted in a last one.
const MAX_AVATARS: usize = 5;
/// The chips' size, and how far each tucks under the one before it.
const CHIP: f32 = 22.;
const OVERLAP: f32 = 2.;

/// Someone's name, or "Anonymous".
fn name_of(peer: &PresenceUser) -> SharedString {
    if peer.name.trim().is_empty() {
        t!("Anonymous").into()
    } else {
        peer.name.clone().into()
    }
}

impl Shell {
    /// The titlebar's Overleaf items: the sync control, then who else is in
    /// the project.
    pub(crate) fn overleaf_tools(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        self.overleaf_sync_control(cx)
            .into_iter()
            .chain(self.overleaf_presence(cx))
            .collect()
    }

    /// Where `peer` is: the file and line their caret is on.
    fn peer_place(&self, peer: &PresenceUser, cx: &App) -> Option<String> {
        let path = self
            .overleaf
            .read(cx)
            .path_of_doc(peer.doc_id.as_deref()?)?;
        Some(match peer.row {
            Some(row) => t!("{path}, line {line}", path = &path, line = row + 1).into(),
            None => path,
        })
    }

    /// Open `peer`'s file at their line.
    fn jump_to_peer(&mut self, peer: &PresenceUser, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = peer
            .doc_id
            .as_deref()
            .and_then(|doc| self.overleaf.read(cx).path_of_doc(doc))
        else {
            return;
        };
        if let Some(root) = self.root(cx) {
            let line = peer.row.map(|row| (row + 1).max(1) as u32);
            self.open_path(root.join(path), line, window, cx);
        }
    }

    fn overleaf_presence(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let bridge = self.overleaf.read(cx);
        if bridge.link().is_none() || bridge.peers().is_empty() {
            return None;
        }
        let peers = bridge.peers().to_vec();
        let reconnecting = bridge.peers_reconnecting();
        let palette = cx.palette().clone();
        let shell = cx.entity().downgrade();
        let chip = |id: SharedString| {
            div()
                .id(id)
                .flex_none()
                .size(px(CHIP))
                .flex()
                .items_center()
                .justify_center()
                .rounded(RADIUS_PILL)
                // Ringed in the titlebar's surface, so each chip reads as cut
                // out of the one beneath.
                .border(px(1.5))
                .border_color(palette.titlebar)
                .text_role(TextRole::Micro, cx)
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .line_height(px(CHIP - 3.))
        };
        let mut stack = div()
            .flex()
            .items_center()
            .px(px(6.))
            .when(reconnecting, |this| this.opacity(0.45));
        for (index, peer) in peers.iter().take(MAX_AVATARS).enumerate() {
            let name = name_of(peer);
            let label = match self.peer_place(peer, cx) {
                Some(place) => t!(
                    "{name} at {place}. Click to jump there",
                    name = &name,
                    place = &place
                )
                .to_string(),
                None => name.to_string(),
            };
            let jump = peer.clone();
            let shell = shell.clone();
            let id = SharedString::from(format!("overleaf-peer-{}", peer.id));
            stack = stack.child(
                chip(id.clone())
                    .when(index > 0, |this| this.ml(px(-OVERLAP)))
                    .bg(hue_color(peer.hue as f32))
                    .text_color(gpui::white())
                    .cursor_pointer()
                    .tooltip(move |_, cx| -> gpui::AnyView {
                        lattice_ui::components::LatticeTooltip::view(
                            SharedString::from(label.clone()),
                            None,
                            cx,
                        )
                    })
                    .on_click(move |_, window, cx| {
                        shell
                            .update(cx, |shell, cx| shell.jump_to_peer(&jump, window, cx))
                            .ok();
                    })
                    .child(initials(&name))
                    // Someone who joins arrives as a short fade into the stack.
                    .with_animation(id, Motion::Moderate.animation(), |this, delta| {
                        this.opacity(delta)
                    }),
            );
        }
        let overflow = peers.len().saturating_sub(MAX_AVATARS);
        if overflow > 0 {
            stack = stack.child(
                chip("overleaf-peers-more".into())
                    .ml(px(-OVERLAP))
                    .bg(palette.panel)
                    .text_color(palette.text_secondary)
                    .child(format!("+{overflow}")),
            );
        }
        let places: Vec<(PresenceUser, Option<String>)> = peers
            .into_iter()
            .map(|peer| {
                let place = self.peer_place(&peer, cx);
                (peer, place)
            })
            .collect();
        Some(
            HoverCard::new("overleaf-presence", stack, move |_, cx| {
                presence_card(&places, reconnecting, shell.clone(), cx)
            })
            .into_any_element(),
        )
    }

    /// Draw everyone's caret in the editors showing their file, and nobody's
    /// in a file no one is in.
    pub(super) fn show_overleaf_carets(&mut self, cx: &mut Context<Self>) {
        let editors = self.open_editors();
        let bridge = self.overleaf.read(cx);
        let linked = bridge.link().is_some();
        let carets: Vec<_> = editors
            .iter()
            .map(|editor| {
                let doc = linked
                    .then(|| bridge.doc_of_path(editor.read(cx).relative()))
                    .flatten();
                let carets: Vec<OverleafCaret> = bridge
                    .peers()
                    .iter()
                    .filter(|peer| doc.is_some() && peer.doc_id == doc)
                    .filter_map(|peer| {
                        Some(OverleafCaret {
                            id: peer.id.clone().into(),
                            name: name_of(peer),
                            color: hue_color(peer.hue as f32),
                            row: u32::try_from(peer.row?).ok()?,
                            column: u32::try_from(peer.column.unwrap_or(0)).unwrap_or(0),
                        })
                    })
                    .collect();
                (editor.clone(), carets)
            })
            .collect();
        for (editor, carets) in carets {
            editor.update(cx, |editor, cx| editor.set_overleaf_carets(carets, cx));
        }
    }

    /// The active editor's caret moved: tell Overleaf where it is.
    pub(super) fn tell_overleaf_caret(
        &mut self,
        editor: &gpui::Entity<crate::editor_panel::EditorPanel>,
        cx: &mut Context<Self>,
    ) {
        if self.active_editor().as_ref() != Some(editor) {
            return;
        }
        let (relative, (row, column)) = {
            let editor = editor.read(cx);
            (editor.relative().to_string(), editor.overleaf_caret())
        };
        self.overleaf.update(cx, |bridge, cx| {
            bridge.caret_moved(&relative, row, column, cx)
        });
    }
}

/// The card: how many are here, and a row per person saying where.
fn presence_card(
    places: &[(PresenceUser, Option<String>)],
    reconnecting: bool,
    shell: WeakEntity<Shell>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let head: SharedString = if reconnecting {
        t!("Reconnecting to Overleaf…").into()
    } else if places.len() == 1 {
        t!("1 person on Overleaf now").into()
    } else {
        t!("{count} people on Overleaf now", count = places.len()).into()
    };
    let rows = places.iter().map(|(peer, place)| {
        let jump = peer.clone();
        let shell = shell.clone();
        let name = name_of(peer);
        div()
            .id(SharedString::from(format!(
                "overleaf-presence-row-{}",
                peer.id
            )))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|this| this.bg(palette.hover))
            .on_click(move |_, window, cx| {
                shell
                    .update(cx, |shell, cx| shell.jump_to_peer(&jump, window, cx))
                    .ok();
            })
            .child(
                div()
                    .flex_none()
                    .size(px(24.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(RADIUS_PILL)
                    .bg(hue_color(peer.hue as f32))
                    .text_color(gpui::white())
                    .text_role(TextRole::Micro, cx)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .child(initials(&name)),
            )
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .truncate()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(name),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(place.clone().unwrap_or_else(|| t!("Not in a file").into())),
                    ),
            )
    });
    div()
        .w(px(280.))
        .flex()
        .flex_col()
        .p(px(4.))
        .rounded(px(10.))
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .child(
            div()
                .px(px(8.))
                .pt(px(6.))
                .pb(px(4.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(head),
        )
        .children(rows)
        .into_any_element()
}
