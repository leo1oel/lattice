//! What each page of the live preview shows (`src/live-preview/rtex-model.ts`,
//! adapted there from realtime-tex-vsc-plugin's `webview/model.ts`, MIT
//! License, Copyright (c) 2026 Henry Yang; see THIRD_PARTY_NOTICES.md).
//!
//! The plugin draws every page from rtex; Lattice keeps the last latexmk PDF
//! ("the base") under the viewer and only paints over it, so beside rtex's
//! layout and live paragraphs this model tracks which source revision the
//! base PDF was built from. A page rtex has changed since then is drawn from
//! rtex; any other page is the base, with the live paragraphs painted over
//! it. Pure module: no GPUI.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

use super::protocol::{DisplayList, Fragment, Item, Line, PageUpdate, Placement};

/// How close a line's baseline and x must be to a placement row's to be
/// that row, in sp.
const MATCH_TOLERANCE: f64 = 64.;

/// The pages to draw again: some, or every page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dirty {
    Pages(HashSet<u32>),
    All,
}

impl Dirty {
    pub fn is_empty(&self) -> bool {
        matches!(self, Dirty::Pages(pages) if pages.is_empty())
    }

    #[cfg(test)]
    pub fn contains(&self, page: u32) -> bool {
        match self {
            Dirty::All => true,
            Dirty::Pages(pages) => pages.contains(&page),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Overlay {
    pub par_id: u64,
    pub dl: Arc<DisplayList>,
    pub fragments: Vec<Fragment>,
    /// The source revision of the edit that produced it.
    pub revision: u64,
}

/// One row of a live paragraph, and its translation onto the page.
#[derive(Clone, Debug)]
pub struct OverlayRow {
    pub line: Line,
    pub dx: f64,
    pub dy: f64,
}

#[derive(Clone, Debug)]
pub struct PageOverlay {
    pub overlay: Overlay,
    pub rows: Vec<OverlayRow>,
}

pub struct LayoutInput {
    pub pages: Vec<PageUpdate>,
    pub pages_total: u32,
    pub placements: Vec<Placement>,
    /// The source revision the layout typeset.
    pub revision: u64,
    /// rtex's layout_version, to match a page with the fallback PDF that
    /// drew it.
    pub layout_version: u64,
    /// A PDF of this layout came with it (some page could not be described
    /// exactly).
    pub has_fallback: bool,
}

/// Where page `n` comes from: the base PDF as the viewer drew it, or rtex's
/// layout, from its display list (`exact`) or from the fallback PDF of its
/// layout.
#[derive(Clone, Debug)]
pub enum PageSource {
    Base,
    DisplayList(Arc<PageUpdate>),
    Fallback {
        page: Arc<PageUpdate>,
        layout_version: u64,
    },
}

#[derive(Default)]
pub struct PreviewModel {
    pub pages: HashMap<u32, Arc<PageUpdate>>,
    pub pages_total: u32,
    /// Layout placements per unit.
    pub placements: HashMap<u64, Vec<Fragment>>,
    /// Live paragraphs by unit, in the order they arrived.
    pub overlays: BTreeMap<u64, Overlay>,
    /// The source revision of the layout that last changed each page.
    page_revision: HashMap<u32, u64>,
    /// The layout_version that last changed each page.
    page_layout: HashMap<u32, u64>,
    /// The layout_version of the newest fallback PDF.
    pub fallback_layout: Option<u64>,
    /// The source revision of the newest layout; `None` before the first.
    pub layout_revision: Option<u64>,
    /// The source revision the base PDF was built from: edits up to it are
    /// on the base's pages. Starts as the revision rtex loaded the project
    /// at, the files on disk the open PDF was built from.
    pub base_revision: u64,
}

impl PreviewModel {
    pub fn has_layout(&self) -> bool {
        self.layout_revision.is_some()
    }

    /// Install a background layout. Returns the pages whose drawing changed.
    pub fn apply_layout(&mut self, input: LayoutInput) -> Dirty {
        let mut dirty = HashSet::new();
        for overlay in self.overlays.values() {
            dirty.extend(overlay.fragments.iter().map(|fragment| fragment.page));
        }
        for page in input.pages {
            dirty.insert(page.page);
            self.page_revision.insert(page.page, input.revision);
            self.page_layout.insert(page.page, input.layout_version);
            self.pages.insert(page.page, Arc::new(page));
        }
        if input.has_fallback {
            self.fallback_layout = Some(input.layout_version);
        }
        self.layout_revision = Some(input.revision);
        self.pages_total = input.pages_total;
        let total = input.pages_total;
        self.pages.retain(|page, _| *page <= total);
        self.page_revision.retain(|page, _| *page <= total);
        self.page_layout.retain(|page, _| *page <= total);
        self.placements = input
            .placements
            .into_iter()
            .map(|placement| (placement.par_id, placement.fragments))
            .collect();
        let placements = &self.placements;
        self.overlays.retain(|id, overlay| {
            // The layout typeset this edit: its pages carry it now.
            if overlay.revision <= input.revision {
                return false;
            }
            if let Some(placed) = placements.get(id) {
                overlay.fragments = reanchor(placed, &overlay.dl.lines);
            }
            dirty.extend(overlay.fragments.iter().map(|fragment| fragment.page));
            true
        });
        Dirty::Pages(dirty)
    }

    /// Install a fast-path result. Returns the pages to redraw.
    pub fn apply_paragraph(
        &mut self,
        par_id: u64,
        dl: Arc<DisplayList>,
        fragments: Vec<Fragment>,
        revision: u64,
    ) -> Dirty {
        let mut dirty = HashSet::new();
        if let Some(old) = self.overlays.get(&par_id) {
            if old.revision > revision {
                return Dirty::Pages(dirty);
            }
            dirty.extend(old.fragments.iter().map(|fragment| fragment.page));
        }
        dirty.extend(fragments.iter().map(|fragment| fragment.page));
        dirty.extend(
            self.placements
                .get(&par_id)
                .into_iter()
                .flatten()
                .map(|fragment| fragment.page),
        );
        self.overlays.insert(
            par_id,
            Overlay {
                par_id,
                dl,
                fragments,
                revision,
            },
        );
        Dirty::Pages(dirty)
    }

    /// Where a live result's rows go, given rtex's own `fragments` for it.
    /// When the unit kept its row count, its rows stay on the baselines the
    /// last layout gave them: rtex's live engine can set a unit's first rows
    /// a few points off its whole-document pass (an abstract's heading gap,
    /// measured 2.9 pt short), which would shift the paragraph on every
    /// keystroke. A unit that gained or lost rows takes rtex's fragments, and
    /// the layout that its pagination change schedules puts it right.
    pub fn place_live(&self, par_id: u64, fragments: Vec<Fragment>) -> Vec<Fragment> {
        let Some(placed) = self.placements.get(&par_id) else {
            return fragments;
        };
        let rows = |list: &[Fragment]| -> usize {
            list.iter().map(|fragment| fragment.baselines.len()).sum()
        };
        if rows(placed) != rows(&fragments) || placed.len() != fragments.len() {
            return fragments;
        }
        fragments
            .into_iter()
            .zip(placed)
            .map(|(fragment, placed)| Fragment {
                page: placed.page,
                baselines: placed.baselines.clone(),
                ..fragment
            })
            .collect()
    }

    /// Drop overlays (all when `ids` is `None`). Returns the pages to redraw.
    pub fn drop_overlays(&mut self, ids: Option<&[u64]>) -> Dirty {
        let victims: Vec<u64> = match ids {
            Some(ids) => ids.to_vec(),
            None => self.overlays.keys().copied().collect(),
        };
        let mut dirty = HashSet::new();
        for id in victims {
            let Some(overlay) = self.overlays.remove(&id) else {
                continue;
            };
            dirty.extend(overlay.fragments.iter().map(|fragment| fragment.page));
            dirty.extend(
                self.placements
                    .get(&id)
                    .into_iter()
                    .flatten()
                    .map(|fragment| fragment.page),
            );
        }
        Dirty::Pages(dirty)
    }

    /// A new base PDF is on screen, built from the files as of `revision`:
    /// the edits it holds no longer need painting. Every page may change
    /// source.
    pub fn set_base(&mut self, revision: u64) {
        self.base_revision = revision;
        self.overlays
            .retain(|_, overlay| overlay.revision > revision);
    }

    /// Where page `n` (1-based) should be drawn from.
    pub fn page_source(&self, n: u32) -> PageSource {
        let Some(page) = self.pages.get(&n) else {
            return PageSource::Base;
        };
        if self.page_revision.get(&n).copied().unwrap_or(0) <= self.base_revision {
            return PageSource::Base;
        }
        if page.exact {
            return PageSource::DisplayList(page.clone());
        }
        let layout = self.page_layout.get(&n).copied().unwrap_or(0);
        // A fallback PDF draws only pages that have not changed since its
        // layout.
        match self.fallback_layout {
            Some(fallback) if fallback >= layout => PageSource::Fallback {
                page: page.clone(),
                layout_version: fallback,
            },
            _ => PageSource::Base,
        }
    }

    /// Whether rtex's newer layout and the PDF on screen disagree on the
    /// page count: pages the PDF lacks cannot be shown until the next build.
    pub fn pages_disagree(&self, base_pages: Option<u32>) -> bool {
        match (base_pages, self.layout_revision) {
            (Some(pages), Some(layout)) => layout > self.base_revision && self.pages_total != pages,
            _ => false,
        }
    }

    /// Indices of the page's lines replaced by overlays (rows of units that
    /// have one).
    pub fn hidden_lines(&self, page: u32) -> HashSet<usize> {
        self.overlays
            .keys()
            .flat_map(|id| self.own_lines(page, *id))
            .collect()
    }

    /// Indices of the page's lines that belong to unit `par_id` in the last
    /// layout: the lines at the unit's placement rows (baseline and x), plus
    /// every other line the capture attributed to the same capture unit
    /// (`line.unit`). The second part catches rows a placement does not pin
    /// down exactly (a picture row, a display), so nothing of the unit stays
    /// behind at its old place while the live result is drawn at the new one.
    pub fn own_lines(&self, page: u32, par_id: u64) -> HashSet<usize> {
        let mut set = HashSet::new();
        let Some(update) = self.pages.get(&page) else {
            return set;
        };
        let mut units = HashSet::new();
        for fragment in self.placements.get(&par_id).into_iter().flatten() {
            if fragment.page != page {
                continue;
            }
            for (k, baseline) in fragment.baselines.iter().enumerate() {
                let x = fragment.xs.get(k).copied().unwrap_or(fragment.x);
                for (ix, line) in update.dl.lines.iter().enumerate() {
                    if (line.y - baseline).abs() <= MATCH_TOLERANCE
                        && (line.x - x).abs() <= MATCH_TOLERANCE
                    {
                        set.insert(ix);
                        if let Some(unit) = line.unit.filter(|unit| *unit != 0) {
                            units.insert(unit);
                        }
                    }
                }
            }
        }
        if !units.is_empty() {
            for (ix, line) in update.dl.lines.iter().enumerate() {
                if line.unit.is_some_and(|unit| units.contains(&unit)) {
                    set.insert(ix);
                }
            }
        }
        set
    }

    /// Overlay rows to draw on `page`, with the translation of each row into
    /// page coordinates.
    pub fn overlays_on(&self, page: u32) -> Vec<PageOverlay> {
        let mut out = Vec::new();
        for overlay in self.overlays.values() {
            let mut rows = Vec::new();
            for fragment in overlay.fragments.iter().filter(|f| f.page == page) {
                for (k, baseline) in fragment.baselines.iter().enumerate() {
                    let Some(line) = (fragment.first_line + k)
                        .checked_sub(1)
                        .and_then(|ix| overlay.dl.lines.get(ix))
                    else {
                        continue;
                    };
                    let x = fragment.xs.get(k).copied().unwrap_or(fragment.x);
                    rows.push(OverlayRow {
                        line: line.clone(),
                        dx: x - line.x,
                        dy: baseline - line.y,
                    });
                }
            }
            if !rows.is_empty() {
                out.push(PageOverlay {
                    overlay: overlay.clone(),
                    rows,
                });
            }
        }
        out
    }
}

/// Place a unit's rows at a layout's placement rows (the algorithm of rtex
/// layout.rs `fragments`): rows are positioned relative to the first
/// placement row of each page; rows beyond the placement continue on its
/// last page.
pub fn reanchor(placed: &[Fragment], rows: &[Line]) -> Vec<Fragment> {
    struct Anchor {
        page: u32,
        x: f64,
        y: f64,
    }
    let anchors: Vec<Anchor> = placed
        .iter()
        .flat_map(|fragment| {
            fragment
                .baselines
                .iter()
                .enumerate()
                .map(move |(k, y)| Anchor {
                    page: fragment.page,
                    x: fragment.xs.get(k).copied().unwrap_or(fragment.x),
                    y: *y,
                })
        })
        .collect();
    let mut fragments = Vec::new();
    let mut i = 0;
    while i < anchors.len() && i < rows.len() {
        let page = anchors[i].page;
        let (anchor_x, anchor_y) = (anchors[i].x, anchors[i].y);
        let (row_x, row_y) = (rows[i].x, rows[i].y);
        let first = i;
        let mut xs = Vec::new();
        let mut baselines = Vec::new();
        while i < anchors.len() && anchors[i].page == page && i < rows.len() {
            xs.push(anchor_x + (rows[i].x - row_x));
            baselines.push(anchor_y + (rows[i].y - row_y));
            i += 1;
        }
        let mut approximate = false;
        if i >= anchors.len() {
            while i < rows.len() {
                xs.push(anchor_x + (rows[i].x - row_x));
                baselines.push(anchor_y + (rows[i].y - row_y));
                i += 1;
                approximate = true;
            }
        }
        fragments.push(Fragment {
            page,
            first_line: first + 1,
            last_line: i,
            x: xs[0],
            xs,
            baselines,
            approximate,
        });
    }
    fragments
}

/// A rectangle in sp.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A picture rtex reused from its picture cache:
/// `["u", "cached_picture", "<index> <x> <top> <width> <height>"]` (sp, in
/// the list's frame).
fn cached_picture(item: &Item) -> Option<(u64, Rect)> {
    let Item::Unknown { kind, detail } = item else {
        return None;
    };
    if kind != "cached_picture" {
        return None;
    }
    let values: Vec<f64> = match detail {
        serde_json::Value::Array(values) => values.iter().filter_map(|v| v.as_f64()).collect(),
        other => other
            .as_str()
            .unwrap_or_default()
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect(),
    };
    let [index, x, y, w, h] = values.get(..5)?.try_into().ok()?;
    (w > 0. && h > 0.).then_some((index as u64, Rect { x, y, w, h }))
}

/// Where the cached pictures of a live unit were on the page (`src`, from the
/// page's display list) and where they are now (`dst`, the unit's item moved
/// by its row's translation). A live compile carries a cached picture only as
/// an item; its pixels come from the page as the last layout drew it, so they
/// are carried over to the new position. Only pictures on the unit's own page
/// lines (`own`, from `own_lines`) are candidates, paired by picture index,
/// else by size: a picture of another unit is never taken.
pub fn cached_picture_moves(
    page: &DisplayList,
    rows: &[OverlayRow],
    own: &HashSet<usize>,
) -> Vec<(Rect, Rect)> {
    let on_page: Vec<(u64, Rect)> = page
        .lines
        .iter()
        .enumerate()
        .filter(|(ix, _)| own.contains(ix))
        .flat_map(|(_, line)| line.items.iter().filter_map(cached_picture))
        .collect();
    let mut used = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        for (index, picture) in row.line.items.iter().filter_map(cached_picture) {
            let same = |k: usize| {
                !used.contains(&k)
                    && (on_page[k].1.w - picture.w).abs() <= MATCH_TOLERANCE
                    && (on_page[k].1.h - picture.h).abs() <= MATCH_TOLERANCE
            };
            let found = (0..on_page.len())
                .find(|k| on_page[*k].0 == index && same(*k))
                .or_else(|| (0..on_page.len()).find(|k| same(*k)));
            let Some(k) = found else {
                continue;
            };
            used.insert(k);
            out.push((
                on_page[k].1,
                Rect {
                    x: picture.x + row.dx,
                    y: picture.y + row.dy,
                    ..picture
                },
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(x: f64, y: f64, unit: Option<u64>) -> Line {
        Line {
            unit,
            x,
            y,
            w: 100.,
            h: 10.,
            d: 2.,
            items: Vec::new(),
        }
    }

    fn fragment(page: u32, xs: &[f64], baselines: &[f64]) -> Fragment {
        Fragment {
            page,
            first_line: 1,
            last_line: baselines.len(),
            x: xs[0],
            xs: xs.to_vec(),
            baselines: baselines.to_vec(),
            approximate: false,
        }
    }

    fn page(n: u32, lines: Vec<Line>, exact: bool) -> PageUpdate {
        PageUpdate {
            page: n,
            exact,
            dl: DisplayList {
                lines,
                ..DisplayList::default()
            },
        }
    }

    fn layout(model: &mut PreviewModel, revision: u64, pages: Vec<PageUpdate>, placements: Vec<Placement>) -> Dirty {
        model.apply_layout(LayoutInput {
            pages,
            pages_total: 2,
            placements,
            revision,
            layout_version: revision,
            has_fallback: false,
        })
    }

    #[test]
    fn a_page_is_the_base_until_rtex_lays_it_out_past_the_base() {
        let mut model = PreviewModel::default();
        model.base_revision = 1;
        layout(&mut model, 1, vec![page(1, vec![], true)], vec![]);
        assert!(matches!(model.page_source(1), PageSource::Base));
        layout(&mut model, 2, vec![page(1, vec![], true)], vec![]);
        assert!(matches!(model.page_source(1), PageSource::DisplayList(_)));
        model.set_base(2);
        assert!(matches!(model.page_source(1), PageSource::Base));
        // A page rtex could not describe exactly needs a fallback PDF.
        layout(&mut model, 3, vec![page(2, vec![], false)], vec![]);
        assert!(matches!(model.page_source(2), PageSource::Base));
    }

    #[test]
    fn a_live_paragraph_keeps_its_layout_baselines_while_its_rows_do() {
        let mut model = PreviewModel::default();
        let placed = fragment(1, &[10.], &[500.]);
        layout(
            &mut model,
            1,
            vec![page(1, vec![line(10., 500., Some(3))], true)],
            vec![Placement { par_id: 3, fragments: vec![placed] }],
        );
        let live = model.place_live(3, vec![fragment(1, &[10.], &[503.])]);
        assert_eq!(live[0].baselines, [500.]);
        let grown = model.place_live(3, vec![fragment(1, &[10., 10.], &[503., 515.])]);
        assert_eq!(grown[0].baselines, [503., 515.]);
    }

    #[test]
    fn overlays_hide_their_units_lines_and_go_once_typeset() {
        let mut model = PreviewModel::default();
        layout(
            &mut model,
            1,
            vec![page(
                1,
                // Rows a line apart: further than the match tolerance.
                vec![line(10., 500e3, Some(3)), line(10., 520e3, Some(3)), line(10., 540e3, Some(4))],
                true,
            )],
            vec![Placement { par_id: 3, fragments: vec![fragment(1, &[10.], &[500e3])] }],
        );
        let dl = Arc::new(DisplayList {
            lines: vec![line(0., 0., None)],
            ..DisplayList::default()
        });
        let dirty = model.apply_paragraph(3, dl, vec![fragment(1, &[10.], &[500e3])], 2);
        assert!(dirty.contains(1));
        // The placement row, and the other row of the same capture unit.
        assert_eq!(model.hidden_lines(1), HashSet::from([0, 1]));
        let rows = model.overlays_on(1);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].rows[0].dx, rows[0].rows[0].dy), (10., 500e3));
        // An older result never paints over a newer one.
        let stale = model.apply_paragraph(3, Arc::new(DisplayList::default()), vec![], 1);
        assert!(stale.is_empty());
        layout(&mut model, 2, vec![], vec![]);
        assert!(model.overlays.is_empty());
    }

    #[test]
    fn reanchoring_follows_the_placement_across_pages() {
        let placed = [fragment(1, &[10.], &[700.]), fragment(2, &[10.], &[100.])];
        let rows = [line(0., 0., None), line(0., 12., None), line(0., 24., None)];
        let fragments = reanchor(&placed, &rows);
        assert_eq!(fragments.len(), 2);
        assert_eq!(fragments[0].baselines, [700.]);
        assert_eq!(fragments[1].page, 2);
        assert_eq!(fragments[1].baselines, [100., 112.]);
        assert!(fragments[1].approximate);
        assert_eq!((fragments[1].first_line, fragments[1].last_line), (2, 3));
    }

    #[test]
    fn a_cached_picture_moves_with_its_row() {
        let mut picture_line = line(10., 500., Some(3));
        picture_line.items.push(Item::Unknown {
            kind: "cached_picture".into(),
            detail: serde_json::json!("1 10 400 50 60"),
        });
        let page = DisplayList {
            lines: vec![picture_line.clone()],
            ..DisplayList::default()
        };
        let rows = [OverlayRow {
            line: picture_line,
            dx: 0.,
            dy: 20.,
        }];
        let moves = cached_picture_moves(&page, &rows, &HashSet::from([0]));
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].1.y, 420.);
        assert!(cached_picture_moves(&page, &rows, &HashSet::new()).is_empty());
    }

    #[test]
    fn page_counts_disagree_only_for_a_newer_layout() {
        let mut model = PreviewModel::default();
        assert!(!model.pages_disagree(Some(3)));
        layout(&mut model, 2, vec![], vec![]);
        assert!(model.pages_disagree(Some(3)));
        assert!(!model.pages_disagree(Some(2)));
        model.set_base(2);
        assert!(!model.pages_disagree(Some(3)));
    }
}
