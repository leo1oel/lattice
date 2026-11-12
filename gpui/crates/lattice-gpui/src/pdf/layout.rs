//! Where each page sits on the PDF's sheet, as the Tauri app's viewer lays
//! them out (`src/pdf/pdf-viewer.css`, PDF.js with `removePageBorders`):
//! one column, each page centred, and 10px under every page but the last.
//!
//! The 8px of breathing room around the column is the scroll area's
//! transparent border in the Tauri app, not padding: the pages scroll inside
//! it, so they always stop 8px short of the panel's edges, and PDF.js fits a
//! page to the width inside it. The view draws that border around its scroll
//! container (`PAGE_INSET`), so the sheet here starts at the column's first
//! page and every viewport size is the one inside the border.
//!
//! Scales are the app's (`src/pdf/pdf-viewer-utils.ts`): logical pixels per
//! PDF point, so 1.0 shows a page at 72 dpi and the zoom field reads
//! `scale × 100` %. Everything here is plain arithmetic on those numbers, so
//! the view (`view.rs`) keeps no geometry of its own.

use std::ops::Range;

/// The scroll area's border around the column (`--space-4`), drawn by the
/// view around its scroll container.
pub const PAGE_INSET: f32 = 8.;
/// Under every page but the last (`--space-5`).
pub const PAGE_GAP: f32 = 10.;
/// The zoom's bounds (`PDF_MIN_SCALE`, `PDF_MAX_SCALE`).
pub const MIN_SCALE: f32 = 0.3;
pub const MAX_SCALE: f32 = 5.0;
/// What a viewer opens with when nothing was saved (`loadPdfViewPreference`).
pub const DEFAULT_SCALE: f32 = 1.1;

pub fn clamp_scale(scale: f32) -> f32 {
    if scale.is_finite() {
        scale.clamp(MIN_SCALE, MAX_SCALE)
    } else {
        DEFAULT_SCALE
    }
}

/// The zoom buttons' step: a tenth, from the scale rounded to one decimal
/// (`stepZoom`), so 1.23 steps to 1.3 and back to 1.2.
pub fn step_scale(scale: f32, direction: f32) -> f32 {
    clamp_scale(((scale + direction * 0.1) * 10.).round() / 10.)
}

/// A percentage typed into the zoom field (`parsePdfZoomPercent`): "184",
/// "184%" or " 90 % ", bounded; `None` for anything else.
pub fn parse_zoom_percent(value: &str) -> Option<f32> {
    let value = value.trim();
    let value = value.strip_suffix('%').unwrap_or(value).trim();
    let percent: f32 = value.parse().ok()?;
    if !percent.is_finite() || percent <= 0. {
        return None;
    }
    Some(clamp_scale((percent / 100. * 1000.).round() / 1000.))
}

/// How a page follows the panel's size, or `None` for a zoom the reader set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FitMode {
    /// PDF.js's `page-width`: the page as wide as the column.
    Width,
    /// PDF.js's `page-fit`: the whole page in view.
    Height,
}

/// The scale that fits a page of `page` points into a viewport of
/// `viewport` logical pixels (inside the border). PDF.js subtracts nothing
/// for a scrollbar with `removePageBorders`, and neither does this.
pub fn fit_scale(mode: FitMode, page: (f32, f32), viewport: (f32, f32)) -> f32 {
    let width = viewport.0.max(1.) / page.0.max(1.);
    let scale = match mode {
        FitMode::Width => width,
        FitMode::Height => width.min(viewport.1.max(1.) / page.1.max(1.)),
    };
    clamp_scale(scale)
}

/// A box in the sheet's coordinates (logical pixels from its top-left).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// The column at one scale and viewport width.
#[derive(Clone, Debug, Default)]
pub struct Layout {
    pub scale: f32,
    /// Each page's box.
    pages: Vec<Rect>,
    /// The sheet's size: as wide as the viewport, or the widest page when
    /// that is wider; as tall as the column.
    pub width: f32,
    pub height: f32,
}

