//! The Writing and Reading presets (`presetLayout` and `returnLayout` in
//! `src/trellis/trellis-layout.ts`): arrangements laid over a project's own
//! layout, and the way back to it.

use serde::{Deserialize, Serialize};

use super::{Arrangement, Dock, Node, PRESET_SHARE, Room, View};

/// The Writing and Reading presets: temporary arrangements over the
/// project's own layout, which is kept to return to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    /// The source beside the compiled PDF.
    Writing,
    /// A paper beside your notes.
    Reading,
}

impl Preset {
    pub const ALL: [Preset; 2] = [Preset::Writing, Preset::Reading];

    pub fn label(self) -> &'static str {
        match self {
            Preset::Writing => "Writing",
            Preset::Reading => "Reading",
        }
    }

    /// `own` rearranged as the preset (`presetLayout` in trellis-layout.ts):
    /// Writing gathers every open document into the center, the .tex being
    /// written in front, beside the PDF; Reading gathers papers with the
    /// Papers library beside a group of everything else. The navigators and
    /// tools leave the screen and come back on the return.
    pub fn arrange(self, own: &Arrangement, active: Option<&str>, room: Room) -> Arrangement {
        let documents: Vec<View> = own
            .views()
            .into_iter()
            .filter(|view| matches!(view, View::File(_)))
            .cloned()
            .collect();
        let half = (room.area() * PRESET_SHARE).round();
        let active_view = active.map(|path| View::File(path.to_string()));
        match self {
            Preset::Writing => {
                let tex = |view: &View| matches!(view, View::File(p) if p.to_ascii_lowercase().ends_with(".tex"));
                let source = active_view
                    .clone()
                    .filter(|view| documents.contains(view) && tex(view))
                    .or_else(|| documents.iter().find(|view| tex(view)).cloned())
                    .or_else(|| active_view.clone().filter(|view| documents.contains(view)))
                    .or_else(|| documents.first().cloned());
                let center = if documents.is_empty() {
                    Node::tabs([View::Project])
                } else {
                    let active = source
                        .and_then(|source| documents.iter().position(|v| *v == source))
                        .unwrap_or(0);
                    Node::Tabs {
                        views: documents,
                        active,
                        slot: None,
                    }
                };
                Arrangement {
                    center,
                    left: None,
                    right: Some(Dock {
                        node: Node::tabs([View::Pdf]),
                        size: half,
                        open: true,
                    }),
                    bottom: None,
                    floating: Vec::new(),
                }
            }
            Preset::Reading => {
                let (read, notes): (Vec<View>, Vec<View>) =
                    documents.into_iter().partition(View::is_reading);
                let paper = active_view
                    .clone()
                    .filter(|view| read.contains(view))
                    .or_else(|| read.first().cloned());
                let mut reading = vec![View::Papers];
                reading.extend(read);
                let active = paper
                    .and_then(|paper| reading.iter().position(|v| *v == paper))
                    .unwrap_or(0);
                let reading = Node::Tabs {
                    views: reading,
                    active,
                    slot: None,
                };
                if notes.is_empty() {
                    Arrangement {
                        center: reading,
                        left: None,
                        right: None,
                        bottom: None,
                        floating: Vec::new(),
                    }
                } else {
                    let note = active_view
                        .filter(|view| notes.contains(view))
                        .or_else(|| {
                            notes
                                .iter()
                                .find(|v| matches!(v, View::File(p) if p.ends_with(".md")))
                                .cloned()
                        })
                        .and_then(|note| notes.iter().position(|v| *v == note))
                        .unwrap_or(0);
                    Arrangement {
                        center: Node::Tabs {
                            views: notes,
                            active: note,
                            slot: None,
                        },
                        left: Some(Dock {
                            node: reading,
                            size: half,
                            open: true,
                        }),
                        right: None,
                        bottom: None,
                        floating: Vec::new(),
                    }
                }
            }
        }
    }
}

