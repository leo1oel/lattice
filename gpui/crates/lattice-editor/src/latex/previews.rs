//! What the cards' previews are drawn from: KaTeX's picture of an equation
//! and a figure's image, as the Tauri app's reference and figure cards show
//! them (`figurePreview` and `equationPreview` in
//! `src/editor/latex/latex-hover-cards.ts`, its images through
//! `use-reference-images.ts`).
//!
//! The editor draws neither itself. The app installs a [`PreviewHost`]
//! (`lattice-gpui`'s `structured/card_math.rs`): it sets math with KaTeX in a
//! page of its own and hands back the picture, and reads a figure (an image,
//! or a PDF's first page). This module keeps what came back, keyed by what
//! it shows, and asks the editors that waited for it to draw again once it
//! is in. Without a host (unit tests, offscreen shots) an equation shows its
//! source and a figure no preview, as the Tauri app's card does before
//! KaTeX loads and without a figure loader.

use std::{
    collections::HashMap,
    hash::Hash,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::SystemTime,
};

use gpui::{AnyElement, App, ElementId, Global, Hsla, ImageSource, Pixels, Task, WeakEntity};

use crate::LatticeEditor;

/// The project's TeX sources, which the host reads its KaTeX macros from
/// (`katexMacrosFromSources`), with a number told apart from every other
/// set of sources: a picture set with other macros is another picture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacroSources {
    pub generation: u64,
    pub sources: Arc<[String]>,
}

static GENERATIONS: AtomicU64 = AtomicU64::new(1);

impl MacroSources {
    pub fn new(sources: Arc<[String]>) -> Self {
        Self {
            generation: GENERATIONS.fetch_add(1, Ordering::Relaxed),
            sources,
        }
    }
}

impl Default for MacroSources {
    fn default() -> Self {
        Self {
            generation: 0,
            sources: Arc::from(Vec::new()),
        }
    }
}

/// An equation to set: its math as written (the host strips `\label` and
/// sets an `align` body as `aligned`, `equationHtml`), in the card's text
/// size and ink.
#[derive(Clone, Debug)]
pub struct MathRequest {
    pub tex: String,
    pub display: bool,
    /// The card's text size; KaTeX sets itself at 1.21 times it.
    pub size: Pixels,
    pub color: Hsla,
    pub macros: MacroSources,
}

/// KaTeX's picture of an equation, and the size it is drawn at. Decoded
/// already: an image GPUI decodes itself draws a frame later, from a view
/// it may not draw again while the card rests.
#[derive(Clone, Debug)]
pub struct MathPicture {
    pub image: Arc<gpui::RenderImage>,
    pub width: Pixels,
    pub height: Pixels,
}

/// A figure, once read.
#[derive(Clone)]
pub enum Figure {
    Shown(ImageSource),
    /// A format with no preview (EPS, say): "Preview unavailable for this
    /// figure format."
    Unavailable,
    /// "Figure preview could not be loaded."
    Failed,
}

/// What the app draws previews with.
pub trait PreviewHost {
    /// KaTeX's picture of `request`, or `None` where KaTeX cannot set it.
    fn math(&self, request: &MathRequest, cx: &mut App) -> Task<Option<MathPicture>>;
    /// The figure at `path` (absolute).
    fn figure(&self, path: &Path, cx: &mut App) -> Task<Figure>;
    /// The loader a preview shows while it is read (`InfinityLoader`).
    fn loader(&self, id: ElementId, size: Pixels, cx: &App) -> AnyElement;
}

/// A preview, as far as it has got.
#[derive(Clone)]
pub enum Preview<T> {
    Loading,
    Ready(T),
}

/// How many pictures and figures are kept: the Tauri app keeps 48 figures
/// (`CACHE_ENTRY_LIMIT`); pictures of equations are small.
const MATH_KEPT: usize = 256;
const FIGURES_KEPT: usize = 48;

#[derive(Clone, PartialEq, Eq, Hash)]
struct MathKey {
    tex: String,
    display: bool,
    size: u32,
    color: [u32; 4],
    macros: u64,
}

impl MathKey {
    fn of(request: &MathRequest) -> Self {
        let Hsla { h, s, l, a } = request.color;
        Self {
            tex: request.tex.clone(),
            display: request.display,
            size: f32::from(request.size).to_bits(),
            color: [h.to_bits(), s.to_bits(), l.to_bits(), a.to_bits()],
            macros: request.macros.generation,
        }
    }
}

/// A file as it is on disk now: a figure changed in place is read again.
#[derive(Clone, PartialEq, Eq, Hash)]
struct FigureKey {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
}

enum Slot<T> {
    /// Being read, with the editors to draw again once it is in.
    Pending(Vec<WeakEntity<LatticeEditor>>),
    Ready(T),
}

/// A cache that forgets what was used longest ago.
struct Kept<K, T> {
    entries: HashMap<K, (Slot<T>, u64)>,
    tick: u64,
    limit: usize,
}

impl<K: Clone + Eq + Hash, T: Clone> Kept<K, T> {
    fn new(limit: usize) -> Self {
        Self {
            entries: HashMap::new(),
            tick: 0,
            limit,
        }
    }

    /// What is kept for `key`, waiting with `editor` if it is still being
    /// read; `None` when nothing is, and it should be.
    fn get(&mut self, key: &K, editor: &WeakEntity<LatticeEditor>) -> Option<Preview<T>> {
        self.tick += 1;
        let (slot, used) = self.entries.get_mut(key)?;
        *used = self.tick;
        Some(match slot {
            Slot::Ready(value) => Preview::Ready(value.clone()),
            Slot::Pending(waiting) => {
                if !waiting.iter().any(|known| known == editor) {
                    waiting.push(editor.clone());
                }
                Preview::Loading
            }
        })
    }

