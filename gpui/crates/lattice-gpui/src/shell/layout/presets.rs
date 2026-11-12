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
                };
                if notes.is_empty() {
                    Arrangement {
                        center: reading,
                        left: None,
                        right: None,
                        bottom: None,
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
                        },
                        left: Some(Dock {
                            node: reading,
                            size: half,
                            open: true,
                        }),
                        right: None,
                        bottom: None,
                    }
                }
            }
        }
    }
}

/// The project's own layout to return to from a preset, brought up to date
/// (`returnLayout` in trellis-layout.ts): documents closed meanwhile stay
/// closed, and documents opened meanwhile join the group holding the active
/// document, else the first group holding a document.
pub fn return_layout(previous: &Arrangement, current: &Arrangement) -> Arrangement {
    let open: Vec<String> = current.documents();
    let mut out = previous.clone();
    let mut keep = |view: &View| match view {
        View::File(path) => open.contains(path),
        _ => true,
    };
    out.center = std::mem::take(&mut out.center)
        .retain(&mut keep)
        .unwrap_or_default();
    for dock in [&mut out.left, &mut out.right, &mut out.bottom] {
        if let Some(d) = dock.take() {
            *dock = d.node.retain(&mut keep).map(|node| Dock { node, ..d });
        }
    }
    for path in open {
        out.add_view(View::File(path), View::is_document);
    }
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
        };
        let writing = Preset::Writing.arrange(&own, Some("notes.md"), room());
        assert_eq!(
            writing.center,
            Node::Tabs {
                views: vec![file("notes.md"), file("main.tex")],
                active: 1
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
                active: 1
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
        let back = return_layout(&own, &current);
        assert_eq!(
            back.center,
            Node::Tabs {
                views: vec![file("a.tex"), file("c.tex")],
                active: 1
            }
        );
        assert_eq!(back.left, own.left);
    }
}