/// The project's own layout to return to from a preset, brought up to date
/// (`returnLayout` in trellis-layout.ts): documents closed meanwhile stay
/// closed, panels floated meanwhile float, and documents opened meanwhile
/// join the group holding the active document, else the first group holding
/// a document, in the order they are open; the active document is selected.
pub fn return_layout(
    previous: &Arrangement,
    current: &Arrangement,
    active: Option<&str>,
) -> Arrangement {
    let open: Vec<String> = current.documents();
    let floated: Vec<&View> = current.floating.iter().map(|f| &f.view).collect();
    let mut out = previous.clone();
    let mut keep = |view: &View| {
        !floated.contains(&view)
            && match view {
                View::File(path) => open.contains(path),
                _ => true,
            }
    };
    out.center = std::mem::take(&mut out.center)
        .retain(&mut keep)
        .unwrap_or_default();
    for dock in [&mut out.left, &mut out.right, &mut out.bottom] {
        if let Some(d) = dock.take() {
            *dock = d.node.retain(&mut keep).map(|node| Dock { node, ..d });
        }
    }
    out.floating.retain(|floating| keep(&floating.view));
    out.floating.extend(current.floating.iter().cloned());
    out.join_documents(open, active);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Room {
        Room {
            width: 1440.,
            height: 900.,
        }
    }

    fn file(path: &str) -> View {
        View::File(path.into())
    }

    #[test]
    fn writing_puts_the_tex_source_beside_the_pdf() {
        let mut own = Arrangement::default_for(room());
        own.center = Node::Tabs {
            views: vec![file("notes.md"), file("main.tex")],
            active: 0,
            slot: None,
        };
        let writing = Preset::Writing.arrange(&own, Some("notes.md"), room());
        assert_eq!(
            writing.center,
            Node::Tabs {
                views: vec![file("notes.md"), file("main.tex")],
                active: 1,
                slot: None,
            }
        );
        assert!(writing.left.is_none(), "the navigators leave the screen");
        assert_eq!(writing.right.unwrap().node, Node::tabs([View::Pdf]));
    }

    #[test]
    fn reading_puts_papers_beside_the_notes() {
        let mut own = Arrangement::default_for(room());
        own.center = Node::tabs([file("notes.md"), file("paper.pdf")]);
        let reading = Preset::Reading.arrange(&own, None, room());
        assert_eq!(
            reading.left.unwrap().node,
            Node::Tabs {
                views: vec![View::Papers, file("paper.pdf")],
                active: 1,
                slot: None,
            }
        );
        assert_eq!(reading.center, Node::tabs([file("notes.md")]));
    }

    #[test]
    fn returning_from_a_preset_keeps_what_was_opened_and_closed_meanwhile() {
        let mut own = Arrangement::default_for(room());
        own.center = Node::tabs([file("a.tex"), file("b.tex")]);
        let mut current = Preset::Writing.arrange(&own, None, room());
        current.center = Node::tabs([file("a.tex"), file("c.tex")]);
        let back = return_layout(&own, &current, Some("a.tex"));
        assert_eq!(
            back.center,
            Node::Tabs {
                views: vec![file("a.tex"), file("c.tex")],
                active: 0,
                slot: None,
            }
        );
        assert_eq!(back.left, own.left);
    }

    #[test]
    fn documents_opened_under_a_preset_return_in_order_behind_the_active_one() {
        // returnLayout (trellis-layout.ts) appends the documents opened
        // meanwhile to the active document's group and selects that document.
        let mut own = Arrangement::default_for(room());
        own.center = Node::tabs([file("a.tex")]);
        let mut current = Preset::Writing.arrange(&own, Some("a.tex"), room());
        current.center = Node::Tabs {
            views: vec![file("a.tex"), file("c.tex"), file("d.tex")],
            active: 0,
            slot: None,
        };
        let back = return_layout(&own, &current, Some("a.tex"));
        assert_eq!(
            back.center,
            Node::Tabs {
                views: vec![file("a.tex"), file("c.tex"), file("d.tex")],
                active: 0,
                slot: None,
            }
        );
    }

    #[test]
    fn documents_opened_under_a_preset_join_the_active_documents_group() {
        let mut own = Arrangement::default_for(room());
        own.center = Node::Split {
            axis: super::super::SplitAxis::Row,
            children: vec![Node::tabs([file("a.tex")]), Node::tabs([file("b.tex")])],
            sizes: vec![None, None],
        };
        let mut current = Preset::Writing.arrange(&own, Some("b.tex"), room());
        current.center = Node::tabs([file("a.tex"), file("b.tex"), file("c.tex")]);
        let back = return_layout(&own, &current, Some("b.tex"));
        let Node::Split { children, .. } = &back.center else {
            panic!("the center stays split");
        };
        assert_eq!(children[0], Node::tabs([file("a.tex")]));
        assert_eq!(
            children[1],
            Node::Tabs {
                views: vec![file("b.tex"), file("c.tex")],
                active: 0,
                slot: None,
            }
        );
    }

    #[test]
    fn a_panel_floating_before_a_preset_floats_again_after_it() {
        let mut own = Arrangement::default_for(room()).without(&View::Pdf);
        own.center = Node::tabs([file("main.tex")]);
        let pdf = super::super::FloatingView {
            view: View::Pdf,
            x: 600.,
            y: 72.,
            width: 420.,
            height: 480.,
        };
        own.floating.push(pdf.clone());
        let writing = Preset::Writing.arrange(&own, Some("main.tex"), room());
        assert!(writing.floating.is_empty());
        assert!(
            writing
                .right
                .as_ref()
                .is_some_and(|dock| dock.node.views() == [&View::Pdf])
        );

        let back = return_layout(&own, &writing, Some("main.tex"));
        assert_eq!(back.floating, vec![pdf]);
        assert!(back.right.is_none());
        assert_eq!(back.documents(), vec!["main.tex".to_string()]);
    }
}
