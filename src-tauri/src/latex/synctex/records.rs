//! The size TeX laid a box out at, read from the raw SyncTeX file, for the
//! boxes `synctex view` measures by content that was drawn somewhere else.
//!
//! `synctex view` reports a horizontal box grown to hold everything recorded
//! inside it, and SyncTeX records what a scaled, resized or rotated box holds
//! at its untransformed size. graphicx draws such content from inside a box
//! with no width (an `\rlap`) holding the original: `\includegraphics
//! [height=32mm]` of an 835 x 663 bp figure therefore answers, for every box
//! on its line, an 835 x 663 bp rectangle growing up from the image's
//! lower-left corner, and an inline graphic stretches its text line the same
//! way. This replays synctex's own measuring (`_synctex_make_hbox_contain_box`
//! and `_contain_point` in synctex_parser.c) to recognise the box it reported,
//! then measures that box again without what was not laid out where SyncTeX
//! records it (`corrections`).

use crate::latex::PdfSyncTarget;
use std::io::Read;
use std::path::Path;

/// SyncTeX's scaled points per PDF point (big point): 65536 sp per TeX point,
/// 72.27 TeX points per 72 big points.
const SP_PER_BP: f64 = 65781.76;

/// The SyncTeX data beside `pdf`, decompressed; `None` when there is none to
/// read.
pub(super) fn read(pdf: &Path) -> Option<String> {
    if let Ok(file) = std::fs::File::open(pdf.with_extension("synctex.gz")) {
        let mut text = String::new();
        flate2::read::MultiGzDecoder::new(file).read_to_string(&mut text).ok()?;
        return Some(text);
    }
    std::fs::read_to_string(pdf.with_extension("synctex")).ok()
}

/// One horizontal box on a page: the rectangle `synctex view` reports for it
/// and the one TeX laid out for it.
pub(super) struct Correction {
    pub reported: PdfSyncTarget,
    pub laid_out: PdfSyncTarget,
}

/// Every horizontal box on `page`, in the order SyncTeX recorded them.
///
/// A box TeX laid out keeps its own size and what it laid out inside it.
/// What a box with some size but no width or no height holds (graphicx's
/// `\rlap` around a scaled original, an `\rlap`, a `\smash`) has no place
/// of its own: it answers with the nearest box around it that was laid out,
/// which for a graphic is the box TeX reserved at its scaled size. A box with
/// no size at all is a pgf anchor — a TikZ node, a tcolorbox's text — and
/// pgf moves SyncTeX's position along with a plain shift, so what it holds
/// keeps its place while that place is inside the box laid out around it.
pub(super) fn corrections(synctex: &str, page: u32) -> Vec<Correction> {
    let (page_open, page_close) = (format!("{{{page}"), format!("}}{page}"));
    let mut scale = Scale::default();
    let mut in_page = false;
    let mut stack: Vec<Frame> = Vec::new();
    // Per box: what synctex reports, and what TeX laid out once known.
    let mut boxes: Vec<(Visible, Option<Visible>)> = Vec::new();
    for record in synctex.lines() {
        if !in_page {
            scale.read(record);
            in_page = record == page_open;
            continue;
        }
        if record == page_close {
            break;
        }
        let Some(kind) = record.chars().next() else { continue };
        if matches!(kind, ')' | ']') {
            let Some(frame) = stack.pop() else { continue };
            let resolved = if frame.hbox { frame.laid } else { frame.declared };
            for &(index, own) in &frame.waiting {
                let own = own.filter(|own| resolved.extent().holds(own.extent()));
                boxes[index].1 = Some(own.unwrap_or(resolved));
            }
            if let Some(index) = frame.index {
                boxes[index].0 = frame.seen;
                // Its own size where that is where it is, else the box
                // around it that was laid out decides.
                let own = if frame.solid { frame.laid } else { frame.seen };
                match frame.trust() {
                    Place::LaidOut => boxes[index].1 = Some(own),
                    trust => {
                        let around = stack
                            .iter_mut()
                            .rev()
                            .find(|frame| frame.place == Place::LaidOut && frame.solid);
                        if let Some(around) = around {
                            around.waiting.push((index, (trust == Place::Anchored).then_some(own)));
                        }
                    }
                }
            }
            // synctex grows a horizontal box by the horizontal boxes inside
            // it, never by a vertical one.
            if frame.hbox {
                if let Some(parent) = stack.last_mut() {
                    parent.contain_box(frame.seen.extent(), frame.laid.extent());
                }
            }
            continue;
        }
        let Some(node) = Node::parse(&record[1..]) else { continue };
        let place = stack.last().map_or(Place::LaidOut, Frame::content);
        match (kind, node.size()) {
            ('(' | '[', Some(size)) => {
                let declared = Visible::new(&node, size);
                let index = (kind == '(').then(|| {
                    boxes.push((declared, None));
                    boxes.len() - 1
                });
                stack.push(Frame {
                    hbox: kind == '(',
                    declared,
                    seen: declared,
                    laid: declared,
                    solid: size.0 > 0.0 && size.1 + size.2 > 0.0,
                    empty: size.0 == 0.0 && size.1 + size.2 == 0.0,
                    place,
                    index,
                    waiting: Vec::new(),
                });
            }
            ('h', Some(size)) => {
                let extent = Visible::new(&node, size).extent();
                if let Some(parent) = stack.last_mut() {
                    parent.contain_box(extent, extent);
                }
            }
            ('k', _) => {
                let Some(&width) = node.lengths.first() else { continue };
                // A kern is the stretch of baseline it covers.
                let (start, end) = (node.h.min(node.h - width), node.h.max(node.h - width));
                if let Some(parent) = stack.last_mut() {
                    let extent = Extent { min: (start, node.v), max: (end, node.v) };
                    parent.contain_box(extent, extent);
                }
            }
            // A glue, a math node or a character boundary is a point; rules
            // and void vertical boxes never grow their box.
            ('g' | '$' | 'x', _) => {
                if let Some(parent) = stack.last_mut() {
                    let point = Extent { min: (node.h, node.v), max: (node.h, node.v) };
                    parent.contain_box(point, point);
                }
            }
            _ => {}
        }
    }
    boxes
        .into_iter()
        .filter_map(|(seen, laid)| {
            Some(Correction {
                reported: scale.target(page, seen),
                laid_out: scale.target(page, laid?),
            })
        })
        .collect()
}

