//! The annotation roles of `foundations.css`: amber while a note is open,
//! the blue of `--glyph-tex` while the agent's proposal waits, the violet of
//! `--glyph-style` while its question does, green once accepted, and the
//! secondary text once resolved; every pin's figure in
//! `--annotation-contrast`. The palette carries the amber and its tint; the
//! glyph colours and the contrast are `theme.css`'s, the same in every tint.

use gpui::{Hsla, rgb};
use lattice_ui::{Appearance, palette::Palette};

use super::model::Status;

fn dark(palette: &Palette) -> bool {
    palette.appearance == Appearance::Dark
}

/// `--annotation-proposed-ink` (`--glyph-tex`).
pub fn proposed(palette: &Palette) -> Hsla {
    if dark(palette) {
        rgb(0x8fa5ff)
    } else {
        rgb(0x3b5bd6)
    }
    .into()
}

/// `--annotation-asked-ink` (`--glyph-style`).
pub fn asked(palette: &Palette) -> Hsla {
    if dark(palette) {
        rgb(0xbba3f2)
    } else {
        rgb(0x7a52c4)
    }
    .into()
}

/// `--annotation-pin-text` (`--annotation-contrast`).
pub fn pin_text(palette: &Palette) -> Hsla {
    if dark(palette) {
        rgb(0x1a1a1c)
    } else {
        rgb(0xffffff)
    }
    .into()
}

/// A pin's or chip's ink for `status` (`--annotation-pin-ink`).
pub fn ink(status: Status, palette: &Palette) -> Hsla {
    match status {
        Status::Proposed => proposed(palette),
        Status::Asked => asked(palette),
        Status::Accepted => palette.success,
        Status::Resolved => palette.text_secondary,
        Status::Open | Status::Rejected | Status::Failed => palette.annotation,
    }
}

/// The passage's mark in the source (`comment-marks.css`): its wash and the
/// rule along its bottom, in the note's colour.
pub struct MarkColors {
    pub tint: Hsla,
    pub rule: Hsla,
}

pub fn mark(status: Status, palette: &Palette) -> MarkColors {
    let (ink, tint) = match status {
        Status::Proposed => (proposed(palette), proposed(palette).opacity(0.10)),
        Status::Asked => (asked(palette), asked(palette).opacity(0.10)),
        _ => (palette.annotation, palette.annotation_highlight),
    };
    MarkColors {
        tint,
        rule: ink.opacity(0.70),
    }
}

/// `--annotation-highlight-edge`: the amber at 70%.
pub fn highlight_edge(palette: &Palette) -> Hsla {
    palette.annotation.opacity(0.70)
}