impl Layout {
    pub fn new(page_sizes: &[(f32, f32)], scale: f32, viewport_width: f32) -> Self {
        let widest = page_sizes
            .iter()
            .map(|(width, _)| width * scale)
            .fold(0., f32::max);
        let width = viewport_width.max(widest);
        let mut y = 0.;
        let count = page_sizes.len();
        let pages = page_sizes
            .iter()
            .enumerate()
            .map(|(ix, (page_width, page_height))| {
                let (w, h) = (page_width * scale, page_height * scale);
                let rect = Rect {
                    x: ((width - w) / 2.).max(0.),
                    y,
                    w,
                    h,
                };
                y += h + if ix + 1 < count { PAGE_GAP } else { 0. };
                rect
            })
            .collect();
        Self {
            scale,
            pages,
            width,
            height: y,
        }
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn page(&self, ix: usize) -> Option<Rect> {
        self.pages.get(ix).copied()
    }

    /// The pages any part of which is between `top` and `top + height`.
    pub fn visible(&self, top: f32, height: f32) -> Range<usize> {
        if self.pages.is_empty() {
            return 0..0;
        }
        let bottom = top + height;
        let start = self.pages.partition_point(|page| page.bottom() <= top);
        let end = self.pages.partition_point(|page| page.y < bottom);
        start.min(self.pages.len() - 1)..end.max(start + 1).min(self.pages.len())
    }

    /// The page a reader is on with the viewport at `top`: the one showing
    /// the most of itself, as PDF.js picks it (`getVisibleElements` sorted
    /// by visibility), keeping `current` while all of it is still in view.
    pub fn current_page(&self, top: f32, height: f32, current: usize) -> usize {
        let visible = self.visible(top, height);
        let bottom = top + height;
        let shown = |page: &Rect| {
            let seen = (page.bottom().min(bottom) - page.y.max(top)).max(0.);
            if page.h > 0. { seen / page.h } else { 0. }
        };
        if let Some(page) = self.page(current)
            && visible.contains(&current)
            && shown(&page) >= 0.999
        {
            return current;
        }
        visible
            .clone()
            .max_by(|a, b| {
                let (a_seen, b_seen) = (shown(&self.pages[*a]), shown(&self.pages[*b]));
                // Ties go to the earlier page.
                a_seen
                    .partial_cmp(&b_seen)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.cmp(a))
            })
            .unwrap_or(0)
    }

    /// The page under the sheet point (`x`, `y`), or the nearest one in the
    /// column (a point in a gap belongs to the page above it).
    pub fn page_near(&self, y: f32) -> usize {
        self.pages
            .partition_point(|page| page.y <= y)
            .saturating_sub(1)
            .min(self.pages.len().saturating_sub(1))
    }

    /// Where a point of page `ix`, in PDF points from its top-left corner,
    /// is on the sheet.
    pub fn to_sheet(&self, ix: usize, x: f32, y: f32) -> Option<(f32, f32)> {
        let page = self.page(ix)?;
        Some((page.x + x * self.scale, page.y + y * self.scale))
    }

    /// The page under a sheet point and the point on it, in PDF points from
    /// its top-left corner; `None` off every page.
    pub fn to_page(&self, x: f32, y: f32) -> Option<(usize, f32, f32)> {
        let ix = self.page_near(y);
        let page = self.page(ix)?;
        page.contains(x, y)
            .then(|| (ix, (x - page.x) / self.scale, (y - page.y) / self.scale))
    }

    /// The largest scroll offset in each direction.
    pub fn max_scroll(&self, viewport: (f32, f32)) -> (f32, f32) {
        (
            (self.width - viewport.0).max(0.),
            (self.height - viewport.1).max(0.),
        )
    }
}