/// Where SyncTeX's record of something is to be believed, from most to
/// least.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Place {
    /// Every box around it has a size: TeX laid it out there.
    LaidOut,
    /// Inside a pgf anchor: there when that is inside what was laid out.
    Anchored,
    /// Inside a box with no width or no height: elsewhere, or transformed.
    Unplaced,
}

/// An open box while its page is read.
struct Frame {
    hbox: bool,
    declared: Visible,
    /// What synctex measures it by.
    seen: Visible,
    /// What it laid out: the same, without what a box with no width or
    /// height holds.
    laid: Visible,
    /// It has a width and a height or depth.
    solid: bool,
    /// It has no size at all: a pgf anchor.
    empty: bool,
    /// Where the box itself is.
    place: Place,
    /// Its place in the page's horizontal boxes.
    index: Option<usize>,
    /// Boxes inside it with no place of their own, which answer with it —
    /// or with their own rectangle (for an anchored box) when it holds that.
    waiting: Vec<(usize, Option<Visible>)>,
}

impl Frame {
    /// Where what this box holds is.
    fn content(&self) -> Place {
        let own = if self.solid {
            Place::LaidOut
        } else if self.empty {
            Place::Anchored
        } else {
            Place::Unplaced
        };
        self.place.max(own)
    }

    /// Where this box's own rectangle is: a box with no size is measured by
    /// what it holds.
    fn trust(&self) -> Place {
        if self.solid {
            self.place
        } else {
            self.content()
        }
    }

    fn contain_box(&mut self, seen: Extent, laid: Extent) {
        if !self.hbox {
            return;
        }
        self.seen.contain(seen);
        if self.solid {
            self.laid.contain(laid);
        }
    }
}

/// A box as synctex measures one, in recorded units: an origin on its
/// baseline, a width (negative runs left), a height above and a depth below.
#[derive(Clone, Copy)]
struct Visible {
    h: f64,
    v: f64,
    width: f64,
    height: f64,
    depth: f64,
}

/// A rectangle by its corners, with `v` growing down the page.
#[derive(Clone, Copy)]
struct Extent {
    min: (f64, f64),
    max: (f64, f64),
}

