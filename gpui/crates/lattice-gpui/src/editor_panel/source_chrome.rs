//! The chrome around a source editor that the Tauri app's document canvas
//! and Trellis header give it (`document-canvas.tsx`,
//! `trellis-latex-view-switch.tsx`): for a `.tex` file, the outline rail
//! over the editor's right edge, whose width the text gives up, and the
//! Source / Visual switch in the panel's strip, shown in room to spare
//! before the Build chip (the ⋯ menu repeats it). Visual is not in the GPUI
//! preview yet: the switch keeps its place and says so.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Styled as _, Window, div,
};
use lattice_editor::{LatticeEditor, latex};
use lattice_ui::ActiveLattice as _;

use super::{
    EditorPanel, EditorPanelEvent, VISUAL_NOT_PORTED,
    outline_rail::{OutlineRail, OutlineRailEvent, RAIL_CLEARANCE},
};
use crate::project::Project;

impl EditorPanel {
    /// The outline rail for the `.tex` file at `relative` in `lattice`.
    pub(super) fn new_rail(
        lattice: &Entity<LatticeEditor>,
        project: &Entity<Project>,
        relative: String,
        source: String,
        cx: &mut Context<Self>,
    ) -> Entity<OutlineRail> {
        let root = project.read(cx).root().to_path_buf();
        let rail = cx.new(|cx| {
            let mut rail = OutlineRail::new(lattice.clone(), root, relative.clone(), cx);
            rail.set_source(relative, source, cx);
            rail
        });
        cx.subscribe(&rail, |_, _, event: &OutlineRailEvent, cx| match event {
            OutlineRailEvent::Jump { path, line } => cx.emit(EditorPanelEvent::OutlineJump {
                path: path.clone(),
                line: *line,
            }),
        })
        .detach();
        // Whether it shows decides the room the text keeps.
        cx.observe(&rail, |_, _, cx| cx.notify()).detach();
        rail
    }

    /// The outline rail, for a `.tex` file.
    pub fn outline_rail(&self) -> Option<&Entity<OutlineRail>> {
        self.rail.as_ref()
    }

    /// The manuscript's outline, as the shell last read it, and its root
    /// document: what the rail marks.
    pub fn set_manuscript_outline(
        &mut self,
        headings: std::rc::Rc<[crate::outline::Heading]>,
        root: String,
        cx: &mut Context<Self>,
    ) {
        if let Some(rail) = &self.rail {
            rail.update(cx, |rail, cx| rail.set_manuscript(headings, root, cx));
        }
    }

    /// Give a `.tex` file's strip its Source / Visual switch (in room to
    /// spare, before the Build chip), or take it away from another file's.
    pub(super) fn offer_view_switch(&mut self, cx: &mut Context<Self>) {
        let panel = gpui_kit::component::dock::PanelId::from(cx.entity_id());
        let tools = latex::is_tex_source(&self.path).then(|| lattice_ui::dock::SpareTools {
            width: std::rc::Rc::new(|window, cx| {
                lattice_ui::components::ViewSwitch::width(&["Source", "Visual"], true, window, cx)
            }),
            render: std::rc::Rc::new(|_, cx| latex_view_switch(cx).into_any_element()),
        });
        lattice_ui::dock::set_spare_tools(panel, tools, cx);
        // The build chip keeps only its mark in a strip short of room; a
        // view switch, a board, sheet or deck draw the same there.
        let this = cx.entity().downgrade();
        let saving: lattice_ui::dock::IconSaving = std::rc::Rc::new(move |window, cx| {
            let chip = this
                .upgrade()
                .is_some_and(|panel| panel.read(cx).shows_build_chip());
            if chip {
                crate::editor_status::build_chip_icon_saving(window, cx)
            } else {
                gpui::px(0.)
            }
        });
        lattice_ui::dock::set_icon_saving(panel, Some(saving), cx);
    }

    /// Whether the strip carries the build chip: no view switch in its
    /// place, and not a board, sheet or deck, which carry no tools.
    pub(super) fn shows_build_chip(&self) -> bool {
        self.structured.is_none() && self.document_view().is_none()
    }

    /// The source editor, with the outline rail over its right edge when the
    /// file has one and the editor room for it; the text gives up the rail's
    /// width.
    pub(super) fn render_source(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let rail_shown = self.rail.as_ref().is_some_and(|rail| rail.read(cx).shown());
        let clearance = if rail_shown {
            RAIL_CLEARANCE
        } else {
            gpui::px(0.)
        };
        self.lattice
            .update(cx, |lattice, cx| lattice.set_end_clearance(clearance, cx));
        let width = self.editor_width.clone();
        let rail = self.rail.clone();
        let this = cx.entity().downgrade();
        div()
            .id("lattice-source")
            .relative()
            .flex_1()
            .min_h_0()
            // The writer moving on by hand ends a rail jump's hold on the
            // current section, unless it is on the rail.
            .capture_any_mouse_down(cx.listener(|this, _, _, cx| this.release_rail(cx)))
            .capture_key_down(cx.listener(|this, _, _, cx| this.release_rail(cx)))
            .child(self.lattice.clone())
            .children(self.rail.clone())
            .child(
                gpui::canvas(
                    move |bounds, window, cx| {
                        let new = bounds.size.width;
                        if width.get() != Some(new) {
                            width.set(Some(new));
                            if let Some(rail) = rail.clone() {
                                cx.defer(move |cx| {
                                    rail.update(cx, |rail, cx| rail.set_editor_width(new, cx))
                                });
                            }
                        }
                        window.insert_hitbox(bounds, gpui::HitboxBehavior::Normal)
                    },
                    // A wheel over the source ends the hold too. Zed and the
                    // gutter stop a wheel that scrolls them, so the release
                    // listens before them, in the capture phase.
                    move |_, hitbox, window, _| {
                        window.on_mouse_event(move |_: &gpui::ScrollEvent, phase, window, cx| {
                            if phase == gpui::DispatchPhase::Capture
                                && hitbox.should_handle_scroll(window)
                            {
                                this.update(cx, |this, cx| this.release_rail(cx)).ok();
                            }
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    fn release_rail(&mut self, cx: &mut Context<Self>) {
        if let Some(rail) = &self.rail
            && !rail.read(cx).hovered()
        {
            rail.update(cx, |rail, cx| rail.release(cx));
        }
    }
}

/// A .tex file's Source / Visual switch: Source is the view; Visual keeps its
/// place, says it is not in the GPUI preview yet, and cannot be chosen.
fn latex_view_switch(cx: &App) -> impl IntoElement {
    let palette = cx.palette();
    lattice_ui::components::ViewSwitch::new("latex-view-switch")
        .mode(lattice_ui::Icon::CODE_XML, "Source", true, |_, _, _| {})
        .unavailable_mode(lattice_ui::Icon::TYPE, "Visual", VISUAL_NOT_PORTED)
        .surface(palette.editor)
        .parity("editor/view-switch")
}
