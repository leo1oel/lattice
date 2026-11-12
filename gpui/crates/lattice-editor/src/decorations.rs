//! Marks and highlights: how a feature styles a range of the text.
//!
//! A *mark* changes the text itself (an underline, wavy or straight, the
//! ink, a strike, the weight), as CodeMirror's `Decoration.mark` with a
//! class does; a *highlight* washes the ground behind it, as the Tauri app's
//! annotation and search marks do. Both are set per named layer, a whole
//! layer at a time, in buffer offsets, and the adapter anchors them, so they
//! move with edits made after they were set (CodeMirror's lint and Overleaf
//! fields rebuild from plain offsets on every edit instead).
//!
//! Zed draws marks as text highlights and highlights as background
//! highlights, both keyed by its closed `HighlightKey` enum, whose one key
//! holds one style. Each layer's distinct styles therefore take keys of
//! their own: `HighlightKey::ConsoleAnsiHighlight(slot)`, a key only Zed's
//! debugger console sets and nothing in this app does, with slots from a
//! range of numbers no console would reach.

use std::{
    collections::HashMap,
    ops::Range,
    sync::{Mutex, OnceLock},
};

use gpui::{FontWeight, HighlightStyle, Hsla, Pixels, StrikethroughStyle, UnderlineStyle, px};

/// How a mark styles its text. Fields left `None` leave the text as the
/// syntax colours it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarkStyle {
    pub underline: Option<Underline>,
    pub color: Option<Hsla>,
    pub background: Option<Hsla>,
    pub strikethrough: Option<Hsla>,
    pub weight: Option<FontWeight>,
}

impl MarkStyle {
    /// A wavy underline in `color`, as CodeMirror's lint draws a diagnostic.
    pub fn squiggle(color: Hsla) -> Self {
        Self {
            underline: Some(Underline {
                color,
                wavy: true,
                thickness: px(1.),
            }),
            ..Self::default()
        }
    }

    pub(crate) fn highlight_style(&self) -> HighlightStyle {
        HighlightStyle {
            color: self.color,
            background_color: self.background,
            font_weight: self.weight,
            underline: self.underline.map(|underline| UnderlineStyle {
                thickness: underline.thickness,
                color: Some(underline.color),
                wavy: underline.wavy,
            }),
            strikethrough: self.strikethrough.map(|color| StrikethroughStyle {
                thickness: px(1.),
                color: Some(color),
            }),
            ..HighlightStyle::default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Underline {
    pub color: Hsla,
    pub wavy: bool,
    pub thickness: Pixels,
}

/// A styled range of the buffer, in byte offsets.
#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub range: Range<usize>,
    pub style: MarkStyle,
}

/// A wash behind a range of the buffer, in byte offsets.
#[derive(Clone, Debug, PartialEq)]
pub struct Highlight {
    pub range: Range<usize>,
    pub color: Hsla,
}

/// The first slot number: far past any console's colour runs.
const FIRST_SLOT: usize = 0x4C41_0000;

/// The key slot for a layer's `style`-th distinct style, the same for the
/// whole process so every editor agrees.
pub(crate) fn slot(layer: &'static str, style: usize) -> usize {
    static SLOTS: OnceLock<Mutex<HashMap<(&'static str, usize), usize>>> = OnceLock::new();
    let mut slots = SLOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let next = FIRST_SLOT + slots.len();
    *slots.entry((layer, style)).or_insert(next)
}

/// A layer's marks grouped by style, in the order each style first appears:
/// one Zed key each.
pub(crate) fn group_by_style(marks: &[Mark]) -> Vec<(MarkStyle, Vec<Range<usize>>)> {
    let mut groups: Vec<(MarkStyle, Vec<Range<usize>>)> = Vec::new();
    for mark in marks {
        if mark.range.start > mark.range.end {
            continue;
        }
        match groups.iter_mut().find(|(style, _)| *style == mark.style) {
            Some((_, ranges)) => ranges.push(mark.range.clone()),
            None => groups.push((mark.style, vec![mark.range.clone()])),
        }
    }
    for (_, ranges) in &mut groups {
        ranges.sort_by_key(|range| (range.start, range.end));
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{hsla, red};

    #[test]
    fn a_layer_takes_one_key_per_distinct_style() {
        let warning = MarkStyle::squiggle(hsla(0.1, 0.8, 0.5, 1.));
        let error = MarkStyle::squiggle(red());
        let marks = vec![
            Mark {
                range: 10..14,
                style: warning,
            },
            Mark {
                range: 2..5,
                style: error,
            },
            Mark {
                range: 0..1,
                style: warning,
            },
            // Inverted: dropped.
            Mark {
                range: 9..3,
                style: error,
            },
        ];
        let groups = group_by_style(&marks);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, warning);
        assert_eq!(groups[0].1, vec![0..1, 10..14]);
        assert_eq!(groups[1].1, vec![2..5]);
    }

    #[test]
    fn slots_are_stable_and_distinct() {
        let a = slot("test-a", 0);
        let b = slot("test-a", 1);
        let c = slot("test-b", 0);
        assert_eq!(slot("test-a", 0), a);
        assert!(a != b && b != c && a != c);
        assert!(a >= FIRST_SLOT);
    }

    #[test]
    fn a_squiggle_is_a_wavy_underline_in_its_colour() {
        let style = MarkStyle::squiggle(red()).highlight_style();
        let underline = style.underline.expect("an underline");
        assert!(underline.wavy);
        assert_eq!(underline.color, Some(red()));
        assert_eq!(style.color, None);
    }
}