impl Extent {
    /// Whether `other` lies inside, to within half a point.
    fn holds(&self, other: Extent) -> bool {
        const SLACK: f64 = 0.5 * SP_PER_BP;
        other.min.0 >= self.min.0 - SLACK
            && other.min.1 >= self.min.1 - SLACK
            && other.max.0 <= self.max.0 + SLACK
            && other.max.1 <= self.max.1 + SLACK
    }
}

impl Visible {
    fn new(node: &Node, (width, height, depth): (f64, f64, f64)) -> Self {
        Self { h: node.h, v: node.v, width, height, depth }
    }

    fn extent(self) -> Extent {
        let (left, right) = if self.width < 0.0 {
            (self.h + self.width, self.h)
        } else {
            (self.h, self.h + self.width)
        };
        Extent { min: (left, self.v - self.height), max: (right, self.v + self.depth) }
    }

    /// `_synctex_make_hbox_contain_box`, quirks kept: it grows each axis on
    /// one side only, the first that falls short.
    fn contain(&mut self, extent: Extent) {
        if self.width < 0.0 {
            let (max, min) = (self.h, self.h + self.width);
            if extent.min.0 < min {
                self.width = extent.min.0 - max;
            } else if extent.max.0 > max {
                self.h = extent.max.0;
                self.width = min - extent.max.0;
            }
        } else {
            let (min, max) = (self.h, self.h + self.width);
            if extent.min.0 < min {
                self.h = extent.min.0;
                self.width = max - extent.min.0;
            } else if extent.max.0 > max {
                self.width = extent.max.0 - min;
            }
        }
        let (min, max) = (self.v - self.height, self.v + self.depth);
        if extent.min.1 < min {
            self.height = self.v - extent.min.1;
        } else if extent.max.1 > max {
            self.depth = extent.max.1 - self.v;
        }
    }
}

/// One content record after its type: `tag,line[,column]:h,v`, then a
/// box's `:W,H,D` or a kern's `:W`.
struct Node {
    h: f64,
    v: f64,
    lengths: Vec<f64>,
}

impl Node {
    fn parse(record: &str) -> Option<Self> {
        let mut parts = record.split(':');
        let mut source = parts.next()?.split(',');
        source.next()?.parse::<u32>().ok()?;
        source.next()?.parse::<u32>().ok()?;
        let (h, v) = parts.next()?.split_once(',')?;
        let lengths = match parts.next() {
            Some(lengths) => {
                lengths.split(',').map(|value| value.parse().ok()).collect::<Option<_>>()?
            }
            None => Vec::new(),
        };
        Some(Self { h: h.parse().ok()?, v: v.parse().ok()?, lengths })
    }

    /// A box's width, height and depth.
    fn size(&self) -> Option<(f64, f64, f64)> {
        match self.lengths[..] {
            [width, height, depth] => Some((width, height, depth)),
            _ => None,
        }
    }
}

/// The preamble's units: `Unit` scaled points per recorded unit, a
/// `Magnification` in thousandths, and offsets in recorded units.
struct Scale {
    unit: f64,
    magnification: f64,
    offset: (f64, f64),
}

impl Default for Scale {
    fn default() -> Self {
        Self { unit: 1.0, magnification: 1000.0, offset: (0.0, 0.0) }
    }
}

impl Scale {
    fn read(&mut self, record: &str) {
        let value = |prefix: &str| record.strip_prefix(prefix)?.trim().parse::<f64>().ok();
        if let Some(unit) = value("Unit:").filter(|unit| *unit > 0.0) {
            self.unit = unit;
        } else if let Some(magnification) = value("Magnification:").filter(|value| *value > 0.0) {
            self.magnification = magnification;
        } else if let Some(x) = value("X Offset:") {
            self.offset.0 = x;
        } else if let Some(y) = value("Y Offset:") {
            self.offset.1 = y;
        }
    }

    /// A box's rectangle in PDF points as `synctex view` prints one: from the
    /// top of its height to the bottom of its depth.
    fn target(&self, page: u32, visible: Visible) -> PdfSyncTarget {
        // As synctex's parser: the magnification scales positions and sizes,
        // not the offsets.
        let length = self.unit * self.magnification / 1000.0 / SP_PER_BP;
        let offset = |value: f64| value * self.unit / SP_PER_BP;
        PdfSyncTarget {
            page,
            x: visible.h * length + offset(self.offset.0),
            y: (visible.v - visible.height) * length + offset(self.offset.1),
            width: visible.width.abs() * length,
            height: (visible.height + visible.depth) * length,
        }
    }
}
