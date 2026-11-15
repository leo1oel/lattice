//! The window's side of local annotations (`crate::annotations`): the
//! Annotations panel in the workspace's "comments" view for a project not
//! linked to Overleaf (a linked one's view is Overleaf's collaboration
//! panel, `overleaf_collab`), the titlebar's Annotations button with what
//! is open, the status bar's counter, the palette's Show annotations and
//! Annotate selection, and what an editor asks about a note (its pin, its
//! card's Resolve and Reply…).
//!
//! As in the Tauri app (`useEditorComments`), a note on a file of a linked
//! project goes to Overleaf as a comment thread; any other note is a local
//! annotation.

use std::sync::Arc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, WeakEntity, Window, actions, div,
};
use gpui_kit::component::dock::{BasePanel, BasePanelView, Panel, PanelEvent, panel_handle};
use lattice_i18n::t;
use lattice_ui::{
    Icon,
    components::{IconButton, Surface},
};

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};
use crate::{
    annotations::{
        AnnotationRequest,
        panel::{AnnotationsPanel, AnnotationsPanelEvent, PanelHost},
        store,
    },
    editor_panel::EditorPanel,
    overleaf::collab::OverleafCollabPanel,
};

actions!(lattice, [ShowAnnotations]);

pub(crate) struct Annotations {
    pub(crate) panel: Entity<AnnotationsPanel>,
    view: Entity<CommentsView>,
    _events: Subscription,
}

/// The "comments" view: Overleaf's collaboration panel for a linked
/// project, else the Annotations panel.
pub struct CommentsView {
    focus_handle: FocusHandle,
    annotations: Entity<AnnotationsPanel>,
    /// Overleaf's bridge and collaboration panel, handed over once the
    /// window is made (the view is made while it is); never read through
    /// the shell, which is mid-update whenever it asks the view anything.
    overleaf: Option<(
        Entity<crate::overleaf::bridge::OverleafBridge>,
        Entity<OverleafCollabPanel>,
    )>,
    _observe: Vec<Subscription>,
}

impl CommentsView {
    /// Whether it shows Overleaf's collaboration panel (a linked project).
    pub(crate) fn shows_overleaf(&self, cx: &App) -> bool {
        self.linked(cx)
    }

    fn linked(&self, cx: &App) -> bool {
        self.overleaf
            .as_ref()
            .is_some_and(|(bridge, _)| bridge.read(cx).link().is_some())
    }

    fn collab(&self, _: &App) -> Option<Entity<OverleafCollabPanel>> {
        self.overleaf.as_ref().map(|(_, collab)| collab.clone())
    }

    fn set_overleaf(
        &mut self,
        bridge: Entity<crate::overleaf::bridge::OverleafBridge>,
        collab: Entity<OverleafCollabPanel>,
        cx: &mut Context<Self>,
    ) {
        self._observe = vec![
            cx.observe(&bridge, |_, _, cx| cx.notify()),
            cx.observe(&collab, |_, _, cx| cx.notify()),
            cx.observe(&self.annotations, |_, _, cx| cx.notify()),
        ];
        self.overleaf = Some((bridge, collab));
        cx.notify();
    }
}

impl EventEmitter<PanelEvent> for CommentsView {}

impl Focusable for CommentsView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        match self.collab(cx) {
            Some(collab) if self.linked(cx) => collab.read(cx).focus_handle(cx),
            _ => self.annotations.read(cx).focus_handle(cx),
        }
    }
}

impl Render for CommentsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shown: AnyElement = match self.collab(cx) {
            Some(collab) if self.linked(cx) => collab.into_any_element(),
            _ => self.annotations.clone().into_any_element(),
        };
        div()
            .track_focus(&self.focus_handle)
            .size_full()
            .child(shown)
    }
}