/// Where the sheet scrolls to after a zoom that keeps the point under
/// `anchor` (in the viewport) where it is: measured on its page rather than
/// scaled from the offset, because the gaps between pages do not scale,
/// which adds up to whole pages of drift deep into a long PDF
/// (`commitPreview` in `use-pdf-zoom.ts`). A point between pages holds the
/// page above it at the same fraction.
pub fn anchored_scroll(
    before: &Layout,
    after: &Layout,
    scroll: (f32, f32),
    anchor: (f32, f32),
    viewport: (f32, f32),
) -> (f32, f32) {
    if before.len() == 0 || after.len() == 0 {
        return (0., 0.);
    }
    let point = (scroll.0 + anchor.0, scroll.1 + anchor.1);
    let ix = before.page_near(point.1).min(after.len() - 1);
    let (Some(old), Some(new)) = (before.page(ix), after.page(ix)) else {
        return scroll;
    };
    let fx = if old.w > 0. {
        (point.0 - old.x) / old.w
    } else {
        0.
    };
    let fy = if old.h > 0. {
        (point.1 - old.y) / old.h
    } else {
        0.
    };
    let target = (new.x + fx * new.w, new.y + fy * new.h);
    let (max_x, max_y) = after.max_scroll(viewport);
    (
        (target.0 - anchor.0).clamp(0., max_x),
        (target.1 - anchor.1).clamp(0., max_y),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LETTER: (f32, f32) = (612., 792.);

    #[test]
    fn pages_stack_in_one_centred_column_with_gaps_between() {
        let layout = Layout::new(&[LETTER, LETTER, (792., 612.)], 1.0, 700.);
        let first = layout.page(0).unwrap();
        // Centred in the column, which the landscape page widens to 792.
        assert_eq!(
            first,
            Rect {
                x: 90.,
                y: 0.,
                w: 612.,
                h: 792.
            }
        );
        let second = layout.page(1).unwrap();
        assert_eq!(second.y, 792. + 10.);
        // The landscape page is wider than the viewport: the sheet widens.
        assert_eq!(layout.width, 792.);
        assert_eq!(layout.page(2).unwrap().x, 0.);
        // No gap after the last page.
        assert_eq!(layout.height, 792. + 10. + 792. + 10. + 612.);
    }

    #[test]
    fn fits_measure_the_viewport_inside_the_border() {
        // A 485px panel is 469px inside its border.
        let width = fit_scale(FitMode::Width, LETTER, (469., 584.));
        assert!((width - 469. / 612.).abs() < 1e-6);
        // Height fit takes the smaller of the two.
        let height = fit_scale(FitMode::Height, LETTER, (469., 584.));
        assert!((height - 584. / 792.).abs() < 1e-6);
        // Bounded like a typed zoom.
        assert_eq!(fit_scale(FitMode::Width, LETTER, (20000., 600.)), MAX_SCALE);
    }

    #[test]
    fn zoom_steps_and_typed_percentages_round_as_the_app_does() {
        assert_eq!(step_scale(1.23, 1.), 1.3);
        assert_eq!(step_scale(1.23, -1.), 1.1);
        assert_eq!(step_scale(0.3, -1.), MIN_SCALE);
        assert_eq!(step_scale(5.0, 1.), MAX_SCALE);
        assert_eq!(parse_zoom_percent("184"), Some(1.84));
        assert_eq!(parse_zoom_percent(" 90 % "), Some(0.9));
        assert_eq!(parse_zoom_percent("9000"), Some(MAX_SCALE));
        assert_eq!(parse_zoom_percent("0"), None);
        assert_eq!(parse_zoom_percent("abc"), None);
    }

    #[test]
    fn the_visible_range_and_the_current_page_follow_the_scroll() {
        let layout = Layout::new(&[LETTER; 5], 0.5, 400.);
        // Each page is 396 tall plus a 10px gap.
        assert_eq!(layout.visible(0., 300.), 0..1);
        assert_eq!(layout.visible(300., 300.), 0..2);
        assert_eq!(layout.current_page(300., 300., 0), 1);
        // Page 0 entirely in view stays current even when page 1 shows too.
        let tall = Layout::new(&[LETTER; 5], 0.5, 400.);
        assert_eq!(tall.current_page(0., 700., 0), 0);
        assert_eq!(layout.visible(10000., 300.), 4..5);
    }

    #[test]
    fn sheet_and_page_points_convert_both_ways() {
        let layout = Layout::new(&[LETTER, LETTER], 2.0, 1000.);
        let (x, y) = layout.to_sheet(1, 100., 50.).unwrap();
        assert_eq!(layout.to_page(x, y), Some((1, 100., 50.)));
        // In the gap between pages: no page.
        let gap = layout.page(0).unwrap().bottom() + 5.;
        assert_eq!(layout.to_page(500., gap), None);
        assert_eq!(layout.page_near(gap), 0);
    }

    #[test]
    fn a_zoom_keeps_the_point_under_the_pointer() {
        let pages = [LETTER; 30];
        let before = Layout::new(&pages, 1.0, 800.);
        let after = Layout::new(&pages, 2.0, 800.);
        let viewport = (800., 600.);
        // Deep into the document, the pointer over a word on page 20.
        let scroll = (0., before.page(20).unwrap().y + 100.);
        let anchor = (400., 300.);
        let next = anchored_scroll(&before, &after, scroll, anchor, viewport);
        let (page, x, y) = before
            .to_page(scroll.0 + anchor.0, scroll.1 + anchor.1)
            .unwrap();
        let (page_after, x_after, y_after) =
            after.to_page(next.0 + anchor.0, next.1 + anchor.1).unwrap();
        assert_eq!(page, page_after);
        assert!((x - x_after).abs() < 0.01 && (y - y_after).abs() < 0.01);
    }
}
