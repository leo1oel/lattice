//! The window's side of the revision rounds (`crate::annotations::rounds`):
//! the rounds themselves, made with what they read from the window (the
//! project, the open buffers); the palette's Revise from annotations; and
//! what they ask of the window: a proposal's file opened with its card under
//! the passage (`editor_panel/annotation_review.rs`), the card put away, the
//! Annotations panel shown.

use gpui::{App, Context, Entity, InteractiveElement as _, Window, actions};
use lattice_i18n::t;

use super::{
    Shell,
    commands::{Command, CommandContext, Section},
    parts::Part,
};
use crate::{
    annotations::{
        rounds::{self, AnnotationRounds, RoundsEvent, RoundsHost},
        store,
    },
    editor_panel::EditorPanel,
};

actions!(
    lattice,
    [
        /// Ask the agent about every open annotation (⇧⌘↵ in the panel).
        ReviseAnnotations
    ]
);

pub(crate) struct Rounds {
    pub(crate) rounds: Entity<AnnotationRounds>,
    _events: gpui::Subscription,
}

impl Shell {
    fn install_rounds(window: &mut Window, cx: &mut Context<Self>) -> Rounds {
        let rounds = rounds::new(cx);
        // The panel shows the rounds and asks them; it is made with the
        // window, as this part is.
        let shown = rounds.clone();
        cx.defer_in(window, move |shell, _, cx| {
            shell
                .annotations_panel()
                .update(cx, |panel, cx| panel.set_rounds(shown, cx));
        });
        let events = cx.subscribe_in(&rounds, window, |this, rounds, event, window, cx| {
            this.sync_rounds(cx);
            this.on_rounds_event(rounds.clone(), event, window, cx)
        });
        Rounds {
            rounds,
            _events: events,
        }
    }

    /// Tell the rounds what the window has open: its project and editors.
    /// Each frame, and before the window asks anything of them.
    pub(crate) fn sync_rounds(&mut self, cx: &mut Context<Self>) {
        let host = RoundsHost {
            project: self.root(cx),
            editors: self.editors.clone(),
        };
        self.annotation_rounds().update(cx, |rounds, cx| rounds.set_host(host, cx));
    }

    /// The window's revision rounds.
    pub(crate) fn annotation_rounds(&self) -> Entity<AnnotationRounds> {
        self.parts.get::<Rounds>().rounds.clone()
    }

    fn on_rounds_event(
        &mut self,
        rounds: Entity<AnnotationRounds>,
        event: &RoundsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            RoundsEvent::Review(id) => {
                let Some(root) = self.root(cx) else {
                    return;
                };
                let Some(path) = store::try_store(cx)
                    .and_then(|store| store.read(cx).get(&root, id).map(|comment| comment.path.clone()))
                else {
                    return;
                };
                // Another file's card leaves with its editor's focus.
                for editor in self.open_editors() {
                    editor.update(cx, |editor, cx| editor.close_annotation_review(cx));
                }
                if let Some(editor) = self.open_path(root.join(&path), None, window, cx) {
                    let id = id.clone();
                    editor.update(cx, |editor, cx| editor.open_annotation_review(&id, rounds, window, cx));
                }
            }
            RoundsEvent::CloseReview => {
                for editor in self.open_editors() {
                    editor.update(cx, |editor: &mut EditorPanel, cx| editor.close_annotation_review(cx));
                }
            }
            RoundsEvent::OpenPanel => self.open_annotations(window, cx),
            RoundsEvent::OpenRounds => self.open_rounds_sheet(window, cx),
        }
    }

    /// How many annotations a round would ask about now, for the palette.
    pub(crate) fn revisable_annotations(&self, cx: &App) -> usize {
        self.parts.get::<Rounds>().rounds.read(cx).revisable_count(cx)
    }
}

fn commands(context: &CommandContext, out: &mut Vec<Command>) {
    let count = context.revisable_annotations;
    if context.in_project && count > 0 {
        let detail = if count == 1 {
            t!("1 annotation").to_string()
        } else {
            t!("{count} annotations", count = count)
        };
        out.push(
            Command::new("annotations-revise", t!("Revise from annotations"), Section::Edit, ReviseAnnotations)
                .detail(detail),
        );
    }
}

/// The revision rounds as a window part (`parts.rs`).
pub(super) const PART: Part = Part {
    install: |window, cx| Box::new(Shell::install_rounds(window, cx)),
    views: &[],
    actions: |element, cx| {
        element.on_action(cx.listener(|this, _: &ReviseAnnotations, _, cx| {
            this.sync_rounds(cx);
            this.annotation_rounds()
                .update(cx, |rounds, cx| rounds.revise(None, cx))
        }))
    },
    commands,
};