impl BasePanel for CommentsView {
    fn panel_name(&self) -> &'static str {
        "CommentsView"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for CommentsView {
    /// Trellis names the tool by what it shows (`trellis-titles.ts`).
    fn tab_name(&self, cx: &App) -> Option<SharedString> {
        Some(if self.linked(cx) {
            t!("Overleaf").into()
        } else {
            t!("Annotations").into()
        })
    }

    fn title(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.linked(cx) {
            t!("Overleaf")
        } else {
            t!("Annotations")
        }
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Shell {
    fn install_annotations(window: &mut Window, cx: &mut Context<Self>) -> Annotations {
        let shell = cx.weak_entity();
        let source_shell = shell.clone();
        let host = PanelHost {
            project: Box::new(move |cx| {
                let shell = shell.upgrade()?;
                let shell = shell.read(cx);
                let root = shell.root(cx)?;
                let active = shell
                    .active_editor()
                    .map(|editor| editor.read(cx).relative().to_string());
                Some((root, active))
            }),
            source: Box::new(move |path, cx| {
                let shell = source_shell.upgrade()?;
                let shell = shell.read(cx);
                shell
                    .editors_open(cx)
                    .into_iter()
                    .find(|editor| editor.read(cx).relative() == path)
                    .map(|editor| editor.read(cx).text(cx))
            }),
        };
        let panel = cx.new(|cx| AnnotationsPanel::new(host, window, cx));
        let events = cx.subscribe_in(
            &panel,
            window,
            |this, _, event: &AnnotationsPanelEvent, window, cx| match event {
                AnnotationsPanelEvent::Open(comment) => {
                    this.open_annotation(comment.path.clone(), comment.id.clone(), window, cx)
                }
                AnnotationsPanelEvent::OpenFile => this.toggle_quick_open(window, cx),
            },
        );
        let view = cx.new(|cx| CommentsView {
            focus_handle: cx.focus_handle(),
            _observe: Vec::new(),
            annotations: panel.clone(),
            overleaf: None,
        });
        let handed = view.clone();
        cx.defer_in(window, move |shell, _, cx| {
            let (bridge, collab) = (shell.overleaf.clone(), shell.overleaf_collab.clone());
            handed.update(cx, |view, cx| view.set_overleaf(bridge, collab, cx));
        });
        Annotations {
            panel,
            view,
            _events: events,
        }
    }

    /// The Annotations panel.
    pub(crate) fn annotations_panel(&self) -> Entity<AnnotationsPanel> {
        self.parts.get::<Annotations>().panel.clone()
    }

    /// The "comments" view's panel.
    pub(super) fn comments_view(&self) -> Arc<dyn BasePanelView> {
        panel_handle(self.parts.get::<Annotations>().view.clone())
    }

    /// The open editors.
    fn editors_open(&self, _: &App) -> Vec<Entity<EditorPanel>> {
        self.editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .collect()
    }

    /// Show the Annotations panel (`openPanel`): Overleaf's comments for a
    /// linked project.
    pub(crate) fn open_annotations(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overleaf.read(cx).link().is_some() {
            self.open_overleaf_collab(
                Some(crate::overleaf::collab::CollabTab::Comments),
                window,
                cx,
            );
            return;
        }
        self.reveal_tool("comments", window, cx);
    }

    /// Open the note's file and show its passage, the panel staying beside
    /// the editor (`openComment`).
    fn open_annotation(
        &mut self,
        path: String,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let panel = self.parts.get::<Annotations>().panel.clone();
        panel.update(cx, |panel, cx| {
            panel.set_active_note(root.clone(), Some(id.clone()), cx)
        });
        if let Some(editor) = self.open_path(root.join(&path), None, window, cx) {
            editor.update(cx, |editor, cx| editor.reveal_annotation(&id, window, cx));
        }
    }

    /// The titlebar's Annotations button (`canvas-toolbar.tsx`): the
    /// annotations mark, and while notes are open the toggle's wash with the
    /// count after the mark.
    pub(crate) fn annotations_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let open = self.root(cx).map_or(0, |root| {
            store::try_store(cx).map_or(0, |store| {
                store
                    .read(cx)
                    .annotations(&root)
                    .into_iter()
                    .filter(|comment| !comment.resolved)
                    .count()
            })
        });
        let mut button = IconButton::new("annotations", Icon::ANNOTATIONS)
            .animated(lattice_ui::animated_icon::ProductIcon::ChatOutline)
            .surface(Surface::Titlebar)
            .on(open > 0)
            .tooltip(t!("Annotations"))
            .on_click(cx.listener(|this, _, window, cx| this.open_annotations(window, cx)));
        if open > 0 {
            button = button.count(open.to_string());
        }
        button.into_any_element()
    }

    /// Annotate the selection as a local note, in a file not linked to
    /// Overleaf.
    pub(super) fn annotate_locally(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        editor.update(cx, |editor, cx| editor.annotate_selection(window, cx));
    }

    /// What an editor asked about a note.
    pub(super) fn on_annotation_request(
        &mut self,
        request: &AnnotationRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let panel = self.parts.get::<Annotations>().panel.clone();
        let Some(root) = self.root(cx) else {
            return;
        };
        match request {
            AnnotationRequest::Created(id) => {
                panel.update(cx, |panel, cx| {
                    panel.set_active_note(root.clone(), Some(id.clone()), cx)
                });
                crate::status_counters::refresh(root, cx);
            }
            AnnotationRequest::Open(id) => {
                panel.update(cx, |panel, cx| {
                    panel.set_active_note(root.clone(), Some(id.clone()), cx)
                });
                self.open_annotations(window, cx);
            }
            AnnotationRequest::Resolve(id) => {
                let store = store::store(cx);
                store.update(cx, |store, cx| store.set_resolved(&root, id, true, cx));
            }
            AnnotationRequest::Reply(id) => {
                self.open_annotations(window, cx);
                panel.update(cx, |panel, cx| {
                    panel.reply_to(root.clone(), id.clone(), window, cx)
                });
            }
            AnnotationRequest::Revise(id) => {
                self.sync_rounds(cx);
                let ids = vec![id.clone()];
                self.annotation_rounds()
                    .update(cx, |rounds, cx| rounds.revise(Some(ids), cx));
            }
        }
    }
}

fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    if context.in_project {
        out.push(Command::new(
            "annotations",
            t!("Show annotations"),
            Section::Edit,
            ShowAnnotations,
        ));
    }
    if context.in_project && !context.overleaf_linked {
        out.push(Command::new(
            "annotate",
            t!("Annotate selection"),
            Section::Edit,
            super::overleaf_collab::AnnotateSelection,
        ));
    }
}

/// Annotations as a window part (`parts.rs`): the panel, Show annotations,
/// and Annotate selection for a project not linked to Overleaf.
pub(super) const PART: Part = Part {
    install: |window, cx| Box::new(Shell::install_annotations(window, cx)),
    views: &[],
    actions: |element, cx| {
        element.on_action(
            cx.listener(|this, _: &ShowAnnotations, window, cx| this.open_annotations(window, cx)),
        )
    },
    commands,
};