    fn start(&mut self, key: K, editor: WeakEntity<LatticeEditor>) {
        self.tick += 1;
        self.entries
            .insert(key, (Slot::Pending(vec![editor]), self.tick));
        while self.entries.len() > self.limit {
            let oldest = self
                .entries
                .iter()
                .filter(|(_, (slot, _))| matches!(slot, Slot::Ready(_)))
                .min_by_key(|(_, (_, used))| *used)
                .map(|(key, _)| key.clone());
            match oldest {
                Some(key) => self.entries.remove(&key),
                None => break,
            };
        }
    }

    /// Keep `value` for `key`: the editors that waited for it.
    fn finish(&mut self, key: K, value: T) -> Vec<WeakEntity<LatticeEditor>> {
        let Some((slot, _)) = self.entries.get_mut(&key) else {
            return Vec::new();
        };
        match std::mem::replace(slot, Slot::Ready(value)) {
            Slot::Pending(waiting) => waiting,
            Slot::Ready(_) => Vec::new(),
        }
    }
}

struct Previews {
    host: Rc<dyn PreviewHost>,
    math: Kept<MathKey, Option<MathPicture>>,
    figures: Kept<FigureKey, Figure>,
}

impl Global for Previews {}

/// Draw the cards' previews with `host` from now on.
pub fn install(host: Rc<dyn PreviewHost>, cx: &mut App) {
    cx.set_global(Previews {
        host,
        math: Kept::new(MATH_KEPT),
        figures: Kept::new(FIGURES_KEPT),
    });
}

/// Whether previews are drawn: a host is installed.
pub fn installed(cx: &App) -> bool {
    cx.has_global::<Previews>()
}

fn redraw(editors: Vec<WeakEntity<LatticeEditor>>, cx: &mut App) {
    for editor in editors {
        editor.update(cx, |_, cx| cx.notify()).ok();
    }
}

/// KaTeX's picture of `request`, started now if it was not; `None` without
/// a host. `editor` draws again when the picture is in.
pub fn math(
    request: &MathRequest,
    editor: &WeakEntity<LatticeEditor>,
    cx: &mut App,
) -> Option<Preview<Option<MathPicture>>> {
    let key = MathKey::of(request);
    let previews = cx.try_global::<Previews>()?;
    let host = previews.host.clone();
    if let Some(kept) = cx.global_mut::<Previews>().math.get(&key, editor) {
        return Some(kept);
    }
    cx.global_mut::<Previews>()
        .math
        .start(key.clone(), editor.clone());
    let task = host.math(request, cx);
    cx.spawn(async move |cx| {
        let picture = task.await;
        cx.update(|cx| {
            let waiting = cx.global_mut::<Previews>().math.finish(key, picture);
            redraw(waiting, cx);
        });
    })
    .detach();
    Some(Preview::Loading)
}

/// The figure at `path` (absolute), read now if it was not since it last
/// changed on disk; `None` without a host.
pub fn figure(
    path: &Path,
    editor: &WeakEntity<LatticeEditor>,
    cx: &mut App,
) -> Option<Preview<Figure>> {
    let previews = cx.try_global::<Previews>()?;
    let host = previews.host.clone();
    let metadata = std::fs::metadata(path).ok();
    let key = FigureKey {
        path: path.to_path_buf(),
        modified: metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok()),
        len: metadata.as_ref().map_or(0, |metadata| metadata.len()),
    };
    if let Some(kept) = cx.global_mut::<Previews>().figures.get(&key, editor) {
        return Some(kept);
    }
    cx.global_mut::<Previews>()
        .figures
        .start(key.clone(), editor.clone());
    let task = host.figure(path, cx);
    cx.spawn(async move |cx| {
        let figure = task.await;
        cx.update(|cx| {
            let waiting = cx.global_mut::<Previews>().figures.finish(key, figure);
            redraw(waiting, cx);
        });
    })
    .detach();
    Some(Preview::Loading)
}

/// The host's loader, or the interface's busy loader without one.
pub fn loader(id: impl Into<ElementId>, size: Pixels, cx: &App) -> AnyElement {
    let id = id.into();
    match cx.try_global::<Previews>() {
        Some(previews) => previews.host.loader(id, size, cx),
        None => {
            use lattice_ui::ActiveLattice as _;
            lattice_ui::loading::loader(id, size, cx.palette().text_secondary, cx)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cache_forgets_the_least_recently_used_finished_entry() {
        let editor = WeakEntity::<LatticeEditor>::new_invalid();
        let mut kept: Kept<u32, u32> = Kept::new(2);
        kept.start(1, editor.clone());
        kept.finish(1, 10);
        kept.start(2, editor.clone());
        kept.finish(2, 20);
        // 1 is used again, so 2 is the one to go.
        assert!(matches!(kept.get(&1, &editor), Some(Preview::Ready(10))));
        kept.start(3, editor.clone());
        assert!(kept.get(&2, &editor).is_none());
        assert!(matches!(kept.get(&1, &editor), Some(Preview::Ready(10))));
        // One still being read is never forgotten.
        assert!(matches!(kept.get(&3, &editor), Some(Preview::Loading)));
    }

    #[test]
    fn macros_read_from_other_sources_are_told_apart() {
        let one = MacroSources::new(Arc::from(vec![
            "\\newcommand{\\R}{\\mathbb{R}}".to_string(),
        ]));
        let two = MacroSources::new(one.sources.clone());
        assert_ne!(one.generation, two.generation);
        assert_ne!(one.generation, MacroSources::default().generation);
    }
}
